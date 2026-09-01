/**
 * Turning hook output into decisions: parsing a hook's exit code / JSON into a
 * block-or-allow verdict, running the gated PreToolUse and UserPromptSubmit passes,
 * and shaping the PostToolUse feedback and system messages surfaced to the user.
 */

import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { PathAnchors } from '../internal/path-rules.js'
import { claudeToolInput, claudeToolName, piToolInput } from './claude-tools.js'
import { type HookCommand, type HooksConfig, isRecord } from './config.js'
import { allCommands, matchingCommands, passesIfFilter } from './matcher.js'
import { type HookRunner, type HookRunResult, timeoutMs } from './runners.js'

export interface HookDecision {
  block: boolean
  reason?: string
  /** Claude's `permissionDecision: "ask"`: the caller should prompt the user and
   * block only on decline. `block` stays true as the no-UI fallback. */
  ask?: boolean
}

export function tryParseJson(text: string):
  | {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; updatedInput?: unknown }
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
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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
  }
}

/** What PreToolUse resolved to: the decision, plus any additionalContext strings
 * the hooks contributed, delivered alongside the eventual tool result. */
export interface PreToolUseOutcome extends HookDecision {
  context?: string[]
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
  const results = await Promise.all(
    commands.map((command) =>
      runner(command, { hook_event_name: 'PreToolUse', tool_name: translatedName ?? toolName, tool_input: translatedInput ?? toolInput }, timeoutMs(command)).then((result) => {
        const updated = tryParseJson(result.stdout)?.hookSpecificOutput?.updatedInput
        if (isRecord(updated) && isRecord(toolInput)) {
          const replacement = translatedInput !== undefined ? piToolInput(toolName, updated) : updated
          if (replacement) replaceRecord(toolInput, replacement)
        }
        return result
      }),
    ),
  )
  surfaceHookFailures(commands, results, onSystemMessage)
  for (const [i, result] of results.entries()) {
    // A killed hook never reached its verdict, and SIGKILL leaves a null exit code that
    // would otherwise read as a clean allow. Fail closed instead.
    if (result.timedOut) return { block: true, reason: `Hook timed out after ${timeoutMs(commands[i])}ms: ${commands[i].command}` }
    // A hook that never spawned (EMFILE, missing /bin/sh) reached no verdict either;
    // its code 0 must fail closed like a timeout, not read as an allow exactly when
    // the machine is degraded.
    if (result.spawnFailed) return { block: true, reason: `Hook failed to run: ${commands[i].command}: ${result.stderr.trim() || 'unknown error'}` }
  }
  if (onSystemMessage) surfaceSystemMessages(results, onSystemMessage)
  // additionalContext is delivered alongside the tool result, so it only applies
  // when the call proceeds; defer discards it, as Claude documents.
  const context = results.flatMap((result) => {
    const parsed = tryParseJson(result.stdout)
    if (parsed?.hookSpecificOutput?.permissionDecision === 'defer') return []
    const text = parsed?.hookSpecificOutput?.additionalContext
    return typeof text === 'string' && text.length > 0 ? [text] : []
  })
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
