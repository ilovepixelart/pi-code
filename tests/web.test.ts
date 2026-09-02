import { describe, expect, it } from 'vitest'

import { htmlToMarkdown } from '../extensions/internal/html-markdown.ts'
import { decodeEntities, filterByDomain, isPrivateAddress, parseSearchResults, resolveResultUrl, stripTags } from '../extensions/web.ts'

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

  it('filters search results by allowed and blocked domains, subdomains included', () => {
    const rs = [
      { title: 'a', url: 'https://pi.dev/docs', snippet: '' },
      { title: 'b', url: 'https://api.pi.dev/x', snippet: '' },
      { title: 'c', url: 'https://example.com/y', snippet: '' },
    ]
    expect(filterByDomain(rs, ['pi.dev'], undefined).map((r) => r.title)).toEqual(['a', 'b'])
    expect(filterByDomain(rs, undefined, ['pi.dev']).map((r) => r.title)).toEqual(['c'])
    // allowed wins when both are given, matching Claude's mutually-exclusive rule.
    expect(filterByDomain(rs, ['example.com'], ['example.com']).map((r) => r.title)).toEqual(['c'])
    expect(filterByDomain(rs, undefined, undefined)).toEqual(rs)
  })

  it('keeps snippets aligned when an ad result is skipped', () => {
    const withAd = `
<div class="result">
  <a class="result__a" href="https://example.com/a">First</a>
  <a class="result__snippet" href="#">Snippet A.</a>
</div>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Sponsored</a>
  <a class="result__snippet" href="#">Ad copy.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/c">Third</a>
  <a class="result__snippet" href="#">Snippet C.</a>
</div>
`
    const results = parseSearchResults(withAd, 5)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ title: 'First', url: 'https://example.com/a', snippet: 'Snippet A.' })
    expect(results[1]).toEqual({ title: 'Third', url: 'https://example.com/c', snippet: 'Snippet C.' })
  })

  it('strips tags and decodes entities', () => {
    expect(stripTags('<b>a &amp; b</b>')).toBe('a & b')
    expect(decodeEntities('&lt;x&gt;')).toBe('<x>')
  })

  it('cannot reassemble a tag from nested brackets', () => {
    // A regex strip removes the inner <b> and leaves <script> behind.
    expect(stripTags('<scr<b>ipt>alert(1)</script>x')).not.toContain('<script')
    expect(stripTags('<scr<b>ipt>alert(1)</script>x')).toBe('ipt>alert(1)x')
  })

  it('keeps a lone < with no closing > as text', () => {
    expect(stripTags('1 < 2 and <b>3</b>')).toBe('1 < 2 and 3')
    expect(stripTags('a <b')).toBe('a <b')
  })

  it('strips a page of nested tag openers in one pass', () => {
    expect(stripTags(`${'<a<b'.repeat(100_000)}>`)).toBe('')
  })

  it('leaves a < that opens no tag alone, as the HTML tokenizer does', () => {
    expect(stripTags('x <3 y <<b>z</b>')).toBe('x <3 y <z')
  })

  it('classifies private and internal addresses for the SSRF guard', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('blocks IPv4-mapped and NAT64 IPv6 in the hex form the URL parser normalizes to', () => {
    // ::ffff:127.0.0.1 -> ::ffff:7f00:1, ::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe
    for (const ip of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', 'fe80::1%eth0', 'febf::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('does not leave a script tag behind when brackets nest inside one', () => {
    const md = htmlToMarkdown('<p>see</p><scr<b>ipt>alert(1)</script><p>done</p>')
    expect(md).not.toContain('<script')
    expect(md).toContain('done')
  })

  it('converts html to markdown, dropping script and style bodies', () => {
    const text = htmlToMarkdown('<html><script>evil()</script><body><h1>Title</h1><p>One</p><p>Two</p></body></html>')
    expect(text).toContain('# Title')
    expect(text).toContain('One')
    expect(text).not.toContain('evil')
    expect(text.split('\n').length).toBeGreaterThan(1)
  })
})

describe('htmlToMarkdown', () => {
  it('converts headings, links, emphasis and lists', () => {
    const md = htmlToMarkdown('<h2>Docs</h2><p>See <a href="https://x.dev/a">the guide</a> for <strong>bold</strong> and <em>slanted</em>.</p><ul><li>one</li><li>two</li></ul>')
    expect(md).toContain('## Docs')
    expect(md).toContain('[the guide](https://x.dev/a)')
    expect(md).toContain('**bold**')
    expect(md).toContain('*slanted*')
    expect(md).toContain('- one')
    expect(md).toContain('- two')
  })

  it('converts pre blocks to fences and inline code to backticks', () => {
    const md = htmlToMarkdown('<p>Run <code>npm test</code>:</p><pre><code>line one\nline two</code></pre>')
    expect(md).toContain('`npm test`')
    expect(md).toContain('```\nline one\nline two\n```')
  })

  it('decodes named and numeric entities', () => {
    expect(htmlToMarkdown('<p>a &amp; b &#8212; c &#x2192; d</p>')).toBe('a & b — c → d')
  })

  it('drops comments and keeps a plain anchor without an http href as text', () => {
    const md = htmlToMarkdown('<!-- hidden --><p><a href="javascript:x()">click</a> and <a href="#top">jump</a></p>')
    expect(md).not.toContain('hidden')
    expect(md).toContain('click')
    expect(md).not.toContain('javascript:')
    expect(md).not.toContain('(#top)')
  })
})
