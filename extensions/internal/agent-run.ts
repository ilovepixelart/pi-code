/**
 * A one-function seam letting the hooks extension spawn a subagent for Claude's
 * experimental `type: "agent"` hooks, without importing the subagent extension.
 *
 * The subagent extension registers a runner once it is loaded; a hook that needs
 * to verify a condition with a tool-using agent (Read/Grep/Glob) goes through
 * runAgent. It is the agentic analogue of the mcp-call seam: if nothing registered
 * a runner (a stripped-down deployment without the subagent extension), agent hooks
 * are skipped rather than failing the event.
 */

export interface AgentRunRequest {
  /** The agent's task prompt, with `$ARGUMENTS` already substituted. */
  prompt: string
  /** Optional model id override; the runner falls back to a fast default. */
  model?: string
  /** Optional extra system prompt (Claude's experimental `systemPrompt` field). */
  systemPrompt?: string
  /** Aborts the run at the hook's deadline. */
  signal?: AbortSignal
}

/** Run a subagent to completion and return its final assistant text. */
export type AgentRunner = (request: AgentRunRequest) => Promise<string>

let runner: AgentRunner | undefined

/** The subagent extension registers its runner here; pass undefined to clear it. */
export function setAgentRunner(fn: AgentRunner | undefined): void {
  runner = fn
}

/** Whether a runner is registered, so agent hooks can be reported as runnable. */
export function hasAgentRunner(): boolean {
  return runner !== undefined
}

/** Run a subagent for an agent hook. Rejects when no runner is registered. */
export function runAgent(request: AgentRunRequest): Promise<string> {
  if (!runner) return Promise.reject(new Error('no subagent runner registered for agent hooks'))
  return runner(request)
}
