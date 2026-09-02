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
 * - PostCompact     -> pi `session_compact` (fire-and-forget); the same event also
 *                      fires SessionStart with source "compact", as Claude does
 *                      when a session continues after compaction
 * - PostModelSwitch -> pi `model_select` (after the change, matched against the new
 *                      model id; stdout context rides the next agent start;
 *                      PreModelSwitch stays unbridged, pi has no veto seam)
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
 * tool_use_id. The universal `systemMessage` output (a user-facing warning) is
 * honored on the decision-bearing events; the observational paths (Notification,
 * InstructionsLoaded) ignore it, as Claude documents for them.
 * `suppressOutput` is accepted and inert: pi never echoes hook stdout to the
 * transcript in the first place.
 * Payloads speak Claude's vocabulary for pi's built-in tools: tool_name Bash/Edit/
 * Write/Read/Grep/Glob, the documented tool_input shapes with absolute file_path,
 * and the documented Bash/Write tool_response shapes, with `updatedInput`
 * translated back to pi's shape (see claude-tools; an incomplete rewrite keeps
 * the original input). PreToolUse `additionalContext` lands next to the tool
 * result; `updatedToolOutput` replaces the output the model sees (schema-checked
 * for built-ins, unvalidated for MCP); `permissionDecision: "defer"` blocks the
 * call, since pi cannot resume a deferred one. The `if` permission-rule filter is
 * honored on tool events, and a hook carrying it never runs elsewhere; Stop and
 * UserPromptSubmit ignore a stray matcher, and a Stop hook's `additionalContext`
 * continues the conversation under the same block cap.
 * `async`/`asyncRewake` (command hooks only, as Claude documents) run in the
 * background on every event: they never block or delay the event that fired them
 * and render no decision. An asyncRewake hook exiting 2 wakes the model with its
 * stderr (stdout when stderr is empty) as a new turn; any other background
 * completion delivers the JSON response's systemMessage/additionalContext to the
 * model on the next turn, shown to nobody else. No timeout is enforced on `async`
 * (asyncRewake keeps its own), and hooks still running at session end are killed,
 * as Claude does at teardown.
 *
 * SubagentStart runs through the pre-spawn seam (internal/subagent-hooks) so its
 * additionalContext reaches the child before its first prompt; it cannot block a
 * spawn, as Claude documents. SubagentStop rides the subagent extension's bus stop
 * event (notify-style: the child has already exited, so exit-2 block semantics
 * cannot be honored) and carries last_assistant_message. Inside a subagent child,
 * agent-frontmatter hooks arrive via PI_CODE_AGENT_HOOKS (Stop pre-converted to
 * SubagentStop, fired at the child's own agent end) and die with the process.
 *
 * Hook commands run through the platform shell (`sh -c`; on Windows Git Bash, or
 * PowerShell when Git Bash is absent, see internal/shell-resolve) with the event JSON
 * on stdin. A PreToolUse
 * hook blocks the tool by exiting 2 (stderr becomes the reason) or by printing
 * `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}` (or the older
 * `{"decision": "block"}`).
 *
 * Config is merged from managed policy settings, ~/.claude/settings.json (always),
 * the project's .claude/settings.json and settings.local.json (only when the
 * project is trusted, since hooks execute arbitrary shell), plugins, and invoked
 * skills' frontmatter. Claude's `disableAllHooks` is tiered: at the managed level
 * it turns everything off; in any honored settings file it disables the
 * non-managed hooks while managed policy hooks keep running. /hooks prints the
 * resolved chain per event with each entry's source. Matchers follow Claude's rule:
 * `*`/empty match all, plain names are exact (with `|`/`,` list separators), and
 * anything with other regex characters is an unanchored regex. Claude matchers
 * are PascalCase (`Bash`); pi tool names are lowercase (`bash`), so comparison
 * is case-insensitive and folds `-` to `_`.
 *
 * Docs: https://code.claude.com/docs/en/hooks.md
 */

import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { claudeEffortLevel } from '../internal/effort.js'
import { INSTRUCTIONS_CHANNEL, isInstructionLoadEvent } from '../internal/instruction-events.js'
import { readManagedSettings } from '../internal/managed-settings.js'
import { isMcpToolAliases, MCP_TOOLS_CHANNEL } from '../internal/mcp-alias.js'
import { resolveModelOverride } from '../internal/model-lookup.js'
import { isPlanModeState, PLAN_MODE_CHANNEL } from '../internal/plan-mode-state.js'
import { installedPlugins } from '../internal/plugins.js'
import { isProjectApproved } from '../internal/project-approval.js'
import { repoRoot } from '../internal/project-root.js'
import { watchSettingsFiles } from '../internal/settings-watch.js'
import { isSkillHooksEvent, SKILL_HOOKS_CHANNEL } from '../internal/skill-hooks.js'
import { isSubagentPhaseEvent, SUBAGENT_CHANNEL } from '../internal/subagent-events.js'
import { setSubagentStartHookRunner } from '../internal/subagent-hooks.js'
import { contentText } from '../internal/values.js'
import { claudeToolInput, claudeToolName, claudeToolResponse, piToolOutput } from './claude-tools.js'
import { formatHooksSummary, type HookCommand, type HookMatcher, type HooksConfig, hookFiles, isBackgroundHook, loadHooks, loadManagedHooks, loadPluginHooks, mergeAgentEnvHooks, mergeSkillHooks, readAllowedHttpHookUrls, readDisableAllHooks, readSettingsDisableAllHooks } from './config.js'
import { blockedToolCall, jsonBlockVerdict, postToolFeedback, promptContext, runPreToolUse, runUserPromptSubmit, surfaceSystemMessages, tryParseJson } from './decisions.js'
import { allCommands, matchingCommands, passesIfFilter } from './matcher.js'
import { type HookRunner, type HookRunResult, runAgentHook, runHookCommand, runHttpHook, runMcpToolHook, runPromptHook, sessionEndTimeoutMs, timeoutMs } from './runners.js'

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
    return contentText(message.content)
  }
  return ''
}

/** Claude overrides a Stop hook after it blocks this many times in a row with no user
 * progress, ending the turn with a warning rather than looping forever. */
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8

/** The consecutive-block cap for the Stop hook: CLAUDE_CODE_STOP_HOOK_BLOCK_CAP when it
 * is a positive integer, the documented "disable the cap" for 0 (unbounded, not a
 * zero-cap that would suppress the very first block), else the default for a negative
 * or malformed value. */
export function stopHookBlockCap(env: Record<string, string | undefined> = process.env): number {
  const override = Number.parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? '', 10)
  if (override === 0) return Number.POSITIVE_INFINITY
  return Number.isInteger(override) && override > 0 ? override : DEFAULT_STOP_HOOK_BLOCK_CAP
}

async function runNotifyHooks(commands: HookCommand[], payload: unknown, runner: HookRunner): Promise<HookRunResult[]> {
  // Non-tool events: a hook carrying `if` never runs, as Claude documents.
  const runnable = commands.filter((command) => passesIfFilter(command, undefined))
  return await Promise.all(runnable.map((command) => runner(command, payload, timeoutMs(command))))
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

/** Claude: idle_prompt fires when "Claude finished responding about 60 seconds ago
 * and you haven't typed since". */
const IDLE_PROMPT_DELAY_MS = 60_000

/** pi's model_select sources in Claude's PostModelSwitch vocabulary: an explicit
 * set is a command-style request, cycling is the picker, and restore is the model
 * Claude Code restores on resume. */
const MODEL_SELECT_SOURCE: Record<string, string> = { set: 'command', cycle: 'picker', restore: 'resume' }

/** One Stop hook result read as a verdict. Claude: `continue` "takes precedence over any
 * event-specific decision fields", and stopReason is the message shown when it is false,
 * so a hook asking to stop wins over its own block whatever exit code carried it. Any
 * blocking spelling counts, including the prompt and agent hook reply schemas, and a
 * non-error additionalContext feeds back the same way so the block cap still bounds it. */
function stopVerdict(result: HookRunResult, stopMessages: string[]): { block: boolean; reason: string } {
  const parsed = tryParseJson(result.stdout)
  if (parsed?.continue === false) {
    if (parsed.stopReason) stopMessages.push(String(parsed.stopReason))
    return { block: false, reason: '' }
  }
  if (result.code === 2) return { block: true, reason: jsonBlockVerdict(parsed, 'Stop blocked by hook')?.reason ?? (result.stderr.trim() || 'Stop blocked by hook') }
  const verdict = jsonBlockVerdict(parsed, 'Stop blocked by hook')
  if (verdict) return { block: true, reason: verdict.reason }
  const context = parsed?.hookSpecificOutput?.additionalContext
  if (typeof context === 'string' && context.length > 0) return { block: true, reason: context }
  return { block: false, reason: '' }
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
  /** Tool start times per call id, for Claude's duration_ms on PostToolUse: the
   * clock starts after PreToolUse hooks and any confirm dialog resolve. */
  const toolStartTimes = new Map<string, number>()
  /** The pending idle_prompt notification: Claude fires it when the turn ended about
   * 60 seconds ago and the user hasn't typed since, so it arms on agent_end and is
   * canceled by input or the next turn. */
  let idlePromptTimer: ReturnType<typeof setTimeout> | undefined
  const cancelIdlePrompt = (): void => {
    clearTimeout(idlePromptTimer)
    idlePromptTimer = undefined
  }
  let sessionCtx: ExtensionContext | undefined
  /** Set inside a subagent child that carries agent-frontmatter hooks: the child's
   * own agent end fires their SubagentStop, per Claude's Stop conversion. */
  let agentIdentity: { agent: string; id?: string } | undefined
  /** Claude's allowManagedHooksOnly: only the managed hook set runs. */
  let managedHooksOnly = false
  /** Skill hooks registered this session, re-applied when a settings edit reloads. */
  const registeredSkillHooks: Array<{ skillName: string; hooks: Record<string, unknown> }> = []
  /** Stops the settings watcher of the previous session. */
  let disposeSettingsWatch: () => void = () => {}
  /** Claude's disableAllHooks escape hatch was set somewhere in the honored chain. */
  let hooksDisabled = false
  /** Which settings file each resolved entry came from, for the /hooks viewer. */
  const hookSources = new Map<HookMatcher, string>()
  /** PreToolUse additionalContext per tool call, delivered alongside its result. */
  const pendingToolContext = new Map<string, string[]>()
  /** Claude sends session_id, transcript_path, cwd and effort on every payload. */
  const commonPayload = (ctx: ExtensionContext): Record<string, unknown> => {
    const common: Record<string, unknown> = { session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, permission_mode: permissionMode }
    const transcript = ctx.sessionManager.getSessionFile()
    if (transcript) common.transcript_path = transcript
    // Claude vocabulary only: pi's minimal maps to low and off carries no effort.
    const effort = claudeEffortLevel(ctx.thinkingLevel)
    if (effort) common.effort = { level: effort }
    return common
  }
  /** Claude's prompt-hook `model` override, resolved against the models this user
   * can run (exact id first, then a substring match); the session model otherwise. */
  const resolveHookModel = (ctx: ExtensionContext, override: string | undefined): ExtensionContext['model'] => resolveModelOverride(ctx, override)

  /** Kills for background hooks still running; Claude kills async hooks at teardown,
   * so session_shutdown reaps anything left rather than let a hung hook pin the
   * event loop past a one-shot run's end. */
  const backgroundKills = new Set<() => void>()
  /** Claude's background delivery: an asyncRewake exit 2 wakes the model with the
   * hook's stderr (stdout when stderr is empty) as a new turn; any other completion
   * feeds the JSON response's systemMessage/additionalContext to the model on the
   * next turn, shown to nobody else. A timeout kill discards the output, like a
   * canceled synchronous hook; it resolves with code 124, so it never reads as a wake. */
  const deliverBackgroundResult = (hook: HookCommand, result: HookRunResult): void => {
    if (result.timedOut) return
    if (hook.asyncRewake === true && result.code === 2) {
      const detail = result.stderr.trim() || result.stdout.trim()
      const content = detail ? `Async hook requested attention (exit 2):\n${detail}` : 'Async hook requested attention (exit 2)'
      pi.sendMessage({ customType: 'claude-async-hook', content, display: true }, { triggerTurn: true })
      return
    }
    const parsed = tryParseJson(result.stdout)
    // The typeof guard doubles as Claude's schema validation: a wrong-typed field is
    // dropped rather than delivered.
    const parts = [parsed?.systemMessage, parsed?.hookSpecificOutput?.additionalContext].filter((part): part is string => typeof part === 'string' && part.length > 0)
    if (parts.length === 0) return
    pi.sendMessage({ customType: 'claude-async-hook', content: parts.join('\n'), display: false }, { deliverAs: 'nextTurn' })
  }
  /** A runner bound to the firing context, filling the common fields into each
   * payload and dispatching on the entry's type. A background hook (see
   * isBackgroundHook) is fired and the caller immediately gets a no-verdict result,
   * so it can neither block nor delay the event that fired it; its completion is
   * delivered by deliverBackgroundResult whenever it lands. */
  const boundRunner =
    (ctx: ExtensionContext, extra?: Record<string, unknown>): HookRunner =>
    (hook, payload, ms) => {
      const merged = { ...commonPayload(ctx), ...extra, ...(payload as Record<string, unknown>) }
      const dispatch = (onChild?: (kill: () => void) => void): Promise<HookRunResult> => {
        if (hook.type === 'http') return runHttpHook(hook, merged, ms, allowedHttpHookUrls)
        if (hook.type === 'prompt') return runPromptHook(hook, merged, resolveHookModel(ctx, hook.model), ms)
        if (hook.type === 'agent') return runAgentHook(hook, merged, ms, (ctx.model as { id?: string } | undefined)?.id)
        if (hook.type === 'mcp_tool') return runMcpToolHook(hook, merged, ms)
        return runHookCommand(hook.command, merged, ms, projectDir, hook.args, onChild, hook.shell)
      }
      // Claude's `once` (skill-frontmatter hooks only): removed after the first
      // successful run; a failure, block, or timeout leaves it in place.
      const markOnce = async (run: Promise<HookRunResult>): Promise<HookRunResult> => {
        const result = await run
        if (hook.once === true && hook.origin?.startsWith('skill:') === true && result.code === 0 && !result.timedOut) hook.spent = true
        return result
      }
      if (!isBackgroundHook(hook)) return markOnce(dispatch())
      let kill: (() => void) | undefined
      void dispatch((registered) => {
        kill = registered
        backgroundKills.add(registered)
      })
        .then((result) => deliverBackgroundResult(hook, result))
        .catch(() => {
          // The hook may outlive the session (/new, shutdown): sendMessage asserts
          // liveness, and nothing awaits this chain, so a throw would otherwise
          // escape as an unhandled rejection.
        })
        .finally(() => {
          if (kill) backgroundKills.delete(kill)
        })
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false })
    }
  // Hooks a skill's frontmatter declares arrive over the shared bus when the skill
  // is invoked (see skills.ts) and stay registered for the rest of the session, as
  // Claude documents; a session restart reloads config and drops them.
  pi.events.on(SKILL_HOOKS_CHANNEL, (data) => {
    if (!isSkillHooksEvent(data)) return
    // Blocked under the escape hatch and under allowManagedHooksOnly, which
    // covers every non-managed hook source.
    if (hooksDisabled || managedHooksOnly) return
    registeredSkillHooks.push({ skillName: data.skillName, hooks: data.hooks })
    mergeSkillHooks(config, data.skillName, data.hooks, hookSources)
  })

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
    // SubagentStart runs through the pre-spawn seam below (so its context can
    // reach the child before its first prompt); the bus start event would
    // double-run it, so only the stop phase is handled here.
    if (!isSubagentPhaseEvent(data) || data.phase !== 'stop' || !sessionCtx) return
    const ctx = sessionCtx
    // Claude's SubagentStop carries the subagent's final text; agent_transcript_path
    // stays absent (a --no-session child writes no transcript, see docs/hooks.md).
    const payload = { hook_event_name: 'SubagentStop', agent_type: data.agentType, agent_id: data.agentId, ...(data.lastAssistantMessage !== undefined ? { last_assistant_message: data.lastAssistantMessage } : {}) }
    try {
      const results = await runNotifyHooks(matchingCommands(config.SubagentStop, data.agentType), payload, boundRunner(ctx))
      surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    } catch {
      // The bus outlives the session: an event landing between /new disposing this
      // ctx and the next session_start hits disposed getters, and nothing awaits a
      // bus listener, so a throw here would escape as an unhandled rejection.
    }
  })

  // Claude's SubagentStart hooks inject additionalContext into the subagent before
  // its first prompt, so they must run before the spawn: the subagent extension
  // calls this seam pre-spawn and prepends the returned context to the child's task.
  setSubagentStartHookRunner(async (agentType, agentId) => {
    if (!sessionCtx) return []
    const ctx = sessionCtx
    const commands = matchingCommands(config.SubagentStart, agentType)
    if (commands.length === 0) return []
    const results = await runNotifyHooks(commands, { hook_event_name: 'SubagentStart', agent_type: agentType, agent_id: agentId }, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    return results.map((result) => promptContext(result.stdout)).filter(Boolean)
  })

  /** Resolve the whole hook configuration from disk. Runs at session start and
   * again when the settings watcher sees an edit, so mid-session changes to
   * hooks, disableAllHooks, or allowedHttpHookUrls apply without a restart. */
  function resolveConfig(cwd: string, trusted: boolean): void {
    const files = hookFiles(cwd, os.homedir(), trusted)
    hookSources.clear()
    allowedHttpHookUrls = readAllowedHttpHookUrls(files)
    // The disableAllHooks escape hatch, checked before any config loads. The tiers
    // differ, as Claude documents: managed-level disableAllHooks turns everything
    // off, while a settings-level one cannot disable the hooks an administrator
    // configured through managed policy settings.
    const managedSettings = readManagedSettings()
    hooksDisabled = readDisableAllHooks(files, managedSettings)
    if (managedSettings.disableAllHooks === true) {
      config = {}
      return
    }
    config = loadManagedHooks(hookSources, managedSettings)
    // Claude's allowManagedHooksOnly: user, project, local, plugin, and skill
    // hooks are blocked; only the managed set runs.
    managedHooksOnly = managedSettings.allowManagedHooksOnly === true
    if (managedHooksOnly || readSettingsDisableAllHooks(files)) return
    for (const [eventName, matchers] of Object.entries(loadHooks(files, hookSources))) config[eventName] = [...(config[eventName] ?? []), ...matchers]
    // Plugins are user-installed and enabled by user settings (see installedPlugins),
    // so a checked-out repo cannot toggle which code-bearing plugin hooks run.
    loadPluginHooks(config, installedPlugins(os.homedir()), hookSources)
    // Inside a subagent child, the parent passes the agent's frontmatter hooks via
    // env (Stop already converted to SubagentStop, per Claude); they run only for
    // this child process.
    agentIdentity = mergeAgentEnvHooks(config, hookSources)
    // A reload must not drop the skill hooks the session already registered.
    for (const skill of registeredSkillHooks) mergeSkillHooks(config, skill.skillName, skill.hooks, hookSources)
  }

  pi.on('session_start', async (event, ctx) => {
    sessionCtx = ctx
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while a Stop-hook continuation streak is in flight; it must not
    // carry into the next session, so reset before any early return (disableAllHooks below).
    stopHookActive = false
    stopHookBlockCount = 0
    pendingToolContext.clear()
    registeredSkillHooks.length = 0
    const trusted = await isProjectApproved(ctx)
    // Claude's CLAUDE_PROJECT_DIR is the project root, not the session cwd; a hook
    // referencing $CLAUDE_PROJECT_DIR/.claude/hooks/helper.sh must resolve from a
    // subdirectory session too.
    projectDir = repoRoot(ctx.cwd) ?? ctx.cwd
    resolveConfig(ctx.cwd, trusted)
    // Claude picks up direct settings edits mid-session via a file watcher.
    disposeSettingsWatch()
    disposeSettingsWatch = watchSettingsFiles(hookFiles(ctx.cwd, os.homedir(), trusted), () => resolveConfig(ctx.cwd, trusted))
    // A disabled or managed-only resolution leaves config empty (or managed-only),
    // so the SessionStart run below fires exactly what remains active.
    pendingSessionContext = []
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
    // A new turn is beginning, so the session is no longer idle.
    cancelIdlePrompt()
    if (pendingSessionContext.length === 0) return
    const content = pendingSessionContext.join('\n')
    pendingSessionContext = []
    return { message: { customType: 'claude-hook-context', content, display: false } }
  })

  pi.on('tool_call', async (event, ctx) => {
    const anchors = { cwd: ctx.cwd, projectRoot: projectDir || ctx.cwd, home: os.homedir() }
    const decision = await runPreToolUse(config, event.toolName, event.input, boundRunner(ctx, { tool_use_id: event.toolCallId }), mcpAliases.get(event.toolName), (message) => ctx.ui.notify(message, 'warning'), anchors)
    if (!decision.block) {
      // additionalContext is delivered alongside the tool result, so stash it for
      // this call's tool_result to append.
      if (decision.context && decision.context.length > 0) pendingToolContext.set(event.toolCallId, decision.context)
      // Claude's duration_ms excludes PreToolUse hook time, so the clock starts here.
      toolStartTimes.set(event.toolCallId, Date.now())
      return undefined
    }
    // Claude's "ask": prompt the user and let the call through if they approve.
    // With no UI (headless) the block stands, which is the safe default.
    if (decision.ask && ctx.hasUI) {
      const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, decision.reason ?? 'A hook asks you to confirm this tool call.')
      if (!approved) return blockedToolCall(decision.reason)
      // Claude's duration_ms also excludes time in permission prompts.
      toolStartTimes.set(event.toolCallId, Date.now())
      return undefined
    }
    return blockedToolCall(decision.reason)
  })

  // Claude's PostToolUse (success) and PostToolUseFailure (error) both feed their
  // hook's output back next to the tool result: a decision:block reason (or exit-2
  // stderr) and additionalContext are appended, which is where Claude documents they
  // land. The failure branch shows the hook's stderr to the model too ("Shows stderr
  // to Claude; the tool already failed"), it just cannot block a call that failed.
  // Payloads report the Claude vocabulary (names, input shapes, and the documented
  // Bash/Write response shapes; see claude-tools), and a schema-valid
  // updatedToolOutput replaces the output the model sees.
  pi.on('tool_result', async (event, ctx) => {
    const alias = mcpAliases.get(event.toolName)
    const translatedName = alias ?? claudeToolName(event.toolName)
    const names = translatedName ? [event.toolName, translatedName] : [event.toolName]
    const eventName = event.isError ? 'PostToolUseFailure' : 'PostToolUse'
    // Contexts stashed by this call's PreToolUse hooks land next to the result even
    // when no PostToolUse hook is configured.
    const pending = pendingToolContext.get(event.toolCallId) ?? []
    pendingToolContext.delete(event.toolCallId)
    const anchors = { cwd: ctx.cwd, projectRoot: projectDir || ctx.cwd, home: os.homedir() }
    const target = { piName: event.toolName, claudeName: translatedName, input: event.input, anchors }
    const commands = matchingCommands(event.isError ? config.PostToolUseFailure : config.PostToolUse, names).filter((command) => passesIfFilter(command, target))
    if (commands.length === 0 && pending.length === 0) return
    const translatedInput = alias === undefined ? claudeToolInput(event.toolName, event.input, ctx.cwd) : undefined
    const response = (alias === undefined && !event.isError ? claudeToolResponse(event.toolName, event.input, contentText(event.content, '\n'), event.isError, ctx.cwd) : undefined) ?? { content: event.content, details: event.details, isError: event.isError }
    const startedAt = toolStartTimes.get(event.toolCallId)
    toolStartTimes.delete(event.toolCallId)
    // Claude delivers a failure as top-level fields rather than a tool_response: "error
    // information as top-level fields ... error ... is_interrupt". is_interrupt is false
    // here because pi reports a cancelled tool through the result, not this event.
    const failure = event.isError ? { error: contentText(event.content, '\n'), is_interrupt: false } : { tool_response: response }
    const payload = { hook_event_name: eventName, tool_name: translatedName ?? event.toolName, tool_input: translatedInput ?? event.input, ...failure, ...(startedAt === undefined ? {} : { duration_ms: Date.now() - startedAt }) }
    const run = boundRunner(ctx, { tool_use_id: event.toolCallId })
    const results = await Promise.all(commands.map((command) => run(command, payload, timeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    // Claude's updatedToolOutput replaces the output the model sees; a value that
    // doesn't match the tool's output schema is ignored, MCP output passes through
    // unvalidated, and a failed call keeps its error output.
    const replacement = event.isError
      ? undefined
      : results
          .filter((result) => !result.timedOut)
          .map((result) => {
            const parsed = tryParseJson(result.stdout)
            const value = alias !== undefined ? (parsed?.updatedMCPToolOutput ?? parsed?.updatedToolOutput) : parsed?.updatedToolOutput
            return value === undefined ? undefined : piToolOutput(event.toolName, value, alias !== undefined)
          })
          .find((text) => text !== undefined)
    const feedback = [...pending, ...results.flatMap((result) => postToolFeedback(result, eventName, event.isError))]
    if (replacement === undefined && feedback.length === 0) return
    const base = replacement !== undefined ? [{ type: 'text' as const, text: replacement }] : event.content
    return { content: [...base, ...feedback.map((text) => ({ type: 'text' as const, text }))] }
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
    const decision = await runPreToolUse(config, 'bash', { command: event.command }, boundRunner(ctx), 'Bash', (message) => ctx.ui.notify(message, 'warning'), { cwd: ctx.cwd, projectRoot: projectDir || ctx.cwd, home: os.homedir() })
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
    // The user typed, so the pending idle_prompt no longer applies.
    cancelIdlePrompt()
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
    // pi's seam for rewriting the submitted text. The prompt itself always survives:
    // "UserPromptSubmit: can't replace the prompt; it only injects additionalContext
    // alongside it". suppressOriginalPrompt scopes to the block message, which never
    // carries the prompt here, so it needs nothing of its own.
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
  /** Claude's Notification event, for the one type pi can honestly source: the agent
   * finished and is waiting for input. idle_prompt fires when the turn ended about 60
   * seconds ago and the user has not typed since, so it arms here and input or the next
   * turn cancels it. Observational only; exit codes and JSON output are ignored. */
  const armIdlePrompt = (ctx: ExtensionContext): void => {
    cancelIdlePrompt()
    const notifyCommands = matchingCommands(config.Notification, ['idle_prompt'])
    if (notifyCommands.length > 0) {
      const runner = boundRunner(ctx)
      idlePromptTimer = setTimeout(() => {
        void runNotifyHooks(notifyCommands, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'pi is waiting for your input' }, runner).catch(() => {})
      }, IDLE_PROMPT_DELAY_MS)
      idlePromptTimer.unref?.()
    }
  }
  pi.on('agent_end', async (event, ctx) => {
    armIdlePrompt(ctx)

    // In a subagent child, the agent-frontmatter Stop hooks were converted to
    // SubagentStop and fire here, at the child's own end, notify-style; before the
    // Stop early-returns, which do not apply to them.
    if (agentIdentity) {
      const subStop = matchingCommands(config.SubagentStop, agentIdentity.agent)
      if (subStop.length > 0) {
        const subText = lastAssistantText((event as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [])
        const subPayload = { hook_event_name: 'SubagentStop', agent_type: agentIdentity.agent, ...(agentIdentity.id ? { agent_id: agentIdentity.id } : {}), stop_hook_active: false, ...(subText ? { last_assistant_message: subText } : {}) }
        await runNotifyHooks(subStop, subPayload, boundRunner(ctx)).catch(() => {})
      }
    }

    // Stop has no matcher support (a stray matcher is ignored, as Claude documents)
    // and an `if`-carrying hook never runs on a non-tool event.
    const commands = allCommands(config.Stop).filter((command) => passesIfFilter(command, undefined))
    if (commands.length === 0) {
      stopHookActive = false
      return
    }
    // Claude: Stop does not run when the stoppage was a user interrupt; pi marks
    // the aborted turn's final assistant message stopReason "aborted".
    const turnMessages = (event as { messages?: Array<{ role: string; stopReason?: string }> }).messages ?? []
    const lastAssistant = [...turnMessages].reverse().find((message) => message.role === 'assistant')
    if (lastAssistant?.stopReason === 'aborted') {
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
    const stopMessages: string[] = []
    const block = results
      .filter((result) => !result.timedOut)
      .map((result) => stopVerdict(result, stopMessages))
      .find((verdict) => verdict.block)
    for (const message of stopMessages) ctx.ui.notify(message, 'warning')
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
    // Claude's custom_instructions: the /compact arguments on a manual run, empty
    // on an automatic one; pi carries them on the event directly.
    const payload = { hook_event_name: 'PreCompact', trigger: trigger.value, custom_instructions: event.customInstructions ?? '' }
    const results = await runNotifyHooks(matchingCommands(config.PreCompact, trigger.names), payload, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    // Claude: "Exit with code 2 to block compaction. For a manual /compact, the stderr
    // message is shown to the user. You can also block by returning JSON with
    // `decision: block`." pi cancels through the result, and a blocked automatic
    // compaction is worth a notice too: the context stays full either way.
    for (const [index, result] of results.entries()) {
      const parsed = tryParseJson(result.stdout)
      const blocked = result.code === 2 && !result.timedOut ? { reason: result.stderr.trim() || 'Compaction blocked by hook' } : jsonBlockVerdict(parsed, 'Compaction blocked by hook')
      if (!blocked) continue
      ctx.ui.notify(`Compaction blocked by ${matchingCommands(config.PreCompact, trigger.names)[index]?.command ?? 'hook'}: ${blocked.reason}`, 'warning')
      return { cancel: true }
    }
  })

  pi.on('session_compact', async (event, ctx) => {
    const trigger = claudeSpelling(PRECOMPACT_TRIGGER, event.reason)
    // Claude's compact_summary: the summary that replaced the compacted history.
    const summary = (event as { compactionEntry?: { summary?: unknown } }).compactionEntry?.summary
    const payload = { hook_event_name: 'PostCompact', trigger: trigger.value, ...(typeof summary === 'string' ? { compact_summary: summary } : {}) }
    const results = await runNotifyHooks(matchingCommands(config.PostCompact, trigger.names), payload, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    // Claude also fires SessionStart with source "compact" when the session
    // continues after compaction; its stdout context rides the next agent start,
    // the same as any other SessionStart context.
    const sessionStart = matchingCommands(config.SessionStart, 'compact')
    if (sessionStart.length > 0) {
      const startResults = await runNotifyHooks(sessionStart, { hook_event_name: 'SessionStart', source: 'compact' }, boundRunner(ctx))
      surfaceSystemMessages(startResults, (message) => ctx.ui.notify(message, 'warning'))
      pendingSessionContext.push(...startResults.map((result) => promptContext(result.stdout)).filter(Boolean))
    }
  })

  pi.on('model_select', async (event, ctx) => {
    // Claude's PostModelSwitch: runs after the session's model changes, matched
    // against the model switched to; it can't block. PreModelSwitch stays
    // unbridged: pi's model_select has no veto seam, and a "Pre" hook whose block
    // decision is silently ignored would be worse than an absent event.
    const { model, previousModel, source } = event as { model: { id: string }; previousModel?: { id: string }; source: string }
    if (!previousModel || previousModel.id === model.id) return
    const commands = matchingCommands(config.PostModelSwitch, model.id)
    if (commands.length === 0) return
    // requested_model is null: pi does not carry the alias the request named.
    const payload = { hook_event_name: 'PostModelSwitch', from_model: previousModel.id, to_model: model.id, requested_model: null, source: MODEL_SELECT_SOURCE[source] ?? 'command' }
    const results = await runNotifyHooks(commands, payload, boundRunner(ctx))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    // Claude delivers the hook's stdout (or additionalContext) to Claude with the
    // next request after the switch; pi's seam for that is the next agent start.
    pendingSessionContext.push(...results.map((result) => promptContext(result.stdout)).filter(Boolean))
  })

  pi.on('session_shutdown', async (event, ctx) => {
    const reason = claudeSpelling(SESSION_END_REASON, event.reason)
    // SessionEnd rides Claude's short shared budget (see sessionEndTimeoutMs) so a
    // slow hook cannot stall session exit, /new or /resume.
    const sessionEndCommands = matchingCommands(config.SessionEnd, reason.names).filter((command) => passesIfFilter(command, undefined))
    const runner = boundRunner(ctx)
    const results = await Promise.all(sessionEndCommands.map((command) => runner(command, { hook_event_name: 'SessionEnd', reason: reason.value }, sessionEndTimeoutMs(command))))
    surfaceSystemMessages(results, (message) => ctx.ui.notify(message, 'warning'))
    // Claude kills async hooks still running at teardown; the session that spawned
    // these is over, and their delivery would target a disposed context anyway.
    for (const kill of backgroundKills) kill()
    backgroundKills.clear()
  })

  // Claude's /hooks manages hook configuration; pi-code's is a viewer: hook failures
  // are otherwise opaque, so showing the resolved chain per event, with the settings
  // file each entry came from, is the debugging surface.
  pi.registerCommand('hooks', {
    description: 'Show the hook configuration resolved from settings',
    handler: async (_args, ctx) => {
      // With a settings-level disable, managed policy hooks stay active and the
      // viewer still shows them; only a fully empty config reports disabled.
      if (hooksDisabled && Object.keys(config).length === 0) {
        ctx.ui.notify('All hooks are disabled by the disableAllHooks setting.', 'info')
        return
      }
      ctx.ui.notify(formatHooksSummary(config, hookSources), 'info')
    },
  })
}
