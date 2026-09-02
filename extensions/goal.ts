/**
 * Goal Extension
 *
 * Claude Code's /goal: a completion condition the session keeps working toward. After
 * each turn a separate model judges the condition against the conversation and returns
 * met, not yet met (its reason becomes the next turn's guidance), or impossible. Claude
 * implements it as a session-scoped prompt-based Stop hook; pi-code runs the same loop
 * on agent_end next to the hooks extension's Stop path:
 * - `/goal <condition>` sets (or replaces) the goal and starts a turn with Claude's
 *   kickoff directive; `/goal` shows status; `/goal clear` (stop/off/reset/none/cancel)
 *   removes it. The condition is capped at 4,000 characters.
 * - The evaluator is the session model, or ANTHROPIC_DEFAULT_HAIKU_MODEL resolved against
 *   the models this user can run. It reads the branch transcript trimmed to half its
 *   context window and cannot run tools, so the condition must be provable from output.
 * - The Stop hooks' consecutive-block cap (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, default 8)
 *   bounds a stalled loop: that many not-met verdicts in a row on turns that used no tool
 *   pause the loop with a warning, goal still set, until the next user prompt.
 * - Evaluation is skipped while a subagent is still running (tracked from the subagent
 *   extension's bus events; pi has no other background work). A check-in turn is
 *   injected once the wait reaches CLAUDE_CODE_GOAL_CHECKIN_MINUTES (30, doubling up to
 *   four times the first interval, at most three idle check-ins between user prompts;
 *   0 turns check-ins off).
 * - A turn ended by the user (Esc) or by an error is not evaluated, and an Esc during
 *   the evaluation cancels it with the goal left set. An unrecoverable
 *   error (authentication, credits, context overflow, model unavailable) clears the goal
 *   with a warning once the run settles; a transient one leaves it set.
 * - The active goal persists as a session entry and is restored on resume or reload with
 *   the turn count, timer, and token baseline reset; an achieved, failed, or cleared goal
 *   is not restored.
 * - Gated as Claude documents: unavailable when hooks are restricted (disableAllHooks or
 *   allowManagedHooksOnly) or the project is not trusted, with the reason shown.
 * - Headless (`pi -p "/goal ..."`), the command holds the process open until the goal
 *   resolves or pauses, and warnings also go to stderr since there is no notify surface.
 *
 * Docs: https://code.claude.com/docs/en/goal.md
 */

import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { hookFiles, readSettingsDisableAllHooks, stopHookBlockCap } from './hooks/index.js'
import {
  checkinIntervalMs,
  checkinText,
  classifyUnrecoverable,
  EVALUATOR_SYSTEM,
  evaluatorPrompt,
  formatAchievedGoal,
  formatActiveGoal,
  formatDuration,
  formatTokens,
  GOAL_CONDITION_MAX_CHARS,
  type GoalSummary,
  type GoalVerdict,
  isClearAlias,
  kickoffPrompt,
  MAX_IDLE_CHECKINS,
  NO_GOAL_TEXT,
  parseVerdict,
  type RunningWork,
  renderTranscript,
  summaryText,
} from './internal/goal-evaluator.js'
import { readManagedSettings } from './internal/managed-settings.js'
import { completeText } from './internal/model-complete.js'
import { resolveModelOverride } from './internal/model-lookup.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { isSubagentPhaseEvent, SUBAGENT_CHANNEL } from './internal/subagent-events.js'

/** Session entry type the goal state persists under, and the custom message type its
 * transcript lines (kickoff, verdicts, check-ins) carry. */
const GOAL_ENTRY = 'goal'
const GOAL_MESSAGE = 'goal'
/** Claude's prompt-hook default; a slow evaluator is an error, not a stall. */
const EVALUATOR_TIMEOUT_MS = 30_000
/** A verdict is one JSON object; the cap stops a runaway reply. */
const EVALUATOR_MAX_TOKENS = 512
/** Claude trims the transcript to half the evaluator's context window. */
const TRANSCRIPT_WINDOW_SHARE = 0.5
const CHARS_PER_TOKEN = 4
const DEFAULT_CONTEXT_WINDOW = 200_000
/** The `◎ goal <elapsed>` indicator re-renders on this cadence while a goal is active. */
const INDICATOR_REFRESH_MS = 60_000

const HOOKS_GATE = "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."
const TRUST_GATE = '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.'

type GoalState = 'active' | 'cleared' | 'achieved' | 'failed'

interface GoalEntry {
  state: GoalState
  condition: string
}

interface ActiveGoal {
  condition: string
  setAt: number
  iterations: number
  lastReason?: string
  /** Session token total when the goal was set; spend is measured from here. */
  tokensAtStart: number
  /** Evaluator calls are not on the session total; they count toward the goal's spend. */
  evaluatorTokens: number
}

interface TurnMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
}

interface TokenUsage {
  totalTokens?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

function usageTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  return usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

function lastAssistant(messages: readonly unknown[]): TurnMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as TurnMessage
    if (message?.role === 'assistant') return message
  }
  return undefined
}

type SessionReader = Pick<ExtensionContext, 'sessionManager'>

/** The branch as the evaluator reads it: messages plus the goal's own transcript lines,
 * which live in custom_message entries. */
function branchMessages(ctx: SessionReader): unknown[] {
  const messages: unknown[] = []
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'message') messages.push(entry.message)
    else if (entry.type === 'custom_message') messages.push({ role: 'custom', customType: entry.customType, content: entry.content })
  }
  return messages
}

/** Cumulative assistant usage on the branch: the session's token spend so far. */
function sessionTokens(ctx: SessionReader): number {
  let total = 0
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') total += usageTokens(entry.message.usage as TokenUsage | undefined)
  }
  return total
}

/** The newest goal entry on the branch, which is the goal's persisted state. */
function lastGoalEntry(ctx: SessionReader): GoalEntry | undefined {
  const branch = ctx.sessionManager.getBranch()
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry.type !== 'custom' || entry.customType !== GOAL_ENTRY) continue
    const data = entry.data as Partial<GoalEntry> | undefined
    return typeof data?.condition === 'string' && typeof data.state === 'string' ? { state: data.state, condition: data.condition } : undefined
  }
  return undefined
}

/** Claude's availability rule: /goal rides the hooks system, so a hooks restriction or an
 * untrusted workspace refuses it with the reason. Checked in Claude's order. */
function goalUnavailable(ctx: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'ui'>): string | undefined {
  const managed = readManagedSettings()
  const trusted = isProjectApprovedSilently(ctx)
  const restricted = managed.disableAllHooks === true || managed.allowManagedHooksOnly === true || readSettingsDisableAllHooks(hookFiles(ctx.cwd, os.homedir(), trusted))
  if (restricted) return HOOKS_GATE
  if (!trusted) return TRUST_GATE
  return undefined
}

/** Claude evaluates on its small fast model, ANTHROPIC_DEFAULT_HAIKU_MODEL overriding it;
 * pi has no such tier, so the session model stands in unless the override names one of
 * the models this user can run. */
function evaluatorModel(ctx: ExtensionContext): ExtensionContext['model'] {
  return resolveModelOverride(ctx, process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || undefined)
}

function transcriptBudget(model: { contextWindow?: number }): number {
  return Math.floor((model.contextWindow || DEFAULT_CONTEXT_WINDOW) * TRANSCRIPT_WINDOW_SHARE * CHARS_PER_TOKEN)
}

export default function goalExtension(pi: ExtensionAPI) {
  let goal: ActiveGoal | undefined
  /** The last goal achieved this session, for the status view after it clears. */
  let achieved: GoalSummary | undefined
  /** The live context, for timer callbacks that fire outside any pi event. */
  let sessionCtx: ExtensionContext | undefined
  /** Bumped whenever the goal is set, cleared, or the session changes, so an evaluation
   * that resolves after any of those is dropped instead of steering the wrong goal. */
  let generation = 0
  /** Whether the run now ending executed a tool: Claude's "progress" for the block cap. */
  let turnUsedTools = false
  /** Not-met verdicts in a row on turns that used no tool. */
  let noProgressStreak = 0
  /** The error the last run ended on, judged once the run settles (past pi's retries). */
  let lastTurnError: string | undefined
  /** Subagents still running, by id, from the subagent extension's bus events. */
  const running = new Map<string, string>()
  let deferredSince: number | undefined
  let checkinsDelivered = 0
  let idleCheckins = 0
  /** A check-in came due while a turn was running: deliver it at the next turn end. */
  let checkinDue = false
  let checkinTimer: ReturnType<typeof setTimeout> | undefined
  let indicatorTimer: ReturnType<typeof setInterval> | undefined

  /** A goal line in the transcript, which the model also reads. A timer can outlive the
   * session that armed it, and sendMessage throws on a disposed one. */
  function send(content: string, options: { triggerTurn: boolean; deliverAs?: 'followUp' }): void {
    try {
      pi.sendMessage({ customType: GOAL_MESSAGE, content, display: true }, options)
    } catch {
      // Disposed session: nothing left to tell.
    }
  }

  /** A line for the user. Headless runs have no notify surface, and a refusal or a
   * loop that stops there without a word would look like a hang, so it also goes to
   * stderr (where Claude's -p mode prints its goal messages). */
  function tell(ctx: ExtensionContext, text: string, level: 'info' | 'warning' | 'error'): void {
    ctx.ui.notify(text, level)
    if (!ctx.hasUI) process.stderr.write(`${text}\n`)
  }

  function currentSummary(ctx: SessionReader): GoalSummary | undefined {
    if (!goal) return undefined
    return { condition: goal.condition, durationMs: Date.now() - goal.setAt, iterations: goal.iterations, tokens: sessionTokens(ctx) - goal.tokensAtStart + goal.evaluatorTokens, lastReason: goal.lastReason }
  }

  function showIndicator(ctx: ExtensionContext): void {
    if (!goal) return
    ctx.ui.setStatus('goal', ctx.ui.theme.fg('accent', `◎ goal ${formatDuration(Date.now() - goal.setAt)}`))
    if (!indicatorTimer) {
      indicatorTimer = setInterval(() => {
        if (sessionCtx) showIndicator(sessionCtx)
      }, INDICATOR_REFRESH_MS)
      indicatorTimer.unref?.()
    }
  }

  function stopIndicator(ctx: ExtensionContext): void {
    clearInterval(indicatorTimer)
    indicatorTimer = undefined
    ctx.ui.setStatus('goal', undefined)
  }

  function stopCheckin(): void {
    clearTimeout(checkinTimer)
    checkinTimer = undefined
  }

  function endDeferral(): void {
    deferredSince = undefined
    checkinDue = false
    stopCheckin()
  }

  /** Make `condition` the active goal with fresh counters; the entry is the caller's. */
  function activate(ctx: ExtensionContext, condition: string): void {
    goal = { condition, setAt: Date.now(), iterations: 0, tokensAtStart: sessionTokens(ctx), evaluatorTokens: 0 }
    generation += 1
    noProgressStreak = 0
    checkinsDelivered = 0
    idleCheckins = 0
    endDeferral()
    showIndicator(ctx)
  }

  /** Drop the active goal, recording how it ended; returns its condition. */
  function endGoal(ctx: ExtensionContext, state: Exclude<GoalState, 'active'>): string | undefined {
    const ended = goal
    if (!ended) return undefined
    goal = undefined
    generation += 1
    endDeferral()
    stopIndicator(ctx)
    pi.appendEntry(GOAL_ENTRY, { state, condition: ended.condition } satisfies GoalEntry)
    return ended.condition
  }

  function finish(ctx: ExtensionContext, state: 'achieved' | 'failed', reason: string): void {
    const summary = currentSummary(ctx)
    if (!summary) return
    if (state === 'achieved') achieved = summary
    endGoal(ctx, state)
    const head = state === 'achieved' ? `Goal achieved (${summaryText(summary)}): ${summary.condition}` : `Goal could not be achieved (${summaryText(summary)}): ${summary.condition}`
    send(reason ? `${head}\nEvaluator: ${reason}` : head, { triggerTurn: false })
  }

  /** Claude feeds a not-met reason back as the next turn, under the Stop hooks' cap. */
  function continueGoal(ctx: ExtensionContext, active: ActiveGoal, reason: string): void {
    noProgressStreak = turnUsedTools ? 0 : noProgressStreak + 1
    const cap = stopHookBlockCap()
    showIndicator(ctx)
    if (noProgressStreak >= cap) {
      noProgressStreak = 0
      tell(ctx, `Goal paused after ${cap} turns in a row without tool use; it stays set and evaluation resumes after your next prompt.`, 'warning')
      return
    }
    const summary = currentSummary(ctx)
    const spent = summary ? ` · ${formatDuration(summary.durationMs)} · ${formatTokens(summary.tokens)} tokens` : ''
    send(`Goal not yet met (turn ${active.iterations}${spent}): ${reason}\nGoal: ${active.condition}`, { triggerTurn: true })
  }

  async function askEvaluator(ctx: ExtensionContext, active: ActiveGoal, model: NonNullable<ExtensionContext['model']>): Promise<GoalVerdict> {
    const transcript = renderTranscript(branchMessages(ctx), transcriptBudget(model))
    // Esc during the evaluation aborts the run's signal; the call must die with it, or
    // a late verdict would queue the next goal turn into a run the user just stopped.
    const deadline = AbortSignal.timeout(EVALUATOR_TIMEOUT_MS)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline
    // Claude runs its evaluator with thinking disabled: the verdict is mechanical.
    // completeText requests no thinking level, which is the same for pi.
    const { text, usage } = await completeText(model, evaluatorPrompt(transcript, active.condition), { system: EVALUATOR_SYSTEM, maxTokens: EVALUATOR_MAX_TOKENS, signal })
    active.evaluatorTokens += usageTokens(usage as TokenUsage | undefined)
    const verdict = parseVerdict(text)
    if (!verdict) throw new Error(`unreadable verdict: ${text.slice(0, 200)}`)
    return verdict
  }

  async function evaluate(ctx: ExtensionContext): Promise<void> {
    const active = goal
    if (!active) return
    const startedGeneration = generation
    const model = evaluatorModel(ctx)
    if (!model) {
      tell(ctx, 'Goal evaluator has no model to run on; the goal stays set.', 'warning')
      return
    }
    let verdict: GoalVerdict
    try {
      verdict = await askEvaluator(ctx, active, model)
    } catch (error) {
      // A user interrupt is not an evaluator failure: the goal stays, nothing to say.
      if (ctx.signal?.aborted) return
      // No verdict is a hook error in Claude's terms: the turn ends and the goal stays.
      if (generation === startedGeneration) tell(ctx, `Goal evaluator error: ${error instanceof Error ? error.message : String(error)}. The goal stays set; the next turn is evaluated again.`, 'warning')
      return
    }
    // Interrupted, cleared, or replaced during the await: this verdict must not act.
    if (ctx.signal?.aborted || generation !== startedGeneration) return
    active.iterations += 1
    active.lastReason = verdict.reason
    if (verdict.ok) finish(ctx, 'achieved', verdict.reason)
    else if (verdict.impossible) finish(ctx, 'failed', verdict.reason)
    else continueGoal(ctx, active, verdict.reason)
  }

  function deliverCheckin(paused: boolean): void {
    if (!goal) return
    checkinDue = false
    checkinsDelivered += 1
    const work: RunningWork[] = [...running].map(([id, agentType]) => ({ id, agentType }))
    send(checkinText(goal.condition, Date.now() - (deferredSince ?? Date.now()), work, paused), { triggerTurn: true })
  }

  function onCheckinDue(): void {
    checkinTimer = undefined
    if (!goal || !sessionCtx) return
    // Claude delivers a due check-in at the next turn end when a turn is running, and
    // only starts idle turns for it up to the per-prompt cap.
    if (!sessionCtx.isIdle() || idleCheckins >= MAX_IDLE_CHECKINS) {
      checkinDue = true
      return
    }
    idleCheckins += 1
    deliverCheckin(idleCheckins >= MAX_IDLE_CHECKINS)
  }

  function armCheckin(): void {
    if (checkinTimer) return
    const ms = checkinIntervalMs(process.env, checkinsDelivered)
    if (ms <= 0) return
    checkinTimer = setTimeout(onCheckinDue, ms)
    checkinTimer.unref?.()
  }

  /** Background work keeps the goal waiting: no verdict this turn, a check-in later. */
  function deferEvaluation(): void {
    deferredSince ??= Date.now()
    if (checkinDue) {
      deliverCheckin(false)
      return
    }
    armCheckin()
  }

  function statusText(ctx: SessionReader): string {
    const summary = currentSummary(ctx)
    if (summary) return formatActiveGoal(summary)
    if (achieved) return formatAchievedGoal(achieved)
    return NO_GOAL_TEXT
  }

  pi.registerCommand('goal', {
    description: 'Set a goal the session keeps working toward until a separate check confirms it is met; /goal shows status, /goal clear stops',
    handler: async (args, ctx) => {
      sessionCtx = ctx
      const condition = args.trim()
      if (condition === '') {
        tell(ctx, statusText(ctx), 'info')
        return
      }
      if (isClearAlias(condition)) {
        const cleared = endGoal(ctx, 'cleared')
        if (cleared === undefined) tell(ctx, 'No goal set', 'info')
        else send(`Goal cleared: ${cleared}`, { triggerTurn: false })
        return
      }
      if (condition.length > GOAL_CONDITION_MAX_CHARS) {
        tell(ctx, `Goal condition is limited to ${GOAL_CONDITION_MAX_CHARS} characters (got ${condition.length})`, 'error')
        return
      }
      const blocked = goalUnavailable(ctx)
      if (blocked) {
        tell(ctx, blocked, 'error')
        return
      }
      // A new goal replaces the current one, as Claude documents; the entry written here
      // is the state a resume restores.
      activate(ctx, condition)
      pi.appendEntry(GOAL_ENTRY, { state: 'active', condition } satisfies GoalEntry)
      tell(ctx, `Goal set: ${condition}`, 'info')
      // Setting a goal starts a turn immediately with the condition as the directive; a
      // send during streaming queues it as a follow-up turn.
      send(kickoffPrompt(condition), ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: 'followUp' })
      // A headless run (`pi -p "/goal ..."`) exits as soon as the command returns, before
      // the kickoff turn runs. pi marks the run active synchronously on the send, and the
      // continuations queued at agent_end extend that run, so waiting here holds the
      // process open until the goal resolves, as Claude's -p mode does. The TUI's main
      // loop returns to the editor on its own, so it must not block on the loop.
      if (!ctx.hasUI) await ctx.waitForIdle()
    },
  })

  pi.events.on(SUBAGENT_CHANNEL, (data) => {
    if (!isSubagentPhaseEvent(data)) return
    if (data.phase === 'start') running.set(data.agentId, data.agentType)
    else running.delete(data.agentId)
  })

  pi.on('session_start', (_event, ctx) => {
    // One extension instance serves every session: drop the previous session's goal and
    // timers before reading this session's persisted state.
    sessionCtx = ctx
    goal = undefined
    achieved = undefined
    generation += 1
    turnUsedTools = false
    noProgressStreak = 0
    lastTurnError = undefined
    checkinsDelivered = 0
    idleCheckins = 0
    endDeferral()
    stopIndicator(ctx)
    const entry = lastGoalEntry(ctx)
    if (entry?.state !== 'active') return
    // Claude restores a still-active goal on resume with its counters reset.
    activate(ctx, entry.condition)
    tell(ctx, `Goal restored: ${entry.condition}`, 'info')
  })

  pi.on('session_shutdown', () => {
    stopCheckin()
    clearInterval(indicatorTimer)
    indicatorTimer = undefined
  })

  pi.on('agent_start', () => {
    turnUsedTools = false
  })

  pi.on('tool_execution_start', () => {
    turnUsedTools = true
  })

  pi.on('input', (event) => {
    // Only genuine user input is progress: a goal continuation or a subagent prompt
    // arrives with source 'extension'. Claude resets the block cap and the idle
    // check-in allowance on the user's next prompt.
    if (event.source === 'extension') return
    noProgressStreak = 0
    idleCheckins = 0
  })

  // On agent_end rather than agent_settled, for the reason hooks.ts gives: a peer
  // extension can hold its agent_end handler on a dialog, which would starve a settle-
  // based evaluation; and a continuation sent here is picked up as the run's own
  // continuation rather than a fresh prompt.
  pi.on('agent_end', async (event, ctx) => {
    sessionCtx = ctx
    const last = lastAssistant(event.messages)
    lastTurnError = last?.stopReason === 'error' ? (last.errorMessage ?? 'unknown error') : undefined
    // Claude runs no Stop evaluation after a user interrupt; a failed turn is judged once
    // the run settles, so neither is evaluated here and the goal stays set.
    if (!goal || last?.stopReason === 'aborted' || lastTurnError !== undefined) return
    if (running.size > 0) {
      deferEvaluation()
      return
    }
    endDeferral()
    await evaluate(ctx)
  })

  pi.on('agent_settled', (_event, ctx) => {
    const message = lastTurnError
    lastTurnError = undefined
    if (!goal || message === undefined) return
    const kind = classifyUnrecoverable(message)
    if (!kind) return
    endGoal(ctx, 'cleared')
    const text = `Goal cleared after an unrecoverable error (${kind}): "${message}". Run /goal again to continue.`
    send(text, { triggerTurn: false })
    tell(ctx, text, 'warning')
  })
}
