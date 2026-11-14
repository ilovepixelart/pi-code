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
 * Deviations: with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, or in a session without a UI
 * (print and json modes, subagents), where no later turn could receive a notification,
 * the tool runs as pi's bash does, which has no default timeout. Claude's Ctrl+B is not
 * offered.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type AgentToolResult, type BashOperations, createBashToolDefinition, createLocalBashOperations, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, SettingsManager } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'

import { type BackgroundShell, forgetShell, registerShell, settleShell, shellCompletionText, shellOutputDir, stopAllShells, stopShell } from './internal/background-shells.ts'
import { sessionHasTurns, sessionMailbox } from './internal/session-mailbox.ts'

/** BASH_DEFAULT_TIMEOUT_MS out of the box: two minutes. */
const DEFAULT_TIMEOUT_MS = 120_000
/** BASH_MAX_TIMEOUT_MS out of the box: ten minutes. */
const MAX_TIMEOUT_MS = 600_000

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

const bashSchema = Type.Object({
  command: Type.String({ description: 'Shell command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional). With no timeout, a command still running after 120 seconds moves to the background.' })),
  run_in_background: Type.Optional(Type.Boolean({ description: 'Run the command in the background and continue working; you are notified when it finishes.' })),
})

type BashParams = Static<typeof bashSchema>

const stopSchema = Type.Object({
  task_id: Type.String({ description: 'The ID of the background command to stop' }),
})

type ToolResult = AgentToolResult<unknown>
type Outcome = { result: ToolResult } | { error: unknown }

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }], details: undefined })

/** pi's own bash settings, which the built-in tool reads and a replacement must too. */
function shellSettings(ctx: ExtensionContext): { shellPath?: string; commandPrefix?: string } {
  try {
    const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted?.() === true })
    return { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() }
  } catch {
    return {}
  }
}

/** The exit code a settled run reports: the built-in tool resolves with it, and throws
 * for an aborted or killed command, which has none. */
function exitCodeOf(outcome: Outcome): number | undefined {
  if ('error' in outcome) return undefined
  const structured = (outcome.result as { structuredContent?: { exit_code?: unknown } }).structuredContent
  return typeof structured?.exit_code === 'number' ? structured.exit_code : undefined
}

export default function backgroundBashExtension(pi: ExtensionAPI) {
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
    const outputFile = path.join(shellOutputDir(), `${id}.output`)
    const log = fs.createWriteStream(outputFile, { mode: 0o600 })
    // A full disk or a removed directory must not take pi down from a stream event.
    log.on('error', () => {})

    // The process gets its own abort signal: the tool call's ends with the call, and a
    // command moved to the background must survive it.
    const lifetime = new AbortController()
    let backgrounded = params.run_in_background === true
    const forwardAbort = (): void => {
      if (!backgrounded) lifetime.abort()
    }
    if (signal?.aborted) lifetime.abort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })

    const { shellPath, commandPrefix } = shellSettings(ctx)
    const local = createLocalBashOperations({ shellPath })
    // The limit is enforced here, by moving to the background, so the built-in timeout
    // that would kill the command is not passed on.
    const operations: BashOperations = {
      exec: (command, cwd, options) =>
        local.exec(command, cwd, {
          ...options,
          timeout: undefined,
          signal: lifetime.signal,
          onData: (data) => {
            log.write(data)
            options.onData(data)
          },
        }),
    }
    const tool = createBashToolDefinition(ctx.cwd, { operations, shellPath, commandPrefix })
    const shell = registerShell({ id, command: params.command, outputFile, stop: () => lifetime.abort() })
    // Updates stop with the tool call: the call has returned once the command is in the background.
    const guardedUpdate = onUpdate && ((update: ToolResult) => !backgrounded && onUpdate(update))

    const settled: Promise<Outcome> = tool.execute(toolCallId, { command: params.command }, lifetime.signal, guardedUpdate as never, ctx).then(
      (result) => ({ result: result as ToolResult }),
      (error: unknown) => ({ error }),
    )
    void settled.then((outcome) => {
      signal?.removeEventListener('abort', forwardAbort)
      log.end()
      settleShell(shell, exitCodeOf(outcome))
      // Stopped through task_stop: the model asked for it and needs no notice.
      if (backgrounded && shell.state !== 'killed') notify(shell)
    })

    const where = `Output is being written to: ${outputFile}`
    if (backgrounded) return text(`Command running in background with ID: ${id}. ${where}. You will be notified when it completes; use task_stop to stop it.`)

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limitMs)
    })
    const first = await Promise.race([settled, deadline])
    clearTimeout(timer)
    // A command that finished in the same tick as the deadline is still a foreground result.
    if (first !== 'timeout' || shell.state !== 'running') {
      const outcome = first === 'timeout' ? await settled : first
      forgetShell(shell)
      if ('error' in outcome) throw outcome.error
      return outcome.result
    }
    backgrounded = true
    return text(`Command did not complete within its ${formatSeconds(limitMs)} timeout and was moved to the background (ID: ${id}). ${where}. You will be notified when it completes; use task_stop to stop it.`)
  }

  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description: `${builtin.description} Set run_in_background to start a long-running command (a dev server, a watcher, a long build) and keep working; a command that reaches its timeout also moves to the background instead of stopping, except one starting with sleep. Background output is written to a file you read with the read tool, and a message arrives when the command finishes.`,
    promptSnippet: builtin.promptSnippet,
    promptGuidelines: [...(builtin.promptGuidelines ?? []), 'Use bash run_in_background for commands that keep running, then read the output file it reports; do not poll with sleep. Stop a background command with task_stop.'],
    parameters: bashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { run_in_background, ...input } = params
      const native = (): Promise<ToolResult> => {
        const { shellPath, commandPrefix } = shellSettings(ctx)
        return createBashToolDefinition(ctx.cwd, { shellPath, commandPrefix }).execute(toolCallId, input, signal, onUpdate as never, ctx) as Promise<ToolResult>
      }
      if (!backgroundAllowed(ctx)) return native()
      // An invalid timeout gets the built-in tool's own error.
      if (input.timeout !== undefined && !(Number.isFinite(input.timeout) && input.timeout > 0)) return native()
      const limitMs = foregroundLimitMs(input.timeout)
      if (!run_in_background && startsWithSleep(input.command)) {
        const { shellPath, commandPrefix } = shellSettings(ctx)
        return createBashToolDefinition(ctx.cwd, { shellPath, commandPrefix }).execute(toolCallId, { command: input.command, timeout: limitMs / 1000 }, signal, onUpdate as never, ctx) as Promise<ToolResult>
      }
      return runTask(toolCallId, { ...input, run_in_background }, limitMs, signal, onUpdate as never, ctx)
    },
  })

  pi.registerTool({
    name: 'task_stop',
    label: 'task_stop',
    description: 'Stop a running background bash command by its ID.',
    promptSnippet: 'Stop a background bash command',
    parameters: stopSchema,
    async execute(_toolCallId, { task_id }) /* NOSONAR typescript:S7503 - pi types execute as returning a Promise */ {
      const outcome = stopShell(task_id)
      if (outcome === 'unknown') throw new Error(`No background command with ID ${task_id}`)
      if (outcome === 'not-running') return text(`Background command ${task_id} is not running.`)
      return text(`Stopped background command ${task_id}.`)
    },
  })

  pi.on('session_start', (_event, ctx) => notices.attach(pi, sessionHasTurns(ctx)))
  pi.on('agent_start', () => notices.markPrompted(pi))
  pi.on('session_shutdown', (event) => {
    notices.detach(pi)
    // On quit nothing is left to read a command's output: stop them all. A session
    // switch or /reload keeps them running; their notices go to the next session.
    if (event.reason === 'quit') stopAllShells()
  })
}
