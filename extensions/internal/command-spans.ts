/**
 * Running the `!` command spans and `@path` references a command or skill body carries.
 *
 * Split from the parsing half: only commands.ts drives spans, while skills.ts and the
 * subagent loader import parsing alone and have no business pulling a shell resolver in.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { bashBinary } from './shell-resolve.js'
import { splitSegments } from './shell-split.js'
import { type Fence, fenceMarker, stepFence } from './strip-comments.js'
export type CommandExec = (command: string) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>

/** PowerShell single-quote escaping: inside a '...' literal the only special
 * characters are the quote delimiters themselves, written doubled. PowerShell's
 * lexer treats U+2018 through U+201B as single quotes too, so each is doubled the
 * same way; leaving them bare let a projectDir like `Alex’s Projects` end the
 * literal mid-path with a ParserError. sh's '\'' form must not be used here,
 * since PowerShell would keep the backslash and reopen the string. */
export function powershellQuote(value: string): string {
  return value.replaceAll(/['‘’‚‛]/g, '$&$&')
}

export { resolvePowershellBinary } from './shell-resolve.js'

export interface SpanExec {
  command: string
  args: string[]
  /** Set when the shell cannot merge stderr into stdout in-script (pwsh 7 drops a
   * native command's stderr from `& { } 2>&1`), asking the caller to append the
   * exec result's stderr to its stdout instead. The sh path merges in-script and
   * leaves this unset. */
  mergeStreams?: boolean
}

/** The sh invocation for a span: CLAUDE_PROJECT_DIR and CLAUDECODE=1 exported in-script
 * (pi.exec takes no env; CLAUDECODE marks every subprocess Claude spawns), stderr merged
 * with 2>&1. The group opens with a `:` null command: `{ }` around an empty or
 * comment-only span is a hard sh syntax error (exit 2) that aborted the whole
 * invocation, and `:` keeps such a span the harmless no-op it was on HEAD while the
 * group still merges stderr for real spans. */
function shSpan(binary: string, projectDir: string, script: string): SpanExec {
  const quoted = projectDir.replaceAll("'", String.raw`'\''`)
  return { command: binary, args: ['-c', `export CLAUDE_PROJECT_DIR='${quoted}'\nexport CLAUDECODE=1\n{ :\n${script}\n} 2>&1`] }
}

/** The PowerShell invocation for a span. No in-script 2>&1: under pwsh 7 it does not
 * merge a native command's stderr on a script block, so mergeStreams has the caller
 * append it. The trailing exit forwards a failed native command's code, which pwsh
 * -Command otherwise swallows (the process exited 0 and a failure never aborted the
 * invocation). An empty or cmdlet-only span leaves $LASTEXITCODE unset and exits 0.
 * Residual gap vs sh: a failing cmdlet sets no exit code, so it cannot abort; its
 * error text still reaches the model through the merged stderr. */
function powershellSpan(binary: string, projectDir: string, script: string): SpanExec {
  const preamble = `$ErrorActionPreference='Continue'\n$env:CLAUDE_PROJECT_DIR='${powershellQuote(projectDir)}'\n$env:CLAUDECODE='1'`
  return { command: binary, args: ['-NoProfile', '-NonInteractive', '-Command', `${preamble}\n& {\n${script}\n}\nexit $LASTEXITCODE`], mergeStreams: true }
}

/**
 * The exec invocation for one injected span, honoring the `shell:` frontmatter per
 * Claude's shell matrix (skills.md). `powershell` runs through a PowerShell binary when
 * one resolves. Otherwise the span runs through bash: /bin/sh off Windows, Git Bash on
 * Windows. Without Git Bash, a skill that declared `shell: bash` fails before any
 * command runs ("requires bash"), an undeclared one falls to PowerShell, and with
 * neither shell the invocation fails. Both paths export CLAUDE_PROJECT_DIR (each
 * shell's own quoting) and merge stderr into stdout, as the Bash tool does when it
 * runs these for Claude: the sh script in-line with 2>&1, the pwsh path via
 * mergeStreams in the caller.
 *
 * The resolvers are parameters so a caller (or test) controls the lookups: the
 * PowerShell one is passed as an imported binding, the bash one defaults to the
 * platform rule.
 */
export function spanExec(shell: string | undefined, projectDir: string, script: string, resolveBinary: () => string | undefined, resolveBash: () => string | undefined = bashBinary): SpanExec {
  if (shell === 'powershell') {
    const binary = resolveBinary()
    if (binary !== undefined) return powershellSpan(binary, projectDir, script)
  }
  const bash = resolveBash()
  if (bash !== undefined) return shSpan(bash, projectDir, script)
  if (shell === 'bash') throw new Error('shell: bash requires Git Bash, which was not found (install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH)')
  const binary = resolveBinary()
  if (binary !== undefined) return powershellSpan(binary, projectDir, script)
  throw new Error('no shell found for the injected commands: install Git for Windows or PowerShell')
}

interface FenceBlock {
  start: number
  end: number
  /** A fence opened with ```! runs its content as one script; any other fence protects. */
  exec: boolean
  content: string
}

/** Fenced blocks of a body: Claude's dynamic syntax is literal text inside a plain
 * fence, while a ```! fence is itself a placeholder that executes. Fences follow
 * CommonMark: any indentation, closed only by the opener's character in a run at
 * least as long, so a tilde line or a shorter fence inside stays content. */
function fenceBlocks(body: string): FenceBlock[] {
  const blocks: FenceBlock[] = []
  let fence: Fence | null = null
  let open: { index: number; exec: boolean; contentStart: number } | undefined
  let offset = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart()
    const step = stepFence(fence, trimmed, fenceMarker(trimmed))
    const lineEnd = offset + line.length
    if (fence === null && step.fence !== null) {
      // Only the exact, unindented ```! opener executes, as Claude documents it.
      open = { index: offset, exec: line.startsWith('```') && step.fence.length === 3 && trimmed.slice(3).trim() === '!', contentStart: lineEnd + 1 }
    } else if (fence !== null && step.fence === null && open !== undefined) {
      blocks.push({ start: open.index, end: lineEnd, exec: open.exec, content: body.slice(Math.min(open.contentStart, offset), offset).replace(/\n$/, '') })
      open = undefined
    }
    fence = step.fence
    offset = lineEnd + 1
  }
  // An unterminated fence protects to the end of the body rather than executing.
  if (open !== undefined) blocks.push({ start: open.index, end: body.length, exec: false, content: '' })
  return blocks
}

/** Exit 1 is a normal result for Claude's documented search and comparison commands
 * (no matches, files differ); exit 2 and up fails even for these. The PowerShell
 * shell uses a different set, which "includes grep and git diff but not find or
 * diff" (test/[ are bash builtins and do not apply there either). */
const EXIT_ONE_OK = new Set(['grep', 'rg', 'egrep', 'fgrep', 'find', 'diff', 'test', '['])
const EXIT_ONE_OK_POWERSHELL = new Set(['grep', 'rg', 'egrep', 'fgrep'])

export type SpanShell = 'bash' | 'powershell'

const isCarveoutSegment = (segment: string, shell: SpanShell): boolean => {
  const words = segment.trim().split(/\s+/)
  if (words[0] === 'git') return words[1] === 'diff' || words[1] === 'grep'
  return (shell === 'powershell' ? EXIT_ONE_OK_POWERSHELL : EXIT_ONE_OK).has(words[0])
}

export function benignExitOne(command: string, shell: SpanShell = 'bash'): boolean {
  const segments = splitSegments(command)
  if (segments.length === 0) return false
  // A `&&`/`||` chain can short-circuit, so an earlier segment's exit 1 becomes the
  // result and the last segment is not the one that set the code: `cd nope && grep x`
  // exits 1 from cd, not a benign grep miss. Only when every segment is a carveout is
  // the exit benign whichever ran last. Without short-circuit operators the exit is
  // the last segment's (a `|` pipeline exits with its final command, `;`/newline with
  // the last statement), so the last segment decides.
  if (/&&|\|\|/.test(command)) return segments.every((segment) => isCarveoutSegment(segment, shell))
  return isCarveoutSegment(segments.at(-1) ?? '', shell)
}

/** Run one injected span. A failure aborts the whole invocation, as Claude
 * documents: the model never sees a half-expanded body. */
async function runSpan(exec: CommandExec, command: string, pattern: string, shell: SpanShell): Promise<string> {
  const result = await exec(command)
  // A timeout kill arrives as killed:true with code 0 (a signal death has no exit code),
  // so the code alone would paste the partial output as a success. Claude kills a span
  // at the Bash timeout and that failure aborts the invocation.
  if (result.killed) throw new Error(`Shell command timed out for pattern "${pattern}"`)
  if (result.code !== 0 && !(result.code === 1 && benignExitOne(command, shell))) {
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
export async function expandDynamicContent(body: string, cwd: string, exec: CommandExec, shell: SpanShell = 'bash'): Promise<string> {
  const blocks = fenceBlocks(body)
  const protectedRanges = blocks.filter((block) => !block.exec).map((block): [number, number] => [block.start, block.end])
  const execRanges = blocks.filter((block) => block.exec).map((block): [number, number] => [block.start, block.end])
  // An inline span or @ ref inside a ```! block is part of that block's script, not a
  // placeholder of its own; the block already covers those bytes.
  const literal = (index: number): boolean => inRanges(protectedRanges, index) || inRanges(execRanges, index)

  const spans: DynamicSpan[] = []
  for (const block of blocks) {
    if (block.exec) spans.push({ start: block.start, end: block.end, run: () => runSpan(exec, block.content, '```!', shell) })
  }
  // `!` counts only at the start of a line or after whitespace; `KEY=!`cmd`` is literal.
  const bashPattern = /(^|\s)!`([^`]+)`/g
  for (let m = bashPattern.exec(body); m !== null; m = bashPattern.exec(body)) {
    if (literal(m.index)) continue
    const [span, lead, command] = m
    spans.push({ start: m.index, end: m.index + span.length, run: async () => lead + (await runSpan(exec, command, `!\`${command}\``, shell)) })
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
