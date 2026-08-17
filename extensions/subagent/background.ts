/**
 * Background subagent runs: fire-and-forget children whose completion wakes
 * the parent agent via a notification message. State lives in an in-memory
 * registry queried via {status: true}; it is lost on restart, and a child
 * still running when pi exits finishes on its own rather than being killed.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface BackgroundRun {
  id: string
  agent: string
  task: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  exitCode?: number
  output?: string
  turns: number
  /** Last stderr bytes of a failed child; the only diagnostics a boot failure leaves. */
  stderr?: string
  /** Set while running so the run can be cancelled; cleared on completion. */
  kill?: () => void
  /** True until the child process actually closes: a cancelled child that ignores
   * SIGTERM is still alive and must keep holding its concurrency slot. */
  live?: boolean
  /** pi session the child ran under, so a follow-up can continue its context. */
  sessionId: string
  /** How the child was spawned, so a follow-up can repeat it with a new task. */
  spawn: BackgroundSpawn
}

export interface BackgroundSpawn {
  command: string
  args: string[]
  cwd: string
  /** The --append-system-prompt body, kept so a resume can rebuild the file the
   * completing run deleted. Without it the resumed child is handed a path that no
   * longer exists, and pi falls back to using that path as the prompt text. */
  promptBody?: string
  /** Claude's maxTurns: kill the child once it has produced this many turns. */
  maxTurns?: number
}

const runs = new Map<string, BackgroundRun>()

/** Cap on simultaneously running background children. */
export const MAX_BACKGROUND_RUNS = 8

/** Finished runs kept for status listings and resume; older ones are evicted so a
 * long session's registry (each entry holds its final output) cannot grow forever. */
export const MAX_FINISHED_RUNS = 20

/** Grace between the cancel SIGTERM and the SIGKILL that ends a child ignoring it. */
const CANCEL_KILL_GRACE_MS = 5000

/** Bytes of stderr kept per run, enough for the boot error without buffering logs. */
const STDERR_TAIL_CHARS = 2048

export function activeBackgroundRuns(): number {
  return [...runs.values()].filter((run) => run.live || run.state === 'running').length
}

function evictFinishedRuns(): void {
  const finished = [...runs.values()].filter((run) => !run.live && run.state !== 'running')
  for (const stale of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RUNS))) runs.delete(stale.id)
}

/** Line-by-line parser keeping only the last assistant text and a turn count, so a
 * long run's JSONL stdout never accumulates whole in the parent's memory. */
export function createJsonlOutputParser(onTurn?: (turns: number) => void): { push: (chunk: string) => void; flush: () => { text: string; turns: number } } {
  let buffer = ''
  let text = ''
  let turns = 0
  const takeLine = (raw: string): void => {
    if (!raw.trim()) return
    let event: { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } }
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') return
    turns++
    onTurn?.(turns)
    // The complete text of the last assistant message, matching getFinalOutput on the
    // foreground path so a multi-part message reads the same in both.
    const parts = (event.message.content ?? []).filter((p) => p.type === 'text' && p.text).map((p) => p.text as string)
    if (parts.length > 0) text = parts.join('\n')
  }
  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) takeLine(line)
    },
    flush() {
      takeLine(buffer)
      buffer = ''
      return { text, turns }
    },
  }
}

/** Extract the final assistant text and turn count from a pi --mode json stdout stream. */
export function parseFinalOutputFromJsonl(jsonl: string): { text: string; turns: number } {
  const parser = createJsonlOutputParser()
  parser.push(jsonl)
  return parser.flush()
}

export function formatStatus(all: Iterable<Pick<BackgroundRun, 'id' | 'agent' | 'task' | 'state' | 'turns' | 'exitCode'>>): string {
  const lines = [...all].map((run) => {
    const label = run.state === 'running' ? 'running' : `${run.state} (exit ${run.exitCode ?? '?'}, ${run.turns} turns)`
    return `${run.id} ${run.agent}: ${label} - ${run.task.slice(0, 60)}`
  })
  return lines.length > 0 ? lines.join('\n') : 'No background runs in this session.'
}

/** Cancel a running background child. Returns what the caller should tell the model:
 * unknown id, already finished, or cancelled. */
export function cancelBackgroundRun(id: string): 'cancelled' | 'not-running' | 'unknown' {
  const run = runs.get(id)
  if (!run) return 'unknown'
  if (run.state !== 'running' || !run.kill) return 'not-running'
  run.state = 'cancelled'
  run.kill()
  run.kill = undefined
  return 'cancelled'
}

export function backgroundStatusText(): string {
  return formatStatus(runs.values())
}

/** A finished run, so a caller can continue its session with a follow-up task. */
export function backgroundRun(id: string): BackgroundRun | undefined {
  return runs.get(id)
}

/** Re-spawn a finished run's session with a new task. The child is started with the
 * same --session-id, so it continues with everything it already saw rather than
 * re-deriving context the parent would have to repeat. */
export function resumeBackgroundRun(id: string, task: string, onComplete: (run: BackgroundRun) => void): 'resumed' | 'still-running' | 'at-capacity' | 'unknown' {
  const run = runs.get(id)
  if (!run) return 'unknown'
  if (run.state === 'running' || run.live) return 'still-running'
  // A resume spawns a child like a fresh start does, so it counts against the cap.
  if (activeBackgroundRuns() >= MAX_BACKGROUND_RUNS) return 'at-capacity'
  // Persisted so the rebuild happens once: rebuilding per resume leaked one temp
  // prompt dir every follow-up.
  const rebuilt = withRebuiltPrompt(run.spawn)
  run.spawn = { ...run.spawn, args: rebuilt }
  const args = rebuilt.map((arg) => (arg.startsWith('Task: ') ? `Task: ${task}` : arg))
  run.state = 'running'
  run.task = task
  run.output = undefined
  run.exitCode = undefined
  run.stderr = undefined
  driveRun(run, { ...run.spawn, args }, onComplete)
  return 'resumed'
}

/** Re-point --append-system-prompt at a fresh file when the original is gone. */
function withRebuiltPrompt(spawnSpec: BackgroundSpawn): string[] {
  const flag = spawnSpec.args.indexOf('--append-system-prompt')
  if (flag === -1 || !spawnSpec.promptBody) return spawnSpec.args
  const current = spawnSpec.args[flag + 1]
  if (current && fs.existsSync(current)) return spawnSpec.args
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-'))
    const file = path.join(dir, 'prompt.md')
    fs.writeFileSync(file, spawnSpec.promptBody, { mode: 0o600 })
    const rebuilt = [...spawnSpec.args]
    rebuilt[flag + 1] = file
    return rebuilt
  } catch {
    // Cannot rewrite it: drop the pair rather than hand pi a path it will treat as
    // prompt text, which would replace the agent persona with a temp path.
    return spawnSpec.args.filter((_arg, i) => i !== flag && i !== flag + 1)
  }
}

export function startBackgroundRun(agent: string, task: string, invocation: BackgroundSpawn, onComplete: (run: BackgroundRun) => void): string | null {
  // Checked here, synchronously with registration: callers await temp-file writes
  // between any check of their own and this call, so a parallel tool-call batch
  // could otherwise all pass that earlier check and overshoot the cap.
  if (activeBackgroundRuns() >= MAX_BACKGROUND_RUNS) return null
  const id = `bg-${randomUUID().slice(0, 8)}`
  // A stable session id per run: the child persists its session, so a follow-up can
  // resume it instead of starting cold.
  const sessionId = `pi-code-${id}-${randomUUID().slice(0, 8)}`
  const args = invocation.args.map((arg) => (arg === '--no-session' ? '--session-id' : arg))
  const withSession = args.includes('--session-id') ? args.flatMap((arg) => (arg === '--session-id' ? ['--session-id', sessionId] : [arg])) : args
  const spawnSpec: BackgroundSpawn = { ...invocation, args: withSession }
  const run: BackgroundRun = { id, agent, task, state: 'running', turns: 0, sessionId, spawn: spawnSpec }
  runs.set(id, run)
  driveRun(run, spawnSpec, onComplete)
  return id
}

/** Spawn the child for a run and wire its lifecycle back onto the record. */
function driveRun(run: BackgroundRun, invocation: BackgroundSpawn, onComplete: (run: BackgroundRun) => void): void {
  const proc = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own group, so cancelling reaches any grandchild the agent spawned.
    detached: true,
    // The marker lets the child's subagent tool refuse to nest further.
    env: { ...process.env, PI_CODE_SUBAGENT: '1' },
  })
  run.live = true
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid!, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // already gone
      }
    }
  }
  run.kill = () => {
    killGroup('SIGTERM')
    // A child ignoring SIGTERM would hold its cap slot and process forever.
    const escalate = setTimeout(() => killGroup('SIGKILL'), CANCEL_KILL_GRACE_MS)
    escalate.unref()
    proc.once('close', () => clearTimeout(escalate))
  }
  // Parsed as it streams: buffering the whole JSONL replays every tool result echoed
  // by the child through the parent's memory for the life of the run. A maxTurns cap
  // kills the child at the turn boundary after its Nth turn, so the output so far is
  // preserved and no turn is cut mid-flight.
  const maxTurns = invocation.maxTurns
  // A maxTurns cap kills the child with SIGTERM, so its close arrives with a null code.
  // That is a clean boundary end (the foreground path treats the same cap as success),
  // so remember it and do not misreport the run as failed.
  let cappedByMaxTurns = false
  const parser = createJsonlOutputParser(
    maxTurns
      ? (turns) => {
          if (turns < maxTurns) return
          cappedByMaxTurns = true
          run.kill?.()
        }
      : undefined,
  )
  let stderrTail = ''
  // Node fires both 'error' and 'close' on a spawn failure (ENOENT); complete once.
  let completed = false
  const complete = (): void => {
    if (completed) return
    completed = true
    evictFinishedRuns()
    // A run outlives the session that started it, and pi's loader wires assertActive()
    // into every runtime call, so notifying a disposed session throws. This fires from
    // the child's 'close'/'error' listener, where nothing upstream catches: an escaping
    // error reaches Node as an uncaughtException and takes pi down with it. The run
    // state is already recorded by this point, so there is nothing to do but drop the
    // notification for a session that is no longer there to receive it.
    try {
      onComplete(run)
    } catch {
      // the session that asked for this run is gone
    }
  }
  proc.stdout.on('data', (data) => parser.push(data.toString()))
  // An 'error' on a stream with no listener is rethrown by EventEmitter, and this one
  // belongs to a detached child, so a pipe read failure would exit pi the same way an
  // unguarded completion would. The foreground runner guards its streams the same way.
  proc.stdout.on('error', () => {})
  proc.stderr?.on('data', (data) => {
    stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_CHARS)
  })
  proc.stderr?.on('error', () => {})
  proc.on('close', (code) => {
    const { text, turns } = parser.flush()
    run.kill = undefined
    run.live = false
    // A cancelled run keeps that state: its non-zero exit is the cancellation. A
    // maxTurns cap ends cleanly with output preserved, so it counts as done, not failed.
    if (run.state !== 'cancelled') run.state = code === 0 || cappedByMaxTurns ? 'done' : 'failed'
    run.exitCode = cappedByMaxTurns ? 0 : (code ?? 0)
    run.output = text
    run.turns = turns
    run.stderr = stderrTail.trim() || undefined
    complete()
  })
  proc.on('error', (error) => {
    run.kill = undefined
    run.live = false
    run.state = 'failed'
    run.exitCode = 1
    run.stderr = stderrTail.trim() || error.message
    complete()
  })
}
