/**
 * Question Tool - a question with options, single- or multi-select.
 * Full custom UI: options list + inline editor for "Type something..." (single-select
 * only), or space-toggled checkboxes when `multiSelect` is set. An optional `header`
 * labels the question. Escape in the editor returns to options; Escape in options cancels.
 * Multiple questions per call are not batched; ask sequentially.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { claudeConfigDir } from './internal/config-dir.js'
import { readManagedSettings } from './internal/managed-settings.js'

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
  const match = /^(\d+)(s|m)$/.exec(value.trim())
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
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(home), 'settings.json'), 'utf-8')) as { askUserQuestionTimeout?: unknown }
    return parseAskUserQuestionTimeout(parsed.askUserQuestionTimeout)
  } catch {
    return undefined
  }
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
    for (const line of editor.render(width - 2)) {
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

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'question',
    label: 'Question',
    description:
      'Ask the user a question and let them pick from options. Use when you need user input to proceed. Pass question and options, for example {"question": "Which one?", "options": [{"label": "alpha"}, {"label": "beta"}]}. To ask 2-4 questions at once, pass questions instead, with the same fields per entry.',
    parameters: QuestionParams,

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const specs = questionList(rawParams as Partial<QuestionSpec> & { questions?: QuestionSpec[] })
      if (specs.length === 0) {
        return { content: [{ type: 'text', text: 'Error: No question provided' }], details: { question: '', options: [], answer: null } as QuestionDetails }
      }
      if (specs.length === 1) return await askOne(specs[0], ctx)

      // Several questions are asked in sequence; a cancel ends the run, since the
      // remaining answers would be guesses about a flow the user just declined.
      const texts: string[] = []
      const collected: QuestionDetails[] = []
      for (const spec of specs) {
        const result = await askOne(spec, ctx)
        const detail = result.details as QuestionDetails
        collected.push(detail)
        texts.push(`${spec.question}\n${result.content[0].text}`)
        if (detail.answer === null) break
      }
      return { content: [{ type: 'text', text: texts.join('\n\n') }], details: { ...collected[0], questions: collected } as QuestionDetails }
    },

    renderCall(args, theme, _context) {
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
    },
    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionDetails | undefined
      if (!details) {
        const text = result.content[0]
        return new Text(text?.type === 'text' ? text.text : '', 0, 0)
      }

      if (details.answer === null) {
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      }

      if (details.timedOut) {
        const already = details.answer ? theme.fg('muted', ` (already selected: ${details.answer})`) : ''
        return new Text(theme.fg('warning', '⏱ Auto-continued (no response)') + already, 0, 0)
      }

      if (details.wasCustom) {
        return new Text(theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', details.answer), 0, 0)
      }
      if (details.multiSelect) {
        return new Text(theme.fg('success', '✓ ') + theme.fg('accent', details.answer || '(none)'), 0, 0)
      }
      const idx = details.options.indexOf(details.answer) + 1
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer
      return new Text(theme.fg('success', '✓ ') + theme.fg('accent', display), 0, 0)
    },
  })
}

async function askOne(params: QuestionSpec, ctx: ExtensionContext): Promise<{ content: Array<{ type: 'text'; text: string }>; details: QuestionDetails }> {
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

  // ui.custom() is terminal-only: with a UI but no terminal (RPC mode) it resolves
  // undefined immediately, which would read as a cancel without ever asking. Ask
  // through the dialog primitives there instead. askUserQuestionTimeout is a TUI
  // concept (a countdown, a keypress resetting it): the dialog-primitive fallback
  // has no keyboard or visible countdown to drive it, so it is not applied there.
  const result = ctx.mode === 'tui' ? await askViaOverlay(params, ctx, allOptions, multiSelect, askUserQuestionTimeoutMs()) : await askViaDialogs(params, ctx, allOptions, multiSelect)

  // Build simple options list for details; header/multiSelect appear only when set,
  // so single-select details are unchanged.
  const simpleOptions = params.options.map((o) => o.label)
  const base = { question: params.question, options: simpleOptions, ...(params.header ? { header: shortHeader(params.header) } : {}), ...(multiSelect ? { multiSelect: true } : {}) }

  if (!result) {
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
    const already = multiSelect && result.answer ? ` Already selected: ${result.answer}.` : ''
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
export function askViaOverlay(params: QuestionSpec, ctx: ExtensionContext, allOptions: DisplayOption[], multiSelect: boolean, timeoutMs?: number): Promise<{ answer: string; wasCustom: boolean; index?: number; timedOut?: boolean } | null> {
  return ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number; timedOut?: boolean } | null>((tui: Parameters<Parameters<ExtensionContext['ui']['custom']>[0]>[0], theme: Theme, _kb: unknown, done: (value: { answer: string; wasCustom: boolean; index?: number; timedOut?: boolean } | null) => void) => {
    let optionIndex = 0
    let editMode = false
    const checked: boolean[] = allOptions.map(() => false)
    let cachedLines: string[] | undefined
    let cachedWidth: number | undefined

    // deadline stays undefined for the whole overlay life when no timeout is
    // configured, so every idle-timer branch below is a no-op in that case.
    let deadline: number | undefined = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined
    let idleTimer: ReturnType<typeof setInterval> | undefined
    let lastCountdown: number | undefined

    function stopIdleTimer(): void {
      if (idleTimer !== undefined) clearInterval(idleTimer)
      idleTimer = undefined
    }

    /** Every exit path (an answer, a cancel, or the timeout itself) goes through
     * here, so the interval can never outlive the overlay it belongs to. */
    function finish(value: { answer: string; wasCustom: boolean; index?: number; timedOut?: boolean } | null): void {
      stopIdleTimer()
      done(value)
    }

    function resetIdleTimer(): void {
      if (timeoutMs === undefined) return
      deadline = Date.now() + timeoutMs
    }

    function fireTimeout(): void {
      // Claude: "submits any options you'd already selected". Single-select has
      // nothing pre-committed (a selection only exists once Enter confirms it), so
      // its timeout answer is empty rather than whatever option merely had focus.
      const answer = multiSelect ? selectedLabels(allOptions, checked) : ''
      finish({ answer, wasCustom: false, timedOut: true })
    }

    if (timeoutMs !== undefined) {
      idleTimer = setInterval(() => {
        if (deadline === undefined) return
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          fireTimeout()
          return
        }
        const remainingSeconds = Math.ceil(remainingMs / 1000)
        const nextCountdown = remainingMs <= COUNTDOWN_WINDOW_MS ? remainingSeconds : undefined
        if (nextCountdown !== lastCountdown) {
          lastCountdown = nextCountdown
          refresh()
        }
      }, IDLE_TICK_MS)
    }

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
    const editor = new Editor(tui, editorTheme)

    editor.onSubmit = (value) => {
      const trimmed = value.trim()
      if (trimmed) {
        finish({ answer: trimmed, wasCustom: true })
      } else {
        editMode = false
        editor.setText('')
        refresh()
      }
    }

    function refresh() {
      cachedLines = undefined
      tui.requestRender()
    }

    function handleInput(data: string) {
      // Claude: "Press any key to restart the timer." Every branch below returns
      // through this function, so resetting unconditionally on entry covers all of
      // them, including the ones (arrow keys, space) that never reach `finish`.
      resetIdleTimer()

      if (editMode) {
        if (matchesKey(data, Key.escape)) {
          editMode = false
          editor.setText('')
          refresh()
          return
        }
        editor.handleInput(data)
        refresh()
        return
      }

      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1)
        refresh()
        return
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(allOptions.length - 1, optionIndex + 1)
        refresh()
        return
      }

      if (multiSelect && data === ' ') {
        checked[optionIndex] = !checked[optionIndex]
        refresh()
        return
      }

      if (matchesKey(data, Key.enter)) {
        if (multiSelect) {
          finish({ answer: selectedLabels(allOptions, checked), wasCustom: false })
          return
        }
        const selected = allOptions[optionIndex]
        if (selected.isOther) {
          editMode = true
          refresh()
        } else {
          finish({ answer: selected.label, wasCustom: false, index: optionIndex + 1 })
        }
        return
      }

      if (matchesKey(data, Key.escape)) {
        finish(null)
      }
    }

    function render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines
      cachedWidth = width
      cachedLines = buildQuestionLines({ width, question: params.question, header: shortHeader(params.header), options: allOptions, optionIndex, editMode, multiSelect, checked, editor, theme, countdownSeconds: lastCountdown })
      return cachedLines
    }

    return {
      render,
      invalidate: () => {
        cachedWidth = undefined
        cachedLines = undefined
      },
      handleInput,
      // Belt and suspenders alongside finish()'s own stopIdleTimer: if the host ever
      // tears the overlay down through a path that does not go through `done`
      // (finish's only caller), the interval still gets cleared here.
      dispose: stopIdleTimer,
    }
  })
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
