import { describe, expect, it } from 'vitest'

import { decodeEntities, htmlToText, parseSearchResults, resolveResultUrl, stripTags } from '../extensions/web.ts'

const FIXTURE = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2Fdocs&amp;rut=abc">pi <b>docs</b></a>
  <a class="result__snippet" href="#">The official pi documentation &amp; guides.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/direct">Direct link</a>
  <a class="result__snippet" href="#">A direct result.</a>
</div>
`

describe('web helpers', () => {
  it('resolves duckduckgo redirect urls', () => {
    expect(resolveResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2Fdocs&rut=x')).toBe('https://pi.dev/docs')
    expect(resolveResultUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(resolveResultUrl('//cdn.example.com/x')).toBe('https://cdn.example.com/x')
  })

  it('parses search results with titles, urls, and snippets', () => {
    const results = parseSearchResults(FIXTURE, 5)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ title: 'pi docs', url: 'https://pi.dev/docs', snippet: 'The official pi documentation & guides.' })
    expect(results[1].url).toBe('https://example.com/direct')
  })

  it('respects the result limit', () => {
    expect(parseSearchResults(FIXTURE, 1)).toHaveLength(1)
  })

  it('strips tags and decodes entities', () => {
    expect(stripTags('<b>a &amp; b</b>')).toBe('a & b')
    expect(decodeEntities('&lt;x&gt;')).toBe('<x>')
  })

  it('converts html to readable text with structure-preserving newlines', () => {
    const text = htmlToText('<html><script>evil()</script><body><h1>Title</h1><p>One</p><p>Two</p></body></html>')
    expect(text).toContain('Title')
    expect(text).toContain('One')
    expect(text).not.toContain('evil')
    expect(text.split('\n').length).toBeGreaterThan(1)
  })
})
