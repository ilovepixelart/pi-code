/**
 * Question Tool - 1-4 questions with options, single- or multi-select.
 * On the TUI the questions share one form: options, a "Type something." entry with an
 * editor (single-select only) and, for several questions, tabs and a final review.
 * Escape in the editor returns to the options; Escape anywhere else cancels.
 * Each question is also offered to a remote responder over pi.events
 * (REMOTE_QUESTION_CHANNEL); the first answer, local or remote, wins.
 */

import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { readManagedSettings } from './internal/managed-settings.ts'
import { readUserSetting } from './internal/settings-chain.ts'

interface OptionWithDesc {
  label: string
  description?: string
}

interface QuestionDetails {
  question: string
  header?: string
  options: string[]
  answer: string | null
  wasCustom?: boolean
  skipped?: boolean
  questions?: QuestionDetails[]
  multiSelect?: boolean
  /** Auto-continued on askUserQuestionTimeout rather than answered or cancelled. */
  timedOut?: boolean
}

type QuestionResult = { content: Array<{ type: 'text'; text: string }>; details: QuestionDetails }

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below label' })),
})

const SingleQuestion = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  header: Type.Optional(Type.String({ description: 'Short label for the question, shown above it, kept to 12 characters' })),
  options: Type.Array(OptionSchema, { description: 'Options for the user to choose from (2-4)', minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow selecting several options (space toggles, enter confirms)' })),
})

/** One question in the flat form, plus an optional batch for Claude's 1-4 questions.
 * The flat fields stay the documented path: a schema offering two equally optional
 * shapes gave smaller models nothing to follow, and they produced neither. */
export const QuestionParams = Type.Object({
  question: Type.Optional(Type.String({ description: 'The question to ask. Required, unless asking several via questions.' })),
  options: Type.Optional(Type.Array(OptionSchema, { description: 'The 2-4 choices for this question, each {label, description?}. Required with question.', minItems: 2, maxItems: 4 })),
  header: Type.Optional(Type.String({ description: 'Optional short label shown above the question, kept to 12 characters' })),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Optional: allow selecting several options (space toggles, enter confirms)' })),
  questions: Type.Optional(Type.Array(SingleQuestion, { description: 'Only to ask 2-4 questions in one call: each entry takes the same fields as above. Leave unset for a single question.', minItems: 1, maxItems: 4 })),
})

export interface QuestionSpec {
  question: string
  header?: string
  options: OptionWithDesc[]
  multiSelect?: boolean
}

/** In-process, question-owned offer; arbitrary custom TUI components are not sent. */
export const REMOTE_QUESTION_CHANNEL = 'pi-code:question:v1'
export type RemoteQuestionOutcome = { action: 'answer'; indices: number[] } | { action: 'text'; text: string } | { action: 'cancel' } | { action: 'pass' }

export interface RemoteQuestionOffer {
  version: 1
  requestId: string
  sessionId: string
  question: string
  header?: string
  options: OptionWithDesc[]
  multiSelect: boolean
  allowFreeText: boolean
  /** Only when the call asks several questions, whose offers are live together:
   * `id` is shared by the call's offers, `index` is 1-based, `total` is their count. */
  batch?: { id: string; index: number; total: number }
  signal: AbortSignal
  /** Must be called during event emission; only one listener receives a settle handle. */
  claim: () => ((outcome: RemoteQuestionOutcome) => boolean) | undefined
  /** The claimed responder reports input activity to reset a configured idle timer. */
  touch: () => boolean
}

/** Normalize either accepted shape into the list of questions to ask, headers shortened. */
function questionList(params: Partial<QuestionSpec> & { questions?: QuestionSpec[] }): QuestionSpec[] {
  if (params.questions && params.questions.length > 0) return params.questions.map((spec) => ({ ...spec, header: shortHeader(spec.header) }))
  if (typeof params.question === 'string') return [{ question: params.question, header: shortHeader(params.header), options: params.options ?? [], multiSelect: params.multiSelect }]
  return []
}

/** Claude keeps a header short for the label slot. Truncating is the forgiving read:
 * rejecting the call costs a turn while the model recovers from a validation error,
 * which is a poor trade for a display detail. */
const HEADER_MAX = 12
export const shortHeader = (header: string | undefined): string | undefined => (header === undefined ? undefined : header.slice(0, HEADER_MAX))

/** Claude's three accepted askUserQuestionTimeout spellings (`60s`, `5m`, `10m`), as
 * milliseconds. Anything else, including unset, means no auto-continue. */
export function parseAskUserQuestionTimeout(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)([sm])$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  return match[2] === 's' ? amount * 1000 : amount * 60 * 1000
}

/** Claude scopes askUserQuestionTimeout to "User or managed": a project's own
 * settings.json cannot set it, so a checked-out repository can never make the
 * user's own dialogs auto-answer themselves. Managed wins over the user's file, as
 * every managed setting does. `home` defaults to the real one and is a parameter
 * only so a test can point it at a fixture without mocking node:os. */
export function askUserQuestionTimeoutMs(home: string = os.homedir()): number | undefined {
  const managed = readManagedSettings() as { askUserQuestionTimeout?: unknown }
  const fromManaged = parseAskUserQuestionTimeout(managed.askUserQuestionTimeout)
  if (fromManaged !== undefined) return fromManaged
  return parseAskUserQuestionTimeout(readUserSetting(home, 'askUserQuestionTimeout'))
}

function unreachable(value: never): never {
  throw new Error(`Unhandled ${JSON.stringify(value)}`)
}

function checkbox(checked: boolean): string {
  return checked ? '[x] ' : '[ ] '
}

function optionLine(label: string, index: number, selected: boolean, theme: Theme): string {
  return (selected ? theme.fg('accent', '❯ ') : '  ') + theme.fg(selected ? 'accent' : 'text', `${index + 1}. ${label}`)
}

/** One row of a question; the cursor indexes into the question's rows. */
type Row = { kind: 'option'; index: number; option: OptionWithDesc } | { kind: 'text' }

function questionRows(spec: QuestionSpec): Row[] {
  // The free-text entry does not compose with checkbox selection, so it is single-select only.
  return [...spec.options.map((option, index): Row => ({ kind: 'option', index, option })), ...(spec.multiSelect ? [] : [{ kind: 'text' } as const])]
}

type SingleAnswer = { kind: 'option'; index: number } | { kind: 'text'; text: string }
/** The checked option indices in option order. */
type MultiAnswer = { kind: 'multi'; indices: number[] }
type Answer = SingleAnswer | MultiAnswer
/** An unconfirmed question when the idle timeout fires; a multiSelect sends what is checked. */
type TimedOut = { kind: 'timedOut'; selected?: MultiAnswer }
type Outcome = Answer | TimedOut

/** What the form ends with; `undefined` in `answers` is an unanswered question. A cancel is null. */
type FormResult = { kind: 'submit'; answers: Array<Answer | undefined> } | { kind: 'timeout'; answers: Outcome[] }

/** A question is answered exactly when `confirmed` is set. */
type QuestionState = { rows: Row[]; cursor: number; typing: boolean; draft: Editor } & ({ mode: 'single'; confirmed?: SingleAnswer } | { mode: 'multi'; checked: boolean[]; confirmed?: MultiAnswer })

function multiAnswer(checked: boolean[]): MultiAnswer {
  return { kind: 'multi', indices: checked.flatMap((on, index) => (on ? [index] : [])) }
}

function answerText(spec: QuestionSpec, answer: Answer): string {
  switch (answer.kind) {
    case 'option':
      return spec.options[answer.index].label
    case 'text':
      return answer.text
    case 'multi':
      return answer.indices.map((index) => spec.options[index].label).join(', ')
    default:
      return unreachable(answer)
  }
}

interface QuestionView {
  width: number
  question: string
  header?: string
  state: QuestionState
  theme: Theme
}

/** The top border, question and rows; the caller adds the tab bar and footer. */
function buildQuestionLines(view: QuestionView): string[] {
  const { width, question, header, state, theme } = view
  const lines: string[] = []
  const add = (s: string) => lines.push(truncateToWidth(s, width))

  add(theme.fg('accent', '─'.repeat(width)))
  if (header) {
    add(theme.bg('selectedBg', theme.fg('text', ` ☐ ${header} `)))
    lines.push('')
  }
  const wrapIndented = (text: string, indent: number, color: 'text' | 'muted') => {
    // Leave at least one column for text when the terminal is narrower than the indent.
    const pad = ' '.repeat(Math.max(0, Math.min(indent, width - 1)))
    for (const line of wrapTextWithAnsi(text.trimEnd(), Math.max(1, width - pad.length))) add(pad + theme.fg(color, line))
  }
  wrapIndented(question, 1, 'text')
  lines.push('')

  const box = (checked: boolean) => (state.mode === 'multi' ? checkbox(checked) : '')
  state.rows.forEach((row, i) => {
    const selected = i === state.cursor
    switch (row.kind) {
      case 'option':
        add(optionLine(box(state.mode === 'multi' && state.checked[row.index]) + row.option.label, i, selected, theme))
        if (row.option.description) wrapIndented(row.option.description, 5, 'muted')
        return
      case 'text':
        add(optionLine(state.typing ? 'Type something. ✎' : 'Type something.', i, selected, theme))
        return
      default:
        unreachable(row)
    }
  })
  if (state.typing) {
    lines.push('')
    add(theme.fg('muted', ' Your answer:'))
    for (const line of state.draft.render(width - 2)) add(` ${line}`)
  }
  return lines
}

function navHint(typing: boolean, multiSelect: boolean, tabs: boolean): string {
  if (typing) return ' Enter to submit · Esc to go back'
  // The longest variant, a multiSelect question in a batch, is exactly 80 columns.
  const move = tabs ? 'Tab/Arrow keys to navigate' : '↑/↓ to navigate'
  return multiSelect ? ` Space to toggle · ${move} · Enter to confirm · Esc to cancel` : ` Enter to select · ${move} · Esc to cancel`
}

/** The first and last tab that fit in `room` columns, one column apart, grown
 * outward from the active tab so it always stays visible. */
function tabWindow(widths: number[], active: number, room: number): [number, number] {
  let first = active
  let last = active
  let used = widths[active]
  for (let grew = true; grew; ) {
    grew = false
    if (first > 0 && used + 1 + widths[first - 1] <= room) {
      used += 1 + widths[--first]
      grew = true
    }
    if (last < widths.length - 1 && used + 1 + widths[last + 1] <= room) {
      used += 1 + widths[++last]
      grew = true
    }
  }
  return [first, last]
}

/** The result line for a question that was not cancelled. */
function renderAnswered(details: QuestionDetails, answer: string, theme: Theme): string {
  if (details.skipped) return theme.fg('warning', 'User skipped this question')
  if (details.timedOut) {
    const already = answer ? theme.fg('muted', ` (already selected: ${answer})`) : ''
    return theme.fg('warning', '⏱ Auto-continued (no response)') + already
  }

  if (details.wasCustom) {
    return theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', answer)
  }
  if (details.multiSelect) {
    return theme.fg('success', '✓ ') + theme.fg('accent', answer || '(none)')
  }
  const idx = details.options.indexOf(answer) + 1
  const display = idx > 0 ? `${idx}. ${answer}` : answer
  return theme.fg('success', '✓ ') + theme.fg('accent', display)
}

/** Arguments stream in partially, so any field may still be missing. */
function renderOptions(args: Partial<QuestionSpec>, theme: Theme): string {
  const multi = args.multiSelect === true
  const opts = Array.isArray(args.options) ? args.options : []
  if (!opts.length) return ''
  const labels = opts.map((o: OptionWithDesc) => o.label)
  const shown = multi ? labels : [...labels, 'Type something.']
  const numbered = shown.map((o, i) => `${i + 1}. ${o}`)
  return `\n${theme.fg('dim', `  Options${multi ? ' (multi)' : ''}: ${numbered.join(', ')}`)}`
}

function renderBatchCall(specs: Array<Partial<QuestionSpec> | null>, theme: Theme): Text {
  const lines = specs.map((entry, index) => {
    const spec = entry ?? {}
    const heading = shortHeader(spec.header) ?? `Q${index + 1}`
    return theme.fg('toolTitle', theme.bold(`question [${heading}] `)) + String(spec.question ?? '') + renderOptions(spec, theme)
  })
  return new Text(lines.join('\n\n'), 0, 0)
}

function renderSingleCall(args: Partial<QuestionSpec>, theme: Theme): Text {
  const heading = args.header ? `[${shortHeader(String(args.header))}] ` : ''
  const text = theme.fg('toolTitle', theme.bold('question ')) + theme.fg('muted', heading + String(args.question ?? ''))
  return new Text(text + renderOptions(args, theme), 0, 0)
}

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'question',
    label: 'Question',
    description:
      'Ask the user a question and let them pick from options. Use when you need user input to proceed. Pass question and options, for example {"question": "Which one?", "options": [{"label": "alpha"}, {"label": "beta"}]}. To ask 2-4 questions at once, pass questions instead, with the same fields per entry.',
    parameters: QuestionParams,
    // The host shows a custom dialog in one editor slot, so two questions running in
    // parallel leave the first unanswerable and the run unable to finish.
    executionMode: 'sequential',

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const specs = questionList(rawParams as Partial<QuestionSpec> & { questions?: QuestionSpec[] })
      if (specs.length === 0) {
        return { content: [{ type: 'text', text: 'Error: No question provided' }], details: { question: '', options: [], answer: null } as QuestionDetails }
      }
      if (ctx.hasUI && ctx.mode === 'tui' && specs.every((spec) => spec.options.length > 0)) {
        return overlayResult(specs, await askViaOverlay(specs, ctx, askUserQuestionTimeoutMs(), pi.events, signal))
      }

      const results: QuestionResult[] = []
      for (const spec of specs) {
        const result = await askOne(spec, ctx, pi.events, signal)
        results.push(result)
        if (result.details.answer === null) {
          // Only the user's cancel declines the call; an error (no UI, no options) keeps its own text.
          if (ctx.hasUI && spec.options.length > 0) return cancelled(specs)
          break
        }
      }
      return combine(specs, results)
    },

    renderCall(args, theme, _context) {
      if (Array.isArray(args.questions) && args.questions.length > 0) {
        return renderBatchCall(args.questions, theme)
      }
      return renderSingleCall(args, theme)
    },
    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionDetails | undefined
      if (!details) {
        const text = result.content[0]
        return new Text(text?.type === 'text' ? text.text : '', 0, 0)
      }

      if (details.questions && details.answer !== null) {
        return new Text(
          details.questions
            .map((detail) => {
              const rendered = detail.answer === null ? theme.fg('warning', 'Cancelled') : renderAnswered(detail, detail.answer, theme)
              return `${detail.header ? `[${detail.header}] ` : ''}${detail.question}\n${rendered}`
            })
            .join('\n\n'),
          0,
          0,
        )
      }

      if (details.answer === null) {
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      }

      return new Text(renderAnswered(details, details.answer, theme), 0, 0)
    },
  })
}

/** null is a cancel. */
type QuestionAnswer = Answer | null

/** A claimed offer raced against the open overlay: whichever answers first wins. */
interface RemoteQuestion {
  /** Routes remote answers into the overlay and remote activity into its idle timer. */
  attach: (answer: (value: QuestionAnswer) => void, touch: () => void) => void
  /** Ends the offer; the responder's settle handle and touch are rejected from then on. */
  close: () => void
}
type RemoteOffer = { kind: 'settled'; value: QuestionAnswer } | { kind: 'claimed'; remote: RemoteQuestion }

function validIndices(indices: unknown, count: number, multiSelect: boolean): indices is number[] {
  if (!Array.isArray(indices) || (!multiSelect && indices.length !== 1)) return false
  return new Set(indices).size === indices.length && indices.every((index) => Number.isInteger(index) && index >= 1 && index <= count)
}

/** A remote outcome as the answer it stands for: null is a cancel, undefined is a
 * pass or anything this question cannot accept, which must never become an answer. */
function remoteAnswer(outcome: RemoteQuestionOutcome, options: OptionWithDesc[], multiSelect: boolean): QuestionAnswer | undefined {
  if (outcome === null || typeof outcome !== 'object') return undefined
  if (outcome.action === 'cancel') return null
  if (outcome.action === 'text') {
    const text = typeof outcome.text === 'string' ? outcome.text.trim() : ''
    return !multiSelect && text ? { kind: 'text', text } : undefined
  }
  if (outcome.action !== 'answer') return undefined
  // Read once and copied, so a getter or Proxy cannot answer with other indices
  // than the ones that passed validation.
  const raw: unknown = outcome.indices
  const indices: unknown = Array.isArray(raw) ? [...raw] : undefined
  if (!validIndices(indices, options.length, multiSelect)) return undefined
  return multiSelect ? multiAnswer(options.map((_, index) => indices.includes(index + 1))) : { kind: 'option', index: indices[0] - 1 }
}

/** Undefined when nobody claims synchronously, so the overlay opens with no async gap. */
function offerRemoteQuestion(params: QuestionSpec, ctx: ExtensionContext, events: ExtensionAPI['events'] | undefined, signal: AbortSignal | undefined, batch?: RemoteQuestionOffer['batch']): RemoteOffer | undefined {
  if (!events) return undefined
  if (signal?.aborted) return { kind: 'settled', value: null }

  const multiSelect = params.multiSelect === true
  const controller = new AbortController()
  let claimed = false
  let early: { value: QuestionAnswer } | undefined
  let deliver: ((value: QuestionAnswer) => void) | undefined
  let touchOverlay: (() => void) | undefined
  const close = (): void => controller.abort()
  const settle = (value: QuestionAnswer): void => {
    close()
    if (deliver) deliver(value)
    else early = { value }
  }
  // Pi aborts the turn before a session replacement invalidates ctx, so this is
  // also the session-replacement path; ctx is never read after emission.
  const abort = (): void => settle(null)
  signal?.addEventListener('abort', abort, { once: true })

  const offer: RemoteQuestionOffer = {
    version: 1,
    requestId: randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    question: params.question,
    header: params.header,
    options: params.options.map(({ label, description }) => ({ label, ...(description === undefined ? {} : { description }) })),
    multiSelect,
    allowFreeText: !multiSelect,
    ...(batch ? { batch } : {}),
    signal: controller.signal,
    claim: () => {
      if (claimed || controller.signal.aborted) return undefined
      claimed = true
      return (outcome) => {
        if (controller.signal.aborted) return false
        const value = remoteAnswer(outcome, params.options, multiSelect)
        if (value !== undefined) {
          settle(value)
          return true
        }
        // A pass or invalid reply only withdraws the remote side; the overlay stays
        // open, and a turn abort must still cancel it.
        controller.abort()
        return outcome?.action === 'pass'
      }
    },
    touch: () => {
      if (!claimed || controller.signal.aborted) return false
      touchOverlay?.()
      return true
    },
  }

  events.emit(REMOTE_QUESTION_CHANNEL, offer)
  // From here on the overlay's own abort listener cancels the question.
  signal?.removeEventListener('abort', abort)
  if (early) return { kind: 'settled', value: early.value }
  if (!claimed || controller.signal.aborted) {
    close()
    return undefined
  }
  return {
    kind: 'claimed',
    remote: {
      attach: (answer, touch) => {
        deliver = answer
        touchOverlay = touch
        // A reply accepted before the form opened, while a later question was being offered.
        if (early) answer(early.value)
      },
      close,
    },
  }
}

async function askOne(spec: QuestionSpec, ctx: ExtensionContext, events: ExtensionAPI['events'] | undefined, signal: AbortSignal | undefined): Promise<QuestionResult> {
  if (!ctx.hasUI) {
    return {
      content: [{ type: 'text', text: 'Error: UI not available (running in non-interactive mode)' }],
      details: { question: spec.question, options: spec.options.map((o) => o.label), answer: null },
    }
  }
  if (spec.options.length === 0) {
    return { content: [{ type: 'text', text: 'Error: No options provided' }], details: { question: spec.question, options: [], answer: null } }
  }
  // ui.custom() is terminal-only: in RPC mode it resolves undefined without asking.
  // askUserQuestionTimeout needs a keyboard and a visible countdown, so dialogs do not apply it.
  if (ctx.mode === 'tui') return overlayResult([spec], await askViaOverlay([spec], ctx, askUserQuestionTimeoutMs(), events, signal))
  return answerToResult(spec, await askViaDialogs(spec, ctx))
}

/** A lone question's own result, or several joined under their questions. */
function combine(specs: QuestionSpec[], results: QuestionResult[], text = results.map((result, index) => `${specs[index].question}\n${result.content[0].text}`).join('\n\n')): QuestionResult {
  if (specs.length === 1) return results[0]
  const collected = results.map((result) => result.details)
  return { content: [{ type: 'text', text }], details: { ...collected[0], questions: collected } }
}

/** As in Claude, a cancel declines the whole call and discards answers already given. */
function cancelled(specs: QuestionSpec[]): QuestionResult {
  return combine(
    specs,
    specs.map((spec) => answerToResult(spec, null)),
    'User cancelled the selection',
  )
}

/** `result` is undefined when ui.custom resolves without a terminal, which reads as a cancel. */
function overlayResult(specs: QuestionSpec[], result: FormResult | null | undefined): QuestionResult {
  if (!result) return cancelled(specs)
  const lone = specs.length === 1
  switch (result.kind) {
    case 'submit':
      return combine(
        specs,
        specs.map((spec, index) => answerToResult(spec, result.answers[index])),
      )
    case 'timeout': {
      const combined = combine(
        specs,
        specs.map((spec, index) => answerToResult(spec, result.answers[index], lone)),
      )
      if (lone) return combined
      // Claude tells the model the user may be away on every timeout, even a fully answered one.
      return { ...combined, content: [{ type: 'text', text: `${combined.content[0].text}\n\n${AWAY_NOTICE} ${PROCEED_NOTICE}` }] }
    }
    default:
      return unreachable(result)
  }
}

const AWAY_NOTICE = 'No response after the configured idle timeout; the user may be away from the keyboard.'
const PROCEED_NOTICE = 'Proceed on your own judgment; you can ask again later if needed.'

/** `outcome` undefined is a skipped question and null a cancel. `awayNotice` false
 * leaves the timeout notice to the caller, which sends it once per call. */
function answerToResult(spec: QuestionSpec, outcome: Outcome | null | undefined, awayNotice = true): QuestionResult {
  const multiSelect = spec.multiSelect === true
  const base = { question: spec.question, options: spec.options.map((o) => o.label), ...(spec.header ? { header: spec.header } : {}), ...(multiSelect ? { multiSelect: true } : {}) }

  if (outcome === undefined) {
    return { content: [{ type: 'text', text: 'User skipped this question' }], details: { ...base, answer: '', skipped: true } }
  }
  if (outcome === null) {
    return { content: [{ type: 'text', text: 'User cancelled the selection' }], details: { ...base, answer: null } }
  }

  switch (outcome.kind) {
    case 'timedOut': {
      // Claude: "tells Claude you may be away from your keyboard, so Claude proceeds
      // on its own judgment and can re-ask later." Not framed as a cancel: `answer` is
      // '' rather than null, so renderResult and a batch's own null-check both read it
      // as "answered nothing, but not declined" rather than the user having said no.
      const selected = outcome.selected ? answerText(spec, outcome.selected) : ''
      const already = selected ? ` Already selected: ${selected}.` : ''
      return {
        content: [{ type: 'text', text: awayNotice ? `${AWAY_NOTICE}${already} ${PROCEED_NOTICE}` : `No response.${already}` }],
        details: { ...base, answer: selected, timedOut: true },
      }
    }
    case 'text':
      return { content: [{ type: 'text', text: `User wrote: ${outcome.text}` }], details: { ...base, answer: outcome.text, wasCustom: true } }
    case 'option': {
      const label = spec.options[outcome.index].label
      return { content: [{ type: 'text', text: `User selected: ${outcome.index + 1}. ${label}` }], details: { ...base, answer: label, wasCustom: false } }
    }
    case 'multi': {
      const labels = answerText(spec, outcome)
      return { content: [{ type: 'text', text: `User selected: ${labels || '(none)'}` }], details: { ...base, answer: labels, wasCustom: false } }
    }
    default:
      return unreachable(outcome)
  }
}

/** Claude: "You see a countdown for the last 20 seconds." */
const COUNTDOWN_WINDOW_MS = 20_000
/** Granularity of the idle-timer tick: fine enough that the countdown's displayed
 * second changes on time, coarse enough not to re-render needlessly often. */
const IDLE_TICK_MS = 250

/** Terminal path: the form for one or several questions. Each row is an option, then
 * the free-text entry for a single-select; several questions add tabs and a review.
 *
 * `timeoutMs`, when set, is Claude's askUserQuestionTimeout: "After a question sits
 * that long with no input, the dialog closes on its own: it submits any options
 * you'd already selected and tells Claude you may be away from your keyboard, so
 * Claude proceeds on its own judgment and can re-ask later. You see a countdown for
 * the last 20 seconds. Press any key to restart the timer." Terminal focus-in
 * restarting the timer, the other documented reset trigger, is not implemented:
 * pi's TUI input stream is not confirmed to carry the terminal's own focus-report
 * escape sequences, and guessing at that risks misreading ordinary input as a
 * focus event on a terminal that reports it differently.
 */
export async function askViaOverlay(specs: QuestionSpec[], ctx: ExtensionContext, timeoutMs?: number, events?: ExtensionAPI['events'], signal?: AbortSignal): Promise<FormResult | null> {
  const saved: Array<Answer | undefined> = specs.map(() => undefined)
  const lone = specs.length === 1
  const batchId = lone ? undefined : randomUUID()
  // One offer per question, made before the form opens and live until that question is settled.
  const remotes: Array<RemoteQuestion | undefined> = specs.map(() => undefined)
  let dispose = () => {
    for (const remote of remotes) remote?.close()
  }
  try {
    for (const [index, spec] of specs.entries()) {
      if (signal?.aborted) return null
      const offer = offerRemoteQuestion(spec, ctx, events, signal, batchId === undefined ? undefined : { id: batchId, index: index + 1, total: specs.length })
      if (offer?.kind === 'claimed') remotes[index] = offer.remote
      else if (offer?.value === null) return null
      else saved[index] = offer?.value
    }
    // Questions answered remotely during emission need no terminal.
    if (saved.every(Boolean)) return { kind: 'submit', answers: saved }
    let active = saved.indexOf(undefined)

    return await ctx.ui.custom<FormResult | null>((tui, theme, _kb, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg('accent', s),
        selectList: {
          selectedPrefix: (t) => theme.fg('accent', t),
          selectedText: (t) => theme.fg('accent', t),
          description: (t) => theme.fg('muted', t),
          scrollInfo: (t) => theme.fg('dim', t),
          noMatch: (t) => theme.fg('warning', t),
        },
      }
      const states = specs.map((spec): QuestionState => {
        const draft = new Editor(tui, editorTheme)
        const common = { rows: questionRows(spec), cursor: 0, typing: false, draft }
        const state: QuestionState = spec.multiSelect ? { ...common, mode: 'multi', checked: spec.options.map(() => false) } : { ...common, mode: 'single' }
        draft.onSubmit = (value) => {
          const text = value.trim()
          state.typing = false
          draft.setText('')
          if (text) commit({ kind: 'text', text })
          else refresh()
        }
        return state
      })
      saved.forEach((value, index) => {
        if (value) restoreRemoteAnswer(index, value)
      })
      let reviewIndex = 0
      let finished = false
      let deadline = 0
      let countdown: number | undefined
      resetIdleTimer()
      const timer = timeoutMs === undefined ? undefined : setInterval(idleTick, IDLE_TICK_MS)

      function refresh(): void {
        tui.requestRender()
      }
      function resetIdleTimer(): void {
        deadline = Date.now() + (timeoutMs ?? 0)
      }
      dispose = () => {
        finished = true
        clearInterval(timer)
        for (const remote of remotes) remote?.close()
        signal?.removeEventListener('abort', abort)
      }
      function finish(value: FormResult | null): void {
        if (finished) return
        dispose()
        done(value)
      }
      function abort(): void {
        finish(null)
      }
      /** A confirmed multi-select with nothing left checked is unanswered. */
      function confirmedAnswer(state: QuestionState): Answer | undefined {
        return state.mode === 'multi' && !state.checked.some(Boolean) ? undefined : state.confirmed
      }
      /** The confirmed answer, else whatever is checked. */
      function draftAnswer(state: QuestionState): Answer | undefined {
        const confirmed = confirmedAnswer(state)
        if (confirmed) return confirmed
        return state.mode === 'multi' && state.checked.some(Boolean) ? multiAnswer(state.checked) : undefined
      }
      function answers(): Array<Answer | undefined> {
        return states.map(draftAnswer)
      }
      /** The confirmed answer, else only the checked options. */
      function timeoutAnswer(state: QuestionState): Outcome {
        const confirmed = confirmedAnswer(state)
        if (confirmed) return confirmed
        return state.mode === 'multi' ? { kind: 'timedOut', selected: multiAnswer(state.checked) } : { kind: 'timedOut' }
      }
      /** Confirms an answer that matches the question's mode. */
      function confirm(state: QuestionState, answer: Answer): void {
        if (state.mode === 'multi') {
          if (answer.kind === 'multi') state.confirmed = answer
        } else if (answer.kind !== 'multi') state.confirmed = answer
      }
      function restoreRemoteAnswer(index: number, value: Answer): void {
        const state = states[index]
        confirm(state, value)
        state.typing = false
        state.draft.setText('')
        switch (value.kind) {
          case 'multi':
            if (state.mode === 'multi') state.checked = state.checked.map((_, option) => value.indices.includes(option))
            return
          case 'text':
            state.cursor = state.rows.findIndex((row) => row.kind === 'text')
            return
          case 'option':
            state.cursor = state.rows.findIndex((row) => row.kind === 'option' && row.index === value.index)
            return
          default:
            unreachable(value)
        }
      }
      function receive(index: number, value: QuestionAnswer): void {
        if (finished) return
        resetIdleTimer()
        if (value === null) {
          finish(null)
          return
        }
        restoreRemoteAnswer(index, value)
        if (answers().every(Boolean)) finish({ kind: 'submit', answers: answers() })
        else if (index === active) navigate(active + 1)
        else refresh()
      }
      function navigate(index: number): void {
        active = index
        refresh()
      }
      function commit(value: Answer): void {
        confirm(states[active], value)
        remotes[active]?.close()
        if (lone) finish({ kind: 'submit', answers: [value] })
        else navigate(active + 1)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      remotes.forEach((remote, index) => {
        remote?.attach((value) => receive(index, value), resetIdleTimer)
      })
      function idleTick(): void {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          finish({ kind: 'timeout', answers: states.map(timeoutAnswer) })
          return
        }
        const next = remaining <= COUNTDOWN_WINDOW_MS ? Math.ceil(remaining / 1000) : undefined
        if (next !== countdown) {
          countdown = next
          refresh()
        }
      }
      function confirmSelection(state: QuestionState): void {
        const row = state.rows[state.cursor]
        switch (row.kind) {
          case 'text':
            state.typing = true
            return
          case 'option':
            break
          default:
            unreachable(row)
        }
        if (state.mode === 'multi') {
          // A lone question answers with nothing checked; in a batch that leaves the question unanswered.
          if (state.checked.some(Boolean) || lone) commit(multiAnswer(state.checked))
          else {
            state.confirmed = undefined
            navigate(active + 1)
          }
          return
        }
        commit({ kind: 'option', index: row.index })
      }
      function moveFocus(state: QuestionState, data: string): boolean {
        if (matchesKey(data, Key.up)) state.cursor = Math.max(0, state.cursor - 1)
        else if (matchesKey(data, Key.down)) state.cursor = Math.min(state.rows.length - 1, state.cursor + 1)
        else return false
        refresh()
        return true
      }
      function toggleChecked(state: QuestionState): void {
        const row = state.rows[state.cursor]
        if (state.mode !== 'multi' || row.kind !== 'option') return
        state.checked[row.index] = !state.checked[row.index]
        // A confirmed answer follows every toggle, so what is checked is what is submitted.
        if (state.confirmed) state.confirmed = multiAnswer(state.checked)
      }
      function handleTypingInput(state: QuestionState, data: string): void {
        if (matchesKey(data, Key.escape)) {
          state.typing = false
          state.draft.setText('')
        } else if (!matchesKey(data, Key.tab) && !matchesKey(data, Key.shift('tab'))) {
          state.draft.handleInput(data)
        }
        refresh()
      }
      function handleQuestionInput(state: QuestionState, data: string): void {
        if (state.typing) {
          handleTypingInput(state, data)
          return
        }
        if (moveFocus(state, data)) return
        if (matchesKey(data, Key.escape)) finish(null)
        else if (matchesKey(data, Key.enter)) confirmSelection(state)
        else if (data === ' ') toggleChecked(state)
        refresh()
      }
      function navigateWithKey(data: string): boolean {
        if (states[active]?.typing) return false
        const next = matchesKey(data, Key.tab) || matchesKey(data, Key.right)
        const previous = matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)
        if (!next && !previous) return false
        navigate(previous ? Math.max(0, active - 1) : Math.min(specs.length, active + 1))
        return true
      }
      function chooseReviewOption(): void {
        finish(reviewIndex === 0 ? { kind: 'submit', answers: answers() } : null)
      }
      function handleReviewInput(data: string): void {
        if (matchesKey(data, Key.up)) reviewIndex = 0
        else if (matchesKey(data, Key.down)) reviewIndex = 1
        else if (matchesKey(data, Key.enter)) chooseReviewOption()
        else if (matchesKey(data, Key.escape)) finish(null)
        refresh()
      }
      function handleInput(data: string): void {
        if (finished) return
        resetIdleTimer()
        if (!lone && navigateWithKey(data)) return
        const state = states[active]
        if (state) handleQuestionInput(state, data)
        else handleReviewInput(data)
      }

      function renderTabs(width: number, saved: Array<Answer | undefined>): string {
        const tabs = specs.map((spec, index) => ` ${saved[index] ? '☒' : '☐'} ${spec.header ?? `Q${index + 1}`} `)
        tabs.push(' ✔ Submit ')
        const widths = tabs.map((tab) => tab.length)
        const arrows = widths[active] + 4 <= width
        const [first, last] = tabWindow(widths, active, arrows ? width - 4 : width)
        const shown = tabs.slice(first, last + 1).map((tab, offset) => (first + offset === active ? theme.bg('selectedBg', theme.fg('text', tab)) : theme.fg('text', tab)))
        return arrows ? `${theme.fg('dim', '←')} ${shown.join(' ')} ${theme.fg('dim', '→')}` : shown.join(' ')
      }
      function reviewBody(width: number, saved: Array<Answer | undefined>): string[] {
        const lines = [` ${theme.bold('Review your answers')}`, '']
        const item = (marker: string, text: string, color: 'text' | 'success') => {
          const lead = Math.min(marker.length, width - 1)
          wrapTextWithAnsi(text, Math.max(1, width - lead)).forEach((line, n) => {
            lines.push((n === 0 ? theme.fg(color, marker.slice(0, lead)) : ' '.repeat(lead)) + theme.fg(color, line))
          })
        }
        if (saved.includes(undefined)) lines.push(theme.fg('warning', ' ⚠ You have not answered all questions'), '')
        specs.forEach((spec, index) => {
          const answer = saved[index]
          if (!answer) return
          item(' ● ', spec.question, 'text')
          item('   → ', answerText(spec, answer) || '(none)', 'success')
        })
        if (saved.some(Boolean)) lines.push('')
        lines.push(theme.fg('muted', ' Ready to submit your answers?'), '', optionLine('Submit answers', 0, reviewIndex === 0, theme), optionLine('Cancel', 1, reviewIndex === 1, theme))
        return lines
      }
      function render(width: number): string[] {
        width = Math.max(1, width)
        const state = states[active]
        const spec = specs[active]
        const saved = answers()
        const rule = theme.fg('accent', '─'.repeat(width))
        const lines = state ? buildQuestionLines({ width, question: theme.bold(spec.question), header: lone ? spec.header : undefined, state, theme }) : [rule, ...reviewBody(width, saved)]
        lines.push('', theme.fg('dim', navHint(state?.typing === true, spec?.multiSelect === true, !lone)))
        if (countdown !== undefined) lines.push(theme.fg('warning', ` Auto-continuing in ${countdown}s if idle · press any key to stay`))
        lines.push(rule)
        // The tab bar sits inside the frame, under its top border.
        if (!lone) lines.splice(1, 0, renderTabs(width, saved), '')
        return lines.map((line) => truncateToWidth(line, width))
      }
      return {
        render,
        handleInput,
        invalidate: () => {
          for (const state of states) state.draft.invalidate()
        },
        dispose,
      }
    })
  } finally {
    dispose()
  }
}

/** Dialog-primitive fallback for UI without a terminal (RPC mode supports
 * select/input/notify but not custom components). A dismissed dialog reads as a
 * cancel, same as Escape in the overlay. */
async function askViaDialogs(params: QuestionSpec, ctx: ExtensionContext): Promise<QuestionAnswer> {
  const title = params.header ? `[${params.header}] ${params.question}` : params.question
  // Number the labels: ctx.ui.select returns the chosen label string, so duplicate
  // labels (or a model-supplied option named like the free-text entry) would be
  // ambiguous by text alone; the number is the unambiguous way back to the option.
  const labels = [...params.options.map((option) => option.label), ...(params.multiSelect ? [] : ['Type something.'])].map((label, i) => `${i + 1}. ${label}`)
  const choice = await ctx.ui.select(title, labels)
  if (choice === undefined) return null
  const index = labels.indexOf(choice)
  if (index === params.options.length) {
    const typed = await ctx.ui.input(params.question, 'Your answer')
    // A dismissed dialog cancels; a submitted empty answer is an (empty) answer, not a
    // cancel, so one accidental blank Enter does not abort the rest of a question batch.
    if (typed === undefined) return null
    return { kind: 'text', text: typed.trim() }
  }
  // A choice outside the offered labels cannot name an option.
  if (index < 0) return null
  return params.multiSelect ? { kind: 'multi', indices: [index] } : { kind: 'option', index }
}
