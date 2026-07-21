/**
 * Output Guard
 *
 * pi requires every tool to truncate its output, at 50KB or 2000 lines, whichever is hit
 * first (docs/extensions.md, "Tool output"). Each tool used to decide that for itself, so
 * the budgets and the truncation notices diverged and a byte-only cap let thousands of
 * short lines through. This is the single place that decision lives.
 *
 * `truncateHead` keeps whole lines, which means a single line over the budget yields no
 * content at all. That trap is handled here once rather than at each call site.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from '@earendil-works/pi-coding-agent'

/** Trim `text` to pi's documented tool-output budget, noting what was dropped. */
export function capForContext(text: string): string {
  const cut = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
  if (!cut.truncated) return text
  const kept = cut.content || text.slice(0, DEFAULT_MAX_BYTES)
  const capped = `${kept}\n\n[truncated: ${formatSize(cut.totalBytes)} total, ${cut.totalLines} lines]`
  // Just over the budget, the notice can cost more than the trim saves.
  return capped.length < text.length ? capped : text
}
