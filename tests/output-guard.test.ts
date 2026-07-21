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

  it('reports the original size and line count in the notice', () => {
    const capped = capForContext(lines(5000))
    expect(capped).toMatch(/\[truncated: .+ total, 5000 lines\]/)
  })
})
