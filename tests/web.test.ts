import { describe, expect, it } from 'vitest'

import { decodeEntities, htmlToText, isPrivateAddress, parseSearchResults, resolveResultUrl, stripTags } from '../extensions/web.ts'

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

  it('converts html to readable text with structure-preserving newlines', () => {
    const text = htmlToText('<html><script>evil()</script><body><h1>Title</h1><p>One</p><p>Two</p></body></html>')
    expect(text).toContain('Title')
    expect(text).toContain('One')
    expect(text).not.toContain('evil')
    expect(text.split('\n').length).toBeGreaterThan(1)
  })
})
