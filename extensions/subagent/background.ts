/**
 * Background subagent runs: fire-and-forget children whose completion wakes
 * the parent agent via a notification message. Session-scoped (children die
 * with pi); state lives in an in-memory registry queried via {action:"status"}.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface BackgroundRun {
  id: string
  agent: string
  task: string
  state: 'running' | 'done' | 'failed'
  exitCode?: number
  output?: string
  turns: number
}

export interface BackgroundSpawn {
  command: string
  args: string[]
  cwd: string
}

const runs = new Map<string, BackgroundRun>()

/** Extract the final assistant text and turn count from a pi --mode json stdout stream. */
export function parseFinalOutputFromJsonl(jsonl: string): { text: string; turns: number } {
  let text = ''
  let turns = 0
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let event: { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue
    turns++
    for (const part of event.message.content ?? []) {
      if (part.type === 'text' && part.text) text = part.text
    }
  }
  return { text, turns }
}

export function formatStatus(all: Iterable<BackgroundRun>): string {
  const lines = [...all].map((run) => {
    const label = run.state === 'running' ? 'running' : `${run.state} (exit ${run.exitCode ?? '?'}, ${run.turns} turns)`
    return `${run.id} ${run.agent}: ${label} - ${run.task.slice(0, 60)}`
  })
  return lines.length > 0 ? lines.join('\n') : 'No background runs in this session.'
}

export function backgroundStatusText(): string {
  return formatStatus(runs.values())
}

export function startBackgroundRun(agent: string, task: string, invocation: BackgroundSpawn, onComplete: (run: BackgroundRun) => void): string {
  const id = `bg-${randomUUID().slice(0, 8)}`
  const run: BackgroundRun = { id, agent, task, state: 'running', turns: 0 }
  runs.set(id, run)

  const proc = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let stdout = ''
  proc.stdout.on('data', (data) => {
    stdout += data.toString()
  })
  proc.on('close', (code) => {
    const { text, turns } = parseFinalOutputFromJsonl(stdout)
    run.state = code === 0 ? 'done' : 'failed'
    run.exitCode = code ?? 0
    run.output = text
    run.turns = turns
    onComplete(run)
  })
  proc.on('error', () => {
    run.state = 'failed'
    run.exitCode = 1
    onComplete(run)
  })
  return id
}
