/**
 * Channel and payload for subagent lifecycle events the subagent extension publishes
 * on pi's shared extension event bus. Hooks bridge them to Claude's SubagentStart and
 * SubagentStop; pi loads extensions without a shared module cache, so state rides the bus.
 */

export const SUBAGENT_CHANNEL = 'pi-code:subagent'

export interface SubagentPhaseEvent {
  phase: 'start' | 'stop'
  agentType: string
  agentId: string
  /** The run's final assistant text, on stop: Claude's SubagentStop delivers it
   * as last_assistant_message so hooks need not parse a transcript. */
  lastAssistantMessage?: string
}

export function isSubagentPhaseEvent(data: unknown): data is SubagentPhaseEvent {
  const event = data as SubagentPhaseEvent
  return (event?.phase === 'start' || event?.phase === 'stop') && typeof event.agentType === 'string' && typeof event.agentId === 'string'
}
