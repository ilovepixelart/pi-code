import { describe, expect, it } from 'vitest'

import { stripBlockComments } from '../extensions/internal/strip-comments.ts'

describe('stripBlockComments', () => {
  it('strips a whole-line comment with its line', () => {
    expect(stripBlockComments('keep\n<!-- maintainer note -->\nalso keep')).toBe('keep\nalso keep')
  })

  it('strips a multi-line comment with all its lines', () => {
    expect(stripBlockComments('a\n<!-- one\ntwo\nthree -->\nb')).toBe('a\nb')
  })

  it('strips an indented whole-line comment', () => {
    expect(stripBlockComments('a\n  <!-- indented -->\nb')).toBe('a\nb')
  })

  it('keeps an inline mid-line comment verbatim', () => {
    const line = 'text <!-- inline note --> more text'
    expect(stripBlockComments(line)).toBe(line)
  })

  it('keeps a line where a leading comment is followed by content', () => {
    // Whole-line-anchored: a comment sharing its line with real content is inline.
    const line = '<!-- note --> content after'
    expect(stripBlockComments(line)).toBe(line)
  })

  it('drops a line holding nothing but several comments', () => {
    expect(stripBlockComments('a\n<!-- one --> <!-- two -->\nb')).toBe('a\nb')
  })

  it('preserves comments inside backtick-fenced code blocks', () => {
    const text = '```html\n<!-- kept -->\n```'
    expect(stripBlockComments(text)).toBe(text)
  })

  it('preserves comments inside tilde-fenced code blocks', () => {
    const text = '~~~\n<!-- kept -->\n~~~'
    expect(stripBlockComments(text)).toBe(text)
  })

  it('does not let a tilde line close a backtick fence around a comment', () => {
    const text = '```\n~~~\n<!-- kept -->\n~~~\n```'
    expect(stripBlockComments(text)).toBe(text)
  })

  it('preserves a comment inside a 4-backtick fence holding a 3-backtick block', () => {
    // CommonMark closes a fenced block only with a same-character fence at least
    // as long as the opener, so the 3-backtick lines are content of the outer block.
    const text = '```` md\n```\n<!-- inside outer fence -->\n```\n````\ndone'
    expect(stripBlockComments(text)).toBe(text)
  })

  it('still strips a block comment after a nested fenced block', () => {
    // A shorter inner fence must not close the outer one and invert the fence
    // state for the rest of the file.
    const text = '```` md\n```\n<!-- inside -->\n````\n<!-- outside: strip me -->\nkeep'
    expect(stripBlockComments(text)).toBe('```` md\n```\n<!-- inside -->\n````\nkeep')
  })

  it('preserves a comment inside a 4-tilde fence holding a 3-tilde block', () => {
    const text = '~~~~\n~~~\n<!-- kept -->\n~~~\n~~~~'
    expect(stripBlockComments(text)).toBe(text)
  })

  it('does not let a commented-out fence line open a code block', () => {
    // The fence line sits inside a multi-line comment, so it is stripped with it.
    expect(stripBlockComments('<!--\n```\n-->\n<!-- gone -->\nkeep')).toBe('keep')
  })

  it('keeps content trailing a multi-line comment closer on its own line', () => {
    expect(stripBlockComments('<!-- a\nb --> tail')).toBe('tail')
  })

  it('returns comment-free text unchanged', () => {
    expect(stripBlockComments('plain\ntext\n')).toBe('plain\ntext\n')
  })

  it('strips a comment that opens the file', () => {
    expect(stripBlockComments('<!-- header note -->\nbody')).toBe('body')
  })
})
