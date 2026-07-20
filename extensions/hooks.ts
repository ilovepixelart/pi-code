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

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

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

export const runHookCommand: HookRunner = (command, payload, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: 0, stdout, stderr })
    })
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
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block) return decision
  }
  return { block: false }
}

async function runNotifyHooks(commands: HookCommand[], payload: unknown, runner: HookRunner): Promise<void> {
  await Promise.all(commands.map((command) => runner(command.command, payload, timeoutMs(command))))
}

export default function hooksExtension(pi: ExtensionAPI) {
  let config: HooksConfig = {}

  pi.on('session_start', async (_event, ctx) => {
    const trusted = ctx.isProjectTrusted?.() ?? false
    config = loadHooks(hookFiles(ctx.cwd, os.homedir(), trusted))
    await runNotifyHooks(matchingCommands(config.SessionStart, ''), { hook_event_name: 'SessionStart' }, runHookCommand)
  })

  pi.on('tool_call', async (event) => {
    const decision = await runPreToolUse(config, event.toolName, event.input, runHookCommand)
    return decision.block ? { block: true, reason: decision.reason } : undefined
  })

  pi.on('tool_execution_end', async (event) => {
    if (event.isError) return
    await runNotifyHooks(matchingCommands(config.PostToolUse, event.toolName), { hook_event_name: 'PostToolUse', tool_name: event.toolName }, runHookCommand)
  })
}
