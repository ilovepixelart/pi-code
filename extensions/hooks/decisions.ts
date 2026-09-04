/**
 * Turning hook output into decisions: parsing a hook's exit code / JSON into a
 * block-or-allow verdict, running the gated PreToolUse and UserPromptSubmit passes,
 * and shaping the PostToolUse feedback and system messages surfaced to the user.
 */

import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { PathAnchors } from '../internal/path-rules.js'
import { errorMessage, isRecord } from '../internal/values.js'
import { claudeToolInput, claudeToolName, piToolInput } from './claude-tools.js'
import type { HookCommand, HooksConfig } from './config.js'
import { allCommands, matchingCommands, passesIfFilter } from './matcher.js'
import { type HookRunner, type HookRunResult, timeoutMs } from './runners.js'

export interface HookDecision {
  block: boolean
  reason?: string
  /** Claude's `permissionDecision: "ask"`: the caller should prompt the user and
   * block only on decline. `block` stays true as the no-UI fallback. */
  ask?: boolean
}

/** Claude's stdout shape rule: only output that starts with `{` and ends with `}`
 * (ignoring surrounding whitespace) is read as JSON output; a JSON array, a quoted
 * string, or a bare number is plain text. Multi-line output whose lines each parse
 * as JSON on their own with no output field set is plain text too (that case
 * arrives here as a parse failure and hookJsonError sorts it from a real error). */
export function tryParseJson(text: string):
  | {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; updatedInput?: unknown; suppressOriginalPrompt?: boolean }
      decision?: string
      reason?: string
      continue?: boolean
      stopReason?: string
      systemMessage?: string
      updatedToolOutput?: unknown
      updatedMCPToolOutput?: unknown
      ok?: boolean
    }
  | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ReturnType<typeof tryParseJson>) : undefined
  } catch {
    return undefined
  }
}

/** Top-level JSON output fields; a multi-line output where a line sets one of
 * these is a parse failure rather than plain text, as Claude documents. */
const OUTPUT_FIELDS = new Set(['decision', 'reason', 'continue', 'stopReason', 'systemMessage', 'suppressOutput', 'hookSpecificOutput', 'updatedToolOutput', 'updatedMCPToolOutput', 'ok'])

/** Claude reports a `<hook> hook error` notice when {..}-shaped stdout cannot be
 * read as JSON output, and does not treat that stdout as plain text. Returns the
 * error message for that case; undefined for valid JSON output and for output the
 * shape rule already reads as plain text (including the multi-line case). */
export function hookJsonError(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  let parseError: string
  try {
    JSON.parse(trimmed)
    return undefined
  } catch (error) {
    parseError = errorMessage(error)
  }
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length >= 2 && !multiLineSetsOutputField(lines)) return undefined
  return `invalid JSON output: ${parseError}`
}

/** Whether every line parses as JSON and at least one sets an output field; a
 * non-JSON line means the multi-line rule does not apply (still a parse error). */
function multiLineSetsOutputField(lines: string[]): boolean {
  let setsField = false
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return true // not all-JSON: the whole output is a parse failure
    }
    if (parsed !== null && typeof parsed === 'object' && Object.keys(parsed).some((key) => OUTPUT_FIELDS.has(key))) setsField = true
  }
  return setsField
}

/** The reason a JSON body's blocking decision carries, whichever spelling made it. */
function jsonBlockingReason(parsed: ReturnType<typeof tryParseJson>): string | undefined {
  if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') return parsed.hookSpecificOutput.permissionDecisionReason
  if (parsed?.decision === 'block') return parsed.reason
  if (parsed?.continue === false) return parsed.stopReason
  return undefined
}

/** A blocking verdict in any of the JSON spellings a hook can answer with: the
 * command-hook fields, and the prompt/agent reply schemas (`permissionDecision:
 * "deny"` from pi's prompt-hook system prompt, `ok: false` from Claude's documented
 * prompt-hook response). Undefined when the body renders no block. */
export function jsonBlockVerdict(parsed: ReturnType<typeof tryParseJson>, fallback: string): { reason: string } | undefined {
  if (parsed?.decision === 'block') return { reason: parsed.reason ?? fallback }
  if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') return { reason: parsed.hookSpecificOutput.permissionDecisionReason ?? fallback }
  if (parsed?.ok === false) return { reason: parsed.reason ?? fallback }
  return undefined
}

/** Map a hook's exit code / output to a block-or-allow decision. */
export function interpretHookResult(code: number, stdout: string, stderr: string): HookDecision {
  const parsed = tryParseJson(stdout)
  // Claude: on exit 2 the blocking message is the JSON blocking decision's reason
  // when it makes one, and the stderr text otherwise.
  if (code === 2) return { block: true, reason: jsonBlockingReason(parsed) ?? (stderr.trim() || 'Blocked by hook') }
  const specific = parsed?.hookSpecificOutput
  // Claude's "ask" prompts the user; the tool_call handler turns this into a
  // ctx.ui.confirm and blocks only on decline. block:true is the fallback for a
  // headless run with no dialog to show, which is the safe reading on a gated path.
  if (specific?.permissionDecision === 'ask') return { block: true, ask: true, reason: specific.permissionDecisionReason ?? 'A hook asks you to confirm this tool call.' }
  if (specific?.permissionDecision === 'deny') return { block: true, reason: specific.permissionDecisionReason ?? 'Blocked by hook' }
  // Claude's "defer" exits gracefully so the tool can be resumed later; pi cannot
  // resume a deferred call, so running it now would invert the intent. The block
  // carries its own explanation (the hook's reason is ignored for defer, as
  // documented).
  if (specific?.permissionDecision === 'defer') return { block: true, reason: 'Tool call deferred by hook; pi cannot resume a deferred call, so it was not run.' }
  if (parsed?.decision === 'block') return { block: true, reason: parsed.reason ?? 'Blocked by hook' }
  if (parsed?.continue === false) return { block: true, reason: parsed.stopReason ?? 'Blocked by hook' }
  return { block: false }
}

/** Claude's updatedInput replaces the whole tool_input, and pi's tool_call contract is
 * in-place mutation, so the target object is emptied and refilled rather than reassigned. */
function replaceRecord(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

/** Claude surfaces a hook error notice; on ungated events the action proceeds, while
 * PreToolUse and UserPromptSubmit additionally fail closed on the same results (see
 * their spawnFailed checks). Silence would hide that a guard never ran. */
function surfaceHookFailures(commands: HookCommand[], results: HookRunResult[], notify?: SystemMessageSink): void {
  if (!notify) return
  for (const [i, result] of results.entries()) {
    if (result.spawnFailed) notify(`Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}`)
    // Claude shows a `<hook> hook error` notice when {..}-shaped stdout cannot be
    // read as JSON output (exit 2 still blocks and reads its own channels).
    const jsonError = result.code === 2 ? undefined : hookJsonError(result.stdout)
    if (jsonError !== undefined) {
      notify(`${commands[i].command} hook error: ${jsonError}`)
      continue
    }
    // A non-zero exit that is neither a block (2) nor a timeout, with nothing parseable
    // on stdout, is Claude's non-blocking error: the action proceeds and the notice
    // carries the first line of stderr. Without it a mistyped path in settings.json
    // leaves a policy hook silently disabled, since the shell exits 127 and says so only
    // on stderr. A spawn failure is reported above and skipped here.
    if (!result.spawnFailed && !result.timedOut && result.code !== 0 && result.code !== 2) {
      const firstLine = result.stderr.trim().split('\n')[0]
      notify(`${commands[i].command} hook error: Failed with non-blocking status code: ${firstLine || result.code}`)
    }
  }
}

/** What PreToolUse resolved to: the decision, plus any additionalContext strings
 * the hooks contributed, delivered alongside the eventual tool result. */
export interface PreToolUseOutcome extends HookDecision {
  context?: string[]
}

/** Apply a hook's updatedInput rewrite in place, translating a built-in rewrite
 * back to the pi shape; an incomplete built-in rewrite keeps the original input
 * rather than corrupting it. */
function applyUpdatedInput(toolName: string, toolInput: unknown, translated: boolean, stdout: string): void {
  const updated = tryParseJson(stdout)?.hookSpecificOutput?.updatedInput
  if (!isRecord(updated) || !isRecord(toolInput)) return
  const replacement = translated ? piToolInput(toolName, updated) : updated
  if (replacement) replaceRecord(toolInput, replacement)
}

/** The fail-closed scan for the gated events: a timed-out or never-spawned hook
 * reached no verdict, and its silence must not read as an allow. */
function failClosedVerdict(commands: HookCommand[], results: HookRunResult[]): HookDecision | undefined {
  for (const [i, result] of results.entries()) {
    // A killed hook never reached its verdict, and SIGKILL leaves a null exit code
    // that would otherwise read as a clean allow.
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(commands[i])}ms: ${commands[i].command}` }
    // A hook that never spawned (EMFILE, missing /bin/sh) reached no verdict either;
    // its code 0 must fail closed like a timeout, not read as an allow exactly when
    // the machine is degraded.
    if (result.spawnFailed) return { block: true, reason: `Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}` }
  }
  return undefined
}

/** additionalContext strings the PreToolUse hooks contributed; delivered alongside
 * the tool result, so a deferring hook's context is discarded, as Claude documents. */
function preToolContexts(results: HookRunResult[]): string[] {
  return results.flatMap((result) => {
    const parsed = tryParseJson(result.stdout)
    if (parsed?.hookSpecificOutput?.permissionDecision === 'defer') return []
    const text = parsed?.hookSpecificOutput?.additionalContext
    return typeof text === 'string' && text.length > 0 ? [text] : []
  })
}

/** Run PreToolUse hooks for a tool, in parallel as Claude does; the first blocking
 * verdict in config order wins. The payload reports the Claude vocabulary: the MCP
 * alias for MCP tools, and the documented name and tool_input shape for pi's
 * built-ins (see claude-tools). Every hook sees the original tool input;
 * hookSpecificOutput.updatedInput replaces the input in place as each hook
 * completes, translated back to the pi shape for a built-in (an incomplete rewrite
 * keeps the original input rather than corrupting it), so with several rewrites
 * the last to finish takes effect (the docs leave multi-rewrite ordering
 * unspecified). */
export async function runPreToolUse(config: HooksConfig, toolName: string, toolInput: unknown, runner: HookRunner, claudeName?: string, onSystemMessage?: SystemMessageSink, anchors?: PathAnchors): Promise<PreToolUseOutcome> {
  const cwd = anchors?.cwd ?? process.cwd()
  const translatedName = claudeName ?? claudeToolName(toolName)
  // A built-in's payload input is the translated Claude shape; MCP and unknown
  // tools keep the pi shape (MCP input passes through untranslated in Claude too).
  const translatedInput = claudeName === undefined ? claudeToolInput(toolName, toolInput, cwd) : undefined
  const names = translatedName ? [toolName, translatedName] : [toolName]
  const target = anchors ? { piName: toolName, claudeName: translatedName, input: toolInput, anchors } : undefined
  const commands = matchingCommands(config.PreToolUse, names).filter((command) => passesIfFilter(command, target))
  const payload = { hook_event_name: 'PreToolUse', tool_name: translatedName ?? toolName, tool_input: translatedInput ?? toolInput }
  const results = await Promise.all(
    commands.map((command) =>
      runner(command, payload, timeoutMs(command)).then((result) => {
        applyUpdatedInput(toolName, toolInput, translatedInput !== undefined, result.stdout)
        return result
      }),
    ),
  )
  surfaceHookFailures(commands, results, onSystemMessage)
  const failClosed = failClosedVerdict(commands, results)
  if (failClosed) return failClosed
  if (onSystemMessage) surfaceSystemMessages(results, onSystemMessage)
  const context = preToolContexts(results)
  // A hard deny wins over an ask, matching Claude's deny > ask > allow precedence:
  // scan for any deny first, and only fall back to the first ask.
  let ask: HookDecision | undefined
  for (const result of results) {
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block && !decision.ask) return decision
    if (decision.ask && ask === undefined) ask = decision
  }
  return ask ?? { block: false, context: context.length > 0 ? context : undefined }
}

type SystemMessageSink = (message: string) => void

/** Claude's universal systemMessage output field: a warning surfaced to the user. */
export function surfaceSystemMessages(results: HookRunResult[], notify: SystemMessageSink): void {
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
export function promptContext(stdout: string): string {
  const parsed = tryParseJson(stdout)
  if (parsed) return parsed.hookSpecificOutput?.additionalContext ?? ''
  // Malformed JSON output is an error, not plain text: no context is added.
  if (hookJsonError(stdout) !== undefined) return ''
  return stdout.trim()
}

/** Run UserPromptSubmit hooks, in parallel as Claude does: the first blocking
 * verdict in config order wins; otherwise their additional context is concatenated
 * in config order for injection ahead of the prompt. The event has no matcher
 * support (a stray matcher is ignored) and an `if`-carrying hook never runs here. */
export async function runUserPromptSubmit(config: HooksConfig, prompt: string, runner: HookRunner, onSystemMessage?: SystemMessageSink): Promise<PromptDecision> {
  const commands = allCommands(config.UserPromptSubmit).filter((command) => passesIfFilter(command, undefined))
  const results = await Promise.all(commands.map((command) => runner(command, { hook_event_name: 'UserPromptSubmit', prompt }, timeoutMs(command))))
  surfaceHookFailures(commands, results, onSystemMessage)
  for (const [i, result] of results.entries()) {
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(commands[i])}ms: ${commands[i].command}`, context: '' }
    // No verdict was delivered, so fail closed like a timeout (see runPreToolUse).
    if (result.spawnFailed) return { block: true, reason: `Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}`, context: '' }
  }
  if (onSystemMessage) surfaceSystemMessages(results, onSystemMessage)
  const contexts: string[] = []
  for (const result of results) {
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block) return { block: true, reason: decision.reason, context: '' }
    const context = promptContext(result.stdout)
    if (context) contexts.push(context)
  }
  return { block: false, context: contexts.join('\n') }
}

/** The feedback lines one PostToolUse/PostToolUseFailure result appends next to the
 * tool result: a block notice (exit-2 stderr, or decision:block on success) followed
 * by any additionalContext. A failed tool cannot be blocked, so its stderr is shown
 * but never a decision:block verdict. */
export function postToolFeedback(result: HookRunResult, eventName: string, isError: boolean): string[] {
  const lines: string[] = []
  const parsed = tryParseJson(result.stdout)
  // A failed tool cannot be blocked, but the hook's stderr is still shown; on
  // success, exit-2 / decision:block feed back as a block notice.
  if (!result.timedOut && result.code === 2) lines.push(`${eventName} hook: ${result.stderr.trim() || (isError ? 'hook reported an error' : 'Blocked by hook')}`)
  else if (!isError) {
    // Any JSON blocking spelling feeds back, including the prompt/agent hook reply
    // schemas (permissionDecision deny, ok:false), which arrive as stdout here.
    const verdict = jsonBlockVerdict(parsed, 'Blocked by hook')
    if (verdict) lines.push(`PostToolUse hook: ${verdict.reason}`)
  }
  const context = parsed?.hookSpecificOutput?.additionalContext
  if (context) lines.push(context)
  return lines
}

/** A blocked tool_call verdict carrying pi's `terminate` flag (#7715): with it set on
 * an all-terminating tool batch, pi skips the automatic follow-up model call that a plain
 * block would otherwise pay for. */
export function blockedToolCall(reason: string | undefined): ToolCallEventResult {
  return { block: true, reason, terminate: true }
}
