import { describe, expect, it } from 'vitest'

import { contentText } from '../extensions/internal/values.ts'

describe('contentText', () => {
  it('returns a plain-string content unchanged', () => {
    expect(contentText('already text')).toBe('already text')
  })

  it('joins every text part with the separator the caller names', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(contentText(content, ' ')).toBe('first second')
    expect(contentText(content, '\n')).toBe('first\nsecond')
    // The default concatenates, which is what Claude's last_assistant_message carries.
    expect(contentText(content)).toBe('firstsecond')
  })

  it('drops thinking and tool parts, keeping only text', () => {
    const content = [
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'kept' },
      { type: 'toolCall', name: 'bash', args: {} },
    ]
    expect(contentText(content, '|')).toBe('kept')
  })

  it('drops a text part whose text is not a string', () => {
    expect(contentText([{ type: 'text', text: 42 }, { type: 'text' }, { type: 'text', text: 'ok' }], '|')).toBe('ok')
  })

  it('keeps an empty text part, so the separator still shows it was there', () => {
    expect(
      contentText(
        [
          { type: 'text', text: '' },
          { type: 'text', text: 'after' },
        ],
        '|',
      ),
    ).toBe('|after')
  })

  it('is empty for content that is neither a string nor an array', () => {
    expect(contentText(undefined)).toBe('')
    expect(contentText(null)).toBe('')
    expect(contentText({ type: 'text', text: 'not in an array' })).toBe('')
    expect(contentText(7)).toBe('')
  })

  it('ignores a non-object entry rather than reading a property off it', () => {
    expect(contentText(['loose string', null, { type: 'text', text: 'ok' }], '|')).toBe('ok')
  })
})
