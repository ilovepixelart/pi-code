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

export interface ParsedCommand {
  description: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation: boolean
  body: string
}

export interface DiscoveredCommand {
  /** Claude's namespaced name: a nested file is `dir:name`. */
  name: string
  filePath: string
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
}

/**
 * Claude scopes a grant to arguments: `Bash(git add:*)` allows exactly those commands.
 * pi's active-tool list is per tool, with no argument dimension, so the scope is
 * dropped and the base tool is granted. Keeping the scope in the name matched nothing
 * when the list was intersected with the active tools, which left a command declaring
 * only scoped grants running with no tools at all.
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

/**
 * A tool grant is either a comma-separated string or a YAML list, and the two mean the
 * same thing. An empty list is not the same as an absent one: it says no tools, so it
 * comes back as an empty array rather than undefined.
 */
export function parseToolList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  let items: unknown[]
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'string') items = toolEntries(raw)
  else return undefined
  if (items.some((item) => typeof item !== 'string')) return undefined
  return [...new Set((items as string[]).map(normalizeToolName).filter(Boolean))]
}

/** YAML types a bare scalar, so a model named `3.5` arrives as a number, not a string. */
const text = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

/** Claude writes `argument-hint: [pr]`, which YAML reads as a list; render it back. */
const hint = (value: unknown): string => (Array.isArray(value) ? `[${value.join(', ')}]` : text(value))

export function parseCommandFile(content: string): ParsedCommand {
  // pi's own parser, rather than a hand-rolled one: it reads the YAML shapes Claude
  // command files actually use (flow sequences, block lists, quoted and multi-line
  // values), and a value this misreads is a restriction silently not applied.
  const { frontmatter, body: raw } = parseFrontmatter(content)
  const body = raw.trim()
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  const disable = frontmatter['disable-model-invocation']
  return {
    description: text(frontmatter.description) || firstLine.slice(0, 60),
    argumentHint: hint(frontmatter['argument-hint']) || undefined,
    allowedTools: parseToolList(frontmatter['allowed-tools']),
    model: text(frontmatter.model) || undefined,
    disableModelInvocation: disable === true || text(disable) === 'true',
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

/** Claude's substitutions: `$ARGUMENTS`, `$@`, `$1`..`$n`, `${n:-default}`, and `\$`
 * for a literal dollar. An unfilled positional becomes empty rather than leaking its
 * literal token. One pass with a replacer function: sequential string passes both
 * interpreted `$&`-style metacharacters in the arguments and re-scanned substituted
 * text, so `$` sequences the user typed were consumed as tokens. */
export function substituteArgs(body: string, args: string): string {
  const parts = splitArgs(args)
  const all = args.trim()
  return body.replaceAll(/\\\$|\$\{(\d+):-([^}]*)\}|\$\{ARGUMENTS:-([^}]*)\}|\$ARGUMENTS\b|\$@|\$(\d+)/g, (token, index?: string, fallback?: string, argsFallback?: string, position?: string) => {
    if (token === '\\$') return '$'
    if (index !== undefined) return parts[Number(index) - 1] ?? fallback ?? ''
    if (argsFallback !== undefined) return all || argsFallback
    if (position !== undefined) return parts[Number(position) - 1] ?? ''
    return all
  })
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

/** Spans of a body that are inside a fenced code block, where Claude's dynamic
 * syntax is literal text rather than an instruction. */
function fencedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /^(```|~~~)[^\n]*$/gm
  let open: number | undefined
  let match = fence.exec(body)
  while (match !== null) {
    if (open === undefined) open = match.index
    else {
      ranges.push([open, match.index + match[0].length])
      open = undefined
    }
    match = fence.exec(body)
  }
  if (open !== undefined) ranges.push([open, body.length])
  return ranges
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

/** Claude's dynamic command content: `` !`cmd` `` runs a shell command and pastes
 * its output, `@path` inlines a file. Both are skipped inside fenced code blocks. */
export async function expandDynamicContent(body: string, cwd: string, exec: CommandExec): Promise<string> {
  const fenced = fencedRanges(body)

  const commands: Array<{ span: string; command: string; index: number }> = []
  const bashPattern = /!`([^`]+)`/g
  let bashMatch = bashPattern.exec(body)
  while (bashMatch !== null) {
    if (!inRanges(fenced, bashMatch.index)) commands.push({ span: bashMatch[0], command: bashMatch[1], index: bashMatch.index })
    bashMatch = bashPattern.exec(body)
  }

  // Splice by recorded position: a textual replace would interpret `$` sequences in
  // the command's output and could hit an identical fenced copy of the span instead.
  let expanded = ''
  let cursor = 0
  for (const entry of commands) {
    const result = await exec(entry.command)
    const output = result.code === 0 ? result.stdout.trimEnd() : `(command failed: ${entry.command})\n${result.stderr.trim() || result.stdout.trim()}`
    expanded += body.slice(cursor, entry.index) + output
    cursor = entry.index + entry.span.length
  }
  expanded += body.slice(cursor)

  // Ranges are recomputed: command output can change offsets.
  const fencedAfter = fencedRanges(expanded)
  return expanded.replaceAll(/(^|\s)@(\S+)/g, (whole, lead: string, reference: string, offset: number) => {
    if (inRanges(fencedAfter, offset)) return whole
    const content = readReference(cwd, reference)
    if (content === undefined) return whole
    return `${lead}\n<file path="${reference}">\n${content.trimEnd()}\n</file>\n`
  })
}
