/**
 * Question Tool - a question with options, single- or multi-select.
 * Full custom UI: options list + inline editor for "Type something..." (single-select
 * only), or space-toggled checkboxes when `multiSelect` is set. An optional `header`
 * labels the question. Escape in the editor returns to options; Escape in options cancels.
 * Multiple terminal questions share a navigable overlay and a final review.
 * On the TUI each question is also offered to a remote responder over pi.events
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

type DisplayOption = OptionWithDesc & { isOther?: boolean }

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
  options: DisplayOption[]
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
  signal: AbortSignal
  /** Must be called during event emission; only one listener receives a settle handle. */
  claim: () => ((outcome: RemoteQuestionOutcome) => boolean) | undefined
  /** The claimed responder reports input activity to reset a configured idle timer. */
  touch: () => boolean
}

/** Normalize either accepted shape into the list of questions to ask. */
function questionList(params: Partial<QuestionSpec> & { questions?: QuestionSpec[] }): QuestionSpec[] {
  if (params.questions && params.questions.length > 0) return params.questions
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

function checkbox(checked: boolean | undefined): string {
  if (checked === undefined) return ''
  return checked ? '[x] ' : '[ ] '
}

function optionLine(opt: DisplayOption, index: number, selected: boolean, editMode: boolean, checked: boolean | undefined, theme: Theme): string {
  const label = `${index + 1}. ${checkbox(checked)}${opt.label}`
  const prefix = selected ? theme.fg('accent', '> ') : '  '
  if (opt.isOther === true && editMode) {
    return prefix + theme.fg('accent', `${label} ✎`)
  }
  if (selected) {
    return prefix + theme.fg('accent', label)
  }
  return `  ${theme.fg('text', label)}`
}

interface QuestionView {
  width: number
  question: string
  header?: string
  options: DisplayOption[]
  optionIndex: number
  editMode: boolean
  multiSelect: boolean
  checked: boolean[]
  editor: Editor
  theme: Theme
  /** Claude: "You see a countdown for the last 20 seconds." Undefined the rest of
   * the idle window, and always when there is no configured timeout at all. */
  countdownSeconds?: number
}

function buildQuestionLines(view: QuestionView): string[] {
  const { width, question, header, options, optionIndex, editMode, multiSelect, checked, editor, theme, countdownSeconds } = view
  const lines: string[] = []
  const add = (s: string) => lines.push(truncateToWidth(s, width))

  add(theme.fg('accent', '─'.repeat(width)))
  if (header) add(theme.fg('muted', ` [${header}]`))
  add(theme.fg('text', ` ${question}`))
  lines.push('')

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    const box = multiSelect && opt.isOther !== true ? checked[i] : undefined
    add(optionLine(opt, i, i === optionIndex, editMode, box, theme))
    if (opt.description) {
      add(`     ${theme.fg('muted', opt.description)}`)
    }
  }

  if (editMode) {
    lines.push('')
    add(theme.fg('muted', ' Your answer:'))
    for (const line of editor.render(Math.max(1, width - 2))) {
      add(` ${line}`)
    }
  }

  lines.push('')
  add(theme.fg('dim', navHint(editMode, multiSelect)))
  if (countdownSeconds !== undefined) {
    add(theme.fg('warning', ` Auto-continuing in ${countdownSeconds}s if idle · press any key to stay`))
  }
  add(theme.fg('accent', '─'.repeat(width)))

  return lines
}

function navHint(editMode: boolean, multiSelect: boolean): string {
  if (editMode) return ' Enter to submit • Esc to go back'
  if (multiSelect) return ' ↑↓ navigate • Space to toggle • Enter to confirm • Esc to cancel'
  return ' ↑↓ navigate • Enter to select • Esc to cancel'
}

/** The comma-joined labels of the checked options, in order. */
function selectedLabels(options: DisplayOption[], checked: boolean[]): string {
  return options
    .filter((_, i) => checked[i])
    .map((o) => o.label)
    .join(', ')
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

function renderBatchCall(specs: QuestionSpec[], theme: Theme): Text {
  const lines = specs.map((spec, index) => {
    const heading = shortHeader(spec.header) ?? `Q${index + 1}`
    const options = spec.options.map((option, i) => `${i + 1}. ${option.label}`).join(', ')
    return `${theme.fg('toolTitle', theme.bold(`question [${heading}] `)) + spec.question}\n${theme.fg('dim', `  Options${spec.multiSelect ? ' (multi)' : ''}: ${options}`)}`
  })
  return new Text(lines.join('\n\n'), 0, 0)
}

function renderSingleCall(args: Partial<QuestionSpec>, theme: Theme): Text {
  const multi = args.multiSelect === true
  const heading = args.header ? `[${shortHeader(String(args.header))}] ` : ''
  let text = theme.fg('toolTitle', theme.bold('question ')) + theme.fg('muted', heading + String(args.question ?? ''))
  const opts = Array.isArray(args.options) ? args.options : []
  if (opts.length) {
    const labels = opts.map((o: OptionWithDesc) => o.label)
    const shown = multi ? labels : [...labels, 'Type something.']
    const numbered = shown.map((o, i) => `${i + 1}. ${o}`)
    const optionsLine = `  Options${multi ? ' (multi)' : ''}: ${numbered.join(', ')}`
    text += `\n${theme.fg('dim', optionsLine)}`
  }
  return new Text(text, 0, 0)
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
      if (specs.length === 1) return await askOne(specs[0], ctx, pi.events, signal)

      if (ctx.hasUI && ctx.mode === 'tui' && specs.every((spec) => spec.options.length > 0)) {
        const answers = await askBatchViaOverlay(specs, ctx, pi.events, signal)
        const results = (answers === null ? specs.slice(0, 1) : specs).map((spec, index) => answerToResult(spec, answers === null ? null : answers[index]))
        const collected = results.map((result) => result.details)
        return { content: [{ type: 'text', text: results.map((result, index) => `${specs[index].question}\n${result.content[0].text}`).join('\n\n') }], details: { ...collected[0], questions: collected } }
      }

      const texts: string[] = []
      const collected: QuestionDetails[] = []
      for (const spec of specs) {
        const result = await askOne(spec, ctx, pi.events, signal)
        const detail = result.details as QuestionDetails
        collected.push(detail)
        texts.push(`${spec.question}\n${result.content[0].text}`)
        if (detail.answer === null) break
      }
      return { content: [{ type: 'text', text: texts.join('\n\n') }], details: { ...collected[0], questions: collected } as QuestionDetails }
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

type QuestionAnswer = Awaited<ReturnType<typeof askViaOverlay>>

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
function remoteAnswer(outcome: RemoteQuestionOutcome, options: DisplayOption[], multiSelect: boolean): QuestionAnswer | undefined {
  if (outcome === null || typeof outcome !== 'object') return undefined
  if (outcome.action === 'cancel') return null
  if (outcome.action === 'text') {
    const text = typeof outcome.text === 'string' ? outcome.text.trim() : ''
    return !multiSelect && text ? { answer: text, wasCustom: true } : undefined
  }
  if (outcome.action !== 'answer') return undefined
  // Read once and copied, so a getter or Proxy cannot answer with other indices
  // than the ones that passed validation.
  const raw: unknown = outcome.indices
  const indices: unknown = Array.isArray(raw) ? [...raw] : undefined
  if (!validIndices(indices, options.length, multiSelect)) return undefined
  const checked = options.map((_, index) => indices.includes(index + 1))
  return { answer: selectedLabels(options, checked), wasCustom: false, ...(multiSelect ? { checked } : { index: indices[0] }) }
}

/** Undefined when nobody claims synchronously, so the overlay opens with no async gap. */
function offerRemoteQuestion(params: QuestionSpec, allOptions: DisplayOption[], ctx: ExtensionContext, events: ExtensionAPI['events'] | undefined, signal: AbortSignal | undefined): RemoteOffer | undefined {
  if (!events) return undefined
  if (signal?.aborted) return { kind: 'settled', value: null }

  const multiSelect = params.multiSelect === true
  const controller = new AbortController()
  let claimed = false
  let early: { value: QuestionAnswer } | undefined
  let deliver: ((value: QuestionAnswer) => void) | undefined
  let touchOverlay: (() => void) | undefined
  const close = (): void => {
    controller.abort()
    signal?.removeEventListener('abort', abort)
  }
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
    header: shortHeader(params.header),
    options: params.options.map(({ label, description }) => ({ label, ...(description === undefined ? {} : { description }) })),
    multiSelect,
    allowFreeText: allOptions.some((option) => option.isOther === true),
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
      },
      close,
    },
  }
}

/** ui.custom() is terminal-only: with a UI but no terminal (RPC mode) it resolves
 * undefined immediately, which would read as a cancel without ever asking. Ask
 * through the dialog primitives there instead. askUserQuestionTimeout is a TUI
 * concept (a countdown, a keypress resetting it): the dialog-primitive fallback
 * has no keyboard or visible countdown to drive it, so it is not applied there. */
async function collectAnswer(params: QuestionSpec, ctx: ExtensionContext, allOptions: DisplayOption[], multiSelect: boolean, events?: ExtensionAPI['events'], signal?: AbortSignal): Promise<QuestionAnswer> {
  if (ctx.mode !== 'tui') return askViaDialogs(params, ctx, allOptions, multiSelect)
  const offer = offerRemoteQuestion(params, allOptions, ctx, events, signal)
  if (offer?.kind === 'settled') return offer.value
  const remote = offer?.remote
  try {
    return await askViaOverlay(params, ctx, allOptions, multiSelect, askUserQuestionTimeoutMs(), remote)
  } finally {
    remote?.close()
  }
}

async function askOne(params: QuestionSpec, ctx: ExtensionContext, events?: ExtensionAPI['events'], signal?: AbortSignal): Promise<{ content: Array<{ type: 'text'; text: string }>; details: QuestionDetails }> {
  if (!ctx.hasUI) {
    return {
      content: [{ type: 'text', text: 'Error: UI not available (running in non-interactive mode)' }],
      details: {
        question: params.question,
        options: params.options.map((o) => o.label),
        answer: null,
      } as QuestionDetails,
    }
  }

  if (params.options.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: No options provided' }],
      details: { question: params.question, options: [], answer: null } as QuestionDetails,
    }
  }

  const multiSelect = params.multiSelect === true
  // The free-text option does not compose with checkbox selection, so it is single-select only.
  const allOptions: DisplayOption[] = multiSelect ? [...params.options] : [...params.options, { label: 'Type something.', isOther: true }]

  const result = await collectAnswer(params, ctx, allOptions, multiSelect, events, signal)

  return answerToResult(params, result)
}

function answerToResult(params: QuestionSpec, result: QuestionAnswer | undefined): { content: Array<{ type: 'text'; text: string }>; details: QuestionDetails } {
  const multiSelect = params.multiSelect === true
  const simpleOptions = params.options.map((o) => o.label)
  const base = { question: params.question, options: simpleOptions, ...(params.header ? { header: shortHeader(params.header) } : {}), ...(multiSelect ? { multiSelect: true } : {}) }

  if (result === undefined) {
    return { content: [{ type: 'text', text: 'User skipped this question' }], details: { ...base, answer: '', skipped: true } }
  }

  if (result === null) {
    return {
      content: [{ type: 'text', text: 'User cancelled the selection' }],
      details: { ...base, answer: null } as QuestionDetails,
    }
  }

  if (result.timedOut) {
    // Claude: "tells Claude you may be away from your keyboard, so Claude proceeds
    // on its own judgment and can re-ask later." Not framed as a cancel: `answer` is
    // '' rather than null, so renderResult and a batch's own null-check both read it
    // as "answered nothing, but not declined" rather than the user having said no.
    const already = result.answer ? ` Already selected: ${result.answer}.` : ''
    return {
      content: [{ type: 'text', text: `No response after the configured idle timeout; the user may be away from the keyboard.${already} Proceed on your own judgment; you can ask again later if needed.` }],
      details: { ...base, answer: result.answer, timedOut: true } as QuestionDetails,
    }
  }

  if (result.wasCustom) {
    return {
      content: [{ type: 'text', text: `User wrote: ${result.answer}` }],
      details: { ...base, answer: result.answer, wasCustom: true } as QuestionDetails,
    }
  }
  const selectionText = multiSelect ? `User selected: ${result.answer || '(none)'}` : `User selected: ${result.index}. ${result.answer}`
  return {
    content: [{ type: 'text', text: selectionText }],
    details: { ...base, answer: result.answer, wasCustom: false } as QuestionDetails,
  }
}

/** Claude: "You see a countdown for the last 20 seconds." */
const COUNTDOWN_WINDOW_MS = 20_000
/** Granularity of the idle-timer tick: fine enough that the countdown's displayed
 * second changes on time, coarse enough not to re-render needlessly often. */
const IDLE_TICK_MS = 250

/** Terminal path: the full custom overlay (options list, checkboxes, inline editor).
 *
 * `timeoutMs`, when set, is Claude's askUserQuestionTimeout: "After a question sits
 * that long with no input, the dialog closes on its own: it submits any options
 * you'd already selected and tells Claude you may be away from your keyboard, so
 * Claude proceeds on its own judgment and can re-ask later. You see a countdown for
 * the last 20 seconds. Press any key to restart the timer." Terminal focus-in
 * restarting the timer, the other documented reset trigger, is not implemented:
 * pi's TUI input stream is not confirmed to carry the terminal's own focus-report
 * escape sequences, and guessing at that risks misreading ordinary input as a
 * focus event on a terminal that reports it differently. Exported so the timer
 * mechanics are testable directly, independent of where timeoutMs itself is read
 * from (askUserQuestionTimeoutMs, tested separately).
 */
export function askViaOverlay(params: QuestionSpec, ctx: ExtensionContext, allOptions: DisplayOption[], multiSelect: boolean, timeoutMs?: number, remote?: RemoteQuestion): Promise<OverlayAnswer | null> {
  return openQuestionOverlay([{ ...params, multiSelect }], ctx, [allOptions], timeoutMs, remote).then((answers) => (answers === null ? null : (answers[0] ?? null)))
}

type OverlayAnswer = { answer: string; wasCustom: boolean; index?: number; timedOut?: boolean; checked?: boolean[] }
type BatchAnswers = Array<OverlayAnswer | undefined>

async function askBatchViaOverlay(specs: QuestionSpec[], ctx: ExtensionContext, events: ExtensionAPI['events'], signal?: AbortSignal): Promise<BatchAnswers | null> {
  const options = specs.map((spec) => (spec.multiSelect ? [...spec.options] : [...spec.options, { label: 'Type something.', isOther: true }]))
  const saved: BatchAnswers = specs.map(() => undefined)
  let active = 0
  let remote: RemoteQuestion | undefined
  while (active < specs.length) {
    if (signal?.aborted) return null
    const offer = offerRemoteQuestion(specs[active], options[active], ctx, events, signal)
    if (offer?.kind !== 'settled') {
      remote = offer?.remote
      break
    }
    if (offer.value === null) return null
    saved[active++] = offer.value
  }
  if (signal?.aborted) return null
  if (active === specs.length) return saved
  return openQuestionOverlay(specs, ctx, options, askUserQuestionTimeoutMs(), remote, { events, signal, saved, active })
}

async function openQuestionOverlay(specs: QuestionSpec[], ctx: ExtensionContext, options: DisplayOption[][], timeoutMs?: number, initialRemote?: RemoteQuestion, batch?: { events: ExtensionAPI['events']; signal?: AbortSignal; saved: BatchAnswers; active: number }): Promise<BatchAnswers | null> {
  let dispose = () => initialRemote?.close()
  try {
    return await ctx.ui
      .custom<BatchAnswers | OverlayAnswer | null>((tui, theme, _kb, done) => {
        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg('accent', s),
          selectList: {
            selectedPrefix: (s) => theme.fg('accent', s),
            selectedText: (s) => theme.fg('accent', s),
            description: (s) => theme.fg('muted', s),
            scrollInfo: (s) => theme.fg('dim', s),
            noMatch: (s) => theme.fg('warning', s),
          },
        }
        const states = specs.map((_, index) => {
          const saved = batch?.saved[index]
          const editor = new Editor(tui, editorTheme)
          if (saved?.wasCustom) editor.setText(saved.answer)
          return {
            optionIndex: (saved?.index ?? 1) - 1,
            editMode: false,
            checked: saved?.checked ?? options[index].map(() => false),
            editor,
            answer: saved,
            remotelyAnswered: saved !== undefined,
          }
        })
        let active = batch?.active ?? 0
        let remote = initialRemote
        let finished = false
        let deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
        let countdown: number | undefined
        let timer: ReturnType<typeof setInterval> | undefined

        function refresh(): void {
          tui.requestRender()
        }
        function resetIdleTimer(): void {
          if (timeoutMs !== undefined) deadline = Date.now() + timeoutMs
        }
        function cleanup(): void {
          if (timer !== undefined) clearInterval(timer)
          remote?.close()
          batch?.signal?.removeEventListener('abort', abort)
        }
        dispose = () => {
          finished = true
          cleanup()
        }
        function finish(value: BatchAnswers | null): void {
          if (finished) return
          finished = true
          cleanup()
          done(batch || value === null ? value : (value[0] ?? null))
        }
        function abort(): void {
          finish(null)
        }
        function draftAnswer(index: number): OverlayAnswer | undefined {
          const state = states[index]
          if (specs[index].multiSelect) {
            if (!state.checked.some(Boolean) && !state.answer) return undefined
            return { answer: selectedLabels(options[index], state.checked), wasCustom: false }
          }
          const draft = state.editor.getText().trim()
          return draft ? { answer: draft, wasCustom: true } : state.answer
        }
        function answers(timedOut = false): BatchAnswers {
          return states.map((_, index) => {
            const answer = draftAnswer(index)
            if (!timedOut) return answer
            return { ...(answer ?? { answer: '', wasCustom: false }), timedOut: true }
          })
        }
        function restoreRemoteAnswer(value: OverlayAnswer): void {
          const state = states[active]
          state.answer = value
          state.remotelyAnswered = true
          if (specs[active].multiSelect) {
            state.checked = value.checked ?? options[active].map(() => false)
            return
          }
          state.editor.setText(value.wasCustom ? value.answer : '')
          state.optionIndex = value.wasCustom ? options[active].length - 1 : (value.index ?? 1) - 1
        }
        function receive(value: QuestionAnswer): void {
          if (finished) return
          resetIdleTimer()
          if (value === null) {
            finish(null)
            return
          }
          restoreRemoteAnswer(value)
          if (!batch) {
            finish([value])
            return
          }
          if (states.every((state) => state.remotelyAnswered)) {
            finish(answers())
            return
          }
          navigate((active + 1) % (specs.length + 1))
        }
        function attachRemote(): void {
          remote?.attach(receive, resetIdleTimer)
        }
        function navigate(index: number): void {
          remote?.close()
          remote = undefined
          active = index
          refresh()
          if (!batch || active === specs.length || finished) return
          const offer = offerRemoteQuestion(specs[active], options[active], ctx, batch.events, batch.signal)
          if (offer?.kind === 'settled') receive(offer.value)
          else {
            remote = offer?.remote
            attachRemote()
          }
        }
        function commit(value: OverlayAnswer): void {
          states[active].answer = value
          states[active].remotelyAnswered = false
          if (!batch) finish([value])
          else navigate(active + 1)
        }
        states.forEach((state, index) => {
          state.editor.onSubmit = (value) => {
            if (active !== index || finished) return
            const trimmed = value.trim()
            if (trimmed) commit({ answer: trimmed, wasCustom: true })
            else {
              state.editMode = false
              state.editor.setText('')
              refresh()
            }
          }
        })
        batch?.signal?.addEventListener('abort', abort, { once: true })
        if (batch?.signal?.aborted) abort()
        attachRemote()
        function timeoutAnswers(): BatchAnswers {
          if (batch) return answers(true)
          const answer = specs[0].multiSelect ? selectedLabels(options[0], states[0].checked) : ''
          return [{ answer, wasCustom: false, timedOut: true }]
        }
        function idleTick(): void {
          if (deadline === undefined) return
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            finish(timeoutAnswers())
            return
          }
          const next = remaining <= COUNTDOWN_WINDOW_MS ? Math.ceil(remaining / 1000) : undefined
          if (next !== countdown) {
            countdown = next
            refresh()
          }
        }
        if (!finished && timeoutMs !== undefined) timer = setInterval(idleTick, IDLE_TICK_MS)
        function confirmSelection(): void {
          const state = states[active]
          if (specs[active].multiSelect) {
            commit({ answer: selectedLabels(options[active], state.checked), wasCustom: false })
            return
          }
          if (options[active][state.optionIndex].isOther) {
            state.editMode = true
            return
          }
          state.editor.setText('')
          commit({ answer: options[active][state.optionIndex].label, wasCustom: false, index: state.optionIndex + 1 })
        }
        function moveFocus(data: string): boolean {
          const state = states[active]
          if (matchesKey(data, Key.up)) state.optionIndex = Math.max(0, state.optionIndex - 1)
          else if (matchesKey(data, Key.down)) state.optionIndex = Math.min(options[active].length - 1, state.optionIndex + 1)
          else return false
          refresh()
          return true
        }
        function handleSelectInput(data: string): void {
          if (moveFocus(data)) return
          const state = states[active]
          if (specs[active].multiSelect && data === ' ') {
            state.checked[state.optionIndex] = !state.checked[state.optionIndex]
            state.remotelyAnswered = false
          }
          if (matchesKey(data, Key.escape)) finish(null)
          if (matchesKey(data, Key.enter)) confirmSelection()
          refresh()
        }
        function handleEditInput(data: string): void {
          const state = states[active]
          state.remotelyAnswered = false
          if (matchesKey(data, Key.escape)) {
            state.editMode = false
            if (!batch) state.editor.setText('')
          } else {
            if (batch && state.answer?.wasCustom) state.answer = undefined
            state.editor.handleInput(data)
          }
          refresh()
        }
        function navigateWithKey(data: string): boolean {
          const editing = states[active]?.editMode
          const next = matchesKey(data, Key.tab) || (!editing && matchesKey(data, Key.right))
          const previous = matchesKey(data, Key.shift('tab')) || (!editing && matchesKey(data, Key.left))
          if (!next && !previous) return false
          navigate((active + (previous ? specs.length : 1)) % (specs.length + 1))
          return true
        }
        function handleReviewInput(data: string): void {
          if (matchesKey(data, Key.enter)) finish(answers())
          if (matchesKey(data, Key.escape)) finish(null)
        }
        function handleInput(data: string): void {
          if (finished) return
          resetIdleTimer()
          const state = states[active]
          if (batch && navigateWithKey(data)) return
          if (!state) {
            handleReviewInput(data)
            return
          }
          if (state.editMode) handleEditInput(data)
          else handleSelectInput(data)
        }

        function renderTabs(width: number, saved: BatchAnswers): string {
          const tabs = specs.map((spec, index) => `[${shortHeader(spec.header) ?? `Q${index + 1}`}${saved[index] ? '✓' : '?'}]`)
          tabs.push('[Submit]')
          tabs[active] = `>${tabs[active]}`
          let visible = tabs[active]
          for (let distance = 1; distance < tabs.length; distance++) {
            const before = tabs[active - distance]
            const after = tabs[active + distance]
            if (before && `${before} ${visible}`.length <= width) visible = `${before} ${visible}`
            if (after && `${visible} ${after}`.length <= width) visible += ` ${after}`
          }
          return visible
        }
        function renderReview(width: number, saved: BatchAnswers): string[] {
          const lines = ['Review answers']
          specs.forEach((spec, index) => {
            const answer = saved[index]
            const summary = answer ? answer.answer || '(none)' : '(unanswered)'
            lines.push(...wrapTextWithAnsi(`${spec.question}: ${summary}`, width))
          })
          const skipped = saved.filter((answer) => answer === undefined).length
          lines.push(theme.fg('warning', `${skipped} unanswered question(s) will be skipped.`), 'Enter to submit • Esc to cancel')
          if (countdown !== undefined) lines.push(`Auto-continuing in ${countdown}s if idle`)
          return lines
        }
        function render(width: number): string[] {
          width = Math.max(1, width)
          const state = states[active]
          const saved = answers()
          const lines = batch ? [renderTabs(width, saved)] : []
          if (state) lines.push(...buildQuestionLines({ width, question: specs[active].question, header: shortHeader(specs[active].header), options: options[active], ...state, multiSelect: specs[active].multiSelect === true, theme, countdownSeconds: countdown }))
          else lines.push(...renderReview(width, saved))
          if (batch) lines.push('Tab/Right next • Shift+Tab/Left previous')
          return lines.map((line) => truncateToWidth(line, width))
        }
        return {
          render,
          handleInput,
          invalidate: () => {
            for (const state of states) state.editor.invalidate()
          },
          dispose,
        }
      })
      .then((value) => (value === null ? null : Array.isArray(value) ? value : [value]))
  } finally {
    dispose()
  }
}

/** Dialog-primitive fallback for UI without a terminal (RPC mode supports
 * select/input/notify but not custom components). Mirrors the overlay's result
 * shape; a dismissed dialog reads as a cancel, same as Escape in the overlay. */
async function askViaDialogs(params: QuestionSpec, ctx: ExtensionContext, allOptions: DisplayOption[], multiSelect: boolean): Promise<{ answer: string; wasCustom: boolean; index?: number; timedOut?: boolean } | null> {
  const header = shortHeader(params.header)
  const title = header ? `[${header}] ${params.question}` : params.question
  // Number the labels: ctx.ui.select returns the chosen label string, so duplicate
  // labels (or a model-supplied option named like the free-text entry) would be
  // ambiguous by text alone; the number is the unambiguous way back to the option.
  const labels = allOptions.map((option, i) => `${i + 1}. ${option.label}`)
  const choice = await ctx.ui.select(title, labels)
  if (choice === undefined) return null
  const index = labels.indexOf(choice)
  const chosen = allOptions[index]
  if (!multiSelect && chosen?.isOther === true) {
    const typed = await ctx.ui.input(params.question, 'Your answer')
    // A dismissed dialog cancels; a submitted empty answer is an (empty) answer, not a
    // cancel, so one accidental blank Enter does not abort the rest of a question batch.
    if (typed === undefined) return null
    return { answer: typed.trim(), wasCustom: true }
  }
  const answer = chosen?.label ?? choice
  return multiSelect ? { answer, wasCustom: false } : { answer, wasCustom: false, index: index + 1 }
}
