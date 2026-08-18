/**
 * Thinking Keyword Escalation
 *
 * Claude Code raises reasoning effort for a single turn when the prompt carries a
 * think keyword: `ultrathink` asks for the maximum, `think hard`/`think harder` for
 * a high level, and a bare `think` for a medium one. The word stays in the prompt
 * (the input is observed, never consumed or transformed), the escalation only ever
 * raises the level, and the prior level is restored once the turn settles, mirroring
 * how commands.ts restores a per-command model override on agent_settled.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// The pi ThinkingLevel union, taken from the setter's parameter so it tracks the SDK.
type ThinkingLevel = Parameters<ExtensionAPI['setThinkingLevel']>[0]

/** Lowest to highest, matching pi's ThinkingLevel union; rank is the index. */
const THINKING_ORDER: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function thinkingRank(level: ThinkingLevel): number {
  const i = THINKING_ORDER.indexOf(level)
  return Math.max(i, 0)
}

/** The reasoning level a prompt requests through Claude's think keywords, or undefined
 * when it names none. Checked most-specific first so `think harder` does not fall
 * through to the bare-`think` branch, and on word boundaries so `rethink`/`thinking`
 * and the whole word `ultrathink` never trip the bare match. */
export function requestedThinkingLevel(text: string): ThinkingLevel | undefined {
  if (/\bultrathink\b/i.test(text)) return 'max'
  if (/\bthink harder\b/i.test(text) || /\bthink hard\b/i.test(text)) return 'high'
  if (/\bthink\b/i.test(text)) return 'medium'
  return undefined
}

export default function thinkingExtension(pi: ExtensionAPI) {
  // The level to restore once the escalated turn settles, captured the first time a
  // turn escalates so back-to-back keywords in one turn still restore the original.
  // Cleared on agent_settled, the run's true end past any retry/compaction/Stop
  // continuation, the same clearing point commands.ts uses for its model override.
  let pendingRestore: ThinkingLevel | undefined
  // The level this extension last escalated to. The restore is conditional on the level
  // still being this target at settle: commands.ts also restores an `effort:` override
  // on agent_settled, so both fire on the same event. Keying the restore on the target
  // makes the outcome order-independent: if a command's restore (or a manual change)
  // already moved the level, thinking stands down instead of clobbering it.
  let pendingTarget: ThinkingLevel | undefined

  pi.on('session_start', () => {
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while an escalation is still pending (its agent_settled never came),
    // and that stale restore must be dropped rather than fired into the next session, whose
    // level the new session owns. Drop only: do NOT setThinkingLevel here.
    pendingRestore = undefined
    pendingTarget = undefined
  })

  pi.on('input', (event, ctx) => {
    // Only genuine user input escalates. sendUserMessage emits an input event with
    // source 'extension' (a subagent prompt, a command body replayed through it); a
    // think keyword the user did not type must not escalate, mirroring hooks.ts's guard.
    if (event.source === 'extension') return
    // A prompt that escalated but was then BLOCKED by a hook runs no turn, so no
    // agent_settled ever fires to restore the level. The arrival of a new input is the
    // signal that the prior prompt is gone: if this extension still owns the level (it is
    // exactly our escalation target), restore before handling this input. In the normal
    // path a settle already cleared pending, so this fires only for the blocked case.
    if (pendingRestore !== undefined && (pi.getThinkingLevel?.() ?? ctx.thinkingLevel) === pendingTarget) {
      pi.setThinkingLevel?.(pendingRestore)
      pendingRestore = undefined
      pendingTarget = undefined
    }
    const target = requestedThinkingLevel(event.text)
    if (!target) return
    const current = pi.getThinkingLevel?.() ?? ctx.thinkingLevel ?? 'off'
    // A keyword only raises reasoning: leave a level already at or above the target.
    if (thinkingRank(current) >= thinkingRank(target)) return
    pendingRestore = pendingRestore ?? current
    pendingTarget = target
    pi.setThinkingLevel?.(target)
    // Return nothing so the input is neither consumed nor transformed: Claude keeps
    // the keyword in the prompt.
  })

  pi.on('agent_settled', () => {
    if (pendingRestore === undefined) return
    const restore = pendingRestore
    const target = pendingTarget
    pendingRestore = undefined
    pendingTarget = undefined
    // Restore only if nothing else moved the level since this extension set it. If a
    // command's effort restore or the user's manual change already took over (current
    // no longer equals our target), leave that value in place and stand down. When the
    // level cannot be read, restore unconditionally, the prior best-effort behavior.
    const current = pi.getThinkingLevel?.()
    if (current !== undefined && current !== target) return
    pi.setThinkingLevel?.(restore)
  })
}
