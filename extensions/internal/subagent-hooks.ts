/**
 * Pre-spawn seam for Claude's SubagentStart hooks. The hooks extension registers
 * the runner; the subagent extension calls it before spawning a child, so the
 * hooks' additionalContext can be injected before the child's first prompt,
 * which the after-the-fact bus event structurally cannot do. Same module-seam
 * pattern as mcp-call.
 */

import { sharedSlot } from './shared-slot.js'

export type SubagentStartHookRunner = (agentType: string, agentId: string) => Promise<string[]>

const slot = sharedSlot<SubagentStartHookRunner>('subagent-start-hook-runner')

export function setSubagentStartHookRunner(fn: SubagentStartHookRunner | undefined): void {
  slot.set(fn)
}

/** Context strings SubagentStart hooks contribute; empty when no runner is
 * registered or the runner fails (hooks must never block a spawn). */
export async function runSubagentStartHooks(agentType: string, agentId: string): Promise<string[]> {
  const runner = slot.get()
  if (!runner) return []
  try {
    return await runner(agentType, agentId)
  } catch {
    return []
  }
}
