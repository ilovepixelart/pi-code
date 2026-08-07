/**
 * Question Tool - a question with options, single- or multi-select.
 * Full custom UI: options list + inline editor for "Type something..." (single-select
 * only), or space-toggled checkboxes when `multiSelect` is set. An optional `header`
 * labels the question. Escape in the editor returns to options; Escape in options cancels.
 * Multiple questions per call are not batched; ask sequentially.
 */

import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

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
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below label' })),
})

export const QuestionParams = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  header: Type.Optional(Type.String({ description: 'Short label for the question, shown above it (max 12 characters)', maxLength: 12 })),
  options: Type.Array(OptionSchema, { description: 'Options for the user to choose from (1-4)', minItems: 1, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow selecting several options (space toggles, enter confirms)' })),
})

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
}

function buildQuestionLines(view: QuestionView): string[] {
  const { width, question, header, options, optionIndex, editMode, multiSelect, checked, editor, theme } = view
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
    description: 'Ask the user a question and let them pick from options. Use when you need user input to proceed.',
    parameters: QuestionParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

      const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>((tui, theme, _kb, done) => {
        let optionIndex = 0
        let editMode = false
        const checked: boolean[] = allOptions.map(() => false)
        let cachedLines: string[] | undefined
        let cachedWidth: number | undefined

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
            done({ answer: trimmed, wasCustom: true })
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
              done({ answer: selectedLabels(allOptions, checked), wasCustom: false })
              return
            }
            const selected = allOptions[optionIndex]
            if (selected.isOther) {
              editMode = true
              refresh()
            } else {
              done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 })
            }
            return
          }

          if (matchesKey(data, Key.escape)) {
            done(null)
          }
        }

        function render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines
          cachedWidth = width
          cachedLines = buildQuestionLines({ width, question: params.question, header: params.header, options: allOptions, optionIndex, editMode, multiSelect, checked, editor, theme })
          return cachedLines
        }

        return {
          render,
          invalidate: () => {
            cachedWidth = undefined
            cachedLines = undefined
          },
          handleInput,
        }
      })

      // Build simple options list for details; header/multiSelect appear only when set,
      // so single-select details are unchanged.
      const simpleOptions = params.options.map((o) => o.label)
      const base = { question: params.question, options: simpleOptions, ...(params.header ? { header: params.header } : {}), ...(multiSelect ? { multiSelect: true } : {}) }

      if (!result) {
        return {
          content: [{ type: 'text', text: 'User cancelled the selection' }],
          details: { ...base, answer: null } as QuestionDetails,
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
    },

    renderCall(args, theme, _context) {
      const multi = args.multiSelect === true
      const heading = args.header ? `[${args.header}] ` : ''
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
