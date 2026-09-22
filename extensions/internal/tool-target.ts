/**
 * Which file a tool call touched.
 *
 * pi's read, edit and write tools accept `file_path` as an alias for `path`, so every
 * reader of a file tool's target must accept both, and a handler reading only `path`
 * does nothing for a model that used the alias. This is the one reader (claude-rules,
 * context-imports and the command path-scope guard all go through it).
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The tools that name a file pi-code acts on. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write'])

/** The spaces pi folds to a plain one before resolving (pi dist/utils/paths). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** `target` as pi's file tools read it before resolving against cwd: a leading @ (which
 * some models add) stripped, ~ expanded, a file:// URL decoded, unicode spaces folded.
 * pi does this in resolveToCwd (dist/core/tools/path-utils), which the package does not
 * export. A reader that skips it judges a different file than the one pi opens: a
 * command scoped to `Read(*.md)` allowed `~/secret/notes.md`, read as <cwd>/~/secret.
 * Exported for the hook `if` filter, which judges the same paths against the same rules
 * but reaches them through tool names this module's FILE_TOOLS set does not cover. */
export function asPiReadsIt(target: string): string {
  const folded = target.replace(UNICODE_SPACES, ' ')
  const bare = folded.startsWith('@') ? folded.slice(1) : folded
  if (bare === '~') return os.homedir()
  if (bare.startsWith('~/') || (process.platform === 'win32' && bare.startsWith('~\\'))) return path.join(os.homedir(), bare.slice(2))
  if (!bare.startsWith('file://')) return bare
  try {
    return fileURLToPath(bare)
  } catch {
    return bare
  }
}

/** The path a file tool call named, or undefined for any other tool, an errored call,
 * or a call that named none. Normalised as pi normalises it, and still relative when
 * the model gave a relative path: callers resolve it against their own cwd. */
export function fileToolTarget(event: { toolName: string; input?: unknown; isError?: boolean }): string | undefined {
  if (event.isError === true) return undefined
  if (!FILE_TOOLS.has(event.toolName)) return undefined
  const input = event.input as { path?: unknown; file_path?: unknown } | undefined
  const target = typeof input?.path === 'string' ? input.path : input?.file_path
  return typeof target === 'string' && target.length > 0 ? asPiReadsIt(target) : undefined
}
