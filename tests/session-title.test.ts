import { afterEach, describe, expect, it } from 'vitest'

import { setCompleteBackend } from '../extensions/internal/model-complete.ts'
import sessionTitle, { cleanTitle, firstUserText } from '../extensions/session-title.ts'

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown

/** A minimal assistant message the stubbed completion backend can return. */
const assistantMsg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 }) as never

const userEntry = (content: any, id = 'u1') => ({ type: 'message', id, parentId: null, timestamp: '', message: { role: 'user', content } })
const assistantEntry = (content: any, id = 'a1') => ({ type: 'message', id, parentId: null, timestamp: '', message: { role: 'assistant', content } })

afterEach(() => setCompleteBackend(null))

/** Fresh extension instance over a stub API. `initialName` seeds a pre-named session. */
function setup(initialName?: string) {
  const handlers = new Map<string, Handler>()
  let name: string | undefined = initialName
  const namesSet: string[] = []
  const setTitles: string[] = []

  sessionTitle({
    on: (event: string, fn: Handler) => handlers.set(event, fn),
    setSessionName: (n: string) => {
      name = n
      namesSet.push(n)
    },
    getSessionName: () => name,
  } as any)

  const makeCtx = (branch: any[], opts: { model?: unknown; setTitle?: boolean; throwUi?: boolean } = {}) => {
    const base = {
      model: 'model' in opts ? opts.model : {},
      hasUI: true,
      mode: 'tui' as const,
      sessionManager: { getBranch: () => branch },
    }
    // A ctx whose ui getter throws models a session disposed while a title call was in flight.
    if (opts.throwUi) {
      return Object.defineProperty(base, 'ui', {
        get: () => {
          throw new Error('session disposed')
        },
      })
    }
    return { ...base, ui: opts.setTitle === false ? {} : { setTitle: (t: string) => setTitles.push(t) } }
  }

  return {
    settle: (branch: any[], opts?: { model?: unknown; setTitle?: boolean; throwUi?: boolean }) => handlers.get('agent_settled')?.({ type: 'agent_settled' }, makeCtx(branch, opts)),
    start: (reason = 'new') => handlers.get('session_start')?.({ type: 'session_start', reason }, makeCtx([])),
    namesSet,
    setTitles,
    getName: () => name,
  }
}

describe('session auto-titling', () => {
  it('names an unnamed session from its first user message on the first settle', async () => {
    const t = setup()
    setCompleteBackend(async () => assistantMsg('Refactor Config Loader'))
    await t.settle([userEntry('refactor the config loader so it validates the schema up front')])
    expect(t.namesSet).toEqual(['Refactor Config Loader'])
    expect(t.setTitles).toEqual(['Refactor Config Loader'])
    expect(t.getName()).toBe('Refactor Config Loader')
  })

  it('does not re-title on a later settle once the session is named', async () => {
    const t = setup()
    setCompleteBackend(async () => assistantMsg('First Title'))
    await t.settle([userEntry('do the first thing')])
    setCompleteBackend(async () => assistantMsg('Second Title'))
    await t.settle([userEntry('do the first thing'), userEntry('do a second thing', 'u2')])
    expect(t.namesSet).toEqual(['First Title'])
    expect(t.setTitles).toEqual(['First Title'])
  })

  it('leaves a session that already has a name untouched, without calling the model', async () => {
    const t = setup('User Chosen Name')
    let called = false
    setCompleteBackend(async () => {
      called = true
      return assistantMsg('Model Title')
    })
    await t.settle([userEntry('some message')])
    expect(t.namesSet).toEqual([])
    expect(t.setTitles).toEqual([])
    expect(called).toBe(false)
    expect(t.getName()).toBe('User Chosen Name')
  })

  it('skips titling and never throws when the completion fails', async () => {
    const t = setup()
    setCompleteBackend(async () => {
      throw new Error('no credentials')
    })
    await expect(t.settle([userEntry('a message')])).resolves.toBeUndefined()
    expect(t.namesSet).toEqual([])
    expect(t.setTitles).toEqual([])
    expect(t.getName()).toBeUndefined()
  })

  it('strips surrounding quotes and trailing punctuation from the model title', async () => {
    const t = setup()
    setCompleteBackend(async () => assistantMsg('"Fix The Parser."'))
    await t.settle([userEntry('fix the parser bug')])
    expect(t.namesSet).toEqual(['Fix The Parser'])
  })

  it('does not title a turn with no user text (slash-command-only)', async () => {
    const t = setup()
    let called = false
    setCompleteBackend(async () => {
      called = true
      return assistantMsg('Nope')
    })
    await t.settle([assistantEntry([{ type: 'text', text: 'hello from the assistant' }])])
    expect(t.namesSet).toEqual([])
    expect(called).toBe(false)
  })

  it('does not title when no model is available (headless)', async () => {
    const t = setup()
    let called = false
    setCompleteBackend(async () => {
      called = true
      return assistantMsg('Nope')
    })
    await t.settle([userEntry('hello')], { model: undefined })
    expect(t.namesSet).toEqual([])
    expect(called).toBe(false)
  })

  it('still names the session when the ui cannot set a window title', async () => {
    const t = setup()
    setCompleteBackend(async () => assistantMsg('Some Title'))
    await t.settle([userEntry('do a thing')], { setTitle: false })
    expect(t.namesSet).toEqual(['Some Title'])
    expect(t.setTitles).toEqual([])
  })

  it('does not retry a failed attempt until a new session resets the guard', async () => {
    const t = setup()
    setCompleteBackend(async () => {
      throw new Error('provider down')
    })
    await t.settle([userEntry('a message')])
    // Same session, model now works: the single attempt was already spent, so no retry.
    setCompleteBackend(async () => assistantMsg('Recovered Title'))
    await t.settle([userEntry('a message'), userEntry('another', 'u2')])
    expect(t.namesSet).toEqual([])
    // A fresh session clears the guard, so titling can happen again.
    await t.start('new')
    await t.settle([userEntry('brand new session message')])
    expect(t.namesSet).toEqual(['Recovered Title'])
  })

  it('drops a stale title when a new session starts during the model call', async () => {
    const t = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setCompleteBackend(async () => {
      await gate
      return assistantMsg('Stale Title')
    })
    // Start titling the first session, then a /new mid-call resets state to a fresh,
    // different session (a new generation) before the completion resolves.
    const settling = t.settle([userEntry('do the first thing')])
    await t.start('new')
    release()
    await settling
    // The late title belonged to the prior session; it must not rename the new one.
    expect(t.namesSet).toEqual([])
    expect(t.setTitles).toEqual([])
  })

  it('does not reject when the ctx is disposed after the model call resolves', async () => {
    const t = setup()
    setCompleteBackend(async () => assistantMsg('Some Title'))
    // A ctx whose ui getter throws post-await models a session disposed while the call
    // was in flight; an escaping rejection from this un-awaited settle can exit pi.
    await expect(t.settle([userEntry('do a thing')], { throwUi: true })).resolves.toBeUndefined()
  })
})

describe('cleanTitle', () => {
  it('strips wrapping quotes, trailing punctuation, and collapses whitespace', () => {
    expect(cleanTitle('  "Refactor   the Loader."  ')).toBe('Refactor the Loader')
    expect(cleanTitle("'Add Retry Logic'")).toBe('Add Retry Logic')
    expect(cleanTitle('Plain Title')).toBe('Plain Title')
    expect(cleanTitle('“Smart Quotes”')).toBe('Smart Quotes')
    expect(cleanTitle('`Backtick Title`!')).toBe('Backtick Title')
  })
})

describe('firstUserText', () => {
  const ctxFor = (branch: any[]) => ({ sessionManager: { getBranch: () => branch } }) as any

  it('returns the first user message text from string or text-part content', () => {
    expect(firstUserText(ctxFor([userEntry('just a string')]))).toBe('just a string')
    expect(
      firstUserText(
        ctxFor([
          userEntry([
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ]),
        ]),
      ),
    ).toBe('part one part two')
  })

  it('skips assistant entries and returns empty when there is no user text', () => {
    expect(firstUserText(ctxFor([assistantEntry('hi'), userEntry('the real one', 'u2')]))).toBe('the real one')
    expect(firstUserText(ctxFor([assistantEntry([{ type: 'text', text: 'assistant only' }])]))).toBe('')
    expect(firstUserText(ctxFor([]))).toBe('')
  })
})
