import { describe, expect, it } from 'vitest'
import { stringEnum } from '../extensions/internal/string-enum.ts'

describe('stringEnum', () => {
  it('emits the plain enum schema every provider accepts', () => {
    expect(JSON.parse(JSON.stringify(stringEnum(['a', 'b'] as const, { description: 'pick one' })))).toEqual({ type: 'string', enum: ['a', 'b'], description: 'pick one' })
  })

  it('omits the description when none is given', () => {
    expect(JSON.parse(JSON.stringify(stringEnum(['a'] as const)))).toEqual({ type: 'string', enum: ['a'] })
  })
})
