import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Text } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import questionExtension, { askUserQuestionTimeoutMs, askViaOverlay, parseAskUserQuestionTimeout, QuestionParams, shortHeader } from '../extensions/question.ts'

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
const uiCtx = (resolved: unknown) => ({ hasUI: true, mode: 'tui', ui: { custom: async () => resolved } })

/** Start execute, capture the live overlay, and hand back the still-pending result. */
const openOverlay = (tool: QuestionTool, options: Option[] = OPTIONS) => {
  let overlay: Overlay | undefined
  const ctx = {
    hasUI: true,
    mode: 'tui',
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
    mode: 'tui',
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
      mode: 'tui',
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

  it('reports a timed-out single-select distinctly from a cancel, with an empty answer', async () => {
    // Claude: the auto-continue "tells Claude you may be away from your keyboard,
    // so Claude proceeds on its own judgment and can re-ask later" — not the same
    // outcome as the user declining, so it must not read as answer: null either.
    const timedOut = { answer: '', wasCustom: false, timedOut: true }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(timedOut))
    expect(result.content[0].text).toContain('No response after the configured idle timeout')
    expect(result.content[0].text).not.toContain('Already selected')
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: '', timedOut: true })
  })

  it('names what was already checked in a timed-out multiSelect', async () => {
    const timedOut = { answer: 'Alpha, Beta', wasCustom: false, timedOut: true }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS, multiSelect: true } as never, undefined, undefined, uiCtx(timedOut) as never)
    expect(result.content[0].text).toContain('Already selected: Alpha, Beta.')
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], multiSelect: true, answer: 'Alpha, Beta', timedOut: true })
  })

  it('reports a typed answer as custom', async () => {
    const typed = { answer: 'something else', wasCustom: true }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(typed))
    expect(result.content).toEqual([{ type: 'text', text: 'User wrote: something else' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'something else', wasCustom: true })
  })
})

describe('question over dialogs (hasUI without tui)', () => {
  interface DialogCall {
    kind: 'select' | 'input' | 'custom'
    title?: string
    options?: string[]
  }

  /** RPC-shaped ctx: hasUI is true, custom() resolves undefined (terminal-only),
   * select/input answer from canned values. Every UI call is recorded. */
  const rpcCtx = (selected: string | undefined, typed?: string | undefined) => {
    const calls: DialogCall[] = []
    const ctx = {
      hasUI: true,
      mode: 'rpc',
      ui: {
        custom: async () => {
          calls.push({ kind: 'custom' })
          return undefined
        },
        select: async (title: string, options: string[]) => {
          calls.push({ kind: 'select', title, options })
          return selected
        },
        input: async (title: string) => {
          calls.push({ kind: 'input', title })
          return typed
        },
      },
    }
    return { ctx, calls }
  }

  it('asks through ui.select with numbered labels and reports the picked option', async () => {
    const { ctx, calls } = rpcCtx('2. Beta')
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, ctx)
    expect(calls).toEqual([{ kind: 'select', title: 'Pick one', options: ['1. Alpha', '2. Beta', '3. Type something.'] }])
    expect(result.content).toEqual([{ type: 'text', text: 'User selected: 2. Beta' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Beta', wasCustom: false })
  })

  it('routes the free-text option through ui.input', async () => {
    const { ctx, calls } = rpcCtx('3. Type something.', 'my own words')
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, ctx)
    expect(calls.map((c) => c.kind)).toEqual(['select', 'input'])
    expect(result.content).toEqual([{ type: 'text', text: 'User wrote: my own words' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'my own words', wasCustom: true })
  })

  it('disambiguates by number when an option is named like the free-text entry', async () => {
    // The last numbered label is the real free-text entry, even though an option shares
    // its text; picking it routes through ui.input rather than reporting a plain choice.
    const { ctx, calls } = rpcCtx('3. Type something.', 'typed answer')
    const result = await setup().execute('call-1', { question: 'Pick one', options: [{ label: 'Type something.' }, { label: 'Beta' }] as never }, undefined, undefined, ctx)
    expect((calls[0] as { options: string[] }).options).toEqual(['1. Type something.', '2. Beta', '3. Type something.'])
    expect(result.details).toMatchObject({ answer: 'typed answer', wasCustom: true })
  })

  it('reports a dismissed selector as cancelled', async () => {
    const { ctx } = rpcCtx(undefined)
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, ctx)
    expect(result.content).toEqual([{ type: 'text', text: 'User cancelled the selection' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: null })
  })

  it('treats a dismissed free-text input as cancelled', async () => {
    const { ctx } = rpcCtx('3. Type something.', undefined)
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, ctx)
    expect(result.content).toEqual([{ type: 'text', text: 'User cancelled the selection' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: null })
  })

  it('treats an empty free-text submit as an empty answer, not a cancel', async () => {
    // A blank Enter is a (blank) answer; treating it as a cancel would abort the rest of
    // a multi-question batch on one accidental keystroke.
    const { ctx } = rpcCtx('3. Type something.', '  ')
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, ctx)
    expect(result.details).toMatchObject({ answer: '', wasCustom: true })
  })

  it('offers no free-text entry for multiSelect and prefixes the header in the title', async () => {
    const { ctx, calls } = rpcCtx('1. Alpha')
    const result = await setup().execute('call-1', { question: 'Pick some', header: 'Scope', options: OPTIONS, multiSelect: true } as never, undefined, undefined, ctx)
    expect(calls).toEqual([{ kind: 'select', title: '[Scope] Pick some', options: ['1. Alpha', '2. Beta'] }])
    expect(result.content).toEqual([{ type: 'text', text: 'User selected: Alpha' }])
    expect(result.details).toEqual({ question: 'Pick some', header: 'Scope', options: ['Alpha', 'Beta'], answer: 'Alpha', wasCustom: false, multiSelect: true })
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

  it('shows the header truncated to the same 12 characters as the dialog', () => {
    expect(lines(setup().renderCall({ question: 'Pick one', header: 'A'.repeat(30) }, theme))).toEqual([`question [${'A'.repeat(12)}] Pick one`])
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

  it('marks a timed-out answer distinctly from a cancel', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha'], answer: '', timedOut: true } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['⏱ Auto-continued (no response)'])
  })

  it('names what was already selected in a timed-out render', () => {
    const result = { content: [], details: { question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Alpha', timedOut: true, multiSelect: true } }
    expect(lines(setup().renderResult(result, undefined, theme))).toEqual(['⏱ Auto-continued (no response) (already selected: Alpha)'])
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
      mode: 'tui',
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
      mode: 'tui',
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

describe('parseAskUserQuestionTimeout', () => {
  it('reads the three documented spellings', () => {
    expect(parseAskUserQuestionTimeout('60s')).toBe(60_000)
    expect(parseAskUserQuestionTimeout('5m')).toBe(5 * 60_000)
    expect(parseAskUserQuestionTimeout('10m')).toBe(10 * 60_000)
  })

  it('rejects anything else, including unset', () => {
    for (const bad of [undefined, null, 60, '', '60', '60x', '1h']) {
      expect(parseAskUserQuestionTimeout(bad)).toBeUndefined()
    }
  })

  it('tolerates surrounding whitespace, the forgiving read', () => {
    expect(parseAskUserQuestionTimeout(' 60s ')).toBe(60_000)
  })
})

describe('askUserQuestionTimeoutMs', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'q-timeout-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    setManagedSettingsPath(undefined)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the value from the user settings.json', () => {
    const home = tempDir()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ askUserQuestionTimeout: '5m' }))
    expect(askUserQuestionTimeoutMs(home)).toBe(5 * 60_000)
  })

  it('returns undefined with no settings file, and does not throw', () => {
    expect(askUserQuestionTimeoutMs(tempDir())).toBeUndefined()
  })

  it('prefers the managed value over the user file, as every managed setting does', () => {
    const home = tempDir()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ askUserQuestionTimeout: '5m' }))
    const managedDir = tempDir()
    writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({ askUserQuestionTimeout: '60s' }))
    setManagedSettingsPath(join(managedDir, 'managed-settings.json'))
    expect(askUserQuestionTimeoutMs(home)).toBe(60_000)
  })
})

describe('askViaOverlay idle timeout', () => {
  /** Drives askViaOverlay directly (exported for exactly this), capturing the live
   * overlay the way openOverlay does for the full tool, plus the still-pending
   * result promise so a test can await it once the timer fires. */
  const openTimed = (options: Option[], multiSelect: boolean, timeoutMs: number | undefined) => {
    let overlay: Overlay | undefined
    const ctx = {
      hasUI: true,
      mode: 'tui',
      ui: {
        custom: (factory: CustomFactory) =>
          new Promise((resolve) => {
            overlay = factory(fakeTui(), theme, {}, resolve)
          }),
      },
    }
    const result = askViaOverlay({ question: 'Pick one', options: options as never }, ctx as never, options as never, multiSelect, timeoutMs)
    if (!overlay) throw new Error('ui.custom factory was never invoked')
    return { overlay, result }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never fires when no timeout is configured', async () => {
    const { overlay } = openTimed(OPTIONS, false, undefined)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // No countdown line ever appears; the render staying countdown-free for ten
    // full simulated minutes is the proof nothing ticks.
    expect(overlay.render(40).some((line) => line.includes('Auto-continuing'))).toBe(false)
  })

  it('auto-continues a single-select with an empty answer after the idle period', async () => {
    const { overlay, result } = openTimed(OPTIONS, false, 60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toEqual({ answer: '', wasCustom: false, timedOut: true })
    void overlay
  })

  it('auto-continues a multiSelect with only what was already checked, not every option', async () => {
    // Checking one of the two, not both: an implementation that submitted every
    // option regardless of what was checked would pass a two-for-two fixture too.
    const { overlay, result } = openTimed(OPTIONS, true, 60_000)
    overlay.handleInput(RAW.space) // check Alpha only
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toEqual({ answer: 'Alpha', wasCustom: false, timedOut: true })
  })

  it('a keypress resets the timer, so it does not fire on the original schedule', async () => {
    const { overlay, result } = openTimed(OPTIONS, false, 60_000)
    let settled = false
    void result.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(50_000)
    overlay.handleInput(RAW.down) // resets the 60s window from here
    await vi.advanceTimersByTimeAsync(50_000) // 100s of wall time, only 50s since the reset
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000) // now 60s since the reset
    expect(settled).toBe(true)
  })

  it('shows a countdown only in the last 20 seconds', async () => {
    const { overlay } = openTimed(OPTIONS, false, 60_000)
    await vi.advanceTimersByTimeAsync(39_000) // 21s remaining: still outside the window
    expect(overlay.render(40).some((line) => line.includes('Auto-continuing'))).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000) // 20s remaining: window opens
    expect(overlay.render(40).some((line) => line.includes('Auto-continuing in 20s'))).toBe(true)
  })

  it('clears the idle interval once resolved through a normal path', async () => {
    const { overlay } = openTimed(OPTIONS, false, 60_000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    // Resolving a promise a second time is a spec-level no-op, so counting `.then()`
    // calls can never tell a cleared interval from a leaked one that keeps firing
    // into an already-settled result; whether the timer itself is still scheduled
    // is the only oracle that actually distinguishes the two.
    overlay.handleInput(RAW.enter) // resolves via the normal Enter path, not the timeout
    expect(vi.getTimerCount()).toBe(0)
  })
})
