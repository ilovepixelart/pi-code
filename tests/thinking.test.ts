import { describe, expect, it, vi } from 'vitest'

import thinkingExtension, { requestedThinkingLevel, thinkingRank } from '../extensions/thinking.ts'

type Handler = (event: any, ctx: any) => unknown

function wire(initial = 'off') {
  const handlers = new Map<string, Handler>()
  let level = initial
  const setThinkingLevel = vi.fn((l: string) => {
    level = l
  })
  const getThinkingLevel = vi.fn(() => level)
  thinkingExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    getThinkingLevel,
    setThinkingLevel,
  } as never)
  return {
    input: (text: string, ctx: any = {}, source = 'interactive') => handlers.get('input')?.({ text, source }, ctx),
    settle: () => handlers.get('agent_settled')?.({}, {}),
    setThinkingLevel,
    getThinkingLevel,
    level: () => level,
  }
}

describe('thinkingRank', () => {
  it('orders the pi thinking levels from off to max', () => {
    expect(thinkingRank('off')).toBeLessThan(thinkingRank('medium'))
    expect(thinkingRank('medium')).toBeLessThan(thinkingRank('high'))
    expect(thinkingRank('high')).toBeLessThan(thinkingRank('max'))
  })
})

describe('requestedThinkingLevel', () => {
  it('maps ultrathink to max, think hard/harder to high, bare think to medium', () => {
    expect(requestedThinkingLevel('please ultrathink this')).toBe('max')
    expect(requestedThinkingLevel('ULTRATHINK')).toBe('max')
    expect(requestedThinkingLevel('think hard about it')).toBe('high')
    expect(requestedThinkingLevel('think harder here')).toBe('high')
    expect(requestedThinkingLevel('think about the edge cases')).toBe('medium')
  })

  it('requires a word boundary so rethink/thinking do not trip the bare match', () => {
    expect(requestedThinkingLevel('let me rethink this')).toBeUndefined()
    expect(requestedThinkingLevel('it keeps thinking loudly')).toBeUndefined()
    expect(requestedThinkingLevel('nothing to see here')).toBeUndefined()
  })
})

describe('thinking extension', () => {
  it('escalates to max on ultrathink and restores the prior level when the turn settles', () => {
    const t = wire('low')
    t.input('please ultrathink')
    expect(t.setThinkingLevel).toHaveBeenLastCalledWith('max')
    expect(t.level()).toBe('max')
    t.settle()
    expect(t.setThinkingLevel).toHaveBeenLastCalledWith('low')
    expect(t.level()).toBe('low')
  })

  it('escalates think hard to high and bare think to medium', () => {
    const hard = wire('off')
    hard.input('think hard about this')
    expect(hard.level()).toBe('high')

    const bare = wire('off')
    bare.input('think it over')
    expect(bare.level()).toBe('medium')
  })

  it('does nothing when the input names no thinking keyword', () => {
    const t = wire('off')
    t.input('just do the thing')
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
    t.settle()
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
  })

  it('never lowers the level when already at or above the target', () => {
    const t = wire('max')
    t.input('think about it') // target medium, current max: no change
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
    t.settle()
    expect(t.setThinkingLevel).not.toHaveBeenCalled() // nothing captured to restore
  })

  it('restores the original level once across back-to-back escalations in one turn', () => {
    const t = wire('low')
    t.input('think hard') // low -> high
    expect(t.level()).toBe('high')
    t.input('ultrathink now') // high -> max, pending stays low
    expect(t.level()).toBe('max')
    t.settle()
    expect(t.level()).toBe('low')

    // A second settle must not re-apply any restore.
    t.setThinkingLevel.mockClear()
    t.settle()
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
  })

  it('ignores extension-sourced input carrying a think keyword', () => {
    // sendUserMessage emits an input event with source 'extension' (a subagent prompt,
    // or a command body replayed through it). A think keyword the user did not type must
    // not escalate.
    const t = wire('low')
    t.input('please ultrathink', {}, 'extension')
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
    expect(t.level()).toBe('low')
  })

  it('stands down at settle when the level was moved after it escalated', () => {
    // The fight scenario: commands.ts restores its own effort override on agent_settled
    // too. thinking escalated, then something else (that restore, or a manual change)
    // moved the level; thinking must not clobber it with its own restore, so the
    // outcome is order-independent.
    const t = wire('low')
    t.input('please ultrathink')
    expect(t.level()).toBe('max')
    // Simulate a command's effort restore (or a manual change) moving the level away.
    t.setThinkingLevel('high')
    t.settle()
    expect(t.level()).toBe('high') // external value kept, thinking stood down
  })

  it('restores the prior level when it still owns the escalation at settle', () => {
    const t = wire('low')
    t.input('please ultrathink')
    expect(t.level()).toBe('max')
    t.settle()
    expect(t.level()).toBe('low')
  })

  it('reads the prior level from ctx.thinkingLevel when getThinkingLevel is absent', () => {
    const handlers = new Map<string, Handler>()
    const setThinkingLevel = vi.fn()
    thinkingExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn), setThinkingLevel } as never)
    handlers.get('input')?.({ text: 'ultrathink' }, { thinkingLevel: 'medium' })
    expect(setThinkingLevel).toHaveBeenLastCalledWith('max')
    handlers.get('agent_settled')?.({}, {})
    expect(setThinkingLevel).toHaveBeenLastCalledWith('medium')
  })
})
