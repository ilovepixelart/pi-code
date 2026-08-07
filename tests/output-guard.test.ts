import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { capForContext } from '../extensions/internal/output-guard.ts'

const lines = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')

describe('capForContext', () => {
  it('returns short output untouched', () => {
    expect(capForContext('just this')).toBe('just this')
    expect(capForContext('')).toBe('')
  })

  it('caps on line count even when well under the byte budget', () => {
    const many = lines(DEFAULT_MAX_LINES + 1000)
    expect(many.length).toBeLessThan(DEFAULT_MAX_BYTES)

    const capped = capForContext(many)
    expect(capped.split('\n').length).toBeLessThan(DEFAULT_MAX_LINES + 10)
    expect(capped).toContain('truncated')
  })

  it('caps on bytes when a few lines are enormous', () => {
    const huge = `${'x'.repeat(DEFAULT_MAX_BYTES * 2)}\nsecond line`
    const capped = capForContext(huge)
    expect(capped.length).toBeLessThan(huge.length)
    expect(capped).toContain('truncated')
  })

  it('never returns more than it was given', () => {
    // Just over the budget the notice can cost more than the trim saves.
    const barelyOver = `${'x'.repeat(DEFAULT_MAX_BYTES)}\nsecond line`
    expect(capForContext(barelyOver).length).toBeLessThanOrEqual(barelyOver.length)
  })

  it('still returns content when the very first line exceeds the budget', () => {
    // truncateHead keeps whole lines, so it yields nothing here on its own.
    const oneLongLine = 'x'.repeat(DEFAULT_MAX_BYTES * 2)
    const capped = capForContext(oneLongLine)

    expect(capped.startsWith('x')).toBe(true)
    expect(capped.length).toBeGreaterThan(1000)
    expect(capped).toContain('truncated')
  })

  it('honors the byte budget for multi-byte text on the single-long-line path', () => {
    // The fallback slice is the only place the budget is applied by hand. String.slice
    // counts UTF-16 units, so this 150KB line used to come back at ~150KB against a
    // 50KB budget: one CJK character per byte of budget rather than one third of one.
    const oneLongLine = '\u4f60'.repeat(DEFAULT_MAX_BYTES)
    const capped = capForContext(oneLongLine)

    expect(capped.startsWith('\u4f60')).toBe(true)
    expect(Buffer.byteLength(capped, 'utf-8')).toBeLessThan(DEFAULT_MAX_BYTES * 1.1)
  })

  it('reports the original size and line count in the notice', () => {
    const capped = capForContext(lines(5000))
    expect(capped).toMatch(/\[truncated: .+ total, 5000 lines\]/)
  })
})
