/**
 * Monitor: Claude's Monitor tool on pi.
 *
 * tools-reference, "Monitor tool": Monitor "runs a command in the background and feeds
 * each output line back to Claude, so it can react to log entries, file changes, or
 * polled status mid-conversation". "Every watch Claude starts has a deadline: 5 minutes
 * by default, at most 30 minutes"; "at the deadline the watch ends. Claude gets one
 * notice, so it can start the watch again if it's still needed." A watch stops when
 * Claude cancels it (TaskStop, registered here as task_stop) or the session ends.
 *
 * The command runs in the shell pi's bash tool uses, with pi's shell path and command
 * prefix, and is registered in the background-shells registry, so task_stop stops it and
 * /tasks lists it next to background Bash commands. Only its stdout lines are events, as
 * in Claude; stdout and stderr both go to an output file, as a background Bash command's do.
 *
 * Events follow Claude Code's Monitor (2.1.325). Stdout lines that arrive within 200 ms
 * of the first one form one event; a line and an event are cut at fixed lengths, and
 * blank lines are not events. Each event spends one token of an allowance. An event
 * with no token left is suppressed and counted, and the count goes out ahead of the
 * next event that is delivered. A monitor suppressed for 30 seconds without a break is
 * stopped with one notice; so is one whose output passes the cap a background Bash
 * command has.
 *
 * Deviations: the `ws` (WebSocket) source is not offered; a polling command covers the
 * same ground. Claude's 10-minute ceiling under `-p` has no counterpart, because a
 * session without a UI (print and json modes, subagents), where no later turn could
 * receive an event, refuses the tool. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS does not
 * turn it off (env-vars: "MCP tasks and the Monitor tool still run in the background").
 * Claude's permission prompt has no pi counterpart; a hook `if` filter and an
 * allowed-tools scope written for `Bash(...)` cover Monitor commands, as Claude's Bash
 * rules do. The two flood notices have a colon where Claude's have a dash, and name
 * task_stop. A session switch (/new, /resume, /fork) ends the watches, since their
 * events belong to the session that asked; /reload keeps them.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { constants as osConstants } from 'node:os'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { type AgentToolResult, type BashOperations, createBashToolDefinition, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, formatSize, getShellConfig } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { allShells, type BackgroundShell, commandPreview, MAX_OUTPUT_BYTES, registerShell, settleShell, shellOutputDir, shellSettings, stopAllShells, stopShell } from './internal/background-shells.ts'
import { killProcessTree } from './internal/process-tree.ts'
import { sessionHasTurns, sessionMailbox } from './internal/session-mailbox.ts'

/** "5 minutes by default". */
export const DEFAULT_DEADLINE_MS = 5 * 60_000
/** "at most 30 minutes". */
export const MAX_DEADLINE_MS = 30 * 60_000
/** Claude's schema takes no `timeout_ms` under one second. */
export const MIN_DEADLINE_MS = 1_000

/** How long lines gather after the first one before they go out as one event. */
export const BATCH_WINDOW_MS = 200
/** One line longer than this is cut. */
export const MAX_LINE_CHARS = 500
/** One event longer than this is cut. */
export const MAX_EVENT_CHARS = 3_000
/** How much of a line that has not ended yet is kept: its end. */
export const MAX_PARTIAL_CHARS = 1_048_576

/** Events one monitor may send at once. */
export const FLOOD_BURST = 10
/** How long until a monitor may send one more event. */
export const FLOOD_REFILL_MS = 2_000
/** How long a monitor may be suppressed without a break before it is stopped. */
export const SUPPRESSION_LIMIT_MS = 30_000

const TRUNCATED = '...(truncated)'

/** `capacity` uses at once, then one more every `refillMs`, never more than `capacity`. */
export function tokenBucket(capacity: number, refillMs: number, now: () => number = Date.now): { tryConsume: () => boolean; tokens: () => number } {
  let tokens = capacity
  let refilledAt = now()
  const refill = (): void => {
    const gained = Math.floor((now() - refilledAt) / refillMs)
    if (gained === 0) return
    tokens = Math.min(capacity, tokens + gained)
    refilledAt += gained * refillMs
  }
  return {
    tryConsume() {
      refill()
      if (tokens === 0) return false
      tokens--
      return true
    },
    tokens() {
      refill()
      return tokens
    },
  }
}

/** Claude's text counts "events" whatever the number, one included. */
export const suppressionNotice = (count: number): string => `[${count} events suppressed: output rate too high. Consider using task_stop to restart this monitor with a more selective filter.]`

export interface EventGateOptions {
  send: (event: string) => void
  /** Called once the monitor has been suppressed for too long, with the notice to end it on. */
  stop: (notice: string) => void
  capacity?: number
  refillMs?: number
  suppressionLimitMs?: number
  now?: () => number
}

export interface EventGate {
  /** Spend a token on an event; the count of those suppressed before it is sent first. */
  admit: () => boolean
  /** Send the event, or suppress it and stop a monitor suppressed for too long. */
  offer: (event: string) => void
}

/** The allowance events are sent under. Suppression counts as unbroken until the
 * monitor has been quiet for three refills or its allowance is whole again. */
export function eventGate(options: EventGateOptions): EventGate {
  const capacity = options.capacity ?? FLOOD_BURST
  const refillMs = options.refillMs ?? FLOOD_REFILL_MS
  const suppressionLimitMs = options.suppressionLimitMs ?? SUPPRESSION_LIMIT_MS
  const now = options.now ?? Date.now
  const bucket = tokenBucket(capacity, refillMs, now)
  let suppressed = 0
  let suppressedSince: number | undefined
  let lastEventAt = now()

  const admit = (): boolean => {
    const at = now()
    if (at - lastEventAt > refillMs * 3 || bucket.tokens() === capacity) suppressedSince = undefined
    lastEventAt = at
    if (!bucket.tryConsume()) {
      suppressed++
      suppressedSince ??= at
      return false
    }
    if (suppressed > 0) options.send(suppressionNotice(suppressed))
    suppressed = 0
    return true
  }

  return {
    admit,
    offer(event) {
      if (admit()) {
        options.send(event)
        return
      }
      const lasted = now() - (suppressedSince ?? now())
      if (lasted > suppressionLimitMs) options.stop(`[Monitor stopped: too much output (${suppressed} events suppressed over ${Math.round(lasted / 1000)}s). Restart with a more selective source.]`)
    },
  }
}

export interface LineBatcher {
  /** Feed decoded output; complete lines are queued for the next event. */
  push: (text: string) => void
  /** Take what is queued now, the unterminated last line included, and stop the timer. */
  drain: () => string | undefined
}

export interface BatcherOptions {
  emit: (event: string) => void
  windowMs?: number
  now?: () => number
}

const cut = (text: string, max: number, mark: string): string => (text.length > max ? `${text.slice(0, max)}${mark}` : text)

/** Splits output into lines and emits them as events: the first queued line opens a
 * window, and the lines queued when it closes are one event. */
export function createLineBatcher(options: BatcherOptions): LineBatcher {
  const windowMs = options.windowMs ?? BATCH_WINDOW_MS
  const now = options.now ?? Date.now

  let partial = ''
  let lines: string[] = []
  let chars = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let openedAt = 0

  const queue = (raw: string): void => {
    const line = cut(raw.trim(), MAX_LINE_CHARS, TRUNCATED)
    // An event already past its cut shows no later line: a command printing without
    // pause must not queue them without bound.
    if (line === '' || chars > MAX_EVENT_CHARS) return
    lines.push(line)
    chars += line.length + (lines.length > 1 ? 1 : 0)
  }

  const take = (): string | undefined => {
    if (lines.length === 0) return undefined
    const event = cut(lines.join('\n'), MAX_EVENT_CHARS, `\n${TRUNCATED}`)
    lines = []
    chars = 0
    return event
  }

  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const event = take()
    if (event !== undefined) options.emit(event)
  }

  return {
    push(text) {
      // A command printing without pause can keep the event loop on its pipe, and no
      // timer runs meanwhile: a window the clock has closed is emitted from here.
      if (timer && now() - openedAt >= windowMs) fire()
      const parts = (partial + text).split('\n')
      partial = (parts.pop() ?? '').slice(-MAX_PARTIAL_CHARS)
      for (const part of parts) queue(part)
      if (timer || lines.length === 0) return
      openedAt = now()
      timer = setTimeout(fire, windowMs)
      timer.unref?.()
    },
    drain() {
      if (timer) clearTimeout(timer)
      timer = undefined
      queue(partial)
      partial = ''
      return take()
    },
  }
}

/** The deadline a watch gets: the default when none is asked for, capped at the maximum. */
export function deadlineMs(requested: number | undefined, minMs: number = MIN_DEADLINE_MS): number {
  if (requested === undefined) return DEFAULT_DEADLINE_MS
  if (!Number.isFinite(requested) || requested < minMs) throw new Error(`timeout_ms must be a number of milliseconds, at least ${minMs} (a value over ${MAX_DEADLINE_MS} is capped)`)
  return Math.min(Math.floor(requested), MAX_DEADLINE_MS)
}

export function monitorAllowed(ctx: Pick<ExtensionContext, 'hasUI'>): string | undefined {
  if (!ctx.hasUI) return 'Monitor is unavailable in a session without a UI (print or json mode, or a subagent): no later turn could receive its events. Run the command with bash instead.'
  return undefined
}

const formatDuration = (ms: number): string => {
  if (ms % 60_000 === 0) return `${ms / 60_000}-minute`
  return `${Math.round(ms / 100) / 10}-second`
}

/** How a notice names its watch: the ID task_stop takes and the model's own description. */
const label = (id: string, description: string): string => `Monitor ${id} ("${commandPreview(description)}")`

/** The one notice a watch sends when it ends on its own, at its deadline, or because pi stopped it. */
function endNotice(end: { label: string; outputFile: string; limitMs: number; reachedDeadline: boolean; stopReason: string | undefined; exitCode: number | undefined; error: unknown }): string {
  if (end.stopReason) return `${end.label} was stopped: ${end.stopReason}. Full output: ${end.outputFile}`
  if (end.reachedDeadline) return `${end.label} reached its ${formatDuration(end.limitMs)} deadline and stopped. Start it again if you still need it.`
  if (end.error !== undefined) return `${end.label} could not run: ${end.error instanceof Error ? end.error.message : String(end.error)}`
  return `${end.label} ended: the command exited with code ${end.exitCode ?? '?'}. Full output: ${end.outputFile}`
}

export function eventText(id: string, description: string, event: string): string {
  return `${label(id, description)} output:\n${event}`
}

const schema = Type.Object({
  description: Type.String({ description: 'Short description of what you are watching. It names the watch in every message it sends and in /tasks.' }),
  command: Type.String({ description: 'Shell command to watch. Each line it prints is delivered to you as an event; write it so it prints only the lines worth reacting to (for example tail -F with grep --line-buffered, or a polling loop that prints on change).' }),
  timeout_ms: Type.Optional(Type.Number({ minimum: MIN_DEADLINE_MS, description: `Deadline in milliseconds (default ${DEFAULT_DEADLINE_MS}, minimum ${MIN_DEADLINE_MS}, maximum ${MAX_DEADLINE_MS}). At the deadline the watch ends and you get one notice.` })),
})

type ToolResult = AgentToolResult<unknown>

/** What a test may shorten; pi runs with the constants above. */
export type MonitorLimits = Pick<BatcherOptions, 'windowMs'> & { minDeadlineMs?: number; floodBurst?: number; floodRefillMs?: number; suppressionLimitMs?: number; maxOutputBytes?: number }

interface Watch {
  description: string
  command: string
  limitMs: number
}

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }], details: undefined })

interface SplitRun {
  cwd: string
  shellPath: string | undefined
  env: NodeJS.ProcessEnv | undefined
  /** Aborting it ends the command's process tree. */
  signal: AbortSignal
  onStdout: (data: Buffer) => void
  onStderr: (data: Buffer) => void
}

/** Run `command` in the shell pi's bash tool resolves, with stdout and stderr apart:
 * pi's local bash operations hand both streams to one callback. Resolves with the exit
 * code once both streams have closed, and rejects for a command that could not start. */
function execSplit(command: string, run: SplitRun): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(run.cwd)) throw new Error(`Working directory does not exist: ${run.cwd}`)
    const shell = getShellConfig(run.shellPath)
    const fromStdin = shell.commandTransport === 'stdin'
    // Its own process group off Windows, so the kill reaches what the shell spawned.
    const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], { cwd: run.cwd, env: run.env, detached: process.platform !== 'win32', stdio: [fromStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
    if (fromStdin) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(command)
    }
    const kill = (): void => killProcessTree(child, 'SIGKILL')
    if (run.signal.aborted) kill()
    else run.signal.addEventListener('abort', kill, { once: true })
    child.stdout?.on('data', run.onStdout)
    child.stderr?.on('data', run.onStderr)
    child.once('error', reject)
    // A process the shell forked while the kill was landing survives it and holds the
    // pipes open, so 'close' would never come: once the stopped shell is gone, end
    // whatever is left of its group and let go of the pipes. Not on Windows, where
    // there is no group and the shell's process ID may already belong to another process.
    child.once('exit', () => {
      if (!run.signal.aborted) return
      if (process.platform !== 'win32') kill()
      child.stdout?.destroy()
      child.stderr?.destroy()
    })
    child.once('close', (code, signal) => {
      run.signal.removeEventListener('abort', kill)
      // A shell ended by a signal has no exit code: the shell convention stands in.
      resolve(code ?? 128 + (signal ? osConstants.signals[signal] : 0))
    })
  })
}

/** Session-switch reasons that end the session the watches report to. */
const ENDING_REASONS = new Set(['quit', 'new', 'resume', 'fork'])

/** `limits` is a test seam; pi passes only `pi`. */
export default function monitorExtension(pi: ExtensionAPI, limits: MonitorLimits = {}) {
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // Events go to whichever session is current: after /reload this instance's pi throws.
  const events = sessionMailbox('monitor')

  const send = (content: string): void => {
    events.deliver((current, startsTurn) => {
      current.sendMessage({ customType: 'monitor', content, display: true }, { triggerTurn: startsTurn })
    })
  }

  function start({ description, command, limitMs }: Watch, ctx: ExtensionToolContext): BackgroundShell {
    const id = `m${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const outputFile = path.join(shellOutputDir(), `${id}.output`)
    const log = fs.createWriteStream(outputFile, { mode: 0o600 })
    // A full disk or a removed directory must not take pi down from a stream event.
    log.on('error', () => {})

    const lifetime = new AbortController()
    const shell = registerShell({ id, kind: 'monitor', description, command, outputFile, stop: () => lifetime.abort() })
    let floodNotice: string | undefined
    const gate = eventGate({
      send: (event) => send(eventText(id, description, event)),
      stop: (notice) => {
        floodNotice = notice
        stopShell(id, 'too much output')
      },
      capacity: limits.floodBurst,
      refillMs: limits.floodRefillMs,
      suppressionLimitMs: limits.suppressionLimitMs,
    })
    const batcher = createLineBatcher({
      windowMs: limits.windowMs,
      emit: (event) => {
        if (shell.state === 'running') gate.offer(event)
      },
    })
    const decoder = new StringDecoder('utf8')
    let written = 0
    /** Both streams go to the output file, under the cap a background Bash command has. */
    const record = (data: Buffer): void => {
      if (shell.state !== 'running') return
      written += data.length
      log.write(data)
      if (written > maxOutputBytes) stopShell(id, `its output passed the ${formatSize(maxOutputBytes)} limit`)
    }

    let reachedDeadline = false
    const deadline = setTimeout(() => {
      reachedDeadline = true
      stopShell(id)
    }, limitMs)
    deadline.unref?.()

    const { shellPath, commandPrefix } = shellSettings(ctx)
    let exitCode: number | undefined
    // The built-in definition resolves the command (pi's prefix) and its environment
    // (the PI_* session variables, pi's bin directory on PATH) as it does for bash.
    // Only the process is run here, and nothing of the built-in's own result is used.
    const operations: BashOperations = {
      exec: async (resolved, cwd, { env }) => {
        exitCode = await execSplit(resolved, {
          cwd,
          shellPath,
          env,
          signal: lifetime.signal,
          onStdout: (data) => {
            record(data)
            if (shell.state !== 'running') return
            batcher.push(decoder.write(data))
          },
          onStderr: record,
        })
        return { exitCode }
      },
    }
    const run = createBashToolDefinition(ctx.cwd, { operations, shellPath, commandPrefix }).execute(id, { command }, lifetime.signal, undefined, ctx)
    // Without an exit code the command never ran, and the rejection says why.
    const settle = (error?: unknown): void => finish(exitCode, exitCode === undefined ? error : undefined)
    void run.then(() => settle(), settle)

    function finish(exitCode: number | undefined, error: unknown): void {
      clearTimeout(deadline)
      batcher.push(decoder.end())
      const rest = batcher.drain()
      const settled = (): void => {
        const { stopReason } = shell
        const stoppedOnRequest = shell.state === 'killed' && !reachedDeadline && stopReason === undefined
        settleShell(shell, exitCode)
        // Stopped through task_stop or the session ending: nothing is waiting for it.
        if (stoppedOnRequest) return
        // The last event spends a token as any other does; a stopped command's is not sent.
        const last = rest !== undefined && stopReason === undefined && gate.admit() ? [eventText(id, description, rest)] : []
        const notice = floodNotice === undefined ? endNotice({ label: label(id, description), outputFile, limitMs, reachedDeadline, stopReason, exitCode, error }) : eventText(id, description, floodNotice)
        send([...last, notice].join('\n'))
      }
      // Settled once the output file is closed: the file named in the notice is then
      // complete, and Windows cannot remove a directory that holds an open file.
      if (log.closed) settled()
      else log.once('close', settled)
      log.end()
    }

    return shell
  }

  pi.registerTool({
    name: 'monitor',
    label: 'monitor',
    description: `Run a command in the background and receive each line it prints as an event, so you can react to log entries, file changes, or polled status while the conversation continues. Only stdout lines are events; stderr goes to the output file. Lines that arrive within ${BATCH_WINDOW_MS} ms of the first are delivered together as one event. A monitor may send ${FLOOD_BURST} events at once and one more every ${FLOOD_REFILL_MS / 1000} seconds; events past that are suppressed and reported as a count, and a monitor suppressed for ${SUPPRESSION_LIMIT_MS / 1000} seconds without a break is stopped automatically, so filter the command down to the lines worth reacting to. The watch ends at its deadline (${DEFAULT_DEADLINE_MS / 60_000} minutes by default, at most ${MAX_DEADLINE_MS / 60_000}) with one notice; stop it earlier with task_stop.`,
    promptSnippet: 'Watch a background command and react to each line it prints',
    promptGuidelines: ['Use monitor to watch logs, CI or PR status, or file changes instead of polling with sleep; make the command print only lines worth reacting to. Stop a monitor with task_stop once it is no longer needed.'],
    parameters: schema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) /* NOSONAR typescript:S7503 - pi types execute as returning a Promise */ {
      const refusal = monitorAllowed(ctx)
      if (refusal) throw new Error(refusal)
      if (params.command.trim() === '') throw new Error('command must not be empty')
      if ((params.description ?? '').trim() === '') throw new Error('description must not be empty')
      const limitMs = deadlineMs(params.timeout_ms, limits.minDeadlineMs)
      const shell = start({ description: params.description, command: params.command, limitMs }, ctx)
      return text(`Monitor started with ID: ${shell.id}. Each line the command prints is delivered to you as it arrives, in batches. It stops at its ${formatDuration(limitMs)} deadline; use task_stop to stop it sooner. Full output is written to: ${shell.outputFile}`)
    },
  })

  pi.on('session_start', (_event, ctx) => events.attach(pi, sessionHasTurns(ctx)))
  pi.on('agent_start', () => events.markPrompted(pi))
  pi.on('session_shutdown', (event) => {
    events.detach(pi)
    if (!ENDING_REASONS.has(event.reason)) return
    // On quit nothing is left to read any command's output; the bash extension does the
    // same, and stopping twice is harmless. A session switch ends only the watches.
    if (event.reason === 'quit') stopAllShells()
    else for (const shell of allShells()) if (shell.kind === 'monitor') stopShell(shell.id)
  })
}
