/**
 * The pure half of /goal: the directive Claude Code sends when a goal is set, the
 * evaluator prompt its small fast model judges the condition with, the transcript
 * rendering that prompt sees, verdict parsing, the classifier for the errors that
 * clear a goal, the check-in schedule, and the status text. No pi state lives here,
 * so goal.ts stays the lifecycle wiring and each contract is pinned on its own.
 */

/** Claude caps a goal condition at 4,000 characters. */
export const GOAL_CONDITION_MAX_CHARS = 4000

/** `/goal clear` and its documented aliases, matched case-insensitively. */
const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

export function isClearAlias(text: string): boolean {
  return CLEAR_ALIASES.has(text.toLowerCase())
}

/** The directive a set goal starts its first turn with: the condition itself is the task. */
export function kickoffPrompt(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it: treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met, so do not tell the user to run \`/goal clear\` after success; that is only for clearing a goal early.`
}

/** Claude's stop-condition evaluator instructions: transcript evidence only, three
 * verdict shapes, and impossible reserved for a condition that can never hold. */
export const EVALUATOR_SYSTEM = [
  'You are evaluating a stop-condition hook for a coding agent session. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.',
  'Your response must be a JSON object with one of these shapes:',
  '- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}',
  '- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}',
  '- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}',
  'Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.',
  'Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session, for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this: the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant\'s self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".',
  // Claude pins the reply with a JSON schema; pi's one-off completion cannot, so the
  // instruction has to carry that weight.
  'Output the JSON object only, with no text before or after it and no code fence.',
].join('\n')

/** The user turn of the evaluation: the rendered transcript, then Claude's question. */
export function evaluatorPrompt(transcript: string, condition: string): string {
  return `<transcript>\n${transcript}\n</transcript>\n\nBased on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\nCondition: ${condition}`
}

export interface GoalVerdict {
  ok: boolean
  reason: string
  /** Only meaningful when ok is false: the condition can never be satisfied. */
  impossible: boolean
}

/** A reply with no JSON at all but an opening yes/no: a small model answering the
 * question in prose. The whole reply becomes the reason. Anything less clear-cut is
 * not a verdict. */
function proseVerdict(text: string): GoalVerdict | undefined {
  const lead = /^\s*(yes|no)\b/i.exec(text)?.[1]?.toLowerCase()
  if (lead === undefined) return undefined
  return { ok: lead === 'yes', reason: text.trim(), impossible: false }
}

/** The evaluator's JSON verdict, tolerating prose or a code fence around the object; a
 * reply with no object at all falls back to its yes/no lead. Undefined when the object
 * does not parse, `ok` is not a boolean, or no lead is there, which the caller treats
 * as an evaluator error rather than a verdict. */
export function parseVerdict(text: string): GoalVerdict | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1) return proseVerdict(text)
  if (end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { ok, reason, impossible } = parsed as Record<string, unknown>
  if (typeof ok !== 'boolean') return undefined
  return { ok, reason: typeof reason === 'string' ? reason.trim() : '', impossible: !ok && impossible === true }
}

/** One message's rendering is capped so a single tool dump cannot consume the budget. */
const BLOCK_MAX_CHARS = 6000
/** Tool arguments are context, not evidence; a short prefix identifies the call. */
const TOOL_ARGS_MAX_CHARS = 400
const OMITTED_MARKER = '[earlier transcript omitted]'

interface ContentPart {
  type?: string
  text?: string
  name?: string
  arguments?: unknown
}

interface TranscriptMessage {
  role?: string
  content?: unknown
  toolName?: string
  customType?: string
  stopReason?: string
  errorMessage?: string
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`
}

/** Text and tool-call parts of a content value; thinking is dropped, images noted. */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const rendered: string[] = []
  for (const part of content as ContentPart[]) {
    if (part?.type === 'text' && typeof part.text === 'string') rendered.push(part.text)
    else if (part?.type === 'image') rendered.push('[image]')
    else if (part?.type === 'toolCall') rendered.push(`[tool call ${part.name}(${truncate(JSON.stringify(part.arguments ?? {}), TOOL_ARGS_MAX_CHARS)})]`)
  }
  return rendered.join('\n')
}

function renderMessage(message: TranscriptMessage): string | undefined {
  switch (message.role) {
    case 'user':
      return `User: ${partsText(message.content)}`
    case 'assistant': {
      const body = message.stopReason === 'error' ? `[error: ${message.errorMessage ?? 'unknown error'}]` : partsText(message.content)
      return `Assistant: ${body}`
    }
    case 'toolResult':
      return `Tool result (${message.toolName ?? 'tool'}): ${partsText(message.content)}`
    case 'custom':
      return `Note (${message.customType ?? 'note'}): ${partsText(message.content)}`
    default:
      return undefined
  }
}

/**
 * The conversation as the evaluator reads it: one block per message, newest last,
 * trimmed from the head to `budgetChars` (Claude trims to half the evaluator's
 * context window). A cut is marked so the model knows evidence may predate it; the
 * newest message always survives, cut to the budget when it alone exceeds it.
 */
export function renderTranscript(messages: readonly unknown[], budgetChars: number): string {
  const blocks: string[] = []
  for (const message of messages as TranscriptMessage[]) {
    const rendered = renderMessage(message)
    if (rendered !== undefined) blocks.push(truncate(rendered, BLOCK_MAX_CHARS))
  }
  if (blocks.length === 0) return ''
  const separator = '\n\n'
  const kept: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cost = blocks[i].length + (kept.length > 0 ? separator.length : 0)
    if (used + cost > budgetChars) {
      if (kept.length > 0) kept.unshift(OMITTED_MARKER)
      break
    }
    kept.unshift(blocks[i])
    used += cost
  }
  if (kept.length === 0) return blocks[blocks.length - 1].slice(0, budgetChars)
  return kept.join(separator)
}

export type UnrecoverableKind = 'authentication' | 'credits' | 'context overflow' | 'model unavailable'

/** Claude clears a goal after an error the user has to fix. Transient failures (rate
 * limits, overloads, network) deliberately match nothing so the goal stays set. */
const UNRECOVERABLE: ReadonlyArray<[UnrecoverableKind, RegExp]> = [
  ['authentication', /\b40[13]\b|unauthori[sz]ed|authentication|invalid (?:api[ -])?key|x-api-key/i],
  ['credits', /\bcredit|billing|insufficient[ _](?:funds|balance|quota)|payment required|\b402\b/i],
  ['context overflow', /context (?:window|length)|too (?:long|many tokens)|maximum (?:context|input) (?:length|tokens)/i],
  ['model unavailable', /model.*(?:not found|unavailable|does not exist|not available|unsupported)|no such model|not_found_error|\b404\b/i],
]

export function classifyUnrecoverable(errorMessage: string): UnrecoverableKind | undefined {
  return UNRECOVERABLE.find(([, pattern]) => pattern.test(errorMessage))?.[0]
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export interface GoalSummary {
  condition: string
  durationMs: number
  /** Turns the evaluator has judged. */
  iterations: number
  /** Tokens spent since the goal was set, evaluator calls included. */
  tokens: number
  lastReason?: string
}

/** Claude's status view fields: duration, turn count, and token spend. */
export function summaryText(summary: GoalSummary): string {
  return `${formatDuration(summary.durationMs)} · ${plural(summary.iterations, 'turn')} · ${formatTokens(summary.tokens)} tokens`
}

export const NO_GOAL_TEXT = 'No goal set. Usage: /goal <condition>'

export function formatActiveGoal(summary: GoalSummary): string {
  const turns = summary.iterations === 0 ? 'not yet evaluated' : plural(summary.iterations, 'turn')
  const lines = [`Goal active: ${summary.condition} (${turns})`, `Running for ${formatDuration(summary.durationMs)} · ${formatTokens(summary.tokens)} tokens`]
  if (summary.lastReason) lines.push(`Last check: ${summary.lastReason}`)
  lines.push('/goal clear to stop early')
  return lines.join('\n')
}

export function formatAchievedGoal(summary: GoalSummary): string {
  return `Goal achieved: ${summary.condition} (${summaryText(summary)})\n/goal <condition> to set another`
}

/** Claude's first check-in interval while background work keeps a goal waiting. */
export const DEFAULT_CHECKIN_MINUTES = 30
/** Later check-ins wait twice as long each, up to four times the first interval. */
const MAX_CHECKIN_DOUBLINGS = 2
/** Idle check-ins per goal between user prompts; the third says they are paused. */
export const MAX_IDLE_CHECKINS = 3

/** Milliseconds until the next check-in given how many have been delivered for this
 * goal: CLAUDE_CODE_GOAL_CHECKIN_MINUTES (0 turns check-ins off, junk falls back to
 * the default) scaled by Claude's doubling. */
export function checkinIntervalMs(env: Record<string, string | undefined>, delivered: number): number {
  const raw = env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  const minutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CHECKIN_MINUTES
  return minutes * 60_000 * 2 ** Math.min(delivered, MAX_CHECKIN_DOUBLINGS)
}

export interface RunningWork {
  id: string
  agentType: string
}

/** Claude's check-in turn: the running work to look at, or a nudge to continue when
 * the work stopped without reporting. `paused` marks the capped idle check-in. */
export function checkinText(condition: string, deferredMs: number, running: readonly RunningWork[], paused: boolean): string {
  const minutes = Math.max(1, Math.round(deferredMs / 60_000))
  const pausedNote = paused ? ' Idle check-ins are paused until your next message, so say clearly where things stand.' : ''
  if (running.length === 0) {
    return `Goal check-in: «${condition}» is still active. Its evaluation was deferred for ${minutes} min while background work ran, and that work is no longer running (it finished or was stopped without reporting back). Continue toward the goal.${pausedNote}`
  }
  const list = running.map((work) => `- ${work.id} · subagent ${work.agentType}`).join('\n')
  return `Goal check-in: «${condition}» is still active, and evaluation has been deferred for ${minutes} min because background work is still running:\n${list}\nCheck on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting; if they are stuck or no longer needed, fix or stop them and continue toward the goal.${pausedNote}`
}
