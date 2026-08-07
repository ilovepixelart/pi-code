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

/** Claude tool names are PascalCase; pi's are lowercase. */
function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}

function field(frontmatter: string, key: string): string {
  const match = new RegExp(String.raw`^\s*${key}\s*:\s*(.+)$`, 'm').exec(frontmatter)
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
}

export function parseCommandFile(content: string): ParsedCommand {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const frontmatter = match ? match[1] : ''
  const body = (match ? content.slice(match[0].length) : content).trim()
  const tools = field(frontmatter, 'allowed-tools')
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  return {
    description: field(frontmatter, 'description') || firstLine.slice(0, 60),
    argumentHint: field(frontmatter, 'argument-hint') || undefined,
    allowedTools: tools ? tools.split(',').map(normalizeToolName).filter(Boolean) : undefined,
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
    .replace(/\$\{(\d+):-([^}]*)\}/g, (_m, index: string, fallback: string) => parts[Number(index) - 1] ?? fallback)
    .replace(/\$\{ARGUMENTS:-([^}]*)\}/g, (_m, fallback: string) => (args.trim() ? args.trim() : fallback))
    .replace(/\$ARGUMENTS\b/g, args.trim())
    .replace(/\$@/g, args.trim())
    .replace(/\$(\d+)/g, (_m, index: string) => parts[Number(index) - 1] ?? '')
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
  const resolved = path.resolve(cwd, reference)
  const root = path.resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined
  try {
    if (!fs.statSync(resolved).isFile()) return undefined
    return fs.readFileSync(resolved, 'utf-8')
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
  return expanded.replace(/(^|\s)@(\S+)/g, (whole, lead: string, reference: string, offset: number) => {
    if (inRanges(fencedAfter, offset)) return whole
    const content = readReference(cwd, reference)
    if (content === undefined) return whole
    return `${lead}\n<file path="${reference}">\n${content.trimEnd()}\n</file>\n`
  })
}
