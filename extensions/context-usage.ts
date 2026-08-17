/**
 * Context Usage Command
 *
 * Claude Code's `/context` reports how much of the model's context window the
 * current session occupies. This registers a `context` command that reads pi's
 * live ContextUsage and renders a concise breakdown through notify. pi exposes
 * three fields (tokens, contextWindow, percent); the used/window/free lines and
 * the percentage are built from exactly those, with the model's window as a
 * fallback when the usage snapshot does not carry one.
 */

import type { ContextUsage, ExtensionAPI } from '@earendil-works/pi-coding-agent'

const fmt = (n: number): string => n.toLocaleString('en-US')

/** The breakdown text for a usage snapshot, or a friendly line when there is none.
 * `tokens` is null right after a compaction (before the next response recounts), so
 * that case reports a recalculating state instead of a bogus zero. */
export function formatContextUsage(usage: ContextUsage | undefined, modelWindow?: number): string {
  if (!usage) {
    return 'Context usage is not available yet. It appears once the model has responded (and resets right after a compaction).'
  }
  const window = usage.contextWindow || modelWindow || 0
  if (usage.tokens === null) {
    const tail = window > 0 ? ` Window: ${fmt(window)} tokens.` : ''
    return `Context usage: recalculating the token count (e.g. right after a compaction).${tail}`
  }
  const tokens = usage.tokens
  const percent = usage.percent ?? (window > 0 ? (tokens / window) * 100 : null)
  const lines = ['Context usage', `  Used:   ${fmt(tokens)} tokens${percent === null ? '' : ` (${percent.toFixed(1)}%)`}`]
  if (window > 0) {
    lines.push(`  Window: ${fmt(window)} tokens`)
    lines.push(`  Free:   ${fmt(Math.max(window - tokens, 0))} tokens`)
  }
  return lines.join('\n')
}

export default function contextUsageExtension(pi: ExtensionAPI) {
  pi.registerCommand('context', {
    description: 'Show how much of the model context window this session is using',
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatContextUsage(ctx.getContextUsage(), ctx.model?.contextWindow), 'info')
    },
  })
}
