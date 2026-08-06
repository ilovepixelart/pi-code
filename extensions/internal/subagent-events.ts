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
}

export function isSubagentPhaseEvent(data: unknown): data is SubagentPhaseEvent {
  const event = data as SubagentPhaseEvent
  return (event?.phase === 'start' || event?.phase === 'stop') && typeof event.agentType === 'string' && typeof event.agentId === 'string'
}
