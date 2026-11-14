/**
 * Background Bash: Claude's background commands on pi's bash tool.
 *
 * tools-reference, "Background commands": Claude "can set `run_in_background: true` to
 * start the command as a background task and continue working while it runs", and "when
 * a foreground command reaches its timeout without finishing, Claude Code moves it to
 * the background instead of stopping it, unless the command starts with `sleep`". The
 * output streams to a file the model reads, a notification arrives when the command
 * finishes, and TaskStop ends it early (registered here as task_stop).
 *
 * The timeout is BASH_DEFAULT_TIMEOUT_MS (two minutes) when the model passes none, and a
 * requested timeout is capped at the larger of that and BASH_MAX_TIMEOUT_MS (ten
 * minutes). pi's own bash tool takes its timeout in seconds, so the parameter keeps
 * pi's unit.
 *
 * The built-in tool still runs every command, through its operations seam: the output
 * formatting, truncation, renderer and exit-code handling are pi's own. This extension
 * only owns the process lifetime, so a command can outlive the tool call that started it.
 *
 * With CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 the tool has no `run_in_background`
 * parameter and a command is stopped at its timeout, as in Claude. Deviation: the same
 * holds in a session without a UI (print and json modes, subagents), where no later turn
 * could receive a notification. Claude's Ctrl+B is not offered.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type AgentToolResult, type BashOperations, type BashToolDetails, createBashToolDefinition, createLocalBashOperations, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, formatSize } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'

import { type BackgroundShell, forgetShell, markBackground, registerShell, runningShells, setShellsListener, settleShell, shellCompletionText, shellOutputDir, shellSettings, shellsFooterText, stopAllShells, stopShell } from './internal/background-shells.ts'
import { sessionHasTurns, sessionMailbox } from './internal/session-mailbox.ts'

/** BASH_DEFAULT_TIMEOUT_MS out of the box: two minutes. */
const DEFAULT_TIMEOUT_MS = 120_000
/** BASH_MAX_TIMEOUT_MS out of the box: ten minutes. */
const MAX_TIMEOUT_MS = 600_000
/** Claude stops a background command whose output passes 5 GB. */
const MAX_OUTPUT_BYTES = 5 * 1024 ** 3

const positiveMs = (raw: string | undefined): number | undefined => {
  const value = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** How long a command may run in the foreground before it moves to the background.
 * env-vars: the default applies "when Claude passes no timeout"; the maximum "caps
 * whatever Claude requests: the effective ceiling is the larger of the two". */
export function foregroundLimitMs(timeoutSeconds: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fallback = positiveMs(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
  const ceiling = Math.max(fallback, positiveMs(env.BASH_MAX_TIMEOUT_MS) ?? MAX_TIMEOUT_MS)
  return timeoutSeconds === undefined ? fallback : Math.min(timeoutSeconds * 1000, ceiling)
}

/** Claude stops, rather than backgrounds, a command that "starts with `sleep`". */
export function startsWithSleep(command: string): boolean {
  return /^\s*sleep(\s|$)/.test(command)
}

export function backgroundAllowed(ctx: Pick<ExtensionContext, 'hasUI'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return ctx.hasUI && env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== '1'
}

const formatSeconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`

const commandParam = Type.String({ description: 'Shell command to execute' })

/** `defaultMs` is the timeout in force when the model passes none. */
const bashSchema = (defaultMs: number) =>
  Type.Object({
    command: commandParam,
    timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (optional). With no timeout, a command still running after ${defaultMs / 1000} seconds moves to the background.` })),
    run_in_background: Type.Optional(Type.Boolean({ description: 'Run the command in the background and continue working; you are notified when it finishes.' })),
  })

/** The schema where background commands are off: Claude removes the parameter there. */
const foregroundSchema = (defaultMs: number) =>
  Type.Object({
    command: commandParam,
    timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (optional). With no timeout, a command is stopped after ${defaultMs / 1000} seconds.` })),
  })

type BashParams = Static<ReturnType<typeof bashSchema>>

const stopSchema = Type.Object({
  task_id: Type.Optional(Type.String({ description: 'The ID of the background command to stop' })),
  shell_id: Type.Optional(Type.String({ description: 'Deprecated: use task_id' })),
})

type ToolResult = AgentToolResult<BashToolDetails | undefined>
type Outcome = { result: ToolResult } | { error: unknown }

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }], details: undefined })

/** The exit code a settled run reports: the built-in tool resolves with it, and throws
 * for an aborted or killed command, which has none. */
function exitCodeOf(outcome: Outcome): number | undefined {
  if ('error' in outcome) return undefined
  const structured = (outcome.result as { structuredContent?: { exit_code?: unknown } }).structuredContent
  return typeof structured?.exit_code === 'number' ? structured.exit_code : undefined
}

/** A command's output file. `closed` settles once the stream has let go of it. */
function openOutputFile(id: string): { outputFile: string; log: fs.WriteStream; closed: Promise<void> } {
  const outputFile = path.join(shellOutputDir(), `${id}.output`)
  const log = fs.createWriteStream(outputFile, { mode: 0o600 })
  // A full disk or a removed directory must not take pi down from a stream event.
  log.on('error', () => {})
  const closed = new Promise<void>((resolve) => log.once('close', () => resolve()))
  return { outputFile, log, closed }
}

/** The outcome of a run that settles within `limitMs`, or undefined once that has passed. */
async function settledWithin(settled: Promise<Outcome>, limitMs: number): Promise<Outcome | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), limitMs)
  })
  const first = await Promise.race([settled, deadline])
  clearTimeout(timer)
  return first
}

function foregroundResult(outcome: Outcome): ToolResult {
  if ('error' in outcome) throw outcome.error
  return outcome.result
}

/** `limits.maxOutputBytes` is a test seam; pi passes only `pi`. */
export default function backgroundBashExtension(pi: ExtensionAPI, limits: { maxOutputBytes?: number } = {}): void {
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // A background command outlives a session switch, and this instance's pi throws once
  // its session is replaced; notices go to whichever session is current when it ends.
  const notices = sessionMailbox('bash-background')

  const notify = (shell: BackgroundShell): void => {
    notices.deliver((current, startsTurn) => {
      current.sendMessage({ customType: 'bash-background', content: shellCompletionText(shell), display: true }, { triggerTurn: startsTurn })
    })
  }

  const builtin = createBashToolDefinition(process.cwd())

  /** Run `command` as a task that may move to the background: immediately when
   * `background` is set, otherwise once `limitMs` passes without it finishing. */
  async function runTask(toolCallId: string, params: BashParams, limitMs: number, signal: AbortSignal | undefined, onUpdate: ((update: ToolResult) => void) | undefined, ctx: ExtensionToolContext): Promise<ToolResult> {
    const id = `b${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const { outputFile, log, closed } = openOutputFile(id)

    // The process gets its own abort signal: the tool call's ends with the call, and a
    // command moved to the background must survive it.
    const lifetime = new AbortController()
    let backgrounded = params.run_in_background === true
    const forwardAbort = (): void => {
      if (!backgrounded) lifetime.abort()
    }
    if (signal?.aborted) lifetime.abort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })

    /** The file the built-in tool saved the full output to, if it truncated any. The
     * model was pointed at the output file, never at this copy. */
    let builtinCopy: string | undefined
    const dropBuiltinCopy = (): void => {
      if (!backgrounded || !builtinCopy) return
      try {
        fs.rmSync(builtinCopy, { force: true })
      } catch {
        // Windows can refuse while the built-in tool still has the file open; the call
        // made when the command settles, after it has closed the file, removes it.
      }
    }
    // At quit pi exits before a stopped command settles, so the copy goes with the stop.
    const stop = (): void => {
      lifetime.abort()
      dropBuiltinCopy()
    }
    const shell = registerShell({ id, command: params.command, outputFile, stop, background: backgrounded })
    let written = 0
    /** Every chunk goes to the output file. The built-in tool's accumulator gets it only
     * while the call is waiting on the result: once the command is in the background
     * nothing reads that copy, and past its truncation limit it is a second file. */
    const onData = (data: Buffer, toBuiltin: (data: Buffer) => void): void => {
      if (shell.state !== 'running') return
      written += data.length
      log.write(data)
      if (!backgrounded) toBuiltin(data)
      else if (written > maxOutputBytes) stopShell(id, `its output passed the ${formatSize(maxOutputBytes)} limit`)
    }

    const { shellPath, commandPrefix } = shellSettings(ctx)
    const local = createLocalBashOperations({ shellPath })
    // The limit is enforced here, by moving to the background, so the built-in timeout
    // that would kill the command is not passed on.
    const operations: BashOperations = {
      exec: (command, cwd, options) => local.exec(command, cwd, { ...options, timeout: undefined, signal: lifetime.signal, onData: (data) => onData(data, options.onData) }),
    }
    const tool = createBashToolDefinition(ctx.cwd, { operations, shellPath, commandPrefix })
    // Updates stop with the tool call: the call has returned once the command is in the background.
    const update = (partial: ToolResult): void => {
      builtinCopy = partial.details?.fullOutputPath ?? builtinCopy
      if (!backgrounded) onUpdate?.(partial)
    }

    const settled: Promise<Outcome> = tool.execute(toolCallId, { command: params.command }, lifetime.signal, update as never, ctx).then(
      (result) => ({ result: result as ToolResult }),
      (error: unknown) => ({ error }),
    )
    void settled.then((outcome) => {
      signal?.removeEventListener('abort', forwardAbort)
      log.end()
      settleShell(shell, exitCodeOf(outcome))
      dropBuiltinCopy()
      if (!backgrounded) return
      // Stopped through task_stop: the model asked for it and needs no notice.
      if (shell.state !== 'killed' || shell.stopReason) notify(shell)
    })

    const where = `Output is being written to: ${outputFile}`
    if (backgrounded) return text(`Command running in background with ID: ${id}. ${where}. You will be notified when it completes; use task_stop to stop it.`)

    const outcome = await settledWithin(settled, limitMs)
    // A command that finished in the same tick as the deadline is still a foreground result.
    if (outcome !== undefined || shell.state !== 'running') {
      // The stream creates the file when it opens, which can be after the command has
      // ended: removing it before the stream has closed would leave it behind.
      await closed
      forgetShell(shell)
      return foregroundResult(outcome ?? (await settled))
    }
    backgrounded = true
    markBackground(shell)
    return text(`Command did not complete within its ${formatSeconds(limitMs)} timeout and was moved to the background (ID: ${id}). ${where}. You will be notified when it completes; use task_stop to stop it.`)
  }

  /** What the model is shown follows the session: pi re-describes a registered tool's
   * parameters only by registering it again, and whether a session has a UI is not known
   * before it starts. */
  const registerBash = (background: boolean): void => {
    const defaultMs = foregroundLimitMs(undefined)
    pi.registerTool({
      // Everything the built-in definition carries (output schema, constrained sampling,
      // renderers) stays, except what is replaced below.
      ...builtin,
      description: background
        ? `${builtin.description} Set run_in_background to start a long-running command (a dev server, a watcher, a long build) and keep working; a command that reaches its timeout also moves to the background instead of stopping, except one starting with sleep. Background output is written to a file you read with the read tool, and a message arrives when the command finishes.`
        : `${builtin.description} A command still running at its timeout is stopped.`,
      promptGuidelines: background ? [...(builtin.promptGuidelines ?? []), 'Use bash run_in_background for commands that keep running, then read the output file it reports; do not poll with sleep. Stop a background command with task_stop.'] : builtin.promptGuidelines,
      parameters: (background ? bashSchema(defaultMs) : foregroundSchema(defaultMs)) as ReturnType<typeof bashSchema>,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const { run_in_background, ...input } = params
        // The built-in tool, which stops a command at `timeout`; an invalid timeout gets its own error.
        const stopAtTimeout = (timeout: number | undefined): Promise<ToolResult> => {
          const { shellPath, commandPrefix } = shellSettings(ctx)
          return createBashToolDefinition(ctx.cwd, { shellPath, commandPrefix }).execute(toolCallId, { command: input.command, timeout }, signal, onUpdate as never, ctx) as Promise<ToolResult>
        }
        if (input.timeout !== undefined && !(Number.isFinite(input.timeout) && input.timeout > 0)) return stopAtTimeout(input.timeout)
        const allowed = backgroundAllowed(ctx)
        // Running it in the foreground instead would block the turn on a command that may never exit.
        if (run_in_background && !allowed) throw new Error('Background commands are not available in this session. Run the command in the foreground, with a timeout if it may not exit.')
        const limitMs = foregroundLimitMs(input.timeout)
        if (!allowed || (!run_in_background && startsWithSleep(input.command))) return stopAtTimeout(limitMs / 1000)
        return runTask(toolCallId, { ...input, run_in_background }, limitMs, signal, onUpdate as never, ctx)
      },
    })
  }
  registerBash(backgroundAllowed({ hasUI: true }))

  pi.registerTool({
    name: 'task_stop',
    label: 'task_stop',
    description: 'Stop a running background bash command or monitor by its ID.',
    promptSnippet: 'Stop a background bash command or monitor',
    parameters: stopSchema,
    async execute(_toolCallId, params) /* NOSONAR typescript:S7503 - pi types execute as returning a Promise */ {
      const task_id = params.task_id ?? params.shell_id
      if (task_id === undefined) throw new Error('task_id is required')
      const outcome = stopShell(task_id)
      if (outcome === 'unknown') throw new Error(`No background command with ID ${task_id}`)
      if (outcome === 'not-running') return text(`Background command ${task_id} is not running.`)
      return text(`Stopped background command ${task_id}.`)
    },
  })

  // The footer counts running background commands, as Claude's footer shows background tasks.
  const showFooter = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return
    const status = shellsFooterText(runningShells())
    ctx.ui.setStatus('background-shells', status === undefined ? undefined : ctx.ui.theme.fg('accent', status))
  }

  pi.on('session_start', (_event, ctx) => {
    registerBash(backgroundAllowed(ctx))
    notices.attach(pi, sessionHasTurns(ctx))
    setShellsListener(() => showFooter(ctx))
    // Commands that kept running across a session switch show from the start.
    showFooter(ctx)
  })
  pi.on('agent_start', () => notices.markPrompted(pi))
  pi.on('session_shutdown', (event) => {
    notices.detach(pi)
    setShellsListener(undefined)
    // On quit nothing is left to read a command's output: stop them all. A session
    // switch or /reload keeps them running; their notices go to the next session.
    if (event.reason === 'quit') stopAllShells()
  })
}
