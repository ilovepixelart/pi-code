/**
 * Parsing and discovery for Claude Code slash-command files.
 *
 * pi's own prompt-template loader reads only `description` and `argument-hint`
 * from one flat directory, so the rest of Claude's command contract lives here and is
 * applied by commands.ts when it registers each command itself: namespaced
 * subdirectories, `allowed-tools`, `model`, and the argument substitutions.
 *
 * Running what a body carries, the `!` bash blocks and `@file` references, is the other
 * half and lives in command-spans.ts; skills.ts and the subagent loader import this file
 * alone and never pull a shell resolver in.
 *
 * Docs: https://code.claude.com/docs/en/slash-commands.md
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseFrontmatter } from '@earendil-works/pi-coding-agent'

/** The pi file tools a Claude path rule can govern. */
export type PathRuleTool = 'read' | 'edit' | 'write'

export interface ParsedCommand {
  description: string
  argumentHint?: string
  allowedTools?: string[]
  /** Claude `Bash(...)` specifiers, present only when every bash grant is scoped. */
  bashRules?: string[]
  /** Claude path rules per pi file tool, from Read(...)/Edit(...)/Write(...) grants. */
  pathRules?: Partial<Record<PathRuleTool, string[]>>
  /** Names from the `arguments:` frontmatter list, mapped to positions in order. */
  argumentNames?: string[]
  /** Tools removed from the pool while the command's turn runs. */
  disallowedTools?: string[]
  /** `shell:` frontmatter: `bash` (the default) or `powershell`, choosing how the
   * command's injected spans run (see spanExec). */
  shell?: string
  model?: string
  /** `effort:` per-command thinking-level override, one of pi's ThinkingLevel values
   * (off/minimal/low/medium/high/xhigh/max); undefined when absent or unrecognized. */
  effort?: string
  /** `when_to_use:` extra trigger text appended to the slash_command tool listing only,
   * never to the user-facing command description. */
  whenToUse?: string
  disableModelInvocation: boolean
  /** `user-invocable:` false hides the command from the slash-command surface while
   * keeping it callable by the model through the slash_command tool. Default true. */
  userInvocable: boolean
  body: string
}

export interface DiscoveredCommand {
  /** Claude names a command by its file name alone; a plugin's is `plugin:name`. */
  name: string
  filePath: string
  /** Set for plugin commands, carrying the ${CLAUDE_PLUGIN_*} and ${user_config.*} substitution sources. */
  plugin?: { root: string; dataDir: string; userConfig?: Record<string, string> }
}

/** Claude tool names are PascalCase and do not all exist in pi: `Glob` is pi's
 * `find`. Lowercasing alone left `glob` in the list, and since pi has no tool by
 * that name the grant was silently dropped when the list was intersected with the
 * active tools. Shared with the subagent's own frontmatter parsing. */
const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  glob: 'find',
  ls: 'ls',
  // Claude's names for the tools this package registers itself. Without these a
  // perfectly ordinary `allowed-tools: WebFetch, WebSearch` matched no pi tool and
  // the intersection left the turn with nothing.
  webfetch: 'web_fetch',
  websearch: 'web_search',
  todowrite: 'todo',
  todoread: 'todo',
  task: 'subagent',
  askuserquestion: 'question',
  exitplanmode: 'plan_mode_complete',
  // Claude's name for the tool this package registers so the model can run user slash
  // commands; without it `allowed-tools: SlashCommand` matched nothing and the grant
  // could neither keep nor drop the tool.
  slashcommand: 'slash_command',
}

/**
 * The pi tool name for one grant entry, scope and all: `Bash(git add:*)` is `bash`.
 * Keeping the scope in the name matched nothing when the list was intersected with
 * the active tools, which left a command declaring only scoped grants running with
 * no tools at all. The scope itself is not dropped: parseToolGrants keeps bash
 * scopes for call-time enforcement.
 */
export function normalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase()
  const scope = lower.indexOf('(')
  const base = (scope === -1 ? lower : lower.slice(0, scope)).trim()
  return CLAUDE_TOOL_MAP[base] ?? base
}

/**
 * Entries are comma- or space-separated, as Claude documents ("a space- or
 * comma-separated string, or a YAML list"), except a separator inside an argument
 * scope belongs to the scope: `Bash(cat, tail)` and `Bash(git add *)` are one grant
 * each. Splitting on every comma made the fragments between them top-level entries,
 * so a command naming only `Bash` came away with pi's `edit` tool active; splitting
 * on no spaces mangled the docs' own space-separated examples into one garbage rule.
 *
 * Scanned rather than matched with a regex: the pattern form is quadratic on an input
 * of unclosed parens, and a command file comes from the repository.
 */
function toolEntries(raw: string): string[] {
  const entries: string[] = []
  let current = ''
  let depth = 0
  for (const ch of raw) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if ((ch === ',' || ch === ' ' || ch === '\t') && depth === 0) {
      entries.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  entries.push(current)
  return entries.map((entry) => entry.trim()).filter(Boolean)
}

export interface ToolGrants {
  /** pi tool names to grant, deduplicated in first-seen order. */
  tools: string[]
  /** Claude `Bash(...)` specifiers, present only when every bash grant is scoped:
   * an unscoped `Bash` entry is the wider grant and wins over its scoped siblings. */
  bashRules?: string[]
  /** Claude path rules per pi file tool, absent for a tool with an unscoped grant.
   * Edit scopes govern writes too, as Claude documents; Write scopes are honored
   * rather than Claude's accept-and-warn-then-ignore, which would fail open here. */
  pathRules?: Partial<Record<PathRuleTool, string[]>>
  /** Entries that carried an argument scope, in their original spelling. */
  scopedEntries: string[]
}

/** The pi file tools one Claude path-ruled entry governs. */
const PATH_RULE_TOOLS: Record<string, Array<PathRuleTool>> = {
  read: ['read'],
  edit: ['edit', 'write'],
  write: ['write'],
}

/** The tools, scopes, and path rules accumulated while scanning one grant list. */
interface GrantAccumulator {
  tools: string[]
  scopedEntries: string[]
  bashRules: string[]
  bashUnscoped: boolean
  pathScopes: Record<PathRuleTool, string[]>
  pathUnscoped: Set<PathRuleTool>
}

function createGrantAccumulator(): GrantAccumulator {
  return { tools: [], scopedEntries: [], bashRules: [], bashUnscoped: false, pathScopes: { read: [], edit: [], write: [] }, pathUnscoped: new Set() }
}

/** Coerce a raw grant value to its string entries: a YAML list stays a list, a
 * comma-separated string is split, and anything else (or a list with a non-string
 * member) is rejected as undefined, the same "not a grant" signal as an absent field. */
function coerceGrantItems(raw: unknown): string[] | undefined {
  let items: unknown[]
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'string') items = toolEntries(raw)
  else return undefined
  if (items.some((item) => typeof item !== 'string')) return undefined
  return items as string[]
}

/** Fold one grant entry into the accumulator: the base tool is granted, an unscoped
 * entry marks its tools wide, and a scoped entry records the scope for bash and the
 * file tools it governs. */
function addGrantEntry(acc: GrantAccumulator, item: string): void {
  const entry = item.trim()
  const name = normalizeToolName(entry)
  if (!name) return
  if (!acc.tools.includes(name)) acc.tools.push(name)
  const open = entry.indexOf('(')
  if (open === -1) {
    if (name === 'bash') acc.bashUnscoped = true
    for (const tool of PATH_RULE_TOOLS[name] ?? []) acc.pathUnscoped.add(tool)
    return
  }
  acc.scopedEntries.push(entry)
  const scope = entry.slice(open + 1, entry.endsWith(')') ? -1 : undefined).trim()
  // An empty specifier (`Bash()`, `Read()`) matches nothing and must not read as
  // the unscoped grant it explicitly is not: it is recorded so the tool stays
  // restricted, and the matchers treat an empty rule as matching no input.
  if (name === 'bash') acc.bashRules.push(scope)
  for (const tool of PATH_RULE_TOOLS[name] ?? []) acc.pathScopes[tool].push(scope)
}

/** The per-tool path rules from a scan: a tool with any unscoped grant is omitted
 * (it is wide), one with only scoped grants keeps them, and the whole map is absent
 * when no tool carries a rule. */
function buildPathRules(acc: GrantAccumulator): ToolGrants['pathRules'] {
  const pathRules: NonNullable<ToolGrants['pathRules']> = {}
  for (const tool of ['read', 'edit', 'write'] as const) {
    if (!acc.pathUnscoped.has(tool) && acc.pathScopes[tool].length > 0) pathRules[tool] = acc.pathScopes[tool]
  }
  return Object.keys(pathRules).length > 0 ? pathRules : undefined
}

/**
 * A tool grant is either a comma-separated string or a YAML list, and the two mean the
 * same thing. An empty list is not the same as an absent one: it says no tools, so it
 * comes back with an empty `tools` array rather than as undefined.
 *
 * Claude scopes a grant to arguments: `Bash(git add:*)` allows exactly those commands.
 * pi's active-tool list is per tool, with no argument dimension, so the base tool is
 * granted and the scope is kept: commands.ts enforces bash scopes at tool_call time,
 * and the subagent's frontmatter parsing rejects a scoped grant it cannot express.
 * A scope on any other tool is dropped, which widens that grant; bash is the one
 * whose widening reaches everything, so it is the one enforced.
 */
export function parseToolGrants(raw: unknown): ToolGrants | undefined {
  const items = coerceGrantItems(raw)
  if (items === undefined) return undefined
  const acc = createGrantAccumulator()
  for (const item of items) addGrantEntry(acc, item)
  return {
    tools: acc.tools,
    scopedEntries: acc.scopedEntries,
    bashRules: !acc.bashUnscoped && acc.bashRules.length > 0 ? acc.bashRules : undefined,
    pathRules: buildPathRules(acc),
  }
}

/** YAML types a bare scalar, so a model named `3.5` arrives as a number, not a string. */
const text = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

/** YAML's affirmative boolean spellings. Claude documents `disable-model-invocation:
 * true`, but a command file is hand-written YAML where `yes`, `on`, and `1` are all
 * ordinary spellings of true, and pi's parser hands those back as the raw string or
 * number rather than a boolean. A flag that gates a command off from the model has to
 * honor them, or a command the user marked off-limits is silently offered to it. */
const YAML_TRUE = new Set(['true', 'yes', 'on', 'y', '1'])
const isFlagEnabled = (value: unknown): boolean => value === true || YAML_TRUE.has(text(value).toLowerCase())

/** YAML's negative boolean spellings, the mirror of YAML_TRUE. A flag that defaults to
 * true (user-invocable) is turned off only by one of these; any other value, absent
 * included, leaves it on, so an unrelated string never silently hides a command. */
const YAML_FALSE = new Set(['false', 'no', 'off', 'n', '0'])
const isFlagDisabled = (value: unknown): boolean => value === false || YAML_FALSE.has(text(value).toLowerCase())

/** pi's ThinkingLevel union, the values a command's `effort:` override may name. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Claude writes `argument-hint: [pr]`, which YAML reads as a list; render it back. */
const hint = (value: unknown): string => (Array.isArray(value) ? `[${value.join(', ')}]` : text(value))

const ARGUMENT_NAME = /^[A-Za-z_]\w*$/

/** The `arguments:` frontmatter: a YAML list or a space- or comma-separated string
 * of names mapping to positions in order. Invalid names are dropped, and ARGUMENTS
 * itself is reserved by the built-in placeholder. */
function parseArgumentNames(raw: unknown): string[] | undefined {
  let items: string[]
  if (Array.isArray(raw)) items = raw.map(String)
  else if (typeof raw === 'string') items = raw.split(/[\s,]+/)
  else return undefined
  const names = items.map((name) => name.trim()).filter((name) => ARGUMENT_NAME.test(name) && name !== 'ARGUMENTS')
  return names.length > 0 ? names : undefined
}

const SHELLS = new Set(['bash', 'powershell'])

export function parseCommandFile(content: string): ParsedCommand {
  // pi's own parser, rather than a hand-rolled one: it reads the YAML shapes Claude
  // command files actually use (flow sequences, block lists, quoted and multi-line
  // values), and a value this misreads is a restriction silently not applied.
  const { frontmatter, body: raw } = parseFrontmatter(content)
  const body = raw.trim()
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  const disable = frontmatter['disable-model-invocation']
  const grants = parseToolGrants(frontmatter['allowed-tools'])
  const shell = text(frontmatter.shell).toLowerCase()
  const effort = text(frontmatter.effort).toLowerCase()
  return {
    description: text(frontmatter.description) || firstLine.slice(0, 60),
    argumentHint: hint(frontmatter['argument-hint']) || undefined,
    allowedTools: grants?.tools,
    bashRules: grants?.bashRules,
    pathRules: grants?.pathRules,
    argumentNames: parseArgumentNames(frontmatter.arguments),
    // A scope on a disallow entry only denies more than asked, so the drop is safe.
    disallowedTools: parseToolGrants(frontmatter['disallowed-tools'])?.tools,
    shell: SHELLS.has(shell) ? shell : undefined,
    model: text(frontmatter.model) || undefined,
    // An unrecognized effort is dropped rather than passed to setThinkingLevel.
    effort: THINKING_LEVELS.has(effort) ? effort : undefined,
    whenToUse: text(frontmatter.when_to_use) || undefined,
    disableModelInvocation: isFlagEnabled(disable),
    userInvocable: !isFlagDisabled(frontmatter['user-invocable']),
    body,
  }
}

/** Split a raw argument string, keeping quoted runs together. */
function splitArgs(args: string): string[] {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match = pattern.exec(args)
  while (match !== null) {
    out.push(match[1] ?? match[2] ?? match[3])
    match = pattern.exec(args)
  }
  return out
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/** One alternation covering every argument placeholder plus the two escape forms.
 * Alternation order is load-bearing: escapes first (so `\$1` never expands), the
 * bracketed forms before `$ARGUMENTS` (so `$ARGUMENTS[0]` is not read as the bare
 * placeholder plus literal brackets). `(?!)` never matches, standing in when no
 * names are declared. */
function argPattern(names: string[]): RegExp {
  const nameAlt = names.length > 0 ? names.map(escapeRegExp).join('|') : '(?!)'
  return new RegExp(
    String.raw`\\{2}(?=\$)` + // doubled backslash: both stay, the token after still expands
      String.raw`|\\\$(?=\d|@|\{|ARGUMENTS\b|(?:${nameAlt})\b)` + // escape: before any placeholder this expands, incl. $@ and ${...:-}
      String.raw`|\$ARGUMENTS\[(\d+)\]` +
      String.raw`|\$\{(\d+):-([^}]*)\}` +
      String.raw`|\$\{ARGUMENTS:-([^}]*)\}` +
      String.raw`|\$ARGUMENTS\b` +
      String.raw`|\$@` +
      String.raw`|\$(\d+)` +
      String.raw`|\$(${nameAlt})\b`,
    'g',
  )
}

export interface SubstitutedArgs {
  text: string
  /** Whether any placeholder actually read the arguments; drives Claude's
   * `ARGUMENTS: <value>` append when a command never looks at what was passed. */
  consumed: boolean
}

/**
 * Claude's substitutions, per the current skills docs: `$ARGUMENTS`,
 * `$ARGUMENTS[N]` and its `$N` shorthand (0-based: `$0` is the first argument),
 * `$name` for names declared in `arguments:` frontmatter, plus the pi extras `$@`
 * and `${N:-default}`/`${ARGUMENTS:-default}`. An unfilled indexed placeholder
 * stays literal; a declared name with no argument becomes empty; `\$` escapes only
 * a real placeholder and a doubled backslash keeps both while still expanding.
 * One pass with a replacer function: sequential string passes both interpreted
 * `$&`-style metacharacters in the arguments and re-scanned substituted text.
 */
export function substituteArgsDetailed(body: string, args: string, names: string[] = []): SubstitutedArgs {
  const parts = splitArgs(args)
  const all = args.trim()
  let consumed = false
  const fill = (value: string | undefined, orElse: string): string => {
    if (value === undefined) return orElse
    consumed = true
    return value
  }
  const text = body.replaceAll(argPattern(names), (token, bracketIdx?: string, defIdx?: string, defVal?: string, argsDefault?: string, shorthandIdx?: string, name?: string) => {
    if (token === String.raw`\\`) return token
    if (token === String.raw`\$`) return '$'
    if (bracketIdx !== undefined) return fill(parts[Number(bracketIdx)], token)
    if (defIdx !== undefined) return fill(parts[Number(defIdx)], defVal ?? '')
    if (argsDefault !== undefined) {
      consumed = true
      return all || argsDefault
    }
    if (shorthandIdx !== undefined) return fill(parts[Number(shorthandIdx)], token)
    if (name !== undefined) {
      // Claude: "A named placeholder counts even when its position has no argument,
      // because it expands to an empty string", unlike an indexed one, which stays
      // literal and does not count. Otherwise a skill using named arguments still got
      // the ARGUMENTS: block appended.
      consumed = true
      return fill(parts[names.indexOf(name)], '')
    }
    consumed = true
    return all // $ARGUMENTS or $@
  })
  return { text, consumed }
}

export function substituteArgs(body: string, args: string, names: string[] = []): string {
  return substituteArgsDetailed(body, args, names).text
}

/** Claude's `${CLAUDE_*}` string substitutions. A backslash does not prevent these,
 * per the docs, and an unknown variable stays literal. */
export function substituteVars(text: string, vars: Record<string, string | undefined>): string {
  return text.replaceAll(/\$\{(CLAUDE_[A-Z0-9_]+)\}/g, (token, name: string) => vars[name] ?? token)
}

/** Claude: "You invoke a command file by its file name"; subdirectories organize
 * files without namespacing, so `a/b/c.md` is `/c`. A same-name file in another
 * subdirectory takes the name over (scan order decides), as with Claude. */
export function commandNameFor(relativePath: string): string {
  return path.basename(relativePath, '.md')
}

/** Every `*.md` under a commands directory, including nested ones. */
export function discoverCommandFiles(root: string): DiscoveredCommand[] {
  const found: DiscoveredCommand[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, path.join(prefix, entry.name))
      else if (entry.name.endsWith('.md')) found.push({ name: commandNameFor(path.join(prefix, entry.name)), filePath: full })
    }
  }
  walk(root, '')
  return found
}
