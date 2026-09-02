/**
 * The subagent tool schema and the result types derived from it. Kept apart from the
 * dispatch so the mode runners can name their own parameters without importing the
 * extension entry point back.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { StringEnum } from '@earendil-works/pi-ai'
import { type Static, Type } from 'typebox'

import type { SingleResult, SubagentDetails } from './types.js'

export const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
})

export const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
})

const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: 'user',
})

export const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: 'Name of the agent to invoke (for single mode)' })),
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' })),
  chain: Type.Optional(Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: 'Prompt before running project-local agents. Default: true.', default: true })),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process (single mode)' })),
  background: Type.Optional(Type.Boolean({ description: 'Run the single-mode task in the background: returns a run id immediately and a notification arrives when it completes.' })),
  status: Type.Optional(Type.Boolean({ description: 'Set true (alone, no other params) to list background runs instead of running anything.' })),
  cancel: Type.Optional(Type.String({ description: 'Background run id to cancel (from the id returned when it started, or from status).' })),
  resume: Type.Optional(Type.String({ description: 'Finished background run id to continue with a follow-up task; the child keeps everything it already saw. Pass task with it.' })),
})

/**
 * pi only sets a tool result's error flag when execute() throws; a returned isError is
 * ignored (docs/extensions.md, "Signaling errors"). Throwing here would be worse: the
 * agent loop replaces the result with createErrorToolResult(message), discarding the
 * details renderResult needs to show the failed agent's transcript. The failure is
 * carried in the content text instead, which is what reaches the model.
 */
export type ToolResult = AgentToolResult<SubagentDetails>
export type SubagentMode = 'single' | 'parallel' | 'chain'
export type MakeDetails = (mode: SubagentMode) => (results: SingleResult[]) => SubagentDetails
export type SubagentParamsStatic = Static<typeof SubagentParams>
export type ChainStepParam = Static<typeof ChainItem>
export type TaskItemParam = Static<typeof TaskItem>

/** The completion notice a background run sends when it finishes. */
