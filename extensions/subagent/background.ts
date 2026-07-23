/**
 * Background subagent runs: fire-and-forget children whose completion wakes
 * the parent agent via a notification message. State lives in an in-memory
 * registry queried via {status: true}; it is lost on restart, and a child
 * still running when pi exits finishes on its own rather than being killed.
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

/** Cap on simultaneously running background children. */
export const MAX_BACKGROUND_RUNS = 8

export function activeBackgroundRuns(): number {
  return [...runs.values()].filter((run) => run.state === 'running').length
}

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
    // The complete text of the last assistant message, matching getFinalOutput on the
    // foreground path so a multi-part message reads the same in both.
    const parts = (event.message.content ?? []).filter((p) => p.type === 'text' && p.text).map((p) => p.text as string)
    if (parts.length > 0) text = parts.join('\n')
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

export function startBackgroundRun(agent: string, task: string, invocation: BackgroundSpawn, onComplete: (run: BackgroundRun) => void): string | null {
  // Checked here, synchronously with registration: callers await temp-file writes
  // between any check of their own and this call, so a parallel tool-call batch
  // could otherwise all pass that earlier check and overshoot the cap.
  if (activeBackgroundRuns() >= MAX_BACKGROUND_RUNS) return null
  const id = `bg-${randomUUID().slice(0, 8)}`
  const run: BackgroundRun = { id, agent, task, state: 'running', turns: 0 }
  runs.set(id, run)

  const proc = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    // The marker lets the child's subagent tool refuse to nest further.
    env: { ...process.env, PI_CODE_SUBAGENT: '1' },
  })
  let stdout = ''
  // Node fires both 'error' and 'close' on a spawn failure (ENOENT); complete once.
  let completed = false
  const complete = (): void => {
    if (completed) return
    completed = true
    onComplete(run)
  }
  proc.stdout.on('data', (data) => {
    stdout += data.toString()
  })
  proc.on('close', (code) => {
    const { text, turns } = parseFinalOutputFromJsonl(stdout)
    run.state = code === 0 ? 'done' : 'failed'
    run.exitCode = code ?? 0
    run.output = text
    run.turns = turns
    complete()
  })
  proc.on('error', () => {
    run.state = 'failed'
    run.exitCode = 1
    complete()
  })
  return id
}
