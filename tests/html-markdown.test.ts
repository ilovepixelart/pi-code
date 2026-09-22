import { describe, expect, it } from 'vitest'

import { htmlToMarkdown, removeTags } from '../extensions/internal/html-markdown.ts'

describe('htmlToMarkdown on well-formed pages', () => {
  it('converts headings, links, emphasis and lists to markdown', () => {
    const md = htmlToMarkdown('<h2>Docs</h2><p>See <a href="https://x.dev/a">the guide</a> for <strong>bold</strong> and <em>slanted</em>.</p><ul><li>one</li><li>two</li></ul>')
    expect(md).toContain('## Docs')
    expect(md).toContain('[the guide](https://x.dev/a)')
    expect(md).toContain('**bold**')
    expect(md).toContain('*slanted*')
    expect(md).toContain('- one')
    expect(md).toContain('- two')
  })

  it('lifts code and pre blocks out before other transforms touch them', () => {
    const md = htmlToMarkdown('<p>Run <code>npm test</code>:</p><pre><code>line one\nline two</code></pre>')
    expect(md).toContain('`npm test`')
    expect(md).toContain('```\nline one\nline two\n```')
  })

  it('drops script, style and comment content', () => {
    const text = htmlToMarkdown('<html><script>evil()</script><style>.x{color:red}</style><!-- hidden --><body><h1>Title</h1><p>One</p></body></html>')
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('hidden')
    expect(text).toContain('# Title')
    expect(text).toContain('One')
  })

  it('renders heading levels and strips tags nested inside an outer emphasis span', () => {
    // The strong/b pass runs before the em/i pass, so an <i> nested inside a <b> is
    // already gone (its tags stripped along with the rest of the <b> body) by the
    // time the em/i pass would have run. Pinning the existing order, not a new one.
    const md = htmlToMarkdown('<h3>Section</h3><p><b>bold <i>and slanted</i></b></p>')
    expect(md).toContain('### Section')
    expect(md).toContain('**bold and slanted**')
  })
})

// A page that repeats one unclosed tag (a broken template, a truncated fetch) used to cost
// one full rescan to the end of the string per occurrence: a lazy `[\s\S]*?<\/tag>` body
// capture that never finds its close scans the whole remainder every time it is tried, so a
// tag repeated n times over a document of length n costs O(n^2). web_fetch caps raw HTML at
// 200,000 characters, so this was a bounded but real multi-second stall per fetch.
describe('htmlToMarkdown on pages that repeat an unclosed tag', () => {
  // Bigger than web_fetch's 200,000-character raw-HTML cap, so a fix that is merely
  // faster (not linear) still fails this at some size; the quadratic pre-fix cost was
  // already several seconds at 200,000.
  const CAP = 300_000

  it.each([
    ['<!--', '<!-- '],
    ['<script>', '<script>'],
    ['<pre>', '<pre>'],
    ['<code>', '<code>'],
    ['<b>', '<b>'],
    ['<strong>', '<strong>'],
    ['<em>', '<em>'],
    ['<i>', '<i>'],
    ['<h1>', '<h1>'],
    ['<a href>', '<a href="x">'],
  ])('converts a page of repeated unclosed %s tags quickly', (_label, unit) => {
    const input = unit.repeat(Math.floor(CAP / unit.length))
    const started = performance.now()
    htmlToMarkdown(input)
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('still finds the one legitimate close among many unclosed tags of the same kind', () => {
    // Nothing before it should have consumed the close that belongs to the real pair.
    const input = `${'<b>'.repeat(5000)}<b>real</b>`
    expect(htmlToMarkdown(input)).toContain('**real**')
  })
})

describe('removeTags', () => {
  it('does not reassemble a tag split across nested brackets', () => {
    // A naive strip can turn `<scr<b>ipt>` into `<script>` by deleting only the inner tag.
    expect(removeTags('<scr<b>ipt>alert(1)</script>')).not.toContain('<script>')
  })
})
