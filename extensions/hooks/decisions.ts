/**
 * Turning hook output into decisions: parsing a hook's exit code / JSON into a
 * block-or-allow verdict, running the gated PreToolUse and UserPromptSubmit passes,
 * and shaping the PostToolUse feedback and system messages surfaced to the user.
 */

import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import { type HookCommand, type HooksConfig, isRecord } from './config.js'
import { matchingCommands } from './matcher.js'
import { type HookRunner, type HookRunResult, timeoutMs } from './runners.js'

export interface HookDecision {
  block: boolean
  reason?: string
  /** Claude's `permissionDecision: "ask"`: the caller should prompt the user and
   * block only on decline. `block` stays true as the no-UI fallback. */
  ask?: boolean
}

export function tryParseJson(text: string): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; updatedInput?: unknown }; decision?: string; reason?: string; continue?: boolean; stopReason?: string; systemMessage?: string } | undefined {
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
  // Claude's "ask" prompts the user; the tool_call handler turns this into a
  // ctx.ui.confirm and blocks only on decline. block:true is the fallback for a
  // headless run with no dialog to show, which is the safe reading on a gated path.
  if (specific?.permissionDecision === 'ask') return { block: true, ask: true, reason: specific.permissionDecisionReason ?? 'A hook asks you to confirm this tool call.' }
  if (specific?.permissionDecision === 'deny') return { block: true, reason: specific.permissionDecisionReason ?? 'Blocked by hook' }
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

/** Run PreToolUse hooks for a tool, in parallel as Claude does; the first blocking
 * verdict in config order wins. For MCP tools the matcher sees both the pi name and
 * the Claude alias, and the payload reports the alias, which is the name a
 * Claude-written hook script expects in tool_name. Every hook sees the original
 * tool input; hookSpecificOutput.updatedInput replaces the input in place as each
 * hook completes, so with several rewrites the last to finish takes effect, which
 * is Claude's documented (non-deterministic) behavior. */
export async function runPreToolUse(config: HooksConfig, toolName: string, toolInput: unknown, runner: HookRunner, claudeName?: string, onSystemMessage?: SystemMessageSink): Promise<HookDecision> {
  const names = claudeName ? [toolName, claudeName] : [toolName]
  const commands = matchingCommands(config.PreToolUse, names)
  const results = await Promise.all(
    commands.map((command) =>
      runner(command, { hook_event_name: 'PreToolUse', tool_name: claudeName ?? toolName, tool_input: toolInput }, timeoutMs(command)).then((result) => {
        const updated = tryParseJson(result.stdout)?.hookSpecificOutput?.updatedInput
        if (isRecord(updated) && isRecord(toolInput)) replaceRecord(toolInput, updated)
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
  // A hard deny wins over an ask, matching Claude's deny > ask > allow precedence:
  // scan for any deny first, and only fall back to the first ask.
  let ask: HookDecision | undefined
  for (const result of results) {
    const decision = interpretHookResult(result.code, result.stdout, result.stderr)
    if (decision.block && !decision.ask) return decision
    if (decision.ask && ask === undefined) ask = decision
  }
  return ask ?? { block: false }
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
 * in config order for injection ahead of the prompt. */
export async function runUserPromptSubmit(config: HooksConfig, prompt: string, runner: HookRunner, onSystemMessage?: SystemMessageSink): Promise<PromptDecision> {
  const commands = matchingCommands(config.UserPromptSubmit, 'UserPromptSubmit')
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
  else if (!isError && parsed?.decision === 'block') lines.push(`PostToolUse hook: ${parsed.reason ?? 'Blocked by hook'}`)
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
