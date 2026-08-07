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
 * with pi's `edit` tool active. A leading `-` is stripped so a YAML block list parses
 * as the same list.
 */
function toolEntries(raw: string): string[] {
  return (raw.match(/[^,()]+(?:\([^)]*\))?/g) ?? []).map((entry) => entry.trim().replace(/^-\s*/, '')).filter(Boolean)
}

function field(frontmatter: string, key: string): string {
  // Horizontal whitespace only: `\s` spans newlines, so a key with no value on its
  // own line used to take the following line as its value.
  const match = new RegExp(String.raw`^\s*${key}[^\S\r\n]*:[^\S\r\n]*(.+)$`, 'm').exec(frontmatter)
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
}

/** `allowed-tools` may be inline (`Bash, Read`) or a YAML block list beneath the key. */
function toolsField(frontmatter: string): string {
  const inline = field(frontmatter, 'allowed-tools')
  if (inline) return inline
  const block = /^\s*allowed-tools[^\S\r\n]*:[^\S\r\n]*\r?\n((?:[^\S\r\n]+-[^\r\n]*\r?\n?)+)/m.exec(frontmatter)
  return block ? block[1].replace(/\r?\n/g, ',') : ''
}

export function parseCommandFile(content: string): ParsedCommand {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const frontmatter = match ? match[1] : ''
  const body = (match ? content.slice(match[0].length) : content).trim()
  const tools = toolsField(frontmatter)
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  return {
    description: field(frontmatter, 'description') || firstLine.slice(0, 60),
    argumentHint: field(frontmatter, 'argument-hint') || undefined,
    // Several scoped grants collapse to one tool name; pi would otherwise be handed
    // the same tool twice.
    allowedTools: tools ? [...new Set(toolEntries(tools).map(normalizeToolName).filter(Boolean))] : undefined,
    model: field(frontmatter, 'model') || undefined,
    disableModelInvocation: field(frontmatter, 'disable-model-invocation') === 'true',
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

/** Claude's substitutions: `$ARGUMENTS`, `$@`, `$1`..`$n`, `${n:-default}`. An
 * unfilled positional becomes empty rather than leaking its literal token. */
export function substituteArgs(body: string, args: string): string {
  const parts = splitArgs(args)
  return body
    .replaceAll(/\$\{(\d+):-([^}]*)\}/g, (_m, index: string, fallback: string) => parts[Number(index) - 1] ?? fallback)
    .replaceAll(/\$\{ARGUMENTS:-([^}]*)\}/g, (_m, fallback: string) => (args.trim() ? args.trim() : fallback))
    .replaceAll(/\$ARGUMENTS\b/g, args.trim())
    .replaceAll('$@', args.trim())
    .replaceAll(/\$(\d+)/g, (_m, index: string) => parts[Number(index) - 1] ?? '')
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

  let expanded = body
  for (const entry of commands) {
    const result = await exec(entry.command)
    const output = result.code === 0 ? result.stdout.trimEnd() : `(command failed: ${entry.command})\n${result.stderr.trim() || result.stdout.trim()}`
    expanded = expanded.replace(entry.span, output)
  }

  // Ranges are recomputed: command output can change offsets.
  const fencedAfter = fencedRanges(expanded)
  return expanded.replaceAll(/(^|\s)@(\S+)/g, (whole, lead: string, reference: string, offset: number) => {
    if (inRanges(fencedAfter, offset)) return whole
    const content = readReference(cwd, reference)
    if (content === undefined) return whole
    return `${lead}\n<file path="${reference}">\n${content.trimEnd()}\n</file>\n`
  })
}
