/**
 * Claude holds idle_prompt while "a background agent, such as a background subagent, is
 * still running". The subagent extension owns the background-run registry and registers
 * its live-run count here; the hooks extension reads it before firing the notification.
 * Same reader-slot pattern as add-dir-flag.
 */

import { sharedSlot } from './shared-slot.ts'

const counterSlot = sharedSlot<() => number>('background-agent-counter')

/** Registered by the subagent extension; pass undefined to clear it. */
export function setBackgroundAgentCounter(count: (() => number) | undefined): void {
  counterSlot.set(count)
}

/** Background agents still running; 0 when no subagent extension is loaded. */
export function runningBackgroundAgents(): number {
  return counterSlot.get()?.() ?? 0
}
