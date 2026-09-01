/**
 * Pre-spawn seam for Claude's SubagentStart hooks. The hooks extension registers
 * the runner; the subagent extension calls it before spawning a child, so the
 * hooks' additionalContext can be injected before the child's first prompt,
 * which the after-the-fact bus event structurally cannot do. Same module-seam
 * pattern as mcp-call.
 */

export type SubagentStartHookRunner = (agentType: string, agentId: string) => Promise<string[]>

let runner: SubagentStartHookRunner | undefined

export function setSubagentStartHookRunner(fn: SubagentStartHookRunner | undefined): void {
  runner = fn
}

/** Context strings SubagentStart hooks contribute; empty when no runner is
 * registered or the runner fails (hooks must never block a spawn). */
export async function runSubagentStartHooks(agentType: string, agentId: string): Promise<string[]> {
  if (!runner) return []
  try {
    return await runner(agentType, agentId)
  } catch {
    return []
  }
}
