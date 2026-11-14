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
 * The command runs through pi's local bash operations, with pi's shell path and command
 * prefix, and is registered in the background-shells registry, so task_stop stops it and
 * /tasks lists it next to background Bash commands. Every byte it prints also goes to an
 * output file, as a background Bash command's does.
 *
 * Lines are not delivered one message each: a chatty command would start a turn per
 * line. They are coalesced over a short window, at most one message per interval, and a
 * message carries a bounded number of lines and characters; the rest are counted and the
 * message points at the output file. Blank lines are not events.
 *
 * Deviations: the `ws` (WebSocket) source is not offered; a polling command covers the
 * same ground. Claude's 10-minute ceiling under `-p` has no counterpart, because a
 * session without a UI (print and json modes, subagents), where no later turn could
 * receive an event, refuses the tool, as does CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1.
 * Claude's permission prompt has no pi counterpart; a hook `if` filter written for
 * `Bash(...)` covers Monitor commands, as Claude's Bash rules do. A session switch
 * (/new, /resume, /fork) ends the watches, since their events belong to the session
 * that asked; /reload keeps them.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { type AgentToolResult, createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { allShells, type BackgroundShell, commandPreview, registerShell, settleShell, shellOutputDir, shellSettings, stopAllShells, stopShell } from './internal/background-shells.ts'
import { sessionHasTurns, sessionMailbox } from './internal/session-mailbox.ts'

/** "5 minutes by default". */
export const DEFAULT_DEADLINE_MS = 5 * 60_000
/** "at most 30 minutes". */
export const MAX_DEADLINE_MS = 30 * 60_000

/** How long lines gather after the first one before they are delivered. */
export const BATCH_WINDOW_MS = 1_000
/** The least time between two deliveries from one monitor. */
export const MIN_INTERVAL_MS = 5_000
/** Lines and characters one delivery carries; the rest are counted, not shown. */
export const MAX_BATCH_LINES = 50
export const MAX_BATCH_CHARS = 4_000
/** One line longer than this is cut. */
export const MAX_LINE_CHARS = 500

export interface Batch {
  lines: string[]
  /** Lines that arrived but did not fit the delivery. */
  omitted: number
}

export interface LineBatcher {
  /** Feed decoded output; complete lines are queued for delivery. */
  push: (text: string) => void
  /** Take what is queued now, the unterminated last line included, and stop the timer. */
  drain: () => Batch | undefined
}

export interface BatcherOptions {
  emit: (batch: Batch) => void
  windowMs?: number
  minIntervalMs?: number
  maxLines?: number
  maxChars?: number
  maxLineChars?: number
  now?: () => number
}

const cut = (line: string, max: number): string => {
  const chars = Array.from(line)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

/** Splits output into lines and delivers them in bounded batches: the first queued
 * line opens a window, and no delivery follows the previous one sooner than the
 * minimum interval. */
export function createLineBatcher(options: BatcherOptions): LineBatcher {
  const windowMs = options.windowMs ?? BATCH_WINDOW_MS
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS
  const maxLines = options.maxLines ?? MAX_BATCH_LINES
  const maxChars = options.maxChars ?? MAX_BATCH_CHARS
  const maxLineChars = options.maxLineChars ?? MAX_LINE_CHARS
  const now = options.now ?? Date.now

  let partial = ''
  let lines: string[] = []
  let chars = 0
  let omitted = 0
  let lastEmit: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const queue = (raw: string): void => {
    const line = cut(raw.replace(/\r$/, ''), maxLineChars)
    if (line.trim() === '') return
    if (lines.length >= maxLines || chars + line.length > maxChars) {
      omitted++
      return
    }
    lines.push(line)
    chars += line.length
  }

  const take = (): Batch | undefined => {
    if (lines.length === 0 && omitted === 0) return undefined
    const batch = { lines, omitted }
    lines = []
    chars = 0
    omitted = 0
    return batch
  }

  const fire = (): void => {
    timer = undefined
    const batch = take()
    if (!batch) return
    lastEmit = now()
    options.emit(batch)
  }

  const schedule = (): void => {
    if (timer || (lines.length === 0 && omitted === 0)) return
    const sinceLast = lastEmit === undefined ? Number.POSITIVE_INFINITY : now() - lastEmit
    timer = setTimeout(fire, Math.max(windowMs, minIntervalMs - sinceLast))
    timer.unref?.()
  }

  return {
    push(text) {
      const parts = (partial + text).split('\n')
      partial = parts.pop() ?? ''
      // A line that never ends must not grow without bound: past the cap it is queued as is.
      if (partial.length > maxLineChars * 4) {
        parts.push(partial)
        partial = ''
      }
      for (const part of parts) queue(part)
      schedule()
    },
    drain() {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (partial) queue(partial)
      partial = ''
      return take()
    },
  }
}

/** The deadline a watch gets: the default when none is asked for, capped at the maximum. */
export function deadlineMs(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_DEADLINE_MS
  if (!Number.isFinite(requested) || requested <= 0) throw new Error(`timeout_ms must be a positive number of milliseconds, at most ${MAX_DEADLINE_MS}`)
  return Math.min(Math.floor(requested), MAX_DEADLINE_MS)
}

export function monitorAllowed(ctx: Pick<ExtensionContext, 'hasUI'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1') return 'Monitor is unavailable: background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1).'
  if (!ctx.hasUI) return 'Monitor is unavailable in a session without a UI (print or json mode, or a subagent): no later turn could receive its events. Run the command with bash instead.'
  return undefined
}

const formatDuration = (ms: number): string => {
  if (ms % 60_000 === 0) return `${ms / 60_000}-minute`
  return `${Math.round(ms / 100) / 10}-second`
}

/** The one notice a watch sends when it ends on its own or at its deadline. */
function endNotice(end: { id: string; outputFile: string; limitMs: number; reachedDeadline: boolean; exitCode: number | undefined; error: unknown }): string {
  if (end.reachedDeadline) return `Monitor ${end.id} reached its ${formatDuration(end.limitMs)} deadline and stopped. Start it again if you still need it.`
  if (end.error !== undefined) return `Monitor ${end.id} could not run: ${end.error instanceof Error ? end.error.message : String(end.error)}`
  return `Monitor ${end.id} ended: the command exited with code ${end.exitCode ?? '?'}. Full output: ${end.outputFile}`
}

export function batchText(id: string, command: string, batch: Batch, outputFile: string): string {
  const head = `Monitor ${id} ("${commandPreview(command)}") output:`
  const more = batch.omitted > 0 ? [`[${batch.omitted} more line${batch.omitted === 1 ? '' : 's'} not shown; full output: ${outputFile}]`] : []
  return [head, ...batch.lines, ...more].join('\n')
}

const schema = Type.Object({
  command: Type.String({ description: 'Shell command to watch. Each line it prints is delivered to you as an event; write it so it prints only the lines worth reacting to (for example tail -F with grep --line-buffered, or a polling loop that prints on change).' }),
  timeout_ms: Type.Optional(Type.Number({ description: `Deadline in milliseconds (default ${DEFAULT_DEADLINE_MS}, maximum ${MAX_DEADLINE_MS}). At the deadline the watch ends and you get one notice.` })),
})

type ToolResult = AgentToolResult<unknown>

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }], details: undefined })

/** Session-switch reasons that end the session the watches report to. */
const ENDING_REASONS = new Set(['quit', 'new', 'resume', 'fork'])

export default function monitorExtension(pi: ExtensionAPI) {
  // Events go to whichever session is current: after /reload this instance's pi throws.
  const events = sessionMailbox('monitor')

  const send = (content: string): void => {
    events.deliver((current, startsTurn) => {
      current.sendMessage({ customType: 'monitor', content, display: true }, { triggerTurn: startsTurn })
    })
  }

  function start(command: string, limitMs: number, ctx: ExtensionContext): BackgroundShell {
    const id = `m${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const outputFile = path.join(shellOutputDir(), `${id}.output`)
    const log = fs.createWriteStream(outputFile, { mode: 0o600 })
    // A full disk or a removed directory must not take pi down from a stream event.
    log.on('error', () => {})

    const lifetime = new AbortController()
    const shell = registerShell({ id, kind: 'monitor', command, outputFile, stop: () => lifetime.abort() })
    const batcher = createLineBatcher({ emit: (batch) => send(batchText(id, command, batch, outputFile)) })
    const decoder = new StringDecoder('utf8')

    let reachedDeadline = false
    const deadline = setTimeout(() => {
      reachedDeadline = true
      stopShell(id)
    }, limitMs)
    deadline.unref?.()

    const { shellPath, commandPrefix } = shellSettings(ctx)
    const resolved = commandPrefix ? `${commandPrefix}\n${command}` : command
    const run = createLocalBashOperations({ shellPath }).exec(resolved, ctx.cwd, {
      signal: lifetime.signal,
      onData: (data) => {
        log.write(data)
        batcher.push(decoder.write(data))
      },
    })

    void run.then(
      ({ exitCode }) => finish(exitCode ?? undefined, undefined),
      (error: unknown) => finish(undefined, error),
    )

    function finish(exitCode: number | undefined, error: unknown): void {
      clearTimeout(deadline)
      log.end()
      batcher.push(decoder.end())
      const rest = batcher.drain()
      const stoppedOnRequest = shell.state === 'killed' && !reachedDeadline
      settleShell(shell, exitCode)
      // Stopped through task_stop or the session ending: nothing is waiting for it.
      if (stoppedOnRequest) return
      const lines = rest ? [batchText(id, command, rest, outputFile)] : []
      send([...lines, endNotice({ id, outputFile, limitMs, reachedDeadline, exitCode, error })].join('\n'))
    }

    return shell
  }

  pi.registerTool({
    name: 'monitor',
    label: 'monitor',
    description: `Run a command in the background and receive each line it prints as an event, so you can react to log entries, file changes, or polled status while the conversation continues. Lines are delivered in batches (at most one message every ${MIN_INTERVAL_MS / 1000} seconds). The watch ends at its deadline (${DEFAULT_DEADLINE_MS / 60_000} minutes by default, at most ${MAX_DEADLINE_MS / 60_000}) with one notice; stop it earlier with task_stop.`,
    promptSnippet: 'Watch a background command and react to each line it prints',
    promptGuidelines: ['Use monitor to watch logs, CI or PR status, or file changes instead of polling with sleep; make the command print only lines worth reacting to. Stop a monitor with task_stop once it is no longer needed.'],
    parameters: schema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) /* NOSONAR typescript:S7503 - pi types execute as returning a Promise */ {
      const refusal = monitorAllowed(ctx)
      if (refusal) throw new Error(refusal)
      if (params.command.trim() === '') throw new Error('command must not be empty')
      const limitMs = deadlineMs(params.timeout_ms)
      const shell = start(params.command, limitMs, ctx)
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
