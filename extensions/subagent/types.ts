/**
 * The result shapes the subagent tool produces and its renderers read. They live apart
 * from both so neither has to import the other.
 */

import type { Message } from '@earendil-works/pi-ai'

import type { AgentScope } from './agents.js'

export interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface SingleResult {
  agent: string
  agentSource: 'user' | 'project' | 'builtin' | 'plugin' | 'unknown'
  task: string
  exitCode: number
  messages: Message[]
  stderr: string
  usage: UsageStats
  model?: string
  stopReason?: string
  errorMessage?: string
  step?: number
  /** Claude's partial marker: the run stopped at its maxTurns limit. */
  partial?: boolean
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain'
  agentScope: AgentScope
  projectAgentsDir: string | null
  results: SingleResult[]
}
