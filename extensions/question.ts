/**
 * Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "Type something..."
 * Escape in editor returns to options, Escape in options cancels
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
  options: string[]
  answer: string | null
  wasCustom?: boolean
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below label' })),
})

const QuestionParams = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  options: Type.Array(OptionSchema, { description: 'Options for the user to choose from' }),
})

function optionLine(opt: DisplayOption, index: number, selected: boolean, editMode: boolean, theme: Theme): string {
  const label = `${index + 1}. ${opt.label}`
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
  options: DisplayOption[]
  optionIndex: number
  editMode: boolean
  editor: Editor
  theme: Theme
}

function buildQuestionLines(view: QuestionView): string[] {
  const { width, question, options, optionIndex, editMode, editor, theme } = view
  const lines: string[] = []
  const add = (s: string) => lines.push(truncateToWidth(s, width))

  add(theme.fg('accent', '─'.repeat(width)))
  add(theme.fg('text', ` ${question}`))
  lines.push('')

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    add(optionLine(opt, i, i === optionIndex, editMode, theme))
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
  add(theme.fg('dim', editMode ? ' Enter to submit • Esc to go back' : ' ↑↓ navigate • Enter to select • Esc to cancel'))
  add(theme.fg('accent', '─'.repeat(width)))

  return lines
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

      const allOptions: DisplayOption[] = [...params.options, { label: 'Type something.', isOther: true }]

      const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>((tui, theme, _kb, done) => {
        let optionIndex = 0
        let editMode = false
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

          if (matchesKey(data, Key.enter)) {
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
          cachedLines = buildQuestionLines({ width, question: params.question, options: allOptions, optionIndex, editMode, editor, theme })
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

      // Build simple options list for details
      const simpleOptions = params.options.map((o) => o.label)

      if (!result) {
        return {
          content: [{ type: 'text', text: 'User cancelled the selection' }],
          details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
        }
      }

      if (result.wasCustom) {
        return {
          content: [{ type: 'text', text: `User wrote: ${result.answer}` }],
          details: {
            question: params.question,
            options: simpleOptions,
            answer: result.answer,
            wasCustom: true,
          } as QuestionDetails,
        }
      }
      return {
        content: [{ type: 'text', text: `User selected: ${result.index}. ${result.answer}` }],
        details: {
          question: params.question,
          options: simpleOptions,
          answer: result.answer,
          wasCustom: false,
        } as QuestionDetails,
      }
    },

    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('question ')) + theme.fg('muted', args.question)
      const opts = Array.isArray(args.options) ? args.options : []
      if (opts.length) {
        const labels = opts.map((o: OptionWithDesc) => o.label)
        const numbered = [...labels, 'Type something.'].map((o, i) => `${i + 1}. ${o}`)
        const optionsLine = `  Options: ${numbered.join(', ')}`
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
      const idx = details.options.indexOf(details.answer) + 1
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer
      return new Text(theme.fg('success', '✓ ') + theme.fg('accent', display), 0, 0)
    },
  })
}
