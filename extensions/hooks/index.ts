/**
 * Claude Hooks Extension
 *
 * Runs Claude Code's `.claude/settings.json` hooks on pi's lifecycle events, so
 * a project's existing hooks work under pi:
 * - PreToolUse      -> pi `tool_call` (can block the tool or rewrite its input), plus
 *                      pi `user_bash` for a `!`/`!!` command the user runs directly (the
 *                      model never issues these, so a deny-list guard would otherwise miss
 *                      them). No pi tool call exists there, so the payload reports the
 *                      Claude name "Bash"; a deny hands pi a synthetic failed result so
 *                      the command never runs. UserBashEvent carries no execution result
 *                      and fires only before the command runs, so it has no PostToolUse
 *                      counterpart (pi never delivers the output to observe).
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
 * - PostToolUseFailure -> pi `tool_result` error branch (stderr/additionalContext
 *                      appended to the failed result; it cannot block, the tool failed)
 * - SessionEnd      -> pi `session_shutdown` (fire-and-forget)
 * - InstructionsLoaded -> bridged from the shared instruction-events bus:
 *                      context-imports publishes session_start for the context
 *                      files that survived claudeMdExcludes (it owns exclusion,
 *                      so a file it removed from the prompt never announces)
 *                      and include for resolved @imports; claude-rules publishes
 *                      path_glob_match. Strictly observational: exit codes and
 *                      JSON output, systemMessage included, are ignored.
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
 * trusted, since hooks execute arbitrary shell). Claude's `disableAllHooks`
 * setting (managed settings or any honored file in that chain) short-circuits
 * the load entirely, so no event fires any hook; /hooks prints the resolved
 * chain per event with each entry's source settings file. Matchers follow Claude's rule:
 * `*`/empty match all, plain names are exact (with `|`/`,` list separators), and
 * anything with other regex characters is an unanchored regex. Claude matchers
 * are PascalCase (`Bash`); pi tool names are lowercase (`bash`), so comparison
 * is case-insensitive and folds `-` to `_`.
 *
 * Docs: https://code.claude.com/docs/en/hooks.md
 */

import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { INSTRUCTIONS_CHANNEL, isInstructionLoadEvent } from '../internal/instruction-events.js'
import { isMcpToolAliases, MCP_TOOLS_CHANNEL } from '../internal/mcp-alias.js'
import { isPlanModeState, PLAN_MODE_CHANNEL } from '../internal/plan-mode-state.js'
import { installedPlugins } from '../internal/plugins.js'
import { isProjectApproved } from '../internal/project-approval.js'
import { repoRoot } from '../internal/project-root.js'
import { isSubagentPhaseEvent, SUBAGENT_CHANNEL } from '../internal/subagent-events.js'
import { formatHooksSummary, type HookCommand, type HookMatcher, type HooksConfig, hookFiles, loadHooks, loadPluginHooks, readAllowedHttpHookUrls, readDisableAllHooks } from './config.js'
import { blockedToolCall, postToolFeedback, promptContext, runPreToolUse, runUserPromptSubmit, surfaceSystemMessages, tryParseJson } from './decisions.js'
import { matchingCommands } from './matcher.js'
import { type HookRunner, type HookRunResult, runAgentHook, runHookCommand, runHttpHook, runMcpToolHook, runPromptHook, timeoutMs } from './runners.js'

export * from './config.js'
export * from './decisions.js'
export * from './matcher.js'
export * from './runners.js'

/** The text of the last assistant message in a turn, for Claude's Stop-hook
 * `last_assistant_message`. Thinking and tool calls are dropped; a plain-string
 * content is returned as-is. */
export function lastAssistantText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
      .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

/** Claude overrides a Stop hook after it blocks this many times in a row with no user
 * progress, ending the turn with a warning rather than looping forever. */
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8

/** The consecutive-block cap for the Stop hook: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP when it
 * is a positive integer, else the default. A non-positive or malformed value falls back
 * to the default rather than capping at zero (which would suppress the very first block). */
export function stopHookBlockCap(env: Record<string, string | undefined> = process.env): number {
  const override = Number.parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? '', 10)
  return Number.isInteger(override) && override > 0 ? override : DEFAULT_STOP_HOOK_BLOCK_CAP
}

async function runNotifyHooks(commands: HookCommand[], payload: unknown, runner: HookRunner): Promise<HookRunResult[]> {
  return await Promise.all(commands.map((command) => runner(command, payload, timeoutMs(command))))
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
  /** Claude's allowedHttpHookUrls allowlist, resolved from the settings chain. */
  let allowedHttpHookUrls: string[] | undefined
  let pendingSessionContext: string[] = []
  let stopHookActive = false
  /** Consecutive Stop-hook blocks with no user progress between them. Reset on user input
   * and on a non-blocking Stop; at the cap the continuation is suppressed and the turn ends. */
  let stopHookBlockCount = 0
  let sessionCtx: ExtensionContext | undefined
  /** Claude's disableAllHooks escape hatch was set somewhere in the honored chain. */
  let hooksDisabled = false
  /** Which settings file each resolved entry came from, for the /hooks viewer. */
  const hookSources = new Map<HookMatcher, string>()
  /** Claude sends session_id, transcript_path, cwd and effort on every payload. */
  const commonPayload = (ctx: ExtensionContext): Record<string, unknown> => {
    const common: Record<string, unknown> = { session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, permission_mode: permissionMode }
    const transcript = ctx.sessionManager.getSessionFile()
    if (transcript) common.transcript_path = transcript
    if (ctx.thinkingLevel) common.effort = { level: ctx.thinkingLevel }
    return common
  }
  /** A runner bound to the firing context, filling the common fields into each
   * payload and dispatching on the entry's type. */
  const boundRunner =
    (ctx: ExtensionContext, extra?: Record<string, unknown>): HookRunner =>
    (hook, payload, ms) => {
      const merged = { ...commonPayload(ctx), ...extra, ...(payload as Record<string, unknown>) }
      if (hook.type === 'http') return runHttpHook(hook, merged, ms, allowedHttpHookUrls)
      if (hook.type === 'prompt') return runPromptHook(hook, merged, ctx.model, ms)
      if (hook.type === 'agent') return runAgentHook(hook, merged, ms, (ctx.model as { id?: string } | undefined)?.id)
      if (hook.type === 'mcp_tool') return runMcpToolHook(hook, merged, ms)
      return runHookCommand(hook.command, merged, ms, projectDir, hook.args)
    }
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
  // Claude's InstructionsLoaded hook has NO decision control: exit codes are
  // ignored and every JSON output field (systemMessage included) is discarded, so
  // dispatch is fire-and-forget on all paths. Two documented load reasons can
  // never fire honestly and are deliberate gaps, not approximations:
  // `nested_traversal` (pi does not lazily load a nested CLAUDE.md on subdirectory
  // entry) and `compact` (pi does not re-load instruction files after compaction).
  const fireInstructionsLoaded = (payload: Record<string, unknown>): void => {
    if (!sessionCtx) return
    const commands = matchingCommands(config.InstructionsLoaded, String(payload.load_reason))
    if (commands.length === 0) return
    void runNotifyHooks(commands, { hook_event_name: 'InstructionsLoaded', ...payload }, boundRunner(sessionCtx)).catch(() => {})
  }
  // Every load rides the shared bus: context-imports publishes session_start for
  // the context files that survived claudeMdExcludes and include for resolved
  // @imports (deduped there, once per file per session); claude-rules publishes
  // path_glob_match when a scoped rule attaches. Consuming the bus rather than
  // iterating raw contextFiles keeps this extension from announcing a file the
  // exclusion removed from the prompt; bus emit is synchronous, so the events
  // arrive regardless of extension load order.
  pi.events.on(INSTRUCTIONS_CHANNEL, (data) => {
    if (!isInstructionLoadEvent(data)) return
    fireInstructionsLoaded({ ...data })
  })

  // Subagent lifecycle arrives over the bus without a pi context; the session context
  // captured at session_start supplies the common payload fields.
  pi.events.on(SUBAGENT_CHANNEL, async (data) => {
    if (!isSubagentPhaseEvent(data) || !sessionCtx) return
    const ctx = sessionCtx
    const eventName = data.phase === 'start' ? 'SubagentStart' : 'SubagentStop'
    const payload = { hook_event_name: eventName, agent_type: data.agentType, agent_id: data.agentId }
    try {
      const results = await runNotifyHooks(matchingCommands(config[eventName], data.agentType), payload, boundRunner(ctx))
      surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    } catch {
      // The bus outlives the session: an event landing between /new disposing this
      // ctx and the next session_start hits disposed getters, and nothing awaits a
      // bus listener, so a throw here would escape as an unhandled rejection.
    }
  })

  pi.on('session_start', async (event, ctx) => {
    sessionCtx = ctx
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while a Stop-hook continuation streak is in flight; it must not
    // carry into the next session, so reset before any early return (disableAllHooks below).
    stopHookActive = false
    stopHookBlockCount = 0
    const trusted = await isProjectApproved(ctx)
    // Claude's CLAUDE_PROJECT_DIR is the project root, not the session cwd; a hook
    // referencing $CLAUDE_PROJECT_DIR/.claude/hooks/helper.sh must resolve from a
    // subdirectory session too.
    projectDir = repoRoot(ctx.cwd) ?? ctx.cwd
    const files = hookFiles(ctx.cwd, os.homedir(), trusted)
    hookSources.clear()
    allowedHttpHookUrls = readAllowedHttpHookUrls(files)
    // The disableAllHooks escape hatch, checked before any config loads: with no
    // config resolved, no event, plugin hooks included, can fire a hook.
    hooksDisabled = readDisableAllHooks(files)
    if (hooksDisabled) {
      config = {}
      pendingSessionContext = []
      return
    }
    config = loadHooks(files, hookSources)
    // Plugins are user-installed and enabled by user settings (see installedPlugins),
    // so a checked-out repo cannot toggle which code-bearing plugin hooks run.
    loadPluginHooks(config, installedPlugins(os.homedir()), hookSources)
    // "reload" re-fires in-process with the same conversation and would double-run hooks;
    // a fork is a genuine session begin, which Claude reports as source "fork".
    if (event.reason === 'reload') return
    const source = claudeSpelling(SESSION_START_SOURCE, event.reason)
    const commands = matchingCommands(config.SessionStart, source.names)
    const payload = { hook_event_name: 'SessionStart', source: source.value }
    const run = boundRunner(ctx)
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    pendingSessionContext = results.map((result) => promptContext(result.stdout)).filter(Boolean)
  })

  // Claude adds a SessionStart hook's additionalContext (or plain stdout) to the
  // conversation before the first prompt; pi's seam for that is a message injected
  // on the next agent start. The session_start InstructionsLoaded events arrive
  // over the bus from context-imports, which owns claudeMdExcludes; announcing
  // the raw contextFiles here would fire for a file the exclusion removed.
  pi.on('before_agent_start', async () => {
    if (pendingSessionContext.length === 0) return
    const content = pendingSessionContext.join('\n')
    pendingSessionContext = []
    return { message: { customType: 'claude-hook-context', content, display: false } }
  })

  pi.on('tool_call', async (event, ctx) => {
    const decision = await runPreToolUse(config, event.toolName, event.input, boundRunner(ctx, { tool_use_id: event.toolCallId }), mcpAliases.get(event.toolName), (message) => ctx.ui.notify(message, 'warning'))
    if (!decision.block) return undefined
    // Claude's "ask": prompt the user and let the call through if they approve.
    // With no UI (headless) the block stands, which is the safe default.
    if (decision.ask && ctx.hasUI) {
      const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, decision.reason ?? 'A hook asks you to confirm this tool call.')
      return approved ? undefined : blockedToolCall(decision.reason)
    }
    return blockedToolCall(decision.reason)
  })

  // Claude's PostToolUse (success) and PostToolUseFailure (error) both feed their
  // hook's output back next to the tool result: a decision:block reason (or exit-2
  // stderr) and additionalContext are appended, which is where Claude documents they
  // land. The failure branch shows the hook's stderr to the model too ("Shows stderr
  // to Claude; the tool already failed"), it just cannot block a call that failed.
  pi.on('tool_result', async (event, ctx) => {
    const alias = mcpAliases.get(event.toolName)
    const names = alias ? [event.toolName, alias] : [event.toolName]
    const response = { content: event.content, details: event.details, isError: event.isError }
    const eventName = event.isError ? 'PostToolUseFailure' : 'PostToolUse'
    const commands = matchingCommands(event.isError ? config.PostToolUseFailure : config.PostToolUse, names)
    if (commands.length === 0) return
    const payload = { hook_event_name: eventName, tool_name: alias ?? event.toolName, tool_input: event.input, tool_response: response }
    const run = boundRunner(ctx, { tool_use_id: event.toolCallId })
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    const feedback = results.flatMap((result) => postToolFeedback(result, eventName, event.isError))
    if (feedback.length === 0) return
    return { content: [...event.content, ...feedback.map((text) => ({ type: 'text' as const, text }))] }
  })

  // Claude's PreToolUse for Bash, extended to a command the user runs directly with the
  // `!`/`!!` prefix. pi fires user_bash before executing it, and the model never sees it,
  // so without this a guard that blocks `git push -f` from the model would not stop the
  // same command typed by hand. There is no pi tool call, so the matcher sees both pi's
  // "bash" and the Claude name "Bash" (exactly as an MCP alias is bridged) and the payload
  // reports "Bash", the tool_name a Claude-written PreToolUse Bash hook expects. The
  // payload carries no tool_use_id (no model tool call produced it). UserBashEventResult
  // exposes no block flag: a deny is enforced through `result` ("extension handled
  // execution, use this result"), a synthetic failed BashResult that stands in for the
  // command so it never runs and its deny reason shows as the output. The event delivers
  // no execution result and fires only before the command runs, so there is deliberately
  // no PostToolUse for it.
  pi.on('user_bash', async (event, ctx) => {
    const decision = await runPreToolUse(config, 'bash', { command: event.command }, boundRunner(ctx), 'Bash', (message) => ctx.ui.notify(message, 'warning'))
    if (!decision.block) return undefined
    // Claude's "ask": prompt before running and let the command through on approval; with
    // no UI (headless) the block stands, the same safe default as the tool_call path.
    if (decision.ask && ctx.hasUI) {
      const approved = await ctx.ui.confirm('Allow this command?', decision.reason ?? 'A hook asks you to confirm this command.')
      if (approved) return undefined
    }
    const reason = decision.reason ?? 'Command blocked by hook'
    return { result: { output: `Blocked by hook: ${reason}`, exitCode: 1, cancelled: false, truncated: false } }
  })

  pi.on('input', async (event, ctx) => {
    // Only genuine user input; extension-injected messages (plan-mode, subagent) are not
    // prompts the user submitted.
    if (event.source === 'extension') return { action: 'continue' }
    // Genuine user input is progress, so it breaks a Stop-hook continuation streak: the
    // block cap counts only consecutive blocks with nothing from the user in between.
    stopHookBlockCount = 0
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
  //
  // On agent_end rather than agent_settled: agent_settled is only emitted after every
  // agent_end handler returns, and a peer extension (plan mode) blocks its agent_end
  // handler on a UI dialog, which would starve the Stop hook and idle notification
  // until the user answers it. agent_end can fire slightly early before a rare
  // automatic retry or compaction; that is the better tradeoff.
  pi.on('agent_end', async (event, ctx) => {
    // Claude's Notification event, for the one type pi can honestly source: the
    // agent finished and is waiting for input (idle_prompt). Observational only;
    // exit codes and JSON output are ignored, as Claude documents for this event.
    const notifyCommands = matchingCommands(config.Notification, ['idle_prompt'])
    if (notifyCommands.length > 0) {
      void runNotifyHooks(notifyCommands, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'pi is waiting for your input' }, boundRunner(ctx)).catch(() => {})
    }

    const commands = matchingCommands(config.Stop, 'Stop')
    if (commands.length === 0) {
      stopHookActive = false
      return
    }
    // Claude's Stop payload carries the turn's final assistant text so a hook need
    // not re-read the transcript; included only when there is one.
    const lastText = lastAssistantText((event as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [])
    const payload = { hook_event_name: 'Stop', stop_hook_active: stopHookActive, ...(lastText ? { last_assistant_message: lastText } : {}) }
    const run = boundRunner(ctx)
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
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
    if (!block) {
      // A non-blocking Stop breaks the streak: the next block starts a fresh count.
      stopHookActive = false
      stopHookBlockCount = 0
      return
    }
    stopHookBlockCount += 1
    const cap = stopHookBlockCap()
    if (stopHookBlockCount >= cap) {
      // Claude overrides a Stop hook that has blocked cap times in a row with no user
      // progress: suppress the continuation, warn, and let the turn end so the loop cannot
      // run forever. Reset the count so a later run (or user turn) starts clean.
      stopHookActive = false
      stopHookBlockCount = 0
      ctx.ui.notify(`Stop hook block cap reached (${cap} consecutive blocks); ending the turn.`, 'warning')
      return
    }
    stopHookActive = true
    pi.sendMessage({ customType: 'claude-stop-hook', content: block.reason, display: true }, { triggerTurn: true })
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

  // Claude's /hooks manages hook configuration; pi-code's is a viewer: hook failures
  // are otherwise opaque, so showing the resolved chain per event, with the settings
  // file each entry came from, is the debugging surface.
  pi.registerCommand('hooks', {
    description: 'Show the hook configuration resolved from settings',
    handler: async (_args, ctx) => {
      if (hooksDisabled) {
        ctx.ui.notify('All hooks are disabled by the disableAllHooks setting.', 'info')
        return
      }
      ctx.ui.notify(formatHooksSummary(config, hookSources), 'info')
    },
  })
}
