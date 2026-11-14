import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventBus } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type Text, visibleWidth } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setCliSettingsReader } from '../extensions/internal/cli-settings.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import questionExtension, { askUserQuestionTimeoutMs, askViaOverlay, parseAskUserQuestionTimeout, QuestionParams, REMOTE_QUESTION_CHANNEL, type RemoteQuestionOffer, shortHeader } from '../extensions/question.ts'

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
  skipped?: boolean
  timedOut?: boolean
  questions?: Details[]
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
  executionMode?: string
  execute: (id: string, params: { question: string; options: Option[] }, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>
  renderCall: (args: Record<string, unknown>, theme: unknown, context?: unknown) => Text
  renderResult: (result: ToolResult, options: unknown, theme: unknown, context?: unknown) => Text
}

/** Identity theme so every assertion can be made against plain, un-styled strings. */
const theme = { fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s, bold: (s: string) => s }

/** The overlay only reaches for requestRender. */
const fakeTui = () => ({ requestRender: () => {}, terminal: { rows: 24 } })

/** Raw terminal byte sequences, as the host feeds them to handleInput. */
const RAW = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', tab: '\t', enter: '\r', escape: '\x1b', space: ' ' }

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

const setupRemote = (onOffer: (offer: RemoteQuestionOffer) => void, bus?: ReturnType<typeof createEventBus>): QuestionTool => {
  let tool: QuestionTool | undefined
  questionExtension({
    registerTool: (t: QuestionTool) => {
      if (t.name === 'question') tool = t
    },
    events: bus ?? {
      emit: (channel: string, offer: RemoteQuestionOffer) => {
        expect(channel).toBe(REMOTE_QUESTION_CHANNEL)
        onOffer(offer)
      },
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
    sessionManager: { getSessionId: () => 'session-1' },
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
  it('runs sequentially, since the host has one dialog slot', () => {
    // pi runs the tool calls of one assistant message in parallel, and the host shows a
    // custom dialog in a single editor slot: a second question replaced the first, whose
    // promise then never resolved. The run could not reach turn_end, and neither Esc nor
    // /new recovered the session. One sequential tool makes pi run the whole batch in order.
    expect(setup().executionMode).toBe('sequential')
  })

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

  it('should cancel a batch when the overlay resolves undefined', async () => {
    const questions = [
      { question: 'First?', options: OPTIONS },
      { question: 'Second?', options: OPTIONS },
    ]
    const result = await setup().execute('call-1', { questions } as never, undefined, undefined, uiCtx(undefined) as never)
    expect(result.content).toEqual([{ type: 'text', text: 'User cancelled the selection' }])
    expect(result.details).toMatchObject({ answer: null })
  })

  it('reports a picked option with the index the overlay resolved', async () => {
    const picked = { kind: 'submit', answers: [{ kind: 'option', index: 1 }] }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(picked))
    expect(result.content).toEqual([{ type: 'text', text: 'User selected: 2. Beta' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'Beta', wasCustom: false })
  })

  it('reports a timed-out single-select distinctly from a cancel, with an empty answer', async () => {
    // Claude: the auto-continue "tells Claude you may be away from your keyboard,
    // so Claude proceeds on its own judgment and can re-ask later" — not the same
    // outcome as the user declining, so it must not read as answer: null either.
    const timedOut = { kind: 'timeout', answers: [{ kind: 'timedOut' }] }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(timedOut))
    expect(result.content[0].text).toContain('No response after the configured idle timeout')
    expect(result.content[0].text).not.toContain('Already selected')
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: '', timedOut: true })
  })

  it('names what was already checked in a timed-out multiSelect', async () => {
    const timedOut = { kind: 'timeout', answers: [{ kind: 'timedOut', selected: { kind: 'multi', indices: [0, 1] } }] }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS, multiSelect: true } as never, undefined, undefined, uiCtx(timedOut) as never)
    expect(result.content[0].text).toContain('Already selected: Alpha, Beta.')
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], multiSelect: true, answer: 'Alpha, Beta', timedOut: true })
  })

  it('reports a typed answer as custom', async () => {
    const typed = { kind: 'submit', answers: [{ kind: 'text', text: 'something else' }] }
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, uiCtx(typed))
    expect(result.content).toEqual([{ type: 'text', text: 'User wrote: something else' }])
    expect(result.details).toEqual({ question: 'Pick one', options: ['Alpha', 'Beta'], answer: 'something else', wasCustom: true })
  })
})

describe('question remote offer', () => {
  const context = (custom: unknown, sessionManager: unknown = { getSessionId: () => 'session-1' }) => ({
    hasUI: true,
    mode: 'tui',
    sessionManager,
    ui: { custom },
  })

  /** A ui.custom that builds the real overlay and stays open until it finishes. */
  const liveOverlay = () => {
    let overlay: Overlay | undefined
    const custom = vi.fn(
      (factory: CustomFactory) =>
        new Promise((resolve) => {
          overlay = factory(fakeTui(), theme, {}, resolve)
        }),
    )
    return { custom, input: (data: string) => overlay?.handleInput(data) }
  }

  const withManagedTimeout = async (value: string, run: () => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'q-remote-timeout-'))
    const settings = join(dir, 'managed-settings.json')
    writeFileSync(settings, JSON.stringify({ askUserQuestionTimeout: value }))
    setManagedSettingsPath(settings)
    try {
      await run()
    } finally {
      setManagedSettingsPath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the local overlay open while a claimed responder is silent, and the local answer wins', async () => {
    const live = liveOverlay()
    let offer: RemoteQuestionOffer | undefined
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const result = setupRemote((request) => {
      offer = request
      settle = request.claim()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(live.custom))
    expect(live.custom).toHaveBeenCalledOnce()
    live.input(RAW.enter)
    // Synchronously after the local answer, before askOne's own cleanup has run.
    expect(settle?.({ action: 'answer', indices: [2] })).toBe(false)
    expect(offer?.signal.aborted).toBe(true)
    expect(offer?.touch()).toBe(false)
    expect((await result).details).toMatchObject({ answer: 'Alpha', wasCustom: false })
  })

  it('closes the open local overlay with a remote answer, accepting only the first settlement', async () => {
    const live = liveOverlay()
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const result = setupRemote((offer) => {
      settle = offer.claim()
      expect(settle).toBeDefined()
      expect(offer.claim()).toBeUndefined()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(live.custom))
    expect(settle?.({ action: 'answer', indices: [2] })).toBe(true)
    expect(settle?.({ action: 'answer', indices: [1] })).toBe(false)
    expect((await result).details).toMatchObject({ answer: 'Beta', wasCustom: false })
    expect(live.custom).toHaveBeenCalledOnce()
  })

  it('imposes no remote wait limit when no idle timeout is configured', async () => {
    vi.useFakeTimers()
    const live = liveOverlay()
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const result = setupRemote((offer) => {
      settle = offer.claim()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(live.custom))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settle?.({ action: 'answer', indices: [2] })).toBe(true)
    expect((await result).details).toMatchObject({ answer: 'Beta' })
  })

  it('keeps the local overlay answerable after a remote pass or malformed reply', async () => {
    for (const outcome of [{ action: 'pass' }, { action: 'answer', indices: [9] }]) {
      const live = liveOverlay()
      let settle: ReturnType<RemoteQuestionOffer['claim']>
      const result = setupRemote((offer) => {
        settle = offer.claim()
      }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(live.custom))
      expect(settle?.(outcome as never)).toBe(outcome.action === 'pass')
      expect(settle?.({ action: 'answer', indices: [2] })).toBe(false)
      live.input(RAW.enter)
      expect((await result).details).toMatchObject({ answer: 'Alpha' })
    }
  })

  it('still cancels on a turn abort after the remote side withdrew', async () => {
    const controller = new AbortController()
    const live = liveOverlay()
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const result = setupRemote((offer) => {
      settle = offer.claim()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, controller.signal, undefined, context(live.custom))
    expect(settle?.({ action: 'pass' })).toBe(true)
    controller.abort()
    expect((await result).details).toMatchObject({ answer: null })
  })

  it('answers with the indices it validated, read once from the outcome', async () => {
    const reads = [[1], [99]]
    const outcome = {
      action: 'answer',
      get indices() {
        return reads.shift() ?? [99]
      },
    }
    const live = liveOverlay()
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const result = setupRemote((offer) => {
      settle = offer.claim()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(live.custom))
    expect(settle?.(outcome as never)).toBe(true)
    expect((await result).content[0].text).toBe('User selected: 1. Alpha')
  })

  it('leaves no abort listener on the turn signal once each question ends', async () => {
    const controller = new AbortController()
    const active = new Set<unknown>()
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
      active.add(listener)
      add(type, listener, options)
    })
    vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((type, listener, options) => {
      active.delete(listener)
      remove(type, listener, options)
    })
    const early = setupRemote((offer) => offer.claim()?.({ action: 'answer', indices: [1] }))
    await early.execute('call-1', { question: 'Pick one', options: OPTIONS }, controller.signal, undefined, context(vi.fn()))
    expect(active.size).toBe(0)
    const live = liveOverlay()
    const late = setupRemote((offer) => {
      offer.claim()
    }).execute('call-2', { question: 'Pick one', options: OPTIONS }, controller.signal, undefined, context(live.custom))
    expect(active.size).toBe(1)
    live.input(RAW.enter)
    await late
    expect(active.size).toBe(0)
  })

  it('withdraws a claimed offer when the overlay fails to open', async () => {
    let offer: RemoteQuestionOffer | undefined
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const custom = vi.fn(async () => {
      throw new Error('no terminal')
    })
    const result = setupRemote((request) => {
      offer = request
      settle = request.claim()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    await expect(result).rejects.toThrow('no terminal')
    expect(offer?.signal.aborted).toBe(true)
    expect(settle?.({ action: 'answer', indices: [1] })).toBe(false)
  })

  it('does not open the overlay for an offer settled during emission or an aborted request', async () => {
    const custom = vi.fn(async () => null)
    const tool = setupRemote((offer) => offer.claim()?.({ action: 'answer', indices: [1] }))
    expect((await tool.execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))).details).toMatchObject({ answer: 'Alpha' })
    const controller = new AbortController()
    controller.abort()
    expect((await tool.execute('call-2', { question: 'Pick one', options: OPTIONS }, controller.signal, undefined, context(custom))).details).toMatchObject({ answer: null })
    expect(custom).not.toHaveBeenCalled()
  })

  it('preserves the local overlay when nobody claims synchronously', async () => {
    const seen: RemoteQuestionOffer[] = []
    const custom = vi.fn(async () => ({ kind: 'submit', answers: [{ kind: 'option', index: 0 }] }))
    const result = await setupRemote((offer) => seen.push(offer)).execute('call-1', { question: 'Pick one', header: 'A long header', options: OPTIONS } as never, undefined, undefined, context(custom))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ version: 1, sessionId: 'session-1', question: 'Pick one', header: 'A long heade', options: OPTIONS, multiSelect: false, allowFreeText: true })
    expect(seen[0].requestId).toEqual(expect.any(String))
    expect(seen[0].claim()).toBeUndefined()
    expect(custom).toHaveBeenCalledOnce()
    expect(result.details).toMatchObject({ answer: 'Alpha' })
  })

  it('preserves ordered checkbox choices and free text', async () => {
    const custom = vi.fn(async () => null)
    const choose = setupRemote((offer) => {
      expect(offer.multiSelect).toBe(true)
      expect(offer.allowFreeText).toBe(false)
      offer.claim()?.({ action: 'answer', indices: [2, 1] })
    })
    const selected = await choose.execute('call-1', { question: 'Pick some', options: OPTIONS, multiSelect: true } as never, undefined, undefined, context(custom))
    expect(selected.details).toMatchObject({ answer: 'Alpha, Beta', multiSelect: true })
    const typed = await setupRemote((offer) => offer.claim()?.({ action: 'text', text: ' another ' })).execute('call-2', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    expect(typed.details).toMatchObject({ answer: 'another', wasCustom: true })
    expect(custom).not.toHaveBeenCalled()
  })

  it('ends a remote batch on explicit cancellation', async () => {
    const seen: string[] = []
    const custom = vi.fn(async () => null)
    const result = await setupRemote((offer) => {
      seen.push(offer.requestId)
      offer.claim()?.({ action: 'cancel' })
    }).execute(
      'call-1',
      {
        questions: [
          { question: 'First', options: OPTIONS },
          { question: 'Second', options: OPTIONS },
        ],
      } as never,
      undefined,
      undefined,
      context(custom),
    )
    expect(seen).toHaveLength(1)
    expect(result.details).toMatchObject({ answer: null, questions: [{ answer: null }, { answer: null }] })
    expect(custom).not.toHaveBeenCalled()
  })

  it('falls back locally on malformed answers or a pass during emission', async () => {
    const custom = vi.fn(async () => ({ kind: 'submit', answers: [{ kind: 'option', index: 0 }] }))
    const pastLast = await setupRemote((offer) => offer.claim()?.({ action: 'answer', indices: [OPTIONS.length + 1] })).execute('call-0', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    const invalid = await setupRemote((offer) => offer.claim()?.({ action: 'answer', indices: [0] })).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    const duplicate = await setupRemote((offer) => offer.claim()?.({ action: 'answer', indices: [1, 1] })).execute('call-2', { question: 'Pick some', options: OPTIONS, multiSelect: true } as never, undefined, undefined, context(custom))
    const forbiddenText = await setupRemote((offer) => offer.claim()?.({ action: 'text', text: 'not allowed' })).execute('call-3', { question: 'Pick some', options: OPTIONS, multiSelect: true } as never, undefined, undefined, context(custom))
    const declined = await setupRemote((offer) => offer.claim()?.({ action: 'pass' })).execute('call-4', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    for (const result of [pastLast, invalid, duplicate, forbiddenText, declined]) expect(result.details).toMatchObject({ answer: 'Alpha' })
    expect(custom).toHaveBeenCalledTimes(5)
  })

  it('settles as cancelled on the abort that precedes session replacement, never reading the stale ctx', async () => {
    // Pi aborts the running turn, then invalidates the old ctx: its getters throw from then on.
    let stale = false
    const sessionManager = {
      getSessionId: () => {
        if (stale) throw new Error('This extension ctx is stale after session replacement')
        return 'session-1'
      },
    }
    const controller = new AbortController()
    const live = liveOverlay()
    let offer: RemoteQuestionOffer | undefined
    let settle: ReturnType<RemoteQuestionOffer['claim']>
    const result = setupRemote((request) => {
      offer = request
      settle = request.claim()
    }).execute('call-1', { question: 'Pick one', options: OPTIONS }, controller.signal, undefined, context(live.custom, sessionManager))
    controller.abort()
    stale = true
    expect((await result).details).toMatchObject({ answer: null })
    expect(offer?.signal.aborted).toBe(true)
    expect(settle?.({ action: 'answer', indices: [1] })).toBe(false)
  })

  it('does not show an overlay after an abort during synchronous emission', async () => {
    const controller = new AbortController()
    const custom = vi.fn(async () => ({ kind: 'submit', answers: [{ kind: 'option', index: 0 }] }))
    const tool = setupRemote((offer) => {
      controller.abort()
      expect(offer.claim()).toBeUndefined()
    })
    const result = await tool.execute('call-1', { question: 'Pick one', options: OPTIONS }, controller.signal, undefined, context(custom))
    expect(result.details).toMatchObject({ answer: null })
    expect(custom).not.toHaveBeenCalled()
  })

  it('remote activity resets the overlay idle timer, which still auto-continues', async () => {
    await withManagedTimeout('60s', async () => {
      vi.useFakeTimers()
      const live = liveOverlay()
      let offer: RemoteQuestionOffer | undefined
      let resolved = false
      const result = setupRemote((request) => {
        offer = request
        request.claim()
      }).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(live.custom))
      void result.then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(50_000)
      expect(offer?.touch()).toBe(true)
      await vi.advanceTimersByTimeAsync(50_000)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await result).details).toMatchObject({ answer: '', timedOut: true })
      expect(offer?.signal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('rejects malformed runtime data even when the real event bus catches handler errors', async () => {
    const bus = createEventBus()
    let accepted: boolean | undefined
    bus.on(REMOTE_QUESTION_CHANNEL, (data) => {
      accepted = (data as RemoteQuestionOffer).claim()?.(null as never)
    })
    const custom = vi.fn(async () => ({ kind: 'submit', answers: [{ kind: 'option', index: 0 }] }))
    const result = await setupRemote(() => {
      throw new Error('unexpected mock event')
    }, bus).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    bus.clear()
    expect(accepted).toBe(false)
    expect(result.details).toMatchObject({ answer: 'Alpha' })
    expect(custom).toHaveBeenCalledOnce()
  })

  it('claims synchronously through the real Pi event bus', async () => {
    const bus = createEventBus()
    bus.on(REMOTE_QUESTION_CHANNEL, (data) => {
      ;(data as RemoteQuestionOffer).claim()?.({ action: 'answer', indices: [2] })
    })
    const custom = vi.fn(async () => null)
    const result = await setupRemote(() => {
      throw new Error('unexpected mock event')
    }, bus).execute('call-1', { question: 'Pick one', options: OPTIONS }, undefined, undefined, context(custom))
    expect(result.details).toMatchObject({ answer: 'Beta' })
    expect(custom).not.toHaveBeenCalled()
    bus.clear()
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

  it('should list the free-text entry for single-select questions when rendering a batch', () => {
    const rendered = lines(
      setup().renderCall(
        {
          questions: [
            { question: 'First?', options: OPTIONS },
            { question: 'Second?', options: OPTIONS, multiSelect: true },
          ],
        },
        theme,
      ),
    )

    expect(rendered, 'Single-select batch questions should list the free-text entry; multi-select ones should not').toEqual(['question [Q1] First?', '  Options: 1. Alpha, 2. Beta, 3. Type something.', '', 'question [Q2] Second?', '  Options (multi): 1. Alpha, 2. Beta'])
  })

  it('should render a batch question without options when its arguments are still streaming', () => {
    const rendered = lines(setup().renderCall({ questions: [{ question: 'Q' }] }, theme))

    expect(rendered, 'A partial batch question should render without an option line').toEqual(['question [Q1] Q'])
  })

  it('should render a placeholder line when a streamed batch entry is null', () => {
    const rendered = lines(setup().renderCall({ questions: [null] }, theme))

    expect(rendered, 'A null batch entry should render an empty question').toEqual(['question [Q1]'])
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
  it('should wrap the full question when it exceeds the available width', () => {
    const { overlay } = openOverlayWith(setup(), { question: 'Which deployment target should we use?', options: OPTIONS })

    const out = overlay.render(20)

    expect(out.slice(1, 4), 'The full question should wrap with one-space indentation').toEqual([' Which deployment', ' target should we', ' use?'])
  })

  it('should wrap the full description when it exceeds the available width', () => {
    const { overlay } = openOverlay(setup(), [{ label: 'Alpha', description: 'Deploy to the production cluster' }, { label: 'Beta' }])

    const out = overlay.render(20)
    const start = out.findIndex((line) => line.endsWith(' 1. Alpha')) + 1

    expect(out.slice(start, start + 3), 'The full description should wrap with five-space indentation').toEqual(['     Deploy to the', '     production', '     cluster'])
  })

  it('should preserve explicit line breaks when the question and description span paragraphs', () => {
    const { overlay } = openOverlayWith(setup(), { question: 'First line\nSecond line', options: [{ label: 'Alpha', description: 'One line\nAnother line' }, { label: 'Beta' }] })

    const out = overlay.render(60)

    expect(out.slice(1, 3), 'Question line breaks should produce indented rows').toEqual([' First line', ' Second line'])
    expect(out.slice(5, 7), 'Description line breaks should produce indented rows').toEqual(['     One line', '     Another line'])
  })

  it('should color each wrapped row separately when the theme applies colors', () => {
    let overlay: Overlay | undefined
    const colorTheme = { fg: (_color: string, s: string) => `\x1b[31m${s}\x1b[39m`, bold: (s: string) => s }
    const ctx = { hasUI: true, mode: 'tui', ui: { custom: (factory: CustomFactory) => new Promise((resolve) => (overlay = factory(fakeTui(), colorTheme, {}, resolve))) } }
    void setup().execute('call-1', { question: 'Which deployment target should we use?', options: [{ label: 'Alpha', description: 'Deploy to the production cluster' }, { label: 'Beta' }] }, undefined, undefined, ctx)
    if (!overlay) throw new Error('ui.custom factory was never invoked')

    const out = overlay.render(30)

    expect(out.slice(1, 3), 'Each question row should open and close its own color').toEqual([' \x1b[31mWhich deployment target\x1b[39m', ' \x1b[31mshould we use?\x1b[39m'])
    expect(
      out.filter((line) => line.startsWith('     \x1b[31m')),
      'Each description row should open and close its own color',
    ).toEqual(['     \x1b[31mDeploy to the production\x1b[39m', '     \x1b[31mcluster\x1b[39m'])
  })

  it('should keep every row within the width when the width is smaller than the description indent', () => {
    const { overlay } = openOverlay(setup(), [{ label: 'Alpha', description: 'Deploy now' }, { label: 'Beta' }])

    const out = overlay.render(4)

    expect(
      out.filter((line) => line.replaceAll('\x1b[0m', '').length > 4),
      'No row should exceed the terminal width',
    ).toEqual([])
    expect(out, 'The description should still render, one column per row').toContain('   D')
  })

  it('should drop trailing newlines when the question and description end with one', () => {
    const { overlay } = openOverlayWith(setup(), { question: 'Q?\n', options: [{ label: 'Alpha', description: 'D\n' }, { label: 'Beta' }] })

    const out = overlay.render(60)

    expect(out.slice(1, 3), 'The question should be followed directly by the blank separator').toEqual([' Q?', ''])
    expect(out[out.findIndex((line) => line.endsWith(' 1. Alpha')) + 2], 'The description should be followed directly by the next option').toContain('2. Beta')
  })

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

  it('moves the cursor back to the previous option on up', () => {
    const { overlay } = openOverlay(setup())
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.up)
    const out = overlay.render(60)
    expect(out).toContain('> 1. Alpha')
    expect(out).toContain('  2. Beta')
  })

  it('keeps the cursor on the first option when up is pressed at the top', () => {
    const { overlay } = openOverlay(setup())
    overlay.handleInput(RAW.up)
    expect(overlay.render(60)).toContain('> 1. Alpha')
  })

  it('keeps the cursor on the free-text option when down is pressed at the bottom', () => {
    const { overlay } = openOverlay(setup())
    for (let i = 0; i < 4; i++) overlay.handleInput(RAW.down)
    expect(overlay.render(60).map(stripTerminalSequences), 'The cursor should stop on the last row').toContain('> 3. Type something.')
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

  it('should show the header and the multi-select hint, and no free-text option, when one question is multiSelect', () => {
    const { overlay } = openOverlayWith(setup(), multiParams)
    const out = overlay.render(80)
    expect(out[1], 'A lone question should show its header with no tab bar').toBe(' [Scope]')
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

  it('renders an empty multi-select answer as (none)', () => {
    const rendered = setup().renderResult({ content: [], details: { question: 'q', options: ['Alpha', 'Beta'], answer: '', wasCustom: false, multiSelect: true } }, {}, theme)
    expect(lines(rendered)).toEqual(['✓ (none)'])
  })
})

describe('question tab navigation', () => {
  it('should show the next unanswered question when Right is pressed', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.right)
    const rendered = overlay.render(120).join('\n')
    overlay.handleInput(RAW.escape)
    await result

    expect(rendered, 'Right should navigate without choosing the focused option').toContain('Second?')
  })

  it('should restore option focus when returning to an unanswered question', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.right)
    expect(overlay.render(120).join('\n'), 'Right should reach the second question before returning').toContain('Second?')
    overlay.handleInput(RAW.left)
    const rendered = overlay.render(120).join('\n')
    overlay.handleInput(RAW.escape)
    await result

    expect(rendered, 'Left should return to the first question').toContain('First?')
    expect(rendered, 'Returning should preserve the focused option').toContain('> 2. Beta')
  })

  it('should preserve checkbox choices when navigating away before confirmation', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS, multiSelect: true },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.right)
    expect(overlay.render(120).join('\n'), 'Right should reach the second question before returning').toContain('Second?')
    overlay.handleInput(RAW.left)
    const rendered = overlay.render(120).join('\n')
    overlay.handleInput(RAW.escape)
    await result

    expect(rendered, 'Returning should preserve the checked option').toContain('[x] Alpha')
  })
})

describe('question batch submission', () => {
  it('should submit no default choices when every question is left unanswered', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.left)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(submitted.details?.questions, 'Unanswered questions should never inherit the highlighted option').toMatchObject([
      { answer: '', skipped: true },
      { answer: '', skipped: true },
    ])
  })

  it('should keep the confirmed multi-select answer when checkboxes change without Enter', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS, multiSelect: true },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.left)
    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(submitted.content[0].text, 'The confirmed checkboxes should win over unconfirmed edits').toContain('First?\nUser selected: Alpha\n')
  })

  it('should leave a multi-select question unanswered and advance when Enter is pressed with nothing checked', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS, multiSelect: true },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    const advanced = overlay.render(120).join('\n')
    overlay.handleInput(RAW.right)
    const review = overlay.render(120).join('\n')
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(advanced, 'Enter should advance to the next question').toContain('Second?')
    expect(review, 'The question should stay unanswered in the tab bar').toContain('☐ Q1')
    expect(submitted.details?.questions?.[0], 'Submit should count the question as skipped').toMatchObject({ answer: '', skipped: true })
  })

  it('should return a confirmed multi-select answer to unanswered when every box is cleared and confirmed', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS, multiSelect: true },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.left)
    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.right)
    const review = overlay.render(120).join('\n')
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(review, 'The tab should go back to unanswered').toContain('☐ Q1')
    expect(review, 'The review should omit the cleared question').not.toContain('First?')
    expect(submitted.details?.questions?.[0], 'Submit should count the cleared question as skipped').toMatchObject({ answer: '', skipped: true })
  })

  it('should retain earlier answers when an empty custom answer is submitted', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.up)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(submitted.details?.questions, 'An empty custom submission should not discard earlier answers or cancel the form').toMatchObject([{ answer: 'Alpha' }, { answer: '', skipped: true }])
  })

  it('should cancel the whole call when Cancel is chosen in the review', async () => {
    const tool = setup()
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.down)
    const review = overlay.render(120).join('\n')
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(review, 'Down should move the pointer to Cancel').toContain('> 2. Cancel')
    expect(submitted.content[0].text, 'Cancel should cancel the call').toBe('User cancelled the selection')
  })

  it('should submit when Up returns the review pointer to Submit answers', async () => {
    const tool = setup()
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.enter)
    const review = overlay.render(120).join('\n')
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.up)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(review, 'A fully answered review should not warn').not.toContain('You have not answered')
    expect(review, 'Submit answers should be selected by default').toContain('> 1. Submit answers')
    expect(submitted.details?.questions, 'Both answers should be submitted').toMatchObject([{ answer: 'Alpha' }, { answer: 'Alpha' }])
  })

  it('should keep the active tab visible when the tab bar exceeds the width', () => {
    const tool = setup()
    const { overlay } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', header: 'Alpha', options: OPTIONS },
        { question: 'Second?', header: 'Bravo', options: OPTIONS },
        { question: 'Third?', header: 'Charlie', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.right)
    const tabBar = overlay.render(24)[1]

    expect(tabBar, 'The active tab should be shown').toContain('Charlie')
    expect(tabBar, 'Far tabs should be dropped to fit').not.toContain('Alpha')
  })

  it('should mark an unanswered question as skipped when submitting a partial form', async () => {
    const tool = setup()
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    const review = overlay.render(120).join('\n')
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(review, 'Review should warn that a question is unanswered').toContain('⚠ You have not answered all questions')
    expect(review, 'Review should list the answered question with its answer').toContain(' ● Second?\n   → Beta')
    expect(review, 'Review should leave the unanswered question out').not.toContain('First?')
    expect(review, 'The tab bar should mark which questions are answered').toContain('☐ Q1   ☒ Q2   ✔ Submit')
    expect(submitted.details?.questions, 'Submission should preserve the answer and explicitly mark the skipped question').toMatchObject([
      { question: 'First?', answer: '', skipped: true },
      { question: 'Second?', answer: 'Beta' },
    ])
    expect(submitted.content[0].text, 'The model should be told the first question was skipped').toContain('User skipped')
    expect(lines(tool.renderResult(submitted, {}, theme)).join('\n'), 'The transcript should render later answers too').toContain('Beta')
  })

  it('should replace an earlier answer when revisiting and selecting another option', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.left)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(submitted.details?.questions, 'Revised answers should replace previous answers in question order').toMatchObject([{ answer: 'Beta' }, { answer: 'Alpha' }])
  })

  it('should submit checked options when leaving a multi-select question without Enter', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS, multiSelect: true },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.space)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(submitted.details?.questions, 'Checked options are answers but untouched questions are skipped').toMatchObject([{ answer: 'Alpha' }, { answer: '', skipped: true }])
  })

  it('should keep the question and draft when Tab or Shift+Tab is pressed while typing', () => {
    const { overlay } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('abc')
    overlay.handleInput(RAW.left)
    overlay.handleInput('X')
    overlay.handleInput(RAW.tab)
    overlay.handleInput('\x1b[Z')
    const rendered = stripTerminalSequences(overlay.render(120).join('\n'))

    expect(rendered, 'Tab and Shift+Tab should not switch questions while typing').toContain('First?')
    expect(rendered, 'Left should move the cursor and Tab should not insert anything').toContain('abXc')
  })

  it('should stay on the question when Left at the start or Right at the end is pressed while typing', () => {
    const { overlay } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('ab')
    for (let i = 0; i < 3; i++) overlay.handleInput(RAW.left)
    const atStart = stripTerminalSequences(overlay.render(120).join('\n'))
    for (let i = 0; i < 3; i++) overlay.handleInput(RAW.right)
    const atEnd = stripTerminalSequences(overlay.render(120).join('\n'))
    overlay.handleInput(RAW.escape)
    overlay.handleInput(RAW.right)
    const switched = stripTerminalSequences(overlay.render(120).join('\n'))

    expect(atStart, 'Left at the start should stay on the question').toContain('First?')
    expect(atEnd, 'Right at the end should stay on the question').toContain('First?')
    expect(switched, 'Right should switch questions after Escape stops typing').toContain('Second?')
  })

  it('should render only bounded lines when question headers exceed the terminal width', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', header: 'A long label', options: OPTIONS },
        { question: 'Second?', header: 'Another label', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.right)
    const rendered = overlay.render(16)
    overlay.handleInput(RAW.escape)
    await result

    expect(
      rendered.every((line) => visibleWidth(line) <= 16),
      'Every line should fit the terminal width',
    ).toBe(true)
    expect(stripTerminalSequences(rendered.join('\n')), 'The active question label should remain visible').toContain(shortHeader('Another label'))
  })

  it('should cancel the whole call when Escape is pressed on Submit', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.escape)
    const submitted = await result

    expect(submitted.content[0].text, 'The model should get one cancellation for the whole call').toBe('User cancelled the selection')
    expect(submitted.details?.questions, 'Cancellation should not become a partial submission').toMatchObject([{ answer: null }, { answer: null }])
  })

  it('should discard confirmed answers when Escape is pressed on a later question', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
        { question: 'Third?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.escape)
    const submitted = await result

    expect(submitted.content[0].text, 'Escape should cancel the whole call').toBe('User cancelled the selection')
    expect(submitted.details?.questions, 'Details should list every question as cancelled').toMatchObject([{ answer: null }, { answer: null }, { answer: null }])
  })

  it('should keep the confirmed answer when navigating away from a later free-text draft', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.left)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('oops')
    overlay.handleInput(RAW.escape)
    overlay.handleInput(RAW.tab)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(submitted.content[0].text, 'The confirmed option should reach the model').toContain('First?\nUser selected: 1. Alpha')
    expect(submitted.content[0].text, 'The abandoned draft should not replace the confirmed answer').not.toContain('oops')
  })

  it('should keep the confirmed answer when Escape leaves a later free-text draft', async () => {
    const { overlay, result } = openOverlayWith(setup(), {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.enter)
    overlay.handleInput(RAW.left)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.enter)
    overlay.handleInput('draft')
    overlay.handleInput(RAW.escape)
    const options = overlay.render(120).join('\n')
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.right)
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(options, 'Escape in the editor should return to the option list').toContain('Enter to select • Tab/←→ switch questions • Esc to cancel')
    expect(submitted.content[0].text, 'The confirmed option should reach the model').toContain('First?\nUser selected: 1. Alpha')
    expect(submitted.content[0].text, 'The draft should not replace the confirmed answer').not.toContain('draft')
  })
})

describe('question batch lifecycle', () => {
  it('should withdraw remote offers when the batch overlay cannot open', async () => {
    let offered: RemoteQuestionOffer | undefined
    let reply: ReturnType<RemoteQuestionOffer['claim']>
    const tool = setupRemote((offer) => {
      offered = offer
      reply = offer.claim()
    })
    const ctx = {
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'session-1' },
      ui: {
        custom: async () => {
          throw new Error('Cannot open overlay')
        },
      },
    }

    await expect(
      tool.execute(
        'call-1',
        {
          questions: [
            { question: 'First?', options: OPTIONS },
            { question: 'Second?', options: OPTIONS },
          ],
        } as never,
        undefined,
        undefined,
        ctx,
      ),
      'Overlay failure should propagate',
    ).rejects.toThrow('Cannot open overlay')

    expect(offered?.signal.aborted, 'Overlay failure should close the active remote offer').toBe(true)
    expect(reply?.({ action: 'answer', indices: [1] }), 'Failed overlays should reject late remote replies').toBe(false)
  })

  it('should stop accepting input when the initialized batch overlay rejects', async () => {
    const offers: RemoteQuestionOffer[] = []
    const tool = setupRemote((offer) => {
      offers.push(offer)
      offer.claim()
    })
    let overlay: Overlay | undefined
    const ctx = {
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'session-1' },
      ui: {
        custom: async (factory: CustomFactory) => {
          overlay = factory(fakeTui(), theme, {}, () => {})
          throw new Error('Overlay failed')
        },
      },
    }

    await expect(
      tool.execute(
        'call-1',
        {
          questions: [
            { question: 'First?', options: OPTIONS },
            { question: 'Second?', options: OPTIONS },
          ],
        } as never,
        undefined,
        undefined,
        ctx,
      ),
      'Initialized overlay failure should propagate',
    ).rejects.toThrow('Overlay failed')
    if (!overlay) throw new Error('Expected the overlay factory to initialize')
    overlay.handleInput(RAW.right)

    expect(offers, 'A failed overlay should not open another remote offer').toHaveLength(1)
    expect(offers[0].signal.aborted, 'Failure should withdraw the initialized remote offer').toBe(true)
  })

  it('should preserve remote checkbox identities when different selections have the same joined labels', async () => {
    let firstReply: ReturnType<RemoteQuestionOffer['claim']>
    const tool = setupRemote((offer) => {
      const reply = offer.claim()
      if (offer.question === 'First?') firstReply = reply
    })
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: [{ label: 'A, B' }, { label: 'A' }, { label: 'B' }], multiSelect: true },
        { question: 'Second?', options: OPTIONS },
      ],
    })
    if (!firstReply) throw new Error('Expected a reply handle for the first question')

    firstReply({ action: 'answer', indices: [2, 3] })
    overlay.handleInput(RAW.left)
    const rendered = stripTerminalSequences(overlay.render(120).join('\n'))
    overlay.handleInput(RAW.escape)
    await result

    expect(rendered, 'Remote selections must retain their original option indices').toContain('[ ] A, B')
    expect(rendered, 'The second option must remain selected').toContain('[x] A\n')
    expect(rendered, 'The third option must remain selected').toContain('[x] B')
  })

  it('should finish without a terminal review when all answers arrive synchronously from a remote responder', async () => {
    const custom = vi.fn(async () => null)
    const tool = setupRemote((offer) => offer.claim()?.({ action: 'answer', indices: [offer.question === 'First?' ? 1 : 2] }))
    const ctx = { hasUI: true, mode: 'tui', sessionManager: { getSessionId: () => 'session-1' }, ui: { custom } }

    const submitted = await tool.execute(
      'call-1',
      {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS },
        ],
      } as never,
      undefined,
      undefined,
      ctx,
    )

    expect(submitted.details?.questions, 'Remote completion should return every answer in order').toMatchObject([{ answer: 'Alpha' }, { answer: 'Beta' }])
    expect(custom, 'A fully remote form should not require terminal interaction').not.toHaveBeenCalled()
  })

  it('should emit one offer per question when navigating back and forth', async () => {
    const offers: RemoteQuestionOffer[] = []
    const tool = setupRemote((offer) => {
      offers.push(offer)
      offer.claim()
    })
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    for (const key of [RAW.right, RAW.left, RAW.tab, RAW.right, RAW.left, RAW.left]) overlay.handleInput(key)
    const live = offers.map((offer) => offer.signal.aborted)
    overlay.handleInput(RAW.escape)
    await result

    expect(
      offers.map((offer) => offer.question),
      'Each question should be offered once, on its first visit',
    ).toEqual(['First?', 'Second?'])
    expect(live, 'Unanswered questions should keep their offers live while another tab has focus').toEqual([false, false])
    expect(
      offers.every((offer) => offer.signal.aborted),
      'Closing the form should abort every offer',
    ).toBe(true)
  })

  it('should save a remote answer to a question that does not have focus', async () => {
    const offers: RemoteQuestionOffer[] = []
    const replies: Array<ReturnType<RemoteQuestionOffer['claim']>> = []
    const tool = setupRemote((offer) => {
      offers.push(offer)
      replies.push(offer.claim())
    })
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.right)
    const accepted = replies[0]?.({ action: 'answer', indices: [2] })
    const focused = overlay.render(120).join('\n')
    overlay.handleInput(RAW.enter)
    const secondAborted = offers[1].signal.aborted
    overlay.handleInput(RAW.enter)
    const submitted = await result

    expect(accepted, 'The unfocused question should accept its remote reply').toBe(true)
    expect(offers[0].signal.aborted, 'A remotely settled question should abort its offer').toBe(true)
    expect(focused, 'A remote answer to another question should not move focus').toContain('Second?')
    expect(secondAborted, 'A locally confirmed question should abort its offer').toBe(true)
    expect(submitted.content[0].text, 'The model should get the remote answer for the unfocused question').toBe('First?\nUser selected: 2. Beta\n\nSecond?\nUser selected: 1. Alpha')
  })

  it('should focus the free-text row when a remote custom answer arrives before the overlay opens', async () => {
    const tool = setupRemote((offer) => {
      const reply = offer.claim()
      if (offer.question === 'First?') reply?.({ action: 'text', text: 'remote words' })
    })
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.left)
    const rendered = stripTerminalSequences(overlay.render(120).join('\n'))
    overlay.handleInput(RAW.escape)
    await result

    expect(rendered, 'The free-text row should have focus for a remote custom answer').toContain('> 3. Type something.')
  })

  it('should submit saved answers and unchecked questions distinctly when the batch times out', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'q-batch-timeout-'))
    const settings = join(dir, 'managed-settings.json')
    writeFileSync(settings, JSON.stringify({ askUserQuestionTimeout: '60s' }))
    setManagedSettingsPath(settings)
    try {
      const { overlay, result } = openOverlayWith(setup(), {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS, multiSelect: true },
          { question: 'Third?', options: OPTIONS },
        ],
      })

      overlay.handleInput(RAW.enter)
      overlay.handleInput(RAW.space)
      overlay.handleInput(RAW.right)
      vi.advanceTimersByTime(60_000)
      const submitted = await result

      expect(submitted.details?.questions, 'Timeout should preserve confirmed answers and unconfirmed checks without inventing a focused answer').toMatchObject([{ answer: 'Alpha' }, { answer: 'Alpha', timedOut: true }, { answer: '', timedOut: true }])
      expect(submitted.content[0].text, 'The unconfirmed checks should be sent').toContain('Second?\nNo response. Already selected: Alpha.')
      expect(submitted.content[0].text, 'Timeout should tell the model the user may be away').toContain('No response after the configured idle timeout')
      expect(vi.getTimerCount(), 'Timeout should stop the form timer').toBe(0)
    } finally {
      setManagedSettingsPath(undefined)
      rmSync(dir, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('should report confirmed answers as a normal submit when the form times out', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'q-review-timeout-'))
    const settings = join(dir, 'managed-settings.json')
    writeFileSync(settings, JSON.stringify({ askUserQuestionTimeout: '60s' }))
    setManagedSettingsPath(settings)
    try {
      const { overlay, result } = openOverlayWith(setup(), {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS },
          { question: 'Third?', options: OPTIONS },
        ],
      })

      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.enter)
      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.enter)
      overlay.handleInput('mine')
      overlay.handleInput(RAW.enter)
      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.enter)
      overlay.handleInput('draft')
      vi.advanceTimersByTime(60_000)
      const submitted = await result
      const [first, second, third, ...rest] = submitted.content[0].text?.split('\n\n') ?? []

      expect(first, 'A confirmed option should keep its number').toBe('First?\nUser selected: 2. Beta')
      expect(second, 'A confirmed custom answer should keep its custom marker').toBe('Second?\nUser wrote: mine')
      expect(third, 'The unconfirmed question should get no response, and an unsubmitted draft should not be selected').toBe('Third?\nNo response.')
      expect(rest, 'The away notice should be sent once for the whole call').toEqual(['No response after the configured idle timeout; the user may be away from the keyboard. Proceed on your own judgment; you can ask again later if needed.'])
    } finally {
      setManagedSettingsPath(undefined)
      rmSync(dir, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('should tell the model the user may be away when the form times out with every question answered', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'q-answered-timeout-'))
    const settings = join(dir, 'managed-settings.json')
    writeFileSync(settings, JSON.stringify({ askUserQuestionTimeout: '60s' }))
    setManagedSettingsPath(settings)
    try {
      const { overlay, result } = openOverlayWith(setup(), {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS },
        ],
      })

      overlay.handleInput(RAW.enter)
      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.enter)
      vi.advanceTimersByTime(60_000)
      const submitted = await result

      expect(submitted.content[0].text, 'Confirmed answers should be reported in full, followed by the away notice').toBe(
        'First?\nUser selected: 1. Alpha\n\nSecond?\nUser selected: 2. Beta\n\nNo response after the configured idle timeout; the user may be away from the keyboard. Proceed on your own judgment; you can ask again later if needed.',
      )
    } finally {
      setManagedSettingsPath(undefined)
      rmSync(dir, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('should keep the confirmed multi-select answer over unconfirmed checkbox edits when the form times out', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'q-multi-timeout-'))
    const settings = join(dir, 'managed-settings.json')
    writeFileSync(settings, JSON.stringify({ askUserQuestionTimeout: '60s' }))
    setManagedSettingsPath(settings)
    try {
      const { overlay, result } = openOverlayWith(setup(), {
        questions: [
          { question: 'First?', options: OPTIONS, multiSelect: true },
          { question: 'Second?', options: OPTIONS },
        ],
      })

      overlay.handleInput(RAW.space)
      overlay.handleInput(RAW.enter)
      overlay.handleInput(RAW.left)
      overlay.handleInput(RAW.space)
      overlay.handleInput(RAW.down)
      overlay.handleInput(RAW.space)
      vi.advanceTimersByTime(60_000)
      const submitted = await result

      expect(submitted.content[0].text, 'The confirmed checkboxes should win on timeout').toContain('First?\nUser selected: Alpha\n')
    } finally {
      setManagedSettingsPath(undefined)
      rmSync(dir, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('should stop typing in the free-text row when a remote answer lands on that question', async () => {
    const replies: Array<ReturnType<RemoteQuestionOffer['claim']>> = []
    const tool = setupRemote((offer) => {
      replies.push(offer.claim())
    })
    const { overlay, result } = openOverlayWith(tool, {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    })

    overlay.handleInput(RAW.down)
    overlay.handleInput(RAW.down)
    overlay.handleInput('x')
    replies[0]?.({ action: 'answer', indices: [1] })
    overlay.handleInput('\x1b[Z')
    const rendered = stripTerminalSequences(overlay.render(120).join('\n'))
    overlay.handleInput(RAW.escape)
    await result

    expect(rendered, 'Typing should stop once a remote answer lands').not.toContain('Esc to stop typing')
    expect(rendered, 'The remote answer should have focus').toContain('> 1. Alpha')
  })

  it('should cancel after remote withdrawal when the turn aborts', async () => {
    const controller = new AbortController()
    const tool = setupRemote((offer) => offer.claim()?.({ action: 'pass' }))
    let overlay: Overlay | undefined
    const ctx = {
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'session-1' },
      ui: {
        custom: (factory: CustomFactory) =>
          new Promise((resolve) => {
            overlay = factory(fakeTui(), theme, {}, resolve)
          }),
      },
    }
    const result = tool.execute(
      'call-1',
      {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS },
        ],
      } as never,
      controller.signal,
      undefined,
      ctx,
    )
    if (!overlay) throw new Error('Expected the batch overlay to open')

    controller.abort()
    const submitted = await result

    expect(submitted.details?.answer, 'Turn abort should cancel the batch even after the remote responder passes').toBeNull()
  })
})

describe('multiple questions per call', () => {
  it('should report the missing UI when a batch runs without one', async () => {
    const result = await setup().execute(
      'call-1',
      {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS },
        ],
      } as never,
      undefined,
      undefined,
      { hasUI: false },
    )

    expect(result.content[0].text, 'A missing UI is an error, not a user cancel').toBe('First?\nError: UI not available (running in non-interactive mode)')
  })

  it('should cancel the whole call when RPC cancels after an earlier answer', async () => {
    const tool = setup()
    const choices = ['1. Alpha', undefined]
    const ctx = { hasUI: true, mode: 'rpc', ui: { select: async () => choices.shift() } }

    const result = await tool.execute(
      'call-1',
      {
        questions: [
          { question: 'First?', options: OPTIONS },
          { question: 'Second?', options: OPTIONS },
        ],
      } as never,
      undefined,
      undefined,
      ctx,
    )
    const rendered = lines(tool.renderResult(result, {}, theme)).join('\n')

    expect(result.content[0].text, 'The model should get one cancellation for the whole call').toBe('User cancelled the selection')
    expect(result.details?.questions, 'Every question should be cancelled').toMatchObject([{ answer: null }, { answer: null }])
    expect(rendered, 'The transcript should show the call as cancelled').toBe('Cancelled')
  })

  it('should ask questions in order when using the RPC fallback', async () => {
    const asked: string[] = []
    const answers = ['1. Alpha', '2. Beta']
    const ctx = {
      hasUI: true,
      mode: 'rpc',
      ui: {
        select: async () => {
          const answer = answers[asked.length]
          asked.push(answer)
          return answer
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

    expect(asked, 'RPC should ask both questions').toHaveLength(2)
    expect(result.content[0].text, 'The result should identify the first question').toContain('First?')
    expect(result.content[0].text, 'The result should include the first answer').toContain('Alpha')
    expect(result.content[0].text, 'The result should identify the second question').toContain('Second?')
    expect(result.content[0].text, 'The result should include the second answer').toContain('Beta')
  })

  it('should stop asking when the RPC selector is cancelled', async () => {
    let calls = 0
    const ctx = {
      hasUI: true,
      mode: 'rpc',
      ui: {
        select: async () => {
          calls++
          return undefined
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

    expect(calls, 'RPC cancellation should stop before asking another question').toBe(1)
    expect(result.content[0].text, 'The result should identify cancellation').toContain('cancelled')
  })

  it('should continue asking when RPC submits a blank custom answer', async () => {
    const answers = ['3. Type something.', '2. Beta']
    let calls = 0
    const ctx = { hasUI: true, mode: 'rpc', ui: { select: async () => answers[calls++], input: async () => '' } }
    const params = {
      questions: [
        { question: 'First?', options: OPTIONS },
        { question: 'Second?', options: OPTIONS },
      ],
    }
    const result = await setup().execute('call-1', params as never, undefined, undefined, ctx as never)

    expect(calls, 'RPC should continue after a submitted blank answer').toBe(2)
    expect(result.content[0].text, 'The result should include the later question').toContain('Second?')
  })

  it('still accepts the single-question shape', async () => {
    const result = await setup().execute('call-1', { question: 'Pick one', options: OPTIONS } as never, undefined, undefined, uiCtx({ kind: 'submit', answers: [{ kind: 'option', index: 0 }] }) as never)
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

  it('reads the --settings value over the user file, and skips the user file when --setting-sources excludes it', () => {
    // Claude: --settings "can set any key your user settings file can set".
    const home = tempDir()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ askUserQuestionTimeout: '5m' }))
    const flag = join(tempDir(), 'settings.json')
    writeFileSync(flag, JSON.stringify({ askUserQuestionTimeout: '30s' }))
    try {
      setCliSettingsReader(() => ({ settingsFile: flag, sources: new Set(['user', 'project', 'local']), forwardArgs: [], errors: [] }))
      expect(askUserQuestionTimeoutMs(home)).toBe(30_000)
      setCliSettingsReader(() => ({ settingsFile: undefined, sources: new Set(['project']), forwardArgs: [], errors: [] }))
      expect(askUserQuestionTimeoutMs(home)).toBeUndefined()
    } finally {
      setCliSettingsReader(undefined)
    }
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
    const result = askViaOverlay([{ question: 'Pick one', options, multiSelect }], ctx as never, timeoutMs).then((result) => result?.answers[0])
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
    expect(await result).toEqual({ kind: 'timedOut' })
    void overlay
  })

  it('auto-continues a multiSelect with only what was already checked, not every option', async () => {
    // Checking one of the two, not both: an implementation that submitted every
    // option regardless of what was checked would pass a two-for-two fixture too.
    const { overlay, result } = openTimed(OPTIONS, true, 60_000)
    overlay.handleInput(RAW.space) // check Alpha only
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toEqual({ kind: 'timedOut', selected: { kind: 'multi', indices: [0] } })
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
