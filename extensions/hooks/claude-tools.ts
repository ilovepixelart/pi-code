/**
 * Claude-vocabulary translation for hook payloads on pi's built-in tools.
 *
 * Claude-written hook scripts branch on documented names ("Bash", "Edit") and read
 * documented input shapes (`tool_input.file_path`); pi's tools carry their own
 * names (`bash`, `edit`) and shapes (`path`, `edits[]`). Payloads report the
 * Claude form, exactly as MCP aliases and user_bash already do, and the decision
 * outputs that reference input/output shapes (`updatedInput`, `updatedToolOutput`)
 * are translated back. Mappings against pi's schemas in
 * node_modules/@earendil-works/pi-coding-agent/dist/core/tools and Claude's hooks
 * reference (per-tool input tables, PostToolUse response shapes).
 *
 * Translation choices the shapes force, each documented on its function:
 * - pi's multi-entry `edits[]` maps to Claude's single Edit with the first entry in
 *   `old_string`/`new_string` and the full array carried alongside as `edits`.
 * - Bash `timeout` converts between pi's seconds and Claude's milliseconds.
 * - pi's bash output is one combined stream, so the Bash response reports it all as
 *   `stdout` with an empty `stderr`.
 */

import * as os from 'node:os'
import * as path from 'node:path'

/** pi built-in -> Claude tool name for hook payloads and matchers. MCP tools ride
 * the alias bus instead; pi tools with no Claude counterpart (ls) stay untranslated. */
const CLAUDE_NAMES: Record<string, string> = { bash: 'Bash', edit: 'Edit', write: 'Write', read: 'Read', grep: 'Grep', find: 'Glob' }

export function claudeToolName(piName: string): string | undefined {
  return CLAUDE_NAMES[piName]
}

/** Claude file-tool paths are always absolute with `~` expanded before hooks run,
 * so a path guard cannot be bypassed by a relative or `~` spelling of the same path. */
function absolutePath(value: unknown, cwd: string): unknown {
  if (typeof value !== 'string' || value.length === 0) return value
  const expanded = value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
  return path.resolve(cwd, expanded)
}

const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)

/** Only the entries whose value passes the filter, so optional fields stay absent
 * rather than arriving as explicit undefined. */
function pick(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined))
}

type InputMapper = (raw: Record<string, unknown>, cwd: string) => Record<string, unknown>

const TO_CLAUDE_INPUT: Record<string, InputMapper> = {
  // pi timeout is seconds, Claude's is milliseconds.
  bash: (raw) => pick({ command: raw.command, timeout: typeof raw.timeout === 'number' ? raw.timeout * 1000 : undefined }),
  write: (raw, cwd) => ({ file_path: absolutePath(raw.path, cwd), content: raw.content }),
  read: (raw, cwd) => pick({ file_path: absolutePath(raw.path, cwd), offset: raw.offset, limit: raw.limit }),
  // Claude's Edit is a single replacement; pi's edit call carries one or more. The
  // documented fields expose the first entry, and the full array rides along as
  // `edits` so a hook auditing the whole call loses nothing.
  edit: (raw, cwd) => {
    const edits = Array.isArray(raw.edits) ? raw.edits : []
    const first = record(edits[0]) ?? {}
    return { file_path: absolutePath(raw.path, cwd), old_string: first.oldText ?? '', new_string: first.newText ?? '', replace_all: false, ...(edits.length > 1 ? { edits } : {}) }
  },
  grep: (raw, cwd) => pick({ pattern: raw.pattern, path: raw.path === undefined ? undefined : absolutePath(raw.path, cwd), glob: raw.glob, '-i': raw.ignoreCase === true ? true : undefined }),
  find: (raw, cwd) => pick({ pattern: raw.pattern, path: raw.path === undefined ? undefined : absolutePath(raw.path, cwd) }),
}

/** pi input -> Claude `tool_input` for the translated built-ins; undefined keeps the
 * pi shape (MCP and unknown tools). */
export function claudeToolInput(piName: string, input: unknown, cwd: string): Record<string, unknown> | undefined {
  const raw = record(input)
  if (!raw) return undefined
  return TO_CLAUDE_INPUT[piName]?.(raw, cwd)
}

type RewriteMapper = (updated: Record<string, unknown>) => Record<string, unknown> | undefined

const FROM_CLAUDE_INPUT: Record<string, RewriteMapper> = {
  bash: (updated) => (typeof updated.command === 'string' ? pick({ command: updated.command, timeout: typeof updated.timeout === 'number' ? updated.timeout / 1000 : undefined }) : undefined),
  write: (updated) => (typeof updated.file_path === 'string' && typeof updated.content === 'string' ? { path: updated.file_path, content: updated.content } : undefined),
  read: (updated) => (typeof updated.file_path === 'string' ? pick({ path: updated.file_path, offset: updated.offset, limit: updated.limit }) : undefined),
  edit: (updated) => {
    if (typeof updated.file_path !== 'string') return undefined
    if (Array.isArray(updated.edits)) return { path: updated.file_path, edits: updated.edits }
    if (typeof updated.old_string !== 'string' || typeof updated.new_string !== 'string') return undefined
    return { path: updated.file_path, edits: [{ oldText: updated.old_string, newText: updated.new_string }] }
  },
  grep: (updated) => (typeof updated.pattern === 'string' ? pick({ pattern: updated.pattern, path: updated.path, glob: updated.glob, ignoreCase: updated['-i'] === true ? true : undefined }) : undefined),
  find: (updated) => (typeof updated.pattern === 'string' ? pick({ pattern: updated.pattern, path: updated.path }) : undefined),
}

/** Claude-shaped `updatedInput` back into pi's input shape for a translated tool.
 * Returns undefined when the rewrite is missing the tool's required fields, so the
 * caller keeps the ORIGINAL input rather than handing pi a corrupted one; for an
 * untranslated tool the caller applies the rewrite verbatim. Claude's Edit
 * `replace_all` has no pi counterpart (pi requires a unique oldText) and is dropped. */
export function piToolInput(piName: string, updated: Record<string, unknown>): Record<string, unknown> | undefined {
  return FROM_CLAUDE_INPUT[piName]?.(updated)
}

/** pi result -> Claude `tool_response` where the docs pin a shape: Bash's structured
 * object (pi's single combined stream reported as stdout) and Write's
 * `{filePath, success}`. Other tools keep pi's `{content, details, isError}`. */
export function claudeToolResponse(piName: string, input: unknown, text: string, isError: boolean, cwd: string): Record<string, unknown> | undefined {
  const raw = record(input)
  switch (piName) {
    case 'bash':
      return { stdout: text, stderr: '', interrupted: false, isImage: false }
    case 'write':
      return { filePath: absolutePath(raw?.path, cwd), success: !isError }
    default:
      return undefined
  }
}

/** A hook's `updatedToolOutput` back into pi text content. Claude validates built-in
 * replacements against the tool's output schema and ignores mismatches (returns
 * undefined here, keeping the original); MCP output passes through unvalidated. */
export function piToolOutput(piName: string, value: unknown, isMcp: boolean): string | undefined {
  if (isMcp) {
    if (typeof value === 'string') return value
    return value === undefined ? undefined : JSON.stringify(value)
  }
  if (piName === 'bash') {
    const raw = record(value)
    if (!raw || typeof raw.stdout !== 'string') return undefined
    const stderr = typeof raw.stderr === 'string' && raw.stderr.length > 0 ? `\n${raw.stderr}` : ''
    return `${raw.stdout}${stderr}`
  }
  // pi's other tool outputs are text content, so a string replacement is
  // shape-valid; a structured value has no pi counterpart and is ignored.
  return typeof value === 'string' ? value : undefined
}
