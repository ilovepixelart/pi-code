import { lookup } from 'node:dns/promises'
import { DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { httpFetch } from '../extensions/internal/web-transport.ts'
import webExtension, { isPrivateAddress, pinnedLookup } from '../extensions/web.ts'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('../extensions/internal/web-transport.js', () => ({ httpFetch: vi.fn() }))

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }
type Execute = (id: string, params: Record<string, unknown>) => Promise<ToolResult>

/** Register the extension against a stub API and expose both tools by name. */
const setup = (): { search: (params: Record<string, unknown>) => Promise<ToolResult>; fetchUrl: (url: string) => Promise<ToolResult> } => {
  const tools = new Map<string, Execute>()
  webExtension({
    on: () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
  } as never)
  const search = tools.get('web_search')
  const fetchUrl = tools.get('web_fetch')
  if (!search || !fetchUrl) throw new Error('web tools were not registered')
  return { search: (params) => search('call-1', params), fetchUrl: (url) => fetchUrl('call-1', { url }) }
}

const lookupMock = vi.mocked(lookup)
const fetchMock = vi.mocked(httpFetch)

const respond = (body: string | ReadableStream<Uint8Array> | null, opts: { status?: number; contentType?: string | null; location?: string } = {}): Response => {
  const headers = new Headers()
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'text/html; charset=utf-8')
  if (opts.location) headers.set('location', opts.location)
  return new Response(body, { status: opts.status ?? 200, headers })
}

const publicAddresses = [{ address: '93.184.216.34', family: 4 }]

const requestUrls = (): string[] => fetchMock.mock.calls.map((call) => String(call[0]))

beforeEach(() => {
  fetchMock.mockReset()
  lookupMock.mockReset()
  lookupMock.mockResolvedValue(publicAddresses as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web_fetch scheme validation', () => {
  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,<b>x</b>', '/relative/path', 'example.com', 'HTTPS://example.com'])('rejects %s without touching DNS or the network', async (url) => {
    const result = await setup().fetchUrl(url)
    expect(result.content).toEqual([{ type: 'text', text: 'Only http(s) URLs are supported.' }])
    expect(lookupMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['http://example.com/a', 'https://example.com/a'])('accepts %s', async (url) => {
    fetchMock.mockResolvedValue(respond('ok', { contentType: 'text/plain' }))
    const result = await setup().fetchUrl(url)
    expect(result.content[0].text).toBe('ok')
    expect(requestUrls()).toEqual([url])
  })
})

describe('web_fetch responses', () => {
  it('converts an html body to readable text and drops scripts', async () => {
    fetchMock.mockResolvedValue(respond('<html><script>evil()</script><body><h1>Hi</h1><p>One &amp; two</p></body></html>'))
    const result = await setup().fetchUrl('https://example.com/page')
    expect(result.content[0].text).toBe('Hi\nOne & two')
    expect(result.details).toEqual({})
  })

  it('returns non-html bodies verbatim, capped at 30000 chars with no truncation marker', async () => {
    fetchMock.mockResolvedValue(respond('x'.repeat(40_000), { contentType: 'application/json' }))
    const result = await setup().fetchUrl('https://example.com/data.json')
    expect(result.content[0].text).toBe('x'.repeat(30_000))
  })

  it('caps the raw download at 200000 chars before the 30000 char output cap', async () => {
    fetchMock.mockResolvedValue(respond('a'.repeat(250_000)))
    const result = await setup().fetchUrl('https://example.com/huge')
    // 250k downloaded -> 200k kept by readCapped -> 30k emitted, 170k reported as dropped.
    expect(result.content[0].text).toBe(`${'a'.repeat(30_000)}\n[truncated 170000 chars]`)
  })

  it('reassembles multi-byte characters split across stream chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x63, 0x61, 0x66, 0xc3])) // "caf" + first byte of "é"
        controller.enqueue(new Uint8Array([0xa9, 0x21])) // second byte of "é" + "!"
        controller.close()
      },
    })
    fetchMock.mockResolvedValue(respond(stream, { contentType: 'text/plain' }))
    const result = await setup().fetchUrl('https://example.com/utf8')
    expect(result.content[0].text).toBe('café!')
  })

  it('falls back to response.text() when the response exposes no body stream', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'body-less payload',
    } as unknown as Response)
    const result = await setup().fetchUrl('https://example.com/nobody')
    expect(result.content[0].text).toBe('body-less payload')
  })

  it('reports an empty body as (empty response)', async () => {
    fetchMock.mockResolvedValue(respond('', { contentType: 'text/plain' }))
    const result = await setup().fetchUrl('https://example.com/empty')
    expect(result.content[0].text).toBe('(empty response)')
  })

  it('caps a body with thousands of short lines at pi tool-output line budget', async () => {
    // The 30k char cap alone lets thousands of short lines through; pi's tool-output
    // contract also bounds lines, which the shared output guard enforces.
    const manyLines = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, i) => `<p>l${i}</p>`).join('')
    fetchMock.mockResolvedValue(respond(manyLines))
    const result = await setup().fetchUrl('https://example.com/lines')
    const text = result.content[0].text as string
    expect(text.split('\n').length).toBeLessThan(DEFAULT_MAX_LINES + 10)
    expect(text).toContain('truncated')
  })

  it('treats a missing content-type as non-html and skips html stripping', async () => {
    // Response() synthesizes text/plain for a string body, so a header-less
    // reply has to be duck-typed to actually reach the `?? ''` fallback.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      url: 'https://example.com/unknown',
      body: null,
      text: async () => '<b>raw</b>',
    } as unknown as Response)
    const result = await setup().fetchUrl('https://example.com/unknown')
    expect(result.content[0].text).toBe('<b>raw</b>')
  })

  it('sends the pi user agent, a timeout signal, and a pinned lookup to the transport', async () => {
    fetchMock.mockResolvedValue(respond('ok', { contentType: 'text/plain' }))
    await setup().fetchUrl('https://example.com/a')
    const opts = fetchMock.mock.calls[0][1]
    expect(opts.userAgent).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) pi-code-web/0.1')
    // The transport never follows redirects and never re-resolves: the loop passes a lookup
    // already pinned to the validated address.
    expect(typeof opts.lookup).toBe('function')
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(opts.signal.aborted).toBe(false)
  })
})

describe('web_fetch failures', () => {
  it.each([404, 410, 500, 503])('surfaces HTTP %i as an error naming the status and url', async (status) => {
    fetchMock.mockResolvedValue(respond('nope', { status }))
    await expect(setup().fetchUrl('https://example.com/missing')).rejects.toThrow(`HTTP ${status} for https://example.com/missing`)
  })

  it('propagates a network-level fetch rejection', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(setup().fetchUrl('https://example.com/a')).rejects.toThrow('fetch failed')
  })

  it('propagates an abort when the request times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await expect(setup().fetchUrl('https://example.com/slow')).rejects.toThrow('The operation was aborted due to timeout')
  })

  it('propagates a malformed absolute url before any lookup', async () => {
    await expect(setup().fetchUrl('https://')).rejects.toThrow(/Invalid URL/)
    expect(lookupMock).not.toHaveBeenCalled()
  })
})

describe('web_fetch SSRF guard', () => {
  it('refuses a host that resolves to a private address, naming host and address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never)
    await expect(setup().fetchUrl('http://intranet.test/secret')).rejects.toThrow('refusing to fetch private/internal address for intranet.test (10.0.0.5)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when any address in a multi-record answer is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ] as never)
    await expect(setup().fetchUrl('http://metadata.test/')).rejects.toThrow('refusing to fetch private/internal address for metadata.test (169.254.169.254)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('strips brackets from an ipv6 literal host before resolving it', async () => {
    lookupMock.mockResolvedValue([{ address: '::1', family: 6 }] as never)
    await expect(setup().fetchUrl('http://[::1]:8080/admin')).rejects.toThrow('refusing to fetch private/internal address for [::1] (::1)')
    expect(lookupMock).toHaveBeenCalledWith('::1', { all: true, verbatim: true })
  })

  it('asks dns for every hostname with all+verbatim and allows public answers through', async () => {
    fetchMock.mockResolvedValue(respond('fine', { contentType: 'text/plain' }))
    const result = await setup().fetchUrl('https://example.com/a')
    expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true, verbatim: true })
    expect(result.content[0].text).toBe('fine')
  })

  it('propagates a dns resolution failure', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }))
    await expect(setup().fetchUrl('https://nope.invalid/')).rejects.toThrow('ENOTFOUND')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('web_fetch redirects', () => {
  it('follows a relative redirect resolved against the current url and re-checks dns', async () => {
    fetchMock.mockResolvedValueOnce(respond(null, { status: 302, location: '/moved/here' })).mockResolvedValueOnce(respond('arrived', { contentType: 'text/plain' }))
    const result = await setup().fetchUrl('https://example.com/start/page')
    expect(requestUrls()).toEqual(['https://example.com/start/page', 'https://example.com/moved/here'])
    expect(lookupMock).toHaveBeenCalledTimes(2)
    expect(result.content[0].text).toBe('arrived')
  })

  it('re-applies the SSRF guard to the redirect target', async () => {
    fetchMock.mockResolvedValueOnce(respond(null, { status: 301, location: 'http://internal.test/' }))
    lookupMock.mockResolvedValueOnce(publicAddresses as never).mockResolvedValueOnce([{ address: '192.168.1.9', family: 4 }] as never)
    await expect(setup().fetchUrl('https://example.com/a')).rejects.toThrow('refusing to fetch private/internal address for internal.test (192.168.1.9)')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('errors when a redirect omits the location header', async () => {
    fetchMock.mockResolvedValue(respond(null, { status: 302 }))
    await expect(setup().fetchUrl('https://example.com/a')).rejects.toThrow('redirect without location from example.com')
  })

  it('gives up after 6 hops with a too many redirects error', async () => {
    fetchMock.mockResolvedValue(respond(null, { status: 307, location: 'https://example.com/loop' }))
    await expect(setup().fetchUrl('https://example.com/loop')).rejects.toThrow('too many redirects for https://example.com/loop')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('treats status 299 as a body, not a redirect, even with a location header', async () => {
    fetchMock.mockResolvedValue(respond('body', { status: 299, contentType: 'text/plain', location: 'https://elsewhere.test/' }))
    const result = await setup().fetchUrl('https://example.com/a')
    expect(result.content[0].text).toBe('body')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats status 400 as an error, not a redirect, even with a location header', async () => {
    fetchMock.mockResolvedValue(respond('body', { status: 400, contentType: 'text/plain', location: 'https://elsewhere.test/' }))
    await expect(setup().fetchUrl('https://example.com/a')).rejects.toThrow('HTTP 400 for https://example.com/a')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

const resultHtml = (n: number): string => Array.from({ length: n }, (_, i) => `<div class="result"><a class="result__a" href="https://site${i}.test/">Title ${i}</a><a class="result__snippet">Snippet ${i}</a></div>`).join('')

describe('web_search', () => {
  it('hits the duckduckgo html endpoint with the query percent-encoded', async () => {
    fetchMock.mockResolvedValue(respond(resultHtml(1)))
    await setup().search({ query: 'pi & code' })
    expect(requestUrls()).toEqual(['https://html.duckduckgo.com/html/?q=pi%20%26%20code'])
  })

  it('formats numbered results with url and snippet lines', async () => {
    fetchMock.mockResolvedValue(respond(resultHtml(2)))
    const result = await setup().search({ query: 'pi' })
    expect(result.content[0].text).toBe('1. Title 0\n   https://site0.test/\n   Snippet 0\n2. Title 1\n   https://site1.test/\n   Snippet 1')
    expect(result.details).toEqual({})
  })

  it('defaults to 5 results', async () => {
    fetchMock.mockResolvedValue(respond(resultHtml(8)))
    const result = await setup().search({ query: 'pi' })
    expect(result.content[0].text.split('\n').filter((line) => /^\d+\. /.test(line))).toHaveLength(5)
  })

  it('honours a smaller explicit count', async () => {
    fetchMock.mockResolvedValue(respond(resultHtml(8)))
    const result = await setup().search({ query: 'pi', count: 2 })
    expect(result.content[0].text).toBe('1. Title 0\n   https://site0.test/\n   Snippet 0\n2. Title 1\n   https://site1.test/\n   Snippet 1')
  })

  it('caps an oversized count at 10', async () => {
    fetchMock.mockResolvedValue(respond(resultHtml(25)))
    const result = await setup().search({ query: 'pi', count: 50 })
    const numbered = result.content[0].text.split('\n').filter((line) => /^\d+\. /.test(line))
    expect(numbered).toHaveLength(10)
    expect(numbered.at(-1)).toBe('10. Title 9')
  })

  it.each([
    ['an empty page', ''],
    ['markup with no result anchors', '<html><body><p>nothing here</p></body></html>'],
  ])('reports no results for %s', async (_label, body) => {
    fetchMock.mockResolvedValue(respond(body))
    const result = await setup().search({ query: 'pi' })
    expect(result.content).toEqual([{ type: 'text', text: 'No results found.' }])
  })

  it('keeps a duckduckgo redirect href verbatim when its uddg payload is not decodable', async () => {
    fetchMock.mockResolvedValue(respond('<a class="result__a" href="//duckduckgo.com/l/?uddg=%E0%A4%A">Broken</a><a class="result__snippet">S</a>'))
    const result = await setup().search({ query: 'pi' })
    expect(result.content[0].text).toBe('1. Broken\n   //duckduckgo.com/l/?uddg=%E0%A4%A\n   S')
  })

  it('surfaces an upstream http failure from the search endpoint', async () => {
    fetchMock.mockResolvedValue(respond('rate limited', { status: 429 }))
    await expect(setup().search({ query: 'pi' })).rejects.toThrow('HTTP 429 for https://html.duckduckgo.com/html/?q=pi')
  })
})

describe('web_fetch guard fails closed', () => {
  it('refuses a host that resolves to no addresses', async () => {
    lookupMock.mockResolvedValue([] as never)
    await expect(setup().fetchUrl('https://nowhere.example/x')).rejects.toThrow(/did not resolve/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a redirect that leaves http(s)', async () => {
    // data:/file: carry no host, so the address loop has nothing to reject.
    fetchMock.mockResolvedValue(respond('', { status: 302, location: 'data:text/html,pwned' }))
    await expect(setup().fetchUrl('https://example.com/a')).rejects.toThrow(/unsupported redirect scheme/)
  })

  it('refuses a redirect to a file url', async () => {
    fetchMock.mockResolvedValue(respond('', { status: 302, location: 'file:///etc/passwd' }))
    await expect(setup().fetchUrl('https://example.com/a')).rejects.toThrow(/unsupported redirect scheme/)
  })
})

describe('web_fetch pins dns against rebinding', () => {
  it('resolves once and hands the transport a lookup it cannot re-resolve', async () => {
    lookupMock.mockResolvedValue(publicAddresses as never)
    fetchMock.mockResolvedValue(respond('ok', { contentType: 'text/plain' }))

    await setup().fetchUrl('https://rebind.example/x')

    // One resolution per hop: a rebinding attack needs a second lookup to swap in a private
    // address, and there is none.
    expect(lookupMock).toHaveBeenCalledTimes(1)

    // Simulate the record flipping to a private address after validation. The pinned lookup
    // the transport received must ignore that and still yield only the validated address.
    lookupMock.mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never)
    const pinned = fetchMock.mock.calls[0][1].lookup
    const yielded = await new Promise((resolve) => pinned('rebind.example', { all: true }, (_e, addrs) => resolve(addrs)))
    expect(yielded).toEqual(publicAddresses)
  })
})

describe('pinnedLookup answers every lookup shape from the frozen addresses', () => {
  const addresses = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800::1', family: 6 },
  ]
  // The node socket may call lookup in several shapes; LookupFunction's type only covers
  // the 3-arg form, so reach the others through a loosely-typed alias.
  type AnyLookup = (host: string, ...rest: unknown[]) => void
  const lookupFor = () => pinnedLookup(addresses) as unknown as AnyLookup

  it('returns the full set for the {all:true} shape node sockets use', async () => {
    const yielded = await new Promise((resolve) => lookupFor()('h', { all: true }, (_e: unknown, a: unknown) => resolve(a)))
    expect(yielded).toEqual(addresses)
  })

  it('returns the first address and family for the single-result shape', async () => {
    const result = await new Promise((resolve) => lookupFor()('h', {}, (_e: unknown, address: unknown, family: unknown) => resolve({ address, family })))
    expect(result).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('accepts the legacy two-argument (hostname, callback) form', async () => {
    const result = await new Promise((resolve) => lookupFor()('h', (_e: unknown, address: unknown, family: unknown) => resolve({ address, family })))
    expect(result).toEqual({ address: '93.184.216.34', family: 4 })
  })
})

describe('isPrivateAddress covers special-use ranges', () => {
  it.each([
    ['198.18.0.1', 'benchmark 198.18/15'],
    ['198.19.255.255', 'benchmark upper bound'],
    ['192.0.0.1', 'protocol assignments 192.0.0/24'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'SSDP multicast'],
    ['240.0.0.1', 'reserved 240/4'],
    ['255.255.255.255', 'broadcast'],
    ['fec0::1', 'deprecated site-local'],
    ['ff02::1', 'IPv6 multicast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it('still allows ordinary public addresses', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false)
    expect(isPrivateAddress('197.255.255.255')).toBe(false)
    expect(isPrivateAddress('199.0.0.1')).toBe(false)
  })
})
