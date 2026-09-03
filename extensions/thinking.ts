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
import { createTurnOverride } from './internal/turn-override.js'

// The pi ThinkingLevel union, taken from the setter's parameter so it tracks the SDK.
type ThinkingLevel = Parameters<ExtensionAPI['setThinkingLevel']>[0]

/** Lowest to highest, matching pi's ThinkingLevel union; rank is the index. */
const THINKING_ORDER: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function thinkingRank(level: ThinkingLevel): number {
  const i = THINKING_ORDER.indexOf(level)
  return Math.max(i, 0)
}

/** The reasoning level a prompt requests, or undefined when it names none.
 *
 * `ultrathink` is the only keyword, per Claude: "Include `ultrathink` anywhere in your
 * prompt to request deeper reasoning on that turn ... Claude Code passes other phrases
 * such as 'think', 'think hard', and 'think more' through as ordinary prompt text and
 * doesn't recognize them as keywords." Escalating on those surprised anyone who merely
 * used the word in a sentence. Matched on a word boundary so `rethink` and `thinking`
 * never trip it.
 *
 * Divergence: Claude adds an in-context instruction and leaves the API effort level
 * unchanged. pi has no separate in-context channel for this, and its thinking level IS
 * how deeper reasoning is requested, so the keyword raises the level for the turn and
 * restores it after. Same intent, the only mechanism pi has. */
export function requestedThinkingLevel(text: string): ThinkingLevel | undefined {
  return /\bultrathink\b/i.test(text) ? 'max' : undefined
}

export default function thinkingExtension(pi: ExtensionAPI) {
  // A per-turn escalation: the level to restore, captured the first time a turn escalates
  // so back-to-back keywords still restore the original, and the target this extension
  // moved to. The restore is conditional on the level still being that target at settle:
  // commands.ts also restores an `effort:` override on agent_settled, so both fire on the
  // same event. Keying the restore on the target makes the outcome order-independent: if a
  // command's restore (or a manual change) already moved the level, thinking stands down
  // instead of clobbering it. The capture clears on agent_settled, the run's true end past
  // any retry/compaction/Stop continuation, the same clearing point commands.ts uses.
  const override = createTurnOverride<ThinkingLevel>({
    set: (level) => pi.setThinkingLevel?.(level),
    get: () => pi.getThinkingLevel?.(),
    conditional: true,
  })

  pi.on('session_start', () => {
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while an escalation is still pending (its agent_settled never came),
    // and that stale restore must be dropped rather than fired into the next session, whose
    // level the new session owns. Drop only: do NOT setThinkingLevel here.
    override.reset()
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
    const armedPrior = override.prior
    if (armedPrior !== undefined && (pi.getThinkingLevel?.() ?? ctx.thinkingLevel) === override.target) {
      pi.setThinkingLevel?.(armedPrior)
      override.reset()
    }
    const target = requestedThinkingLevel(event.text)
    if (!target) return
    const current = pi.getThinkingLevel?.() ?? ctx.thinkingLevel ?? 'off'
    // A keyword only raises reasoning: leave a level already at or above the target.
    if (thinkingRank(current) >= thinkingRank(target)) return
    override.arm(current, target)
    pi.setThinkingLevel?.(target)
    // Return nothing so the input is neither consumed nor transformed: Claude keeps
    // the keyword in the prompt.
  })

  pi.on('agent_settled', () => {
    // Restore the pre-escalation level, but only if nothing else moved it since (a
    // command's effort restore, a manual change): the conditional override stands down in
    // that case and restores unconditionally when the level cannot be read, the prior
    // best-effort behavior.
    override.settle()
  })
}
