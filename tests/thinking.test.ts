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
    start: () => handlers.get('session_start')?.({}, {}),
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
  it('recognizes ultrathink, the only keyword Claude recognizes', () => {
    expect(requestedThinkingLevel('please ultrathink this')).toBe('max')
    expect(requestedThinkingLevel('ULTRATHINK')).toBe('max')
  })

  it('passes every other think phrase through as ordinary text', () => {
    // Claude: "Claude Code passes other phrases such as 'think', 'think hard', and
    // 'think more' through as ordinary prompt text and doesn't recognize them as
    // keywords." Escalating on them surprised anyone who merely wrote the word.
    expect(requestedThinkingLevel('think hard about it')).toBeUndefined()
    expect(requestedThinkingLevel('think harder here')).toBeUndefined()
    expect(requestedThinkingLevel('think about the edge cases')).toBeUndefined()
    expect(requestedThinkingLevel('think more')).toBeUndefined()
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

  it('leaves the level alone for a think phrase that is not the keyword', () => {
    // Replaces a case that asserted the removed escalation. The subject is the same
    // wiring, now pinning the opposite outcome: these phrases are ordinary text.
    for (const phrase of ['think hard about this', 'think it over', 'think more']) {
      const t = wire('off')
      t.input(phrase)
      expect(t.setThinkingLevel).not.toHaveBeenCalled()
      expect(t.level()).toBe('off')
    }
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
    t.input('ultrathink this') // low -> max, pending captured as low
    expect(t.level()).toBe('max')
    t.input('ultrathink again') // already at max, pending must still be low
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

  it('leaves a level the user changed meanwhile alone when the next input arrives', () => {
    // The restore fires only while this extension still owns the level (it equals the
    // escalation target). A user who moved it elsewhere after a blocked prompt keeps
    // their choice; without the guard it would be reset to the pre-escalation level.
    const t = wire('low')
    t.input('please ultrathink') // low -> max, prompt then blocked: no settle
    t.setThinkingLevel('high') // the user picks a level of their own
    t.input('a plain prompt')
    expect(t.level()).toBe('high')
  })

  it('restores a blocked escalation on the next input, without waiting for a settle', () => {
    // A hook can block the prompt that escalated: no turn runs, so no agent_settled ever
    // fires to restore the level. The next input is the signal the prior prompt is gone;
    // if this extension still owns the level, it must restore before handling that input.
    const t = wire('low')
    t.input('please ultrathink') // low -> max
    expect(t.level()).toBe('max')
    // No settle (the prompt was blocked). A second input with no keyword arrives.
    t.input('never mind, just do it')
    expect(t.level()).toBe('low') // restored before evaluating the new input
    // A late settle must not re-apply anything: the restore already cleared the pending.
    t.setThinkingLevel.mockClear()
    t.settle()
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
  })

  it('drops a pending escalation on session_start so it never restores into the next session', () => {
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance while an escalation is still pending; that stale restore must be
    // dropped, not fired into the next session (whose level the new session owns), and
    // session_start itself must not call setThinkingLevel.
    const t = wire('low')
    t.input('please ultrathink') // low -> max
    expect(t.level()).toBe('max')
    t.setThinkingLevel.mockClear()
    t.start()
    expect(t.setThinkingLevel).not.toHaveBeenCalled() // the reset does not fire a restore
    t.settle()
    expect(t.setThinkingLevel).not.toHaveBeenCalled() // the pending escalation was dropped
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

describe('the keyword only ever raises the level', () => {
  it('leaves a session already at max alone, and restores nothing afterwards', () => {
    // ultrathink targets max. A session already there has nothing to raise, so the
    // extension must not touch the level and must not arm a restore: arming one would
    // hand the level back to `max` at settle even if the user changed it mid-turn.
    const t = wire('max')
    t.input('please ultrathink this')

    expect(t.setThinkingLevel).not.toHaveBeenCalled()
    expect(t.level()).toBe('max')

    t.settle()
    expect(t.setThinkingLevel).not.toHaveBeenCalled()
  })

  it('raises from a level below the target and restores that level', () => {
    // The companion half, so the guard above cannot pass by never escalating at all.
    const t = wire('low')
    t.input('please ultrathink this')
    expect(t.level()).toBe('max')

    t.settle()
    expect(t.level()).toBe('low')
  })
})
