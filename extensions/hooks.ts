/**
 * Claude Hooks Extension
 *
 * Runs Claude Code's `.claude/settings.json` hooks on pi's lifecycle events, so
 * a project's existing hooks work under pi:
 * - PreToolUse      -> pi `tool_call` (can block the tool or rewrite its input)
 * - PostToolUse     -> pi `tool_result` (block reasons and additionalContext are
 *                      appended next to the tool result, as Claude documents)
 * - SessionStart    -> pi `session_start` (stdout/additionalContext is injected as
 *                      context before the first prompt via `before_agent_start`)
 * - UserPromptSubmit-> pi `input` (can block the prompt via `handled`, or inject
 *                      additional context by transforming the submitted text)
 * - Stop            -> pi `agent_end` (a block feeds its reason back as a new turn,
 *                      with stop_hook_active as the loop guard)
 * - PreCompact      -> pi `session_before_compact` (fire-and-forget)
 * - PostCompact     -> pi `session_compact` (fire-and-forget)
 * - PostToolUseFailure -> pi `tool_result` error branch (fire-and-forget)
 * - SessionEnd      -> pi `session_shutdown` (fire-and-forget)
 *
 * Every payload carries session_id, transcript_path (pi's session file), cwd,
 * permission_mode (plan-mode state off the shared bus) and effort; tool events add
 * tool_use_id. Every event honors the universal `systemMessage` output (a
 * user-facing warning).
 * `suppressOutput` is accepted and inert: pi never echoes hook stdout to the
 * transcript in the first place.
 *
 * SubagentStart/SubagentStop ride pi-code's own subagent extension, which publishes
 * child-run lifecycle on the shared bus (notify-style: a child has already exited by
 * the time SubagentStop fires, so its exit-2 block semantics cannot be honored).
 *
 * Hook commands run via `sh -c` with the event JSON on stdin. A PreToolUse
 * hook blocks the tool by exiting 2 (stderr becomes the reason) or by printing
 * `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}` (or the older
 * `{"decision": "block"}`).
 *
 * Config is merged from ~/.claude/settings.json (always) plus the project's
 * .claude/settings.json and settings.local.json (only when the project is
 * trusted, since hooks execute arbitrary shell). Matchers follow Claude's rule:
 * `*`/empty match all, plain names are exact (with `|`/`,` list separators), and
 * anything with other regex characters is an unanchored regex. Claude matchers
 * are PascalCase (`Bash`); pi tool names are lowercase (`bash`), so comparison
 * is case-insensitive and folds `-` to `_`.
 *
 * Docs: https://code.claude.com/docs/en/hooks.md
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { isMcpToolAliases, MCP_TOOLS_CHANNEL } from './internal/mcp-alias.js'
import { isPlanModeState, PLAN_MODE_CHANNEL } from './internal/plan-mode-state.js'
import { isProjectApproved } from './internal/project-approval.js'
import { isSubagentPhaseEvent, SUBAGENT_CHANNEL } from './internal/subagent-events.js'

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
export type HookRunner = (command: string, payload: unknown, timeoutMs: number, projectDir?: string) => Promise<HookRunResult>

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
    for (const [event, matchers] of Object.entries(parsed?.hooks ?? {})) {
      if (!Array.isArray(matchers)) continue
      // Entries are validated here rather than where they run: a hand-edited settings
      // file that writes `hooks` as an object instead of a list used to throw out of
      // the tool_call handler, and pi turns that into an error result, so every tool
      // call for the rest of the session failed with an opaque type error.
      const usable = matchers.filter((entry) => isUsableMatcher(entry, file, event))
      if (usable.length > 0) config[event] = [...(config[event] ?? []), ...usable]
    }
  }
  return config
}

/** Claude's rule: a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|`
 * is a list of exact names; anything else is an unanchored regex. */
const EXACT_MATCHER = /^[\w\- ,|]*$/

/** Claude names are PascalCase and keep dashes (`Bash`, `mcp__brave-search__x`);
 * pi names are lowercase with underscores, so comparison folds both. */
function foldName(name: string): string {
  return name.toLowerCase().replaceAll('-', '_')
}

function exactListApplies(matcher: string, names: readonly string[]): boolean {
  const tokens = new Set(
    matcher
      .split(/[|,]/)
      .map((token) => foldName(token.trim()))
      .filter(Boolean),
  )
  return names.some((name) => tokens.has(foldName(name)))
}

/** A matcher entry pi-code can run: an object whose `hooks` is a list. Anything else
 * is reported by name and skipped, so one bad entry costs its own hooks, not the
 * session's tool calls. */
function isUsableMatcher(entry: unknown, file: string, event: string): entry is HookMatcher {
  const candidate = entry as HookMatcher | null
  if (candidate === null || typeof candidate !== 'object') {
    console.warn(`pi-code-hooks: ignoring a non-object ${event} entry in ${file}`)
    return false
  }
  if (candidate.hooks !== undefined && !Array.isArray(candidate.hooks)) {
    console.warn(`pi-code-hooks: ignoring ${event} entry in ${file}: "hooks" must be a list`)
    return false
  }
  if (candidate.matcher !== undefined && typeof candidate.matcher !== 'string') {
    console.warn(`pi-code-hooks: ignoring ${event} entry in ${file}: "matcher" must be a string`)
    return false
  }
  return true
}

function matcherApplies(matcher: string | undefined, names: readonly string[]): boolean {
  if (!matcher || matcher === '*') return true
  if (EXACT_MATCHER.test(matcher)) return exactListApplies(matcher, names)
  try {
    const regex = new RegExp(matcher, 'i')
    return names.some((name) => regex.test(name))
  } catch {
    return exactListApplies(matcher, names)
  }
}

/** Claude settings may carry prompt/agent hook types with no command; running one
 * through `sh -c undefined` would throw out of the tool_call handler. */
function isRunnableHook(hook: HookCommand): boolean {
  return typeof hook.command === 'string' && (hook.type === undefined || hook.type === 'command')
}

/** Command specs whose matcher applies to any of the given tool/source names.
 * Multiple candidates let one event offer both the pi name and its Claude alias. */
export function matchingCommands(matchers: HookMatcher[] | undefined, names: string | readonly string[]): HookCommand[] {
  const candidates = typeof names === 'string' ? [names] : names
  const result: HookCommand[] = []
  const seen = new Set<string>()
  for (const entry of matchers ?? []) {
    if (!matcherApplies(entry.matcher, candidates)) continue
    for (const hook of (entry.hooks ?? []).filter(isRunnableHook)) {
      // Claude runs a handler defined in more than one settings file once.
      if (seen.has(hook.command)) continue
      seen.add(hook.command)
      result.push(hook)
    }
  }
  return result
}

function tryParseJson(text: string): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; updatedInput?: unknown }; decision?: string; reason?: string; continue?: boolean; stopReason?: string; systemMessage?: string } | undefined {
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
  // pi's tool_call return is allow-or-block, so "ask" (confirm) maps to block-with-reason
  // rather than a silent allow, which is the least-safe reading on a trust-gated path.
  if (specific?.permissionDecision === 'deny' || specific?.permissionDecision === 'ask') return { block: true, reason: specific.permissionDecisionReason ?? 'Blocked by hook' }
  if (parsed?.decision === 'block') return { block: true, reason: parsed.reason ?? 'Blocked by hook' }
  if (parsed?.continue === false) return { block: true, reason: parsed.stopReason ?? 'Blocked by hook' }
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

export const runHookCommand: HookRunner = (command, payload, timeoutMs, projectDir) =>
  new Promise((resolve) => {
    // Absolute path so the shell can't be resolved through an attacker-controlled PATH.
    // `detached` makes the shell its own process group leader so the timeout can kill
    // the descendants too. CLAUDE_PROJECT_DIR is Claude's documented way for a hook to
    // reference project files regardless of the shell's cwd.
    const env = projectDir ? { ...process.env, CLAUDE_PROJECT_DIR: projectDir } : process.env
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env })
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

/** Above 2^31-1 ms Node clamps a timer to 1ms, which would kill the hook instantly. */
const MAX_TIMEOUT_S = 2_147_483

function timeoutMs(command: HookCommand): number {
  // Non-positive values fall back to the default: a 0ms timer would fire before the
  // hook runs, and a timed-out PreToolUse hook fails closed, bricking the tool.
  const declared = command.timeout
  const seconds = typeof declared === 'number' && declared > 0 ? Math.min(declared, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S
  return seconds * 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pi's built-in file tools name the target parameter `path`; Claude's name it
 * `file_path`. Hook payloads are Claude-shaped, so built-in file-tool inputs are
 * translated on the way out, and updatedInput coming back is translated on the way in. */
const FILE_TOOL_NAMES = new Set(['read', 'write', 'edit'])

export function toClaudeToolInput(toolName: string, input: unknown): unknown {
  if (!FILE_TOOL_NAMES.has(toolName) || !isRecord(input) || input.file_path !== undefined) return input
  const { path, ...rest } = input
  return path === undefined ? input : { ...rest, file_path: path }
}

export function fromClaudeToolInput(toolName: string, input: unknown): unknown {
  if (!FILE_TOOL_NAMES.has(toolName) || !isRecord(input) || input.path !== undefined) return input
  const { file_path, ...rest } = input
  return file_path === undefined ? input : { ...rest, path: file_path }
}

/** Claude's updatedInput replaces the whole tool_input, and pi's tool_call contract is
 * in-place mutation, so the target object is emptied and refilled rather than reassigned. */
function replaceRecord(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

/** Run PreToolUse hooks for a tool; the first blocking verdict wins. For MCP tools the
 * matcher sees both the pi name and the Claude alias, and the payload reports the alias,
 * which is the name a Claude-written hook script expects in tool_name. A hook's
 * hookSpecificOutput.updatedInput replaces the tool input in place before the permission
 * decision applies, and later hooks see the rewritten input in their payload. */
export async function runPreToolUse(config: HooksConfig, toolName: string, toolInput: unknown, runner: HookRunner, claudeName?: string, onSystemMessage?: SystemMessageSink): Promise<HookDecision> {
  const names = claudeName ? [toolName, claudeName] : [toolName]
  for (const command of matchingCommands(config.PreToolUse, names)) {
    const result = await runner(command.command, { hook_event_name: 'PreToolUse', tool_name: claudeName ?? toolName, tool_input: toClaudeToolInput(toolName, toolInput) }, timeoutMs(command))
    // A killed hook never reached its verdict, and SIGKILL leaves a null exit code that
    // would otherwise read as a clean allow. Fail closed instead.
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(command)}ms: ${command.command}` }
    if (onSystemMessage) surfaceSystemMessages([result], onSystemMessage)
    const updated = tryParseJson(result.stdout)?.hookSpecificOutput?.updatedInput
    const translated = isRecord(updated) ? fromClaudeToolInput(toolName, updated) : updated
    if (isRecord(translated) && isRecord(toolInput)) replaceRecord(toolInput, translated)
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block) return decision
  }
  return { block: false }
}

async function runNotifyHooks(commands: HookCommand[], payload: unknown, runner: HookRunner): Promise<HookRunResult[]> {
  return await Promise.all(commands.map((command) => runner(command.command, payload, timeoutMs(command))))
}

type SystemMessageSink = (message: string) => void

/** Claude's universal systemMessage output field: a warning surfaced to the user. */
function surfaceSystemMessages(results: HookRunResult[], notify: SystemMessageSink): void {
  for (const result of results) {
    const message = tryParseJson(result.stdout)?.systemMessage
    if (message) notify(message)
  }
}

export interface PromptDecision {
  block: boolean
  reason?: string
  context: string
}

/** Additional context a UserPromptSubmit hook contributes: an explicit
 * hookSpecificOutput.additionalContext, or the raw stdout of a plain exit-0 hook. */
function promptContext(stdout: string): string {
  const parsed = tryParseJson(stdout)
  if (parsed) return parsed.hookSpecificOutput?.additionalContext ?? ''
  return stdout.trim()
}

/** Run UserPromptSubmit hooks: the first blocking verdict wins; otherwise their
 * additional context is concatenated for injection ahead of the prompt. */
export async function runUserPromptSubmit(config: HooksConfig, prompt: string, runner: HookRunner, onSystemMessage?: SystemMessageSink): Promise<PromptDecision> {
  const contexts: string[] = []
  for (const command of matchingCommands(config.UserPromptSubmit, 'UserPromptSubmit')) {
    const result = await runner(command.command, { hook_event_name: 'UserPromptSubmit', prompt }, timeoutMs(command))
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(command)}ms: ${command.command}`, context: '' }
    if (onSystemMessage) surfaceSystemMessages([result], onSystemMessage)
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block) return { block: true, reason: decision.reason, context: '' }
    const context = promptContext(result.stdout)
    if (context) contexts.push(context)
  }
  return { block: false, context: contexts.join('\n') }
}

/** pi's lifecycle vocabularies differ from Claude's documented ones. The matcher is
 * offered both spellings so existing configs keep firing either way, and the payload
 * reports the Claude value, which is what a Claude-written hook script parses. */
const SESSION_START_SOURCE: Record<string, string> = { startup: 'startup', new: 'clear', resume: 'resume', fork: 'fork' }
const PRECOMPACT_TRIGGER: Record<string, string> = { manual: 'manual', threshold: 'auto', overflow: 'auto' }
const SESSION_END_REASON: Record<string, string> = { quit: 'prompt_input_exit', new: 'clear', resume: 'resume', reload: 'other', fork: 'other' }

/** The raw pi value plus its Claude spelling, deduplicated, for matcher candidates. */
function claudeSpelling(map: Record<string, string>, raw: string): { names: string[]; value: string } {
  const value = map[raw] ?? raw
  return { names: value === raw ? [raw] : [raw, value], value }
}

export default function hooksExtension(pi: ExtensionAPI) {
  let config: HooksConfig = {}
  let projectDir = ''
  let pendingSessionContext: string[] = []
  let stopHookActive = false
  let sessionCtx: ExtensionContext | undefined
  /** Claude sends session_id, transcript_path, cwd and effort on every payload. */
  const commonPayload = (ctx: ExtensionContext): Record<string, unknown> => {
    const common: Record<string, unknown> = { session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, permission_mode: permissionMode }
    const transcript = ctx.sessionManager.getSessionFile()
    if (transcript) common.transcript_path = transcript
    if (ctx.thinkingLevel) common.effort = { level: ctx.thinkingLevel }
    return common
  }
  /** A runner bound to the firing context, filling the common fields into each stdin. */
  const boundRunner =
    (ctx: ExtensionContext, extra?: Record<string, unknown>): HookRunner =>
    (command, payload, ms) =>
      runHookCommand(command, { ...commonPayload(ctx), ...extra, ...(payload as Record<string, unknown>) }, ms, projectDir)
  // Claude matchers name MCP tools mcp__<server>__<tool>; pi-code registers them as
  // <server>_<tool>. The mcp extension publishes the mapping on pi's shared bus.
  const mcpAliases = new Map<string, string>()
  pi.events.on(MCP_TOOLS_CHANNEL, (data) => {
    if (!isMcpToolAliases(data)) return
    mcpAliases.clear()
    for (const entry of data) mcpAliases.set(entry.pi, entry.claude)
  })
  // Claude's permission_mode: pi has no permission system, but pi-code's plan mode is
  // the documented "plan" mode; its extension publishes the state on the shared bus.
  let permissionMode = 'default'
  pi.events.on(PLAN_MODE_CHANNEL, (data) => {
    if (isPlanModeState(data)) permissionMode = data.active ? 'plan' : 'default'
  })
  // Subagent lifecycle arrives over the bus without a pi context; the session context
  // captured at session_start supplies the common payload fields.
  pi.events.on(SUBAGENT_CHANNEL, async (data) => {
    if (!isSubagentPhaseEvent(data) || !sessionCtx) return
    const ctx = sessionCtx
    const eventName = data.phase === 'start' ? 'SubagentStart' : 'SubagentStop'
    const payload = { hook_event_name: eventName, agent_type: data.agentType, agent_id: data.agentId }
    const results = await runNotifyHooks(matchingCommands(config[eventName], data.agentType), payload, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })

  pi.on('session_start', async (event, ctx) => {
    sessionCtx = ctx
    const trusted = await isProjectApproved(ctx)
    projectDir = ctx.cwd
    config = loadHooks(hookFiles(ctx.cwd, os.homedir(), trusted))
    // "reload" re-fires in-process with the same conversation and would double-run hooks;
    // a fork is a genuine session begin, which Claude reports as source "fork".
    if (event.reason === 'reload') return
    const source = claudeSpelling(SESSION_START_SOURCE, event.reason)
    const commands = matchingCommands(config.SessionStart, source.names)
    const payload = { hook_event_name: 'SessionStart', source: source.value }
    const run = boundRunner(ctx)
    const results = await Promise.all(commands.map((command) => run(command.command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    pendingSessionContext = results.map((result) => promptContext(result.stdout)).filter(Boolean)
  })

  // Claude adds a SessionStart hook's additionalContext (or plain stdout) to the
  // conversation before the first prompt; pi's seam for that is a message injected
  // on the next agent start.
  pi.on('before_agent_start', async () => {
    if (pendingSessionContext.length === 0) return
    const content = pendingSessionContext.join('\n')
    pendingSessionContext = []
    return { message: { customType: 'claude-hook-context', content, display: false } }
  })

  pi.on('tool_call', async (event, ctx) => {
    const decision = await runPreToolUse(config, event.toolName, event.input, boundRunner(ctx, { tool_use_id: event.toolCallId }), mcpAliases.get(event.toolName), (message) => ctx.ui.notify(message, 'warning'))
    if (!decision.block) return undefined
    return { block: true, reason: decision.reason }
  })

  // Claude's PostToolUse runs after a successful call and feeds back into the result:
  // a decision:block reason (or exit-2 stderr) and additionalContext are appended next
  // to the tool result, which is where Claude documents they land. Failed executions
  // are skipped (Claude routes those to PostToolUseFailure, not bridged yet).
  pi.on('tool_result', async (event, ctx) => {
    const alias = mcpAliases.get(event.toolName)
    const names = alias ? [event.toolName, alias] : [event.toolName]
    const response = { content: event.content, details: event.details, isError: event.isError }
    // A failed execution fires Claude's PostToolUseFailure instead: notify-style, no
    // result patch, since the error content is already what the model sees.
    if (event.isError) {
      const failCommands = matchingCommands(config.PostToolUseFailure, names)
      if (failCommands.length === 0) return
      const run = boundRunner(ctx, { tool_use_id: event.toolCallId })
      const failPayload = { hook_event_name: 'PostToolUseFailure', tool_name: alias ?? event.toolName, tool_input: toClaudeToolInput(event.toolName, event.input), tool_response: response }
      const failResults = await Promise.all(failCommands.map((command) => run(command.command, failPayload, timeoutMs(command))))
      surfaceSystemMessages(failResults, (message) => ctx.ui.notify(message, 'warning'))
      return
    }
    const commands = matchingCommands(config.PostToolUse, names)
    if (commands.length === 0) return
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: alias ?? event.toolName,
      tool_input: toClaudeToolInput(event.toolName, event.input),
      tool_response: response,
    }
    const run = boundRunner(ctx, { tool_use_id: event.toolCallId })
    const results = await Promise.all(commands.map((command) => run(command.command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    const feedback: string[] = []
    for (const result of results) {
      const parsed = tryParseJson(result.stdout)
      if (!result.timedOut && result.code === 2) feedback.push(`PostToolUse hook: ${result.stderr.trim() || 'Blocked by hook'}`)
      else if (parsed?.decision === 'block') feedback.push(`PostToolUse hook: ${parsed.reason ?? 'Blocked by hook'}`)
      const context = parsed?.hookSpecificOutput?.additionalContext
      if (context) feedback.push(context)
    }
    if (feedback.length === 0) return
    return { content: [...event.content, ...feedback.map((text) => ({ type: 'text' as const, text }))] }
  })

  pi.on('input', async (event, ctx) => {
    // Only genuine user input; extension-injected messages (plan-mode, subagent) are not
    // prompts the user submitted.
    if (event.source === 'extension') return { action: 'continue' }
    const decision = await runUserPromptSubmit(config, event.text, boundRunner(ctx), (message) => ctx.ui.notify(message, 'warning'))
    if (decision.block) {
      // pi's input result has no reason channel, so surface why before consuming it.
      ctx.ui.notify(decision.reason ?? 'Prompt blocked by hook', 'error')
      return { action: 'handled' }
    }
    // Claude injects a UserPromptSubmit hook's context ahead of the prompt; transform is
    // pi's seam for rewriting the submitted text.
    if (decision.context) return { action: 'transform', text: `${decision.context}\n\n${event.text}` }
    return { action: 'continue' }
  })

  // Claude's Stop hook can prevent stopping: a block feeds its reason back as a new
  // turn, and stop_hook_active in the payload tells the next firing it is already
  // continuing from a stop hook, which is the hook script's documented loop guard.
  // Only exit 2 and decision:"block" continue; continue:false means "stay stopped".
  pi.on('agent_end', async (_event, ctx) => {
    const commands = matchingCommands(config.Stop, 'Stop')
    if (commands.length === 0) {
      stopHookActive = false
      return
    }
    const payload = { hook_event_name: 'Stop', stop_hook_active: stopHookActive }
    const run = boundRunner(ctx)
    const results = await Promise.all(commands.map((command) => run(command.command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    const block = results
      .filter((result) => !result.timedOut)
      .map((result) => {
        if (result.code === 2) return { block: true, reason: result.stderr.trim() || 'Stop blocked by hook' }
        const parsed = tryParseJson(result.stdout)
        if (parsed?.decision === 'block') return { block: true, reason: parsed.reason ?? 'Stop blocked by hook' }
        return { block: false, reason: '' }
      })
      .find((verdict) => verdict.block)
    stopHookActive = block !== undefined
    if (block) pi.sendMessage({ customType: 'claude-stop-hook', content: block.reason, display: true }, { triggerTurn: true })
  })

  pi.on('session_before_compact', async (event, ctx) => {
    const trigger = claudeSpelling(PRECOMPACT_TRIGGER, event.reason)
    const results = await runNotifyHooks(matchingCommands(config.PreCompact, trigger.names), { hook_event_name: 'PreCompact', trigger: trigger.value }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })

  pi.on('session_compact', async (event, ctx) => {
    const trigger = claudeSpelling(PRECOMPACT_TRIGGER, event.reason)
    const results = await runNotifyHooks(matchingCommands(config.PostCompact, trigger.names), { hook_event_name: 'PostCompact', trigger: trigger.value }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })

  pi.on('session_shutdown', async (event, ctx) => {
    const reason = claudeSpelling(SESSION_END_REASON, event.reason)
    const results = await runNotifyHooks(matchingCommands(config.SessionEnd, reason.names), { hook_event_name: 'SessionEnd', reason: reason.value }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
  })
}
