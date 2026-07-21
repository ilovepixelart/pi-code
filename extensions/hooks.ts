/**
 * Claude Hooks Extension
 *
 * Runs Claude Code's `.claude/settings.json` hooks on pi's lifecycle events, so
 * a project's existing hooks work under pi:
 * - PreToolUse  -> pi `tool_call` (can block the tool)
 * - PostToolUse -> pi `tool_execution_end` (fire-and-forget)
 * - SessionStart-> pi `session_start` (fire-and-forget)
 *
 * Hook commands run via `sh -c` with the event JSON on stdin. A PreToolUse
 * hook blocks the tool by exiting 2 (stderr becomes the reason) or by printing
 * `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}` (or the older
 * `{"decision": "block"}`).
 *
 * Config is merged from ~/.claude/settings.json (always) plus the project's
 * .claude/settings.json and settings.local.json (only when the project is
 * trusted, since hooks execute arbitrary shell). Claude tool matchers are
 * PascalCase (`Bash`); pi tool names are lowercase (`bash`), so matchers are
 * applied case-insensitively.
 *
 * Docs: https://code.claude.com/docs/en/hooks.md
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { isProjectApproved } from './internal/project-approval.js'

const DEFAULT_TIMEOUT_S = 60

interface HookCommand {
  type?: string
  command: string
  timeout?: number
}
interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}
export type HooksConfig = Record<string, HookMatcher[]>

export interface HookDecision {
  block: boolean
  reason?: string
}
export interface HookRunResult {
  code: number
  stdout: string
  stderr: string
  /** The hook was killed at its timeout, so its exit code carries no verdict. */
  timedOut: boolean
}
export type HookRunner = (command: string, payload: unknown, timeoutMs: number) => Promise<HookRunResult>

/** Settings files to read, newest-winning. Project files load only when trusted. */
export function hookFiles(cwd: string, home: string, trusted: boolean): string[] {
  const files = [path.join(home, '.claude', 'settings.json')]
  if (trusted) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'))
  return files
}

export function loadHooks(files: string[]): HooksConfig {
  const config: HooksConfig = {}
  for (const file of files) {
    let parsed: { hooks?: HooksConfig }
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      continue
    }
    for (const [event, matchers] of Object.entries(parsed.hooks ?? {})) {
      if (Array.isArray(matchers)) config[event] = [...(config[event] ?? []), ...matchers]
    }
  }
  return config
}

function matcherApplies(matcher: string | undefined, name: string): boolean {
  if (!matcher || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`, 'i').test(name)
  } catch {
    return matcher.toLowerCase() === name.toLowerCase()
  }
}

/** Command specs whose matcher applies to the given tool/source name. */
export function matchingCommands(matchers: HookMatcher[] | undefined, name: string): HookCommand[] {
  const result: HookCommand[] = []
  for (const entry of matchers ?? []) {
    if (matcherApplies(entry.matcher, name)) result.push(...(entry.hooks ?? []))
  }
  return result
}

function tryParseJson(text: string): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }; decision?: string; reason?: string } | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Map a hook's exit code / output to a block-or-allow decision. */
export function interpretHookResult(code: number, stdout: string, stderr: string): HookDecision {
  if (code === 2) return { block: true, reason: stderr.trim() || 'Blocked by hook' }
  const parsed = tryParseJson(stdout)
  const specific = parsed?.hookSpecificOutput
  if (specific?.permissionDecision === 'deny') return { block: true, reason: specific.permissionDecisionReason ?? 'Blocked by hook' }
  if (parsed?.decision === 'block') return { block: true, reason: parsed.reason ?? 'Blocked by hook' }
  return { block: false }
}

/** Memory backstop for a runaway hook. A decision payload is orders of magnitude smaller. */
const MAX_HOOK_OUTPUT = 1_000_000

/** Conventional exit code for a killed-on-timeout command, as `timeout(1)` reports it. */
const TIMEOUT_EXIT_CODE = 124

/**
 * Kill the shell and everything it spawned. `sh -c 'a; b'` forks, so signalling the
 * direct child alone leaves a grandchild alive holding stdout/stderr.
 */
function killTree(child: ChildProcess): void {
  try {
    // Negative pid targets the whole process group, which `detached` gave the shell.
    if (child.pid) {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
  } catch {
    // Group already reaped, or the platform refused it; fall through to the direct kill.
  }
  child.kill('SIGKILL')
}

export const runHookCommand: HookRunner = (command, payload, timeoutMs) =>
  new Promise((resolve) => {
    // Absolute path so the shell can't be resolved through an attacker-controlled PATH.
    // `detached` makes the shell its own process group leader so the timeout can kill
    // the descendants too.
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: HookRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // Resolve from the timer itself rather than waiting for `close`: `close` fires only
    // once every stdio pipe is closed, and a grandchild that inherited them can hold the
    // promise pending long past the timeout, stalling the tool call that awaits it.
    const timer = setTimeout(() => {
      killTree(child)
      finish({ code: TIMEOUT_EXIT_CODE, stdout, stderr, timedOut: true })
    }, timeoutMs)
    // Decode on the stream: concatenating Buffers as strings mangles a multi-byte
    // character split across chunks, and a mangled byte in a hook's deny decision makes
    // it unparseable, which reads as an allow.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_HOOK_OUTPUT) stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_HOOK_OUTPUT) stderr += chunk
    })
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr, timedOut: false }))
    child.on('error', () => finish({ code: 0, stdout, stderr, timedOut: false }))
    // A hook that exits without reading stdin (e.g. `exit 2`) closes the pipe first,
    // so ignore EPIPE on this write rather than crashing the host process.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(payload))
  })

function timeoutMs(command: HookCommand): number {
  return (command.timeout ?? DEFAULT_TIMEOUT_S) * 1000
}

/** Run PreToolUse hooks for a tool; the first blocking verdict wins. */
export async function runPreToolUse(config: HooksConfig, toolName: string, toolInput: unknown, runner: HookRunner): Promise<HookDecision> {
  for (const command of matchingCommands(config.PreToolUse, toolName)) {
    const result = await runner(command.command, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }, timeoutMs(command))
    // A killed hook never reached its verdict, and SIGKILL leaves a null exit code that
    // would otherwise read as a clean allow. Fail closed instead.
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(command)}ms: ${command.command}` }
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block) return decision
  }
  return { block: false }
}

async function runNotifyHooks(commands: HookCommand[], payload: unknown, runner: HookRunner): Promise<void> {
  await Promise.all(commands.map((command) => runner(command.command, payload, timeoutMs(command))))
}

/** Bound on remembered tool inputs, in case a blocked or aborted call never ends. */
const MAX_PENDING_INPUTS = 100

export default function hooksExtension(pi: ExtensionAPI) {
  let config: HooksConfig = {}
  // tool_execution_end does not carry the tool's input, but Claude's PostToolUse
  // contract does, so remember it from tool_call keyed by the call id.
  const pendingInputs = new Map<string, unknown>()

  pi.on('session_start', async (event, ctx) => {
    const trusted = await isProjectApproved(ctx)
    config = loadHooks(hookFiles(ctx.cwd, os.homedir(), trusted))
    // Only fire SessionStart hooks on a genuine session begin, matched by source (Claude uses
    // "startup"/"resume"/...). "reload" and "fork" re-fire in-process and would double-run hooks.
    if (event.reason === 'reload' || event.reason === 'fork') return
    await runNotifyHooks(matchingCommands(config.SessionStart, event.reason), { hook_event_name: 'SessionStart', source: event.reason }, runHookCommand)
  })

  pi.on('tool_call', async (event) => {
    pendingInputs.set(event.toolCallId, event.input)
    if (pendingInputs.size > MAX_PENDING_INPUTS) {
      const oldest = pendingInputs.keys().next().value
      if (oldest !== undefined) pendingInputs.delete(oldest)
    }
    const decision = await runPreToolUse(config, event.toolName, event.input, runHookCommand)
    if (!decision.block) return undefined
    pendingInputs.delete(event.toolCallId) // a blocked tool never reaches tool_execution_end
    return { block: true, reason: decision.reason }
  })

  pi.on('tool_execution_end', async (event) => {
    const toolInput = pendingInputs.get(event.toolCallId)
    pendingInputs.delete(event.toolCallId)
    if (event.isError) return
    await runNotifyHooks(matchingCommands(config.PostToolUse, event.toolName), { hook_event_name: 'PostToolUse', tool_name: event.toolName, tool_input: toolInput, tool_response: event.result }, runHookCommand)
  })
}
