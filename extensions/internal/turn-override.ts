/**
 * A per-turn value override: capture the prior value once, restore it when the turn
 * settles. This is the shape shared by commands.ts's `model:`/`effort:` overrides and
 * thinking.ts's keyword escalation. Each captures what to restore the first time a turn
 * overrides (so back-to-back overrides in one turn still restore the original session
 * value, not an intermediate one), drops that capture without restoring at a session
 * boundary, and restores on settle.
 *
 * A conditional override restores only when the current value still equals the target it
 * moved to, so a later owner (another extension's restore, a manual change) is not
 * clobbered; a current that cannot be read restores unconditionally, the best-effort the
 * consumers relied on. The escalating set itself stays at the call site, since who reads
 * "current" and how the value is applied (sync, async-with-catch) differ per consumer.
 */

export interface TurnOverride<T> {
  /** The value to restore, captured only on the first arm of a turn; undefined when
   * nothing is armed. */
  readonly prior: T | undefined
  /** The value last armed as the move target, for a conditional restore. */
  readonly target: T | undefined
  /** Record the value to restore (kept only the first time per turn) and, optionally, the
   * value moved to for a conditional restore. Does not apply the override. */
  arm(prior: T, target?: T): void
  /** Drop the pending capture without restoring: a session boundary. */
  reset(): void
  /** Restore the captured prior via `set` and clear the capture. A conditional override
   * stands down when the current value has moved off the target. No-op when nothing is
   * armed. */
  settle(): void
}

export function createTurnOverride<T>(opts: {
  /** Applies the restore value. Consumers wrap their setter here (async-with-catch for
   * commands' model, plain for the thinking level). */
  set: (value: T) => void
  /** Reads the current value, for a conditional restore. Only consulted when
   * `conditional` is set. */
  get?: () => T | undefined
  /** When set, restore only if the current value still equals the armed target. */
  conditional?: boolean
}): TurnOverride<T> {
  let prior: T | undefined
  let target: T | undefined
  return {
    get prior() {
      return prior
    },
    get target() {
      return target
    },
    arm(priorValue, targetValue) {
      prior = prior ?? priorValue
      target = targetValue
    },
    reset() {
      prior = undefined
      target = undefined
    },
    settle() {
      if (prior === undefined) return
      const restore = prior
      const movedTo = target
      prior = undefined
      target = undefined
      if (opts.conditional) {
        const current = opts.get?.()
        if (current !== undefined && current !== movedTo) return
      }
      opts.set(restore)
    },
  }
}
