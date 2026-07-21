/**
 * Web Extension
 *
 * Key-free web access: web_search scrapes the DuckDuckGo HTML endpoint (no
 * API key, no account) and web_fetch retrieves a URL as readable text.
 * Honors the local-only setup: no cloud accounts, plain HTTPS to public web.
 */

import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { httpFetch } from './web-transport.js'

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q='
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) pi-code-web/0.1'
const MAX_FETCH_CHARS = 30_000
// Hard cap on raw bytes read before any parsing, so a huge or hostile page can't
// exhaust memory or feed megabytes into the HTML regexes. Output is capped again
// at MAX_FETCH_CHARS, so real pages rarely lose text.
const MAX_RAW_CHARS = 200_000
const FETCH_TIMEOUT_MS = 20_000

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

export function stripTags(html: string): string {
  // [^<>] rather than [^>]: excluding `<` bounds a failed match at the next tag start
  // instead of rescanning to end of input, which is what makes the strip linear.
  return decodeEntities(html.replace(/<[^<>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Resolve DuckDuckGo's redirect links (/l/?uddg=<encoded>) to the target URL. */
export function resolveResultUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return href
    }
  }
  return href.startsWith('//') ? `https:${href}` : href
}

export function parseSearchResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const anchorPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets = [...html.matchAll(snippetPattern)].map((m) => stripTags(m[1]))
  let index = 0
  for (const match of html.matchAll(anchorPattern)) {
    if (results.length >= limit) break
    const url = resolveResultUrl(match[1])
    const title = stripTags(match[2])
    if (!title || url.includes('duckduckgo.com/y.js')) continue
    results.push({ title, url, snippet: snippets[index] ?? '' })
    index++
  }
  return results
}

export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
  const text = decodeEntities(withoutBlocks.replace(/<[^<>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
  return text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n[truncated ${text.length - MAX_FETCH_CHARS} chars]` : text
}

/**
 * IPv4-mapped (::ffff:...) and NAT64 (64:ff9b::...) forms embed an IPv4 in the low 32 bits,
 * in either dotted-decimal or hex; the WHATWG URL parser normalizes literals to the hex form.
 */
function embeddedIpv4(addr: string): string | null {
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (dotted) return dotted[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr)
  if (!hex) return null
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

function isPrivateIpv6(addr: string): boolean {
  const embedded = embeddedIpv4(addr)
  if (embedded) return isPrivateAddress(embedded)
  if (addr === '::1' || addr === '::') return true
  if (/^fe[89ab]/.test(addr)) return true // link-local fe80::/10
  if (/^fe[cdef]/.test(addr)) return true // site-local fec0::/10, deprecated but still routed
  if (addr.startsWith('ff')) return true // multicast ff00::/8
  return /^f[cd]/.test(addr) // unique local fc00::/7
}

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && parts[2] === 0) return true // protocol assignments 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a >= 224) return true // multicast 224/4, reserved 240/4, broadcast 255.255.255.255
  return a === 100 && b >= 64 && b <= 127
}

/** SSRF guard: true for loopback, RFC1918, link-local, CGNAT, and private IPv6 ranges. Fails closed on unparseable input. */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
  return addr.includes(':') ? isPrivateIpv6(addr) : isPrivateIpv4(addr)
}

/** A lookup that always yields `addresses`, so the socket cannot resolve the host again. */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const cb = (typeof options === 'function' ? options : callback) as (err: Error | null, address: unknown, family?: number) => void
    if (typeof options !== 'function' && options.all) return cb(null, addresses)
    const [first] = addresses
    cb(null, first.address, first.family)
  }
}

/**
 * Resolve a host once, reject any private address, and return a lookup pinned to exactly
 * those addresses. Passing that lookup to the transport is what closes the SSRF
 * time-of-check/time-of-use gap: the connection reuses the validated resolution rather
 * than issuing a second, unchecked DNS query that a rebinding record could answer privately.
 */
async function resolveAndPin(url: URL): Promise<LookupFunction> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = await lookup(host, { all: true, verbatim: true })
  // An empty list would leave nothing to reject, so the guard would pass vacuously.
  // Schemes without a host (data:, file:) reach here the same way.
  if (addresses.length === 0) throw new Error(`${url.hostname || url.protocol} did not resolve to any address`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`refusing to fetch private/internal address for ${url.hostname} (${address})`)
  }
  return pinnedLookup(addresses)
}

const MAX_REDIRECTS = 5

/** Read a response body up to MAX_RAW_CHARS, then stop the download. Bounds memory and parsing cost. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return (await response.text()).slice(0, MAX_RAW_CHARS)
  const decoder = new TextDecoder()
  let text = ''
  while (text.length < MAX_RAW_CHARS) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) text += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text.slice(0, MAX_RAW_CHARS)
}

async function fetchText(rawUrl: string, transport = httpFetch): Promise<{ text: string; contentType: string }> {
  let url = new URL(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Resolve, validate and pin per hop: a redirect target gets the same guarantee.
    const lookup = await resolveAndPin(url)
    const response = await transport(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      lookup,
      userAgent: USER_AGENT,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`redirect without location from ${url.hostname}`)
      url = new URL(location, url)
      // Only the caller's URL was scheme-checked; a redirect could hand back data: or
      // file:, which carry no host for the address guard to inspect.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported redirect scheme ${url.protocol} from ${rawUrl}`)
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return { text: await readCapped(response), contentType: response.headers.get('content-type') ?? '' }
  }
  throw new Error(`too many redirects for ${rawUrl}`)
}

export default function webExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_search',
    label: 'Web search',
    description: 'Search the web (DuckDuckGo). Returns titles, URLs, and snippets. Use web_fetch to read a result in full.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      count: Type.Optional(Type.Number({ description: 'Max results (default 5)' })),
    }),
    async execute(_id, params) {
      const { text } = await fetchText(SEARCH_ENDPOINT + encodeURIComponent(params.query))
      const results = parseSearchResults(text, Math.min(params.count ?? 5, 10))
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No results found.' }], details: {} }
      }
      const formatted = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')
      return { content: [{ type: 'text' as const, text: formatted }], details: {} }
    },
  })

  pi.registerTool({
    name: 'web_fetch',
    label: 'Web fetch',
    description: 'Fetch a URL and return its content as readable text (HTML is stripped).',
    parameters: Type.Object({ url: Type.String({ description: 'Absolute http(s) URL to fetch' }) }),
    async execute(_id, params) {
      if (!/^https?:\/\//.test(params.url)) {
        return { content: [{ type: 'text' as const, text: 'Only http(s) URLs are supported.' }], details: {} }
      }
      const { text, contentType } = await fetchText(params.url)
      const body = contentType.includes('html') ? htmlToText(text) : text.slice(0, MAX_FETCH_CHARS)
      return { content: [{ type: 'text' as const, text: body || '(empty response)' }], details: {} }
    },
  })
}
