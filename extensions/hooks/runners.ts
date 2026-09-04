/**
 * The hook runners: one per hook type (shell command incl. exec-form, http POST,
 * in-process prompt, mcp_tool call, agent subagent), plus the timeout budget and
 * the process-group kill used by the shell runner.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import { runAgent } from '../internal/agent-run.js'
import { callMcpTool } from '../internal/mcp-call.js'
import { completeText } from '../internal/model-complete.js'
import { killProcessTree } from '../internal/process-tree.js'
import { resolveShell } from '../internal/shell-resolve.js'
import { errorMessage } from '../internal/values.js'
import { type HookCommand, httpUrlAllowed, isBackgroundHook } from './config.js'

// Claude's defaults vary by type and event (600s for command/http/mcp_tool, 30s
// for prompt, 60s for agent, lowered to 30s on UserPromptSubmit and to a shared
// 1.5s budget on SessionEnd) and a timed-out hook proceeds; here one flat default
// applies and a timed-out PreToolUse or UserPromptSubmit hook fails closed (pi
// has no permission prompt to fall back on), so ten minutes of default budget
// would wedge the turn on a hung hook. Hooks that legitimately run long can
// raise their own per-hook `timeout`.
const DEFAULT_TIMEOUT_S = 60

/** Claude's per-type defaults where they are safe to mirror: 30s for `prompt`
 * hooks and 60s for `agent` hooks. Command/http/mcp_tool keep the flat 60s
 * documented divergence from Claude's 600 (a gated hook fails closed here, so ten
 * minutes of default budget would wedge the turn). */
const TYPE_DEFAULT_TIMEOUT_S: Record<string, number> = { prompt: 30, agent: 60 }

export interface HookRunResult {
  code: number
  stdout: string
  stderr: string
  /** The hook was killed at its timeout, so its exit code carries no verdict. */
  timedOut: boolean
  /** The process errored before delivering a verdict (spawn failure, EIO). */
  spawnFailed?: boolean
}
/** Runs one configured hook entry, whatever its type; boundRunner dispatches. */
export type HookRunner = (hook: HookCommand, payload: unknown, timeoutMs: number) => Promise<HookRunResult>
/** The shell path specifically; the statusline reuses it for its own command. With an
 * `args` array it becomes the exec path: `command` is spawned directly with those args.
 * `onChild` hands the caller a kill for the spawned tree, so a background hook that is
 * still running at session end can be reaped (Claude kills async hooks at teardown). */
/** How one command hook is spawned, beyond the payload and its budget. Grouped rather
 * than trailing off the parameter list: the exec form, the shell choice and the
 * declaring plugin are all per-hook fields that arrive together from one HookCommand. */
export interface HookSpawnOptions {
  projectDir?: string
  /** exec-form argv; shell-form when absent. */
  args?: string[]
  onChild?: (kill: () => void) => void
  shell?: string
  /** The declaring plugin's paths, exported to the child. */
  plugin?: { root: string; dataDir: string }
  /** Claude: "set automatically to the current session ID in ... hook command
   * subprocesses ... this matches the session_id field in the hook JSON input and
   * is updated on /clear." Absent in a stub context with no session manager. */
  sessionId?: string
}

export type HookCommandRunner = (command: string, payload: unknown, timeoutMs: number, options?: HookSpawnOptions) => Promise<HookRunResult>

/** Above 2^31-1 ms Node clamps a timer to 1ms, which would kill the hook instantly. */
const MAX_TIMEOUT_S = 2_147_483

export function timeoutMs(command: HookCommand): number {
  // Claude does not enforce `timeout` on an `async` command hook (it does on
  // `asyncRewake`), so the budget is the Node timer ceiling: the timer exists only
  // so the delay never clamps, not as a deadline. Still-running background hooks
  // are killed at session end instead.
  if (isBackgroundHook(command) && command.asyncRewake !== true) return MAX_TIMEOUT_S * 1000
  // Non-positive values fall back to the default: a 0ms timer would fire before the
  // hook runs, and a timed-out PreToolUse hook fails closed, bricking the tool.
  const declared = command.timeout
  const fallback = TYPE_DEFAULT_TIMEOUT_S[command.type ?? 'command'] ?? DEFAULT_TIMEOUT_S
  const seconds = typeof declared === 'number' && declared > 0 ? Math.min(declared, MAX_TIMEOUT_S) : fallback
  return seconds * 1000
}

/** Claude's SessionEnd budget: hooks share 1.5 seconds so session exit (and /new,
 * /resume) cannot stall on a slow hook; a declared per-hook `timeout` raises the
 * budget to match, up to 60 seconds. */
export function sessionEndTimeoutMs(command: HookCommand): number {
  const declared = command.timeout
  if (typeof declared === 'number' && declared > 0) return Math.min(declared, 60) * 1000
  return 1500
}

/** Memory backstop for a runaway hook. A decision payload is orders of magnitude smaller. */
const MAX_HOOK_OUTPUT = 1_000_000

/** Conventional exit code for a killed-on-timeout command, as `timeout(1)` reports it. */
const TIMEOUT_EXIT_CODE = 124

/** Kill the shell and everything it spawned; see internal/process-tree. */
function killTree(child: ChildProcess): void {
  killProcessTree(child, 'SIGKILL')
}

/** Create the plugin data directory the moment its path is handed to a child. Claude
 * describes it as "created on first reference"; a best-effort mkdir, since a hook whose
 * data dir cannot be created should still run. */
function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // The hook runs anyway; a script that needs the directory reports its own failure.
  }
}

/** The shell invocation for a shell-form command, or undefined when this machine has no
 * shell for it (Windows with neither Git Bash nor PowerShell). */
function shellInvocation(command: string, shell: string | undefined): { file: string; spawnArgs: string[] } | undefined {
  const resolved = resolveShell(shell)
  return resolved ? { file: resolved.file, spawnArgs: resolved.argsFor(command) } : undefined
}

export const runHookCommand: HookCommandRunner = (command, payload, timeoutMs, { projectDir, args, onChild, shell, plugin, sessionId } = {}) =>
  new Promise((resolve) => {
    // /bin/sh by absolute path off Windows, so the shell can't be resolved through an
    // attacker-controlled PATH; on Windows the resolver follows Claude's documented Git
    // Bash lookup. `detached` makes the shell its own process group leader so the
    // timeout can kill the descendants too. CLAUDE_PROJECT_DIR is Claude's documented way for a hook to
    // reference project files regardless of the shell's cwd. CLAUDECODE=1 marks every
    // subprocess Claude spawns, so it is set on the child unconditionally.
    // CLAUDE_CODE_CHILD_SESSION marks per-call children (hook and status line
    // commands), never long-lived stdio MCP servers, as Claude documents; COLUMNS
    // and LINES carry the terminal dimensions since the script's own width
    // detection cannot see the captured terminal.
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }
    if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir
    // Claude: "Claude Code sets this to its own process ID in the subprocesses it
    // spawns: Bash and PowerShell tool commands and hook commands." Set unconditionally,
    // since every hook child qualifies.
    env.CLAUDE_PID = String(process.pid)
    if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId
    // Claude: "All three are exported as environment variables to hook processes and to
    // MCP and LSP server subprocesses", so a plugin script can read them rather than
    // depend on inline substitution. The data directory is "created on first reference",
    // and exporting the path is that reference: a script should not have to mkdir it.
    if (plugin) {
      env.CLAUDE_PLUGIN_ROOT = plugin.root
      env.CLAUDE_PLUGIN_DATA = plugin.dataDir
      ensureDir(plugin.dataDir)
    }
    if (process.stdout.columns) env.COLUMNS = String(process.stdout.columns)
    if (process.stdout.rows) env.LINES = String(process.stdout.rows)
    // An exec-form hook (an `args` array) spawns the executable directly with those args
    // and no shell, so shell metacharacters in the args arrive literally; $ARGUMENTS in
    // each arg is replaced with the event JSON by a replacer function (so $$/$& in the
    // payload survive verbatim). Without args the command string goes to the platform's
    // shell, or to PowerShell when the hook says `shell: "powershell"`. Both share the
    // same detached process group, so killTree reaches the descendants either way.
    const target = Array.isArray(args) ? { file: command, spawnArgs: args.map((arg) => substituteArguments(arg, payload)) } : shellInvocation(command, shell)
    if (!target) {
      // Marked like a spawn failure so a gated event fails closed rather than reading as an allow.
      resolve({ code: 0, stdout: '', stderr: 'no shell found: install Git for Windows or PowerShell', timedOut: false, spawnFailed: true })
      return
    }
    // On Windows `detached` means DETACHED_PROCESS, which gives a console child its own
    // window; windowsHide keeps every hook invisible (a no-op elsewhere).
    const child = spawn(target.file, target.spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true, env })
    onChild?.(() => killTree(child))
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
    // Marked rather than silently read as a clean run: under fd exhaustion a
    // deny-list guard that never spawned would otherwise pass as an allow.
    child.on('error', (error) => finish({ code: 0, stdout, stderr: stderr || error.message, timedOut: false, spawnFailed: true }))
    // A hook that exits without reading stdin (e.g. `exit 2`) closes the pipe first,
    // so ignore EPIPE on this write rather than crashing the host process.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(payload))
  })

/** `$VAR` / `${VAR}` in header values, from allowlisted env vars only; a reference
 * to an unlisted variable becomes an empty string, as Claude documents. */
function interpolateHeaders(headers: Record<string, string> | undefined, allowed: string[] | undefined): Record<string, string> {
  const allowedSet = new Set(allowed ?? [])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = value.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_token, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? ''
      return allowedSet.has(name) ? (process.env[name] ?? '') : ''
    })
  }
  return out
}

/**
 * Claude's `type: "http"` hook: the payload POSTs as JSON and only a 2xx response
 * with a valid JSON body renders a decision, read exactly like command stdout.
 * Everything else, including non-2xx statuses, connection failures and timeouts,
 * is a non-blocking error by contract, so none of these outcomes ever reports
 * `timedOut`, which PreToolUse fails closed on. Claude's `allowedHttpHookUrls`
 * allowlist gates the fetch itself: a URL matching no entry is never contacted,
 * so a settings file cannot point a hook at an arbitrary endpoint and exfiltrate
 * the payload; when the setting is absent there are no restrictions, as Claude
 * documents. A blocked hook renders no decision, like every other http failure.
 */
export async function runHttpHook(hook: { type?: string; command: string; url?: string; headers?: Record<string, string>; allowedEnvVars?: string[] }, payload: unknown, timeoutMs: number, allowedUrls?: string[]): Promise<HookRunResult> {
  const url = hook.url ?? hook.command
  if (!httpUrlAllowed(url, allowedUrls)) return { code: 1, stdout: '', stderr: `${url} does not match allowedHttpHookUrls; the hook was not called`, timedOut: false }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...interpolateHeaders(hook.headers, hook.allowedEnvVars) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await response.text()).slice(0, MAX_HOOK_OUTPUT)
    if (!response.ok) return { code: 1, stdout: '', stderr: `HTTP ${response.status} from ${url}`, timedOut: false }
    if (body.trim().length === 0) return { code: 0, stdout: '', stderr: '', timedOut: false }
    try {
      JSON.parse(body)
    } catch {
      return { code: 1, stdout: '', stderr: `non-JSON response from ${url}`, timedOut: false }
    }
    return { code: 0, stdout: body, stderr: '', timedOut: false }
  } catch (error) {
    // A timeout is the abort that AbortSignal.timeout raises. Mark it as one so a gated
    // event fails closed on it, exactly as a command hook that ran out of time does: the
    // hook never answered, whichever transport it used.
    const name = error instanceof Error ? error.name : ''
    return { code: 1, stdout: '', stderr: errorMessage(error), timedOut: name === 'TimeoutError' || name === 'AbortError' }
  }
}

/** System prompt turning a prompt hook into a structured decision, so its reply
 * flows through interpretHookResult exactly like a command hook's stdout. */
const PROMPT_HOOK_SYSTEM = [
  'You are a Claude Code hook evaluating whether an action should proceed.',
  'Respond with ONLY a JSON object and nothing else:',
  '{"hookSpecificOutput":{"permissionDecision":"allow"|"deny"|"ask","permissionDecisionReason":"<short reason>"}}',
  'Use "allow" to let the action proceed, "deny" to block it, "ask" to require the user to confirm.',
].join('\n')

/**
 * Claude's `type: "prompt"` hook: the prompt (with `$ARGUMENTS` replaced by the
 * event JSON) is evaluated by the model, which returns a JSON decision. pi runs it
 * in-process via completeText and returns the reply as stdout so the existing
 * decision parser handles it. No model (headless) or a provider error is
 * non-blocking; only an abort at the timeout fails closed, like the other hooks.
 */
/** Replace `$ARGUMENTS` with the event JSON via a replacer function, so `$`-sequences
 * in the payload (`$$`, `$&`, `` $` ``, `$'`) are inserted literally, not read as
 * `String.replace` patterns. Prompt and agent hooks feed the result to the model. */
function substituteArguments(prompt: string | undefined, payload: unknown): string {
  const json = JSON.stringify(payload)
  return (prompt ?? '').replaceAll('$ARGUMENTS', () => json)
}

/** Classify a model/agent failure: the deadline is authoritative via the signal (the
 * subagent runner rejects with a plain Error on abort, so an error-name check alone
 * fails open), so a fired signal is a timeout (PreToolUse fails closed); anything else
 * produced no verdict and is non-blocking. */
function abortAwareFailure(signal: AbortSignal, error: unknown): HookRunResult {
  const aborted = signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  return { code: aborted ? TIMEOUT_EXIT_CODE : 1, stdout: '', stderr: errorMessage(error), timedOut: aborted }
}

export async function runPromptHook(hook: HookCommand, payload: unknown, model: Model<Api> | undefined, timeoutMs: number): Promise<HookRunResult> {
  if (!model) return { code: 1, stdout: '', stderr: 'no model available for prompt hook', timedOut: false }
  // A replacer function, so `$$`/`$&`/`` $` ``/`$'` inside the payload JSON are inserted
  // verbatim rather than read as replacement patterns (a Bash `echo $$` is a common trigger).
  // Claude: when $ARGUMENTS is not present, the input JSON is appended to the
  // prompt, so the model never evaluates blind.
  const template = hook.prompt ?? ''
  const withInput = template.includes('$ARGUMENTS') ? template : `${template}\n\n$ARGUMENTS`
  const prompt = substituteArguments(withInput, payload)
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const { text: answer } = await completeText(model, prompt, { system: PROMPT_HOOK_SYSTEM, maxTokens: 512, signal })
    return { code: 0, stdout: answer, stderr: '', timedOut: false }
  } catch (error) {
    return abortAwareFailure(signal, error)
  }
}

/** A dotted path into the hook's JSON input, or undefined when any step is missing. */
function lookupPath(payload: unknown, dotted: string): unknown {
  let current: unknown = payload
  for (const key of dotted.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Claude's ${path} substitution for mcp_tool input: string values may reference the
 * hook's JSON input, such as ${tool_input.file_path}. Arrays and nested objects are
 * walked; an unresolvable path stays literal; non-string looked-up values are
 * JSON-encoded into the string. */
function substituteInputPaths(value: unknown, payload: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([\w.]+)\}/g, (matchText, dotted: string) => {
      const found = lookupPath(payload, dotted)
      if (found === undefined) return matchText
      return typeof found === 'string' ? found : JSON.stringify(found)
    })
  }
  if (Array.isArray(value)) return value.map((entry) => substituteInputPaths(entry, payload))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteInputPaths(entry, payload)]))
  return value
}

/**
 * Claude's `type: "mcp_tool"` hook: call a tool on an already-connected MCP server
 * and treat its text output like command stdout. pi reaches the server through the
 * mcp-call seam the mcp extension registers. Like http, it never fails closed: a
 * missing server, a tool error, or the deadline is non-blocking.
 */
export async function runMcpToolHook(hook: HookCommand, payload: unknown, timeoutMs: number): Promise<HookRunResult> {
  if (!hook.server || !hook.tool) return { code: 1, stdout: '', stderr: 'mcp_tool hook needs server and tool', timedOut: false }
  // Claude: `input` is the arguments passed to the tool; without it the tool is
  // called with no arguments, never handed the whole event payload.
  const input = hook.input && typeof hook.input === 'object' ? (substituteInputPaths(hook.input, payload) as Record<string, unknown>) : {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<HookRunResult>((resolve) => {
    // Marked as a timeout so a gated event fails closed on it, like a command hook.
    timer = setTimeout(() => resolve({ code: 1, stdout: '', stderr: `mcp_tool hook timed out after ${timeoutMs}ms`, timedOut: true }), timeoutMs)
  })
  const call = callMcpTool(hook.server, hook.tool, input)
    .then((result): HookRunResult => ({ code: result.isError ? 1 : 0, stdout: result.text, stderr: '', timedOut: false }))
    .catch((error): HookRunResult => ({ code: 1, stdout: '', stderr: errorMessage(error), timedOut: false }))
  try {
    return await Promise.race([call, deadline])
  } finally {
    // Left running, the deadline timer pins the event loop for the full timeout
    // after the call resolves, delaying exit in a one-shot headless run.
    clearTimeout(timer)
  }
}

/**
 * Claude's experimental `type: "agent"` hook: spawn a subagent (Read/Grep/Glob) to
 * verify a condition, then return its final text as a JSON decision, parsed by the
 * same interpreter as a command hook. pi reaches the subagent through the agent-run
 * seam the subagent extension registers. Like the prompt hook, only an abort at the
 * deadline fails closed; a missing runner or a crashed agent is non-blocking.
 */
export async function runAgentHook(hook: HookCommand, payload: unknown, timeoutMs: number, sessionModelId: string | undefined): Promise<HookRunResult> {
  const prompt = substituteArguments(hook.prompt, payload)
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const answer = await runAgent({ prompt, model: hook.model ?? sessionModelId, systemPrompt: hook.systemPrompt, signal })
    return { code: 0, stdout: answer, stderr: '', timedOut: false }
  } catch (error) {
    return abortAwareFailure(signal, error)
  }
}
