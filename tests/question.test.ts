import type { Text } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import questionExtension, { QuestionParams, shortHeader } from '../extensions/question.ts'

interface Option {
  label: string
  description?: string
}
interface Details {
  question: string
  header?: string
  options: string[]
  answer: string | null
  wasCustom?: boolean
  multiSelect?: boolean
}
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: Details }

/** The subset of the pi-tui component contract that ui.custom hands back to the host. */
interface Overlay {
  render: (width: number) => string[]
  invalidate: () => void
  handleInput: (data: string) => void
}
type CustomFactory = (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => Overlay

interface QuestionTool {
  name: string
  execute: (id: string, params: { question: string; options: Option[] }, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>
  renderCall: (args: Record<string, unknown>, theme: unknown, context?: unknown) => Text
  renderResult: (result: ToolResult, options: unknown, theme: unknown, context?: unknown) => Text
}

/** Identity theme so every assertion can be made against plain, un-styled strings. */
const theme = { fg: (_color: string, s: string) => s, bold: (s: string) => s }

/** Editor only reaches for requestRender and terminal.rows. */
const fakeTui = () => ({ requestRender: () => {}, terminal: { rows: 24 } })

/** Raw terminal byte sequences, as the host feeds them to handleInput. */
const RAW = { up: '\x1b[A', down: '\x1b[B', enter: '\r', escape: '\x1b', space: ' ' }

const setup = (): QuestionTool => {
  let tool: QuestionTool | undefined
  questionExtension({
    registerTool: (t: QuestionTool) => {
      if (t.name === 'question') tool = t
    },
  } as never)
  if (!tool) throw new Error('question tool was not registered')
  return tool
}

/** Text is built padding-free here, so a wide render is the flat list of lines it was given. */
const lines = (text: Text): string[] => text.render(200).map((line) => line.trimEnd())

const OPTIONS: Option[] = [{ label: 'Alpha', description: 'first one' }, { label: 'Beta' }]

/** Resolve ui.custom immediately, without ever building the overlay. */
const uiCtx = (resolved: unknown) => ({ hasUI: true, ui: { custom: async () => resolved } })

/** Start execute, capture the live overlay, and hand back the still-pending result. */
const openOverlay = (tool: QuestionTool, options: Option[] = OPTIONS) => {
  let overlay: Overlay | undefined
  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: CustomFactory) =>
        new Promise((resolve) => {
          overlay = factory(fakeTui(), theme, {}, resolve)
        }),
    },
  }
  const result = tool.execute('call-1', { question: 'Pick one', options }, undefined, undefined, ctx)
  if (!overlay) throw new Error('ui.custom factory was never invoked')
  return { overlay, result }
}

/** openOverlay with arbitrary params (header, multiSelect, ...). */
const openOverlayWith = (tool: QuestionTool, params: Record<string, unknown>) => {
  let overlay: Overlay | undefined
  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: CustomFactory) =>
        new Promise((resolve) => {
          overlay = factory(fakeTui(), theme, {}, resolve)
        }),
    },
  }
  const result = tool.execute('call-1', params as never, undefined, undefined, ctx)
  if (!overlay) throw new Error('ui.custom factory was never invoked')
  return { overlay, result }
}

describe('question schema caps', () => {
  it("bounds options and header to Claude's AskUserQuestion limits", () => {
    const schema = QuestionParams as unknown as { properties: { options: { minItems: number; maxItems: number } } }
    expect(schema.properties.options.maxItems).toBe(4)
    // Claude requires 2-4 options: a single-option question is not a question.
    expect(schema.properties.options.minItems).toBe(2)
    // The header cap is a display detail, so it truncates rather than failing the
    // call: a rejected call costs a turn while the model recovers.
    expect(shortHeader('a very long header indeed')).toBe('a very long ')
    expect(shortHeader(undefined)).toBeUndefined()
  })
})

describe('question execute', () => {
  it('refuses to ask when no UI is available', async () => {
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, { hasUI: false })
    expect(result.content).toEqual([{ type: 'text', text: 'Error: UI not available (running in non-interactive mode)' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: null })
  })

  it('refuses an empty option list without opening the overlay', async () => {
    const ctx = {
      hasUI: true,
      ui: {
        custom: () => {
          throw new Error('ui.custom must not be called for an empty option list')
        },
      },
    }
    const result = await setup().execute('call-1', { question: 'Pick one', options: [] }, undefined, undefined, ctx)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: No options provided' }])
    expect(result.details).toEqual({ question: 'Pick one', options: [], answer: null })
  })

  it('reports a cancelled overlay with a null answer', async () => {
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(null))
    expect(result.content).toEqual([{ type: 'text', text: 'User cancelled the selection' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: null })
  })

  it('reports a picked option with the index the overlay resolved', async () => {
    const picked = { answer: 'Beta', wasCustom: false, index: 2 }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(picked))
    expect(result.content).toEqual([{ type: 'text', text: 'User selected: 2. Beta' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Beta', wasCustom: false })
  })

  it('reports a typed answer as custom', async () => {
    const typed = { answer: 'something else', wasCustom: true }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(typed))
    expect(result.content).toEqual([{ type: 'text', text: 'User wrote: something else' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'something else', wasCustom: true })
  })
})

describe('question renderCall', () => {
  it('numbers the options and appends the free-text entry', () => {
    const rendered = setup().renderCall({ question: 'Pick one', options: OPTIONS }, theme)
    expect(lines(rendered)).toEqual(['question Pick one', '  Options: 1. Alpha, 2. Beta, 3. Type something.'])
  })

  it('omits the option line when the option list is empty', () => {
    expect(lines(setup().renderCall({ question: 'Pick one', options: [] }, theme))).toEqual(['question Pick one'])
  })

  it('omits the option line when options is not an array', () => {
    expect(lines(setup().renderCall({ question: 'Pick one' }, theme))).toEqual(['question Pick one'])
  })
})

describe('question renderResult', () => {
  it('falls back to the raw content text when details are missing', () => {
    const result = { content: [{ type: 'text', text: 'Error: No options provided' }] }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['Error: No options provided'])
  })

  it('renders nothing when details are missing and the content is not text', () => {
    expect(lines(setup().renderResult({ content: [{ type: 'image' }] }, undefined, theme))).toEqual([])
  })

  it('renders a null answer as cancelled', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha'], answer: null } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['Cancelled'])
  })

  it('marks a custom answer as written', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha'], answer: 'my own', wasCustom: true } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['✓ (wrote) my own'])
  })

  it('numbers the first option as 1', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Alpha', wasCustom: false } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['✓ 1. Alpha'])
  })

  it('numbers a later option by its position in the list', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Beta', wasCustom: false } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['✓ 2. Beta'])
  })

  it('drops the number when the answer is not one of the options', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Gamma', wasCustom: false } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['✓ Gamma'])
  })
})

describe('question overlay', () => {
  it('renders the question, the numbered options with descriptions, and the navigation hint', () => {
    const { overlay } = openOverlay(setup())
    const out = overlay.render(60)
    expect(out[0]).toBe('─'.repeat(60))
    expect(out[1]).toBe(' Pick one')
    expect(out).toContain('> 1. Alpha')
    expect(out).toContain('     first one')
    expect(out).toContain('  2. Beta')
    expect(out).toContain('  3. Type something.')
    expect(out).toContain(' ↑↓ navigate • Enter to select • Esc to cancel')
  })

  it('moves the cursor to the next option on down', () => {
    const { overlay } = openOverlay(setup())
    overlay.handleInput(RAW.down)
    const out = overlay.render(60)
    expect(out).toContain('  1. Alpha')
    expect(out).toContain('> 2. Beta')
  })

  it('keeps the cursor on the first option when up is pressed at the top', () => {
    const { overlay } = openOverlay(setup())
    overlay.handleInput(RAW.up)
    expect(overlay.render(60)).toContain('> 1. Alpha')
  })

  it('keeps the cursor on the free-text option when down is pressed at the bottom', () => {
    const { overlay } = openOverlay(setup())
    for (let i = 0; i < 4; i++) overlay.handleInput(RAW.down)
    expect(overlay.render(60)).toContain('> 3. Type something.')
  })

  it('re-lays out when the width changes', () => {
    const { overlay } = openOverlay(setup())
    expect(overlay.render(60)[0]).toBe('─'.repeat(60))
    // A terminal resize only calls requestRender, never invalidate, so the
    // cache must be keyed on width or the overlay paints at the stale one.
    expect(overlay.render(20)[0]).toBe('─'.repeat(20))
  })

  it('reuses its cached lines at an unchanged width until the host invalidates', () => {
    const { overlay } = openOverlay(setup())
    const first = overlay.render(60)
    expect(overlay.render(60)).toEqual(first)

    overlay.handleInput(RAW.down)
    overlay.invalidate()
    expect(overlay.render(60)).not.toEqual(first)
  })

  it('resolves the first option as selection number 1 on enter', async () => {
    const { overlay, result } = openOverlay(setup())
    overlay.handleInput(RAW.enter)
    expect(await result).toEqual({
      content: [{ type: 'text', text: 'User selected: 1. Alpha' }],
      details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Alpha', wasCustom: false },
    })
  })

  it('resolves the option under the cursor with its 1-based number on enter', async () => {
    const { overlay, result } = openOverlay(setup())
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    expect(await result).toEqual({
      content: [{ type: 'text', text: 'User selected: 2. Beta' }],
      details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Beta', wasCustom: false },
    })
  })

  it('cancels on escape from the option list', async () => {
    const { overlay, result } = openOverlay(setup())
    overlay.handleInput(RAW.escape)
    expect(await result).toEqual({
      content: [{ type: 'text', text: 'User cancelled the selection' }],
      details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: null },
    })
  })

  it('shows the editor and its own hint after entering the free-text option', () => {
    const { overlay } = openOverlay(setup())
    for (let i = 0; i < 2; i++) overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    const out = overlay.render(60)
    expect(out).toContain('> 3. Type something. ✎')
    expect(out).toContain(' Your answer:')
    expect(out).toContain(' Enter to submit • Esc to go back')
  })

  it('echoes typed characters into the editor', () => {
    const { overlay } = openOverlay(setup())
    for (let i = 0; i < 2; i++) overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('h')
    overlay.handleInput('i')
    expect(overlay.render(60).some((line) => line.includes('hi'))).toBe(true)
  })

  it('resolves a typed answer as custom when the editor submits', async () => {
    const { overlay, result } = openOverlay(setup())
    for (let i = 0; i < 2; i++) overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('h')
    overlay.handleInput('i')
    overlay.handleInput(RAW.enter)
    expect(await result).toEqual({
      content: [{ type: 'text', text: 'User wrote: hi' }],
      details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'hi', wasCustom: true },
    })
  })

  it('returns to the option list and discards the draft on escape from the editor', () => {
    const { overlay } = openOverlay(setup())
    for (let i = 0; i < 2; i++) overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('x')
    overlay.handleInput(RAW.escape)

    const out = overlay.render(60)
    expect(out).toContain('> 3. Type something.')
    expect(out).toContain(' ↑↓ navigate • Enter to select • Esc to cancel')
    expect(out.some((line) => line.includes('x'))).toBe(false)
  })

  it('stays open on a blank submission instead of answering', async () => {
    const { overlay, result } = openOverlay(setup())
    for (let i = 0; i < 2; i++) overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(' ')
    overlay.handleInput(RAW.enter)
    expect(overlay.render(60)).toContain(' ↑↓ navigate • Enter to select • Esc to cancel')

    overlay.handleInput(RAW.escape)
    expect((await result).content).toEqual([{ type: 'text', text: 'User cancelled the selection' }])
  })
})

describe('question header and multiSelect', () => {
  const multiParams = { question: 'Pick some', header: 'Scope', options: OPTIONS, multiSelect: true }

  it('shows the header and the multi-select hint, and no free-text option', () => {
    const { overlay } = openOverlayWith(setup(), multiParams)
    const out = overlay.render(80)
    expect(out).toContain(' [Scope]')
    expect(out).toContain(' Pick some')
    expect(out).toContain('> 1. [ ] Alpha')
    expect(out).toContain('  2. [ ] Beta')
    expect(out.some((l) => l.includes('Type something.'))).toBe(false)
    expect(out).toContain(' ↑↓ navigate • Space to toggle • Enter to confirm • Esc to cancel')
  })

  it('toggles a checkbox with space', () => {
    const { overlay } = openOverlayWith(setup(), multiParams)
    overlay.handleInput(RAW.space)
    expect(overlay.render(60)).toContain('> 1. [x] Alpha')
    overlay.handleInput(RAW.space)
    expect(overlay.render(60)).toContain('> 1. [x] Alpha'.replace('[x]', '[ ]'))
  })

  it('confirms every toggled option, comma-joined, on enter', async () => {
    const { overlay, result } = openOverlayWith(setup(), multiParams)
    overlay.handleInput(RAW.space) // Alpha
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.space) // Beta
    overlay.handleInput(RAW.enter)
    expect(await result).toEqual({
      content: [{ type: 'text', text: 'User selected: Alpha, Beta' }],
      details: { question: 'Pick some', header: 'Scope', options: ['Alpha', 'Beta'], answer: 'Alpha, Beta', wasCustom: false, multiSelect: true },
    })
  })

  it('reports (none) when nothing is toggled', async () => {
    const { overlay, result } = openOverlayWith(setup(), multiParams)
    overlay.handleInput(RAW.enter)
    expect((await result).content).toEqual([{ type: 'text', text: 'User selected: (none)' }])
  })

  it('renders the header and multi tag in the call, without the free-text entry', () => {
    const rendered = setup().renderCall(multiParams, theme)
    expect(lines(rendered)).toEqual(['question [Scope] Pick some', '  Options (multi): 1. Alpha, 2. Beta'])
  })

  it('renders a multi-select result as the joined answer', () => {
    const rendered = setup().renderResult({ content: [], details: { question: 'q', options: ['Alpha', 'Beta'], answer: 'Alpha, Beta', wasCustom: false, multiSelect: true } }, {}, theme)
    expect(lines(rendered)).toEqual(['✓ Alpha, Beta'])
  })
})

describe('multiple questions per call', () => {
  it('accepts a questions array, asks them in order, and reports every answer', async () => {
    const asked: string[] = []
    const answers = ['Alpha', 'Beta']
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => {
          const answer = answers[asked.length]
          asked.push(answer)
          return { answer, wasCustom: false, index: 1 }
        },
      },
    }
    const params = {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', header: 'Two', options: OPTIONS },
      ],
    }
    const result = await setup().execute('call-1', params as never, undefined, undefined, ctx as never)

    expect(asked).toHaveLength(2)
    expect(result.content[0].text).toContain('First?')
    expect(result.content[0].text).toContain('Alpha')
    expect(result.content[0].text).toContain('Second?')
    expect(result.content[0].text).toContain('Beta')
  })

  it('stops asking once the user cancels', async () => {
    let calls = 0
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => {
          calls++
          return null
        },
      },
    }
    const params = {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    }
    const result = await setup().execute('call-1', params as never, undefined, undefined, ctx as never)

    expect(calls).toBe(1)
    expect(result.content[0].text).toContain('cancelled')
  })

  it('still accepts the single-question shape', async () => {
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS } as never, undefined, undefined, uiCtx({ answer: 'Alpha', wasCustom: false, index: 1 }) as never)
    expect(result.content[0].text).toBe('User selected: 1. Alpha')
  })
})
