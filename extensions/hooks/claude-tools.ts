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

/** pi input -> Claude `tool_input` for the translated built-ins; undefined keeps the
 * pi shape (MCP and unknown tools). */
export function claudeToolInput(piName: string, input: unknown, cwd: string): Record<string, unknown> | undefined {
  const raw = record(input)
  if (!raw) return undefined
  switch (piName) {
    case 'bash':
      // pi timeout is seconds, Claude's is milliseconds.
      return { command: raw.command, ...(typeof raw.timeout === 'number' ? { timeout: raw.timeout * 1000 } : {}) }
    case 'write':
      return { file_path: absolutePath(raw.path, cwd), content: raw.content }
    case 'read':
      return { file_path: absolutePath(raw.path, cwd), ...(raw.offset !== undefined ? { offset: raw.offset } : {}), ...(raw.limit !== undefined ? { limit: raw.limit } : {}) }
    case 'edit': {
      // Claude's Edit is a single replacement; pi's edit call carries one or more.
      // The documented fields expose the first entry, and the full array rides along
      // as `edits` so a hook auditing the whole call loses nothing.
      const edits = Array.isArray(raw.edits) ? raw.edits : []
      const first = record(edits[0]) ?? {}
      return { file_path: absolutePath(raw.path, cwd), old_string: first.oldText ?? '', new_string: first.newText ?? '', replace_all: false, ...(edits.length > 1 ? { edits } : {}) }
    }
    case 'grep':
      return { pattern: raw.pattern, ...(raw.path !== undefined ? { path: absolutePath(raw.path, cwd) } : {}), ...(raw.glob !== undefined ? { glob: raw.glob } : {}), ...(raw.ignoreCase === true ? { '-i': true } : {}) }
    case 'find':
      return { pattern: raw.pattern, ...(raw.path !== undefined ? { path: absolutePath(raw.path, cwd) } : {}) }
    default:
      return undefined
  }
}

/** Claude-shaped `updatedInput` back into pi's input shape for a translated tool.
 * Returns undefined when the rewrite is missing the tool's required fields, so the
 * caller keeps the ORIGINAL input rather than handing pi a corrupted one; for an
 * untranslated tool the caller applies the rewrite verbatim. Claude's Edit
 * `replace_all` has no pi counterpart (pi requires a unique oldText) and is dropped. */
export function piToolInput(piName: string, updated: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (piName) {
    case 'bash':
      if (typeof updated.command !== 'string') return undefined
      return { command: updated.command, ...(typeof updated.timeout === 'number' ? { timeout: updated.timeout / 1000 } : {}) }
    case 'write':
      if (typeof updated.file_path !== 'string' || typeof updated.content !== 'string') return undefined
      return { path: updated.file_path, content: updated.content }
    case 'read':
      if (typeof updated.file_path !== 'string') return undefined
      return { path: updated.file_path, ...(updated.offset !== undefined ? { offset: updated.offset } : {}), ...(updated.limit !== undefined ? { limit: updated.limit } : {}) }
    case 'edit': {
      if (typeof updated.file_path !== 'string') return undefined
      if (Array.isArray(updated.edits)) return { path: updated.file_path, edits: updated.edits }
      if (typeof updated.old_string !== 'string' || typeof updated.new_string !== 'string') return undefined
      return { path: updated.file_path, edits: [{ oldText: updated.old_string, newText: updated.new_string }] }
    }
    case 'grep':
      if (typeof updated.pattern !== 'string') return undefined
      return { pattern: updated.pattern, ...(updated.path !== undefined ? { path: updated.path } : {}), ...(updated.glob !== undefined ? { glob: updated.glob } : {}), ...(updated['-i'] === true ? { ignoreCase: true } : {}) }
    case 'find':
      if (typeof updated.pattern !== 'string') return undefined
      return { pattern: updated.pattern, ...(updated.path !== undefined ? { path: updated.path } : {}) }
    default:
      return undefined
  }
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
