/**
 * Parsing and discovery for Claude Code slash-command files.
 *
 * pi's own prompt-template loader reads only `description` and `argument-hint`
 * from one flat directory, so the rest of Claude's command contract (namespaced
 * subdirectories, `allowed-tools`, `model`, `!` bash blocks, `@file` refs) lives
 * here and is applied by commands.ts when it registers each command itself.
 *
 * Docs: https://code.claude.com/docs/en/slash-commands.md
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseFrontmatter } from '@earendil-works/pi-coding-agent'

import { splitSegments } from './shell-split.js'

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
  /** Claude's namespaced name: a nested file is `dir:name`, a plugin's is `plugin:name`. */
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
 * Entries are comma-separated, except a comma inside an argument scope belongs to the
 * scope: `Bash(cat, tail)` is one grant, not three. Splitting on every comma made the
 * fragments between them top-level entries, so a command naming only `Bash` came away
 * with pi's `edit` tool active.
 *
 * Scanned rather than matched with a regex: the pattern form is quadratic on an input
 * of unclosed parens, and a command file comes from the repository.
 */
export function toolEntries(raw: string): string[] {
  const entries: string[] = []
  let current = ''
  let depth = 0
  for (const ch of raw) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
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
export function splitArgs(args: string): string[] {
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
    if (name !== undefined) return fill(parts[names.indexOf(name)], '')
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

/** `a/b/c.md` becomes Claude's `a:b:c`. */
export function commandNameFor(relativePath: string): string {
  return relativePath.replace(/\.md$/, '').split(path.sep).join(':')
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

export type CommandExec = (command: string) => Promise<{ stdout: string; stderr: string; code: number }>

/** PowerShell single-quote escaping: inside a '...' literal the only special
 * characters are the quote delimiters themselves, written doubled. PowerShell's
 * lexer treats U+2018 through U+201B as single quotes too, so each is doubled the
 * same way; leaving them bare let a projectDir like `Alex’s Projects` end the
 * literal mid-path with a ParserError. sh's '\'' form must not be used here,
 * since PowerShell would keep the backslash and reopen the string. */
export function powershellQuote(value: string): string {
  return value.replaceAll(/['‘’‚‛]/g, '$&$&')
}

/** The PowerShell names worth trying: pwsh everywhere it installs, plus the
 * Windows spellings on win32, where powershell.exe ships with the OS. */
const powershellCandidates = (platform: string): string[] => (platform === 'win32' ? ['pwsh', 'pwsh.exe', 'powershell.exe'] : ['pwsh'])

/** First PowerShell binary found on PATH, or undefined when none is installed. */
export function resolvePowershellBinary(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const candidate of powershellCandidates(platform)) {
    for (const dir of dirs) {
      const full = path.join(dir, candidate)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        if (fs.statSync(full).isFile()) return full
      } catch {
        // not here; keep looking
      }
    }
  }
  return undefined
}

export interface SpanExec {
  command: string
  args: string[]
  /** Set when the shell cannot merge stderr into stdout in-script (pwsh 7 drops a
   * native command's stderr from `& { } 2>&1`), asking the caller to append the
   * exec result's stderr to its stdout instead. The sh path merges in-script and
   * leaves this unset. */
  mergeStreams?: boolean
}

/**
 * The exec invocation for one injected span, honoring the `shell:` frontmatter.
 * The default (absent or `bash`) runs through /bin/sh; `powershell` resolves a
 * PowerShell binary and runs the span with -Command, falling back to /bin/sh when
 * none is installed so the command still works, per Claude's shell matrix. Both
 * paths export CLAUDE_PROJECT_DIR (each shell's own quoting) and merge stderr
 * into stdout, as the Bash tool does when it runs these for Claude: the sh script
 * in-line with 2>&1, the pwsh path via mergeStreams in the caller.
 *
 * The resolver is a parameter rather than a default so the caller passes its own
 * imported binding, which keeps the lookup mockable in tests.
 */
export function spanExec(shell: string | undefined, projectDir: string, script: string, resolveBinary: () => string | undefined): SpanExec {
  if (shell === 'powershell') {
    const binary = resolveBinary()
    if (binary !== undefined) {
      // CLAUDECODE=1 marks every subprocess Claude spawns; pi.exec takes no env, so
      // it is exported in the script alongside CLAUDE_PROJECT_DIR.
      const preamble = `$ErrorActionPreference='Continue'\n$env:CLAUDE_PROJECT_DIR='${powershellQuote(projectDir)}'\n$env:CLAUDECODE='1'`
      // No in-script 2>&1: under pwsh 7 it does not merge a native command's
      // stderr on a script block, so mergeStreams has the caller append it. The
      // trailing exit forwards a failed native command's code, which pwsh
      // -Command otherwise swallows (the process exited 0 and a failure never
      // aborted the invocation). An empty or cmdlet-only span leaves
      // $LASTEXITCODE unset and exits 0. Residual gap vs sh: a failing cmdlet
      // sets no exit code, so it cannot abort; its error text still reaches the
      // model through the merged stderr.
      return { command: binary, args: ['-NoProfile', '-NonInteractive', '-Command', `${preamble}\n& {\n${script}\n}\nexit $LASTEXITCODE`], mergeStreams: true }
    }
  }
  const quoted = projectDir.replaceAll("'", String.raw`'\''`)
  // The group opens with a `:` null command: `{ }` around an empty or
  // comment-only span is a hard sh syntax error (exit 2) that aborted the whole
  // invocation, and `:` keeps such a span the harmless no-op it was on HEAD
  // while the group still merges stderr for real spans.
  return { command: '/bin/sh', args: ['-c', `export CLAUDE_PROJECT_DIR='${quoted}'\nexport CLAUDECODE=1\n{ :\n${script}\n} 2>&1`] }
}

interface FenceBlock {
  start: number
  end: number
  /** A fence opened with ```! runs its content as one script; any other fence protects. */
  exec: boolean
  content: string
}

/** Fenced blocks of a body: Claude's dynamic syntax is literal text inside a plain
 * fence, while a ```! fence is itself a placeholder that executes. */
function fenceBlocks(body: string): FenceBlock[] {
  const blocks: FenceBlock[] = []
  const fence = /^(```|~~~)([^\n]*)$/gm
  let open: { index: number; exec: boolean; contentStart: number } | undefined
  let match = fence.exec(body)
  while (match !== null) {
    if (open === undefined) {
      open = { index: match.index, exec: match[1] === '```' && match[2].trim() === '!', contentStart: match.index + match[0].length + 1 }
    } else {
      blocks.push({ start: open.index, end: match.index + match[0].length, exec: open.exec, content: body.slice(Math.min(open.contentStart, match.index), match.index).replace(/\n$/, '') })
      open = undefined
    }
    match = fence.exec(body)
  }
  // An unterminated fence protects to the end of the body rather than executing.
  if (open !== undefined) blocks.push({ start: open.index, end: body.length, exec: false, content: '' })
  return blocks
}

/** Spans of a body inside a protective fenced code block. */
function fencedRanges(body: string): Array<[number, number]> {
  return fenceBlocks(body)
    .filter((block) => !block.exec)
    .map((block) => [block.start, block.end])
}

/** Exit 1 is a normal result for Claude's documented search and comparison commands
 * (no matches, files differ); exit 2 and up fails even for these. */
const EXIT_ONE_OK = new Set(['grep', 'rg', 'egrep', 'fgrep', 'find', 'diff', 'test', '['])

const isCarveoutSegment = (segment: string): boolean => {
  const words = segment.trim().split(/\s+/)
  if (words[0] === 'git') return words[1] === 'diff' || words[1] === 'grep'
  return EXIT_ONE_OK.has(words[0])
}

function benignExitOne(command: string): boolean {
  const segments = splitSegments(command)
  if (segments.length === 0) return false
  // A `&&`/`||` chain can short-circuit, so an earlier segment's exit 1 becomes the
  // result and the last segment is not the one that set the code: `cd nope && grep x`
  // exits 1 from cd, not a benign grep miss. Only when every segment is a carveout is
  // the exit benign whichever ran last. Without short-circuit operators the exit is
  // the last segment's (a `|` pipeline exits with its final command, `;`/newline with
  // the last statement), so the last segment decides.
  if (/&&|\|\|/.test(command)) return segments.every(isCarveoutSegment)
  return isCarveoutSegment(segments.at(-1) ?? '')
}

/** Run one injected span. A failure aborts the whole invocation, as Claude
 * documents: the model never sees a half-expanded body. */
async function runSpan(exec: CommandExec, command: string, pattern: string): Promise<string> {
  const result = await exec(command)
  if (result.code !== 0 && !(result.code === 1 && benignExitOne(command))) {
    throw new Error(`Shell command failed for pattern "${pattern}"\n[stderr]\n${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trimEnd()
}

const inRanges = (ranges: Array<[number, number]>, index: number): boolean => ranges.some(([start, end]) => index >= start && index < end)

/** Read a `@path` reference, confined to the working directory. Returns undefined
 * when the path escapes it or cannot be read, so the reference stays literal. */
function readReference(cwd: string, reference: string): string | undefined {
  try {
    // Both sides canonicalised: on macOS /var is itself a symlink, so comparing a
    // resolved path against an unresolved root rejects every legitimate read.
    const root = fs.realpathSync(cwd)
    // Confinement is checked after symlinks resolve: a lexical check passes a link
    // that points outside the project, and the read would follow it.
    const real = fs.realpathSync(path.resolve(cwd, reference))
    if (real !== root && !real.startsWith(root + path.sep)) return undefined
    if (!fs.statSync(real).isFile()) return undefined
    return fs.readFileSync(real, 'utf-8')
  } catch {
    return undefined
  }
}

interface DynamicSpan {
  start: number
  end: number
  run: () => Promise<string>
}

/** Claude's dynamic command content: `` !`cmd` `` runs a shell command and pastes
 * its output (recognized only at a word start), a ```! fenced block runs its lines
 * as one script, and `@path` inlines a file. Inline spans and `@` refs are skipped
 * inside plain fenced code blocks. A failed command rejects, aborting the
 * invocation, per the skills docs.
 *
 * Every placeholder is located in the ORIGINAL body and the whole body is expanded
 * in one pass, so a command's output (or a file's content) is inserted verbatim and
 * never re-scanned for further placeholders. Re-scanning was both a parity break
 * (Claude expands once) and a command-injection path: output of a `` ```! `` block
 * such as a commit message could smuggle its own `` !`cmd` `` for a later pass. */
export async function expandDynamicContent(body: string, cwd: string, exec: CommandExec): Promise<string> {
  const blocks = fenceBlocks(body)
  const protectedRanges = blocks.filter((block) => !block.exec).map((block): [number, number] => [block.start, block.end])
  const execRanges = blocks.filter((block) => block.exec).map((block): [number, number] => [block.start, block.end])
  // An inline span or @ ref inside a ```! block is part of that block's script, not a
  // placeholder of its own; the block already covers those bytes.
  const literal = (index: number): boolean => inRanges(protectedRanges, index) || inRanges(execRanges, index)

  const spans: DynamicSpan[] = []
  for (const block of blocks) {
    if (block.exec) spans.push({ start: block.start, end: block.end, run: () => runSpan(exec, block.content, '```!') })
  }
  // `!` counts only at the start of a line or after whitespace; `KEY=!`cmd`` is literal.
  const bashPattern = /(^|\s)!`([^`]+)`/g
  for (let m = bashPattern.exec(body); m !== null; m = bashPattern.exec(body)) {
    if (literal(m.index)) continue
    const [span, lead, command] = m
    spans.push({ start: m.index, end: m.index + span.length, run: async () => lead + (await runSpan(exec, command, `!\`${command}\``)) })
  }
  const atPattern = /(^|\s)@(\S+)/g
  for (let m = atPattern.exec(body); m !== null; m = atPattern.exec(body)) {
    if (literal(m.index)) continue
    const [whole, lead, reference] = m
    spans.push({
      start: m.index,
      end: m.index + whole.length,
      run: async () => {
        const content = readReference(cwd, reference)
        return content === undefined ? whole : `${lead}\n<file path="${reference}">\n${content.trimEnd()}\n</file>\n`
      },
    })
  }

  spans.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue // a rare @/inline overlap: keep the first, skip the nested
    out += body.slice(cursor, span.start) + (await span.run())
    cursor = span.end
  }
  return out + body.slice(cursor)
}
