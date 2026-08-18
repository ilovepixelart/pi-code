/**
 * A cheap freshness token for a file: its mtime and size joined, so a same-mtime rewrite
 * of a different length still invalidates. The per-turn caches that stat a file instead of
 * re-reading it (the CLAUDE.md import memo, the memory index cache) compare this token.
 * Throws when the file cannot be stat'd; callers that treat "missing" as a value catch it.
 */

import * as fs from 'node:fs'

/** `${mtimeMs}:${size}` for `file`. Throws if the file cannot be stat'd. */
export function statToken(file: string): string {
  const stat = fs.statSync(file)
  return `${stat.mtimeMs}:${stat.size}`
}
