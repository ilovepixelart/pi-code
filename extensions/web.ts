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

import { htmlToMarkdown } from './internal/html-markdown.js'
import { completeText } from './internal/model-complete.js'
import { capForContext } from './internal/output-guard.js'
import { httpFetch } from './internal/web-transport.js'

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

/** Keep results whose host matches an allowed domain (or is not blocked). A domain
 * matches the host itself or any subdomain of it, as Claude's domain scoping does. */
export function filterByDomain(results: SearchResult[], allowed: string[] | undefined, blocked: string[] | undefined): SearchResult[] {
  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
  const matches = (host: string, domain: string): boolean => {
    const d = domain.toLowerCase().replace(/^\.+/, '')
    return host === d || host.endsWith(`.${d}`)
  }
  let out = results
  if (allowed && allowed.length > 0) out = out.filter((r) => allowed.some((d) => matches(hostOf(r.url), d)))
  else if (blocked && blocked.length > 0) out = out.filter((r) => !blocked.some((d) => matches(hostOf(r.url), d)))
  return out
}

export function parseSearchResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const anchorPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
  const anchors = [...html.matchAll(anchorPattern)]
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const match = anchors[i]
    const url = resolveResultUrl(match[1])
    const title = stripTags(match[2])
    if (!title || url.includes('duckduckgo.com/y.js')) continue
    // A result's snippet sits between its anchor and the next one; pairing by block
    // keeps attribution right when an ad anchor (skipped above) carries a snippet too.
    const block = html.slice((match.index ?? 0) + match[0].length, anchors[i + 1]?.index ?? html.length)
    const snippet = snippetPattern.exec(block)
    results.push({ title, url, snippet: snippet ? stripTags(snippet[1]) : '' })
  }
  return results
}

/** Cap a converted body at the fetch budget, naming what was dropped. */
function capFetchChars(text: string): string {
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
  // Flush: bytes of a character cut off by the end of the stream become U+FFFD
  // instead of vanishing silently.
  text += decoder.decode()
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
      // The hop's body is never read; without the cancel its socket stays held
      // until the 20s abort timeout, once per hop.
      void response.body?.cancel().catch(() => {})
      const location = response.headers.get('location')
      if (!location) throw new Error(`redirect without location from ${url.hostname}`)
      url = new URL(location, url)
      // Only the caller's URL was scheme-checked; a redirect could hand back data: or
      // file:, which carry no host for the address guard to inspect.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported redirect scheme ${url.protocol} from ${rawUrl}`)
      continue
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return { text: await readCapped(response), contentType: response.headers.get('content-type') ?? '' }
  }
  throw new Error(`too many redirects for ${rawUrl}`)
}

/** Claude documents a 15-minute per-URL cache for WebFetch. */
const FETCH_CACHE_TTL_MS = 15 * 60 * 1000
const FETCH_CACHE_MAX_ENTRIES = 50

export default function webExtension(pi: ExtensionAPI) {
  const fetchCache = new Map<string, { expires: number; body: string }>()
  pi.registerTool({
    name: 'web_search',
    label: 'Web search',
    description: 'Search the web (DuckDuckGo). Returns titles, URLs, and snippets. Use web_fetch to read a result in full.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      count: Type.Optional(Type.Number({ description: 'Max results (default 5)' })),
      allowed_domains: Type.Optional(Type.Array(Type.String(), { description: 'Only include results from these domains' })),
      blocked_domains: Type.Optional(Type.Array(Type.String(), { description: 'Exclude results from these domains' })),
    }),
    async execute(_id, params) {
      // Claude documents allowed/blocked domains as mutually exclusive; allowed wins.
      const { text } = await fetchText(SEARCH_ENDPOINT + encodeURIComponent(params.query))
      const limit = Math.min(params.count ?? 5, 10)
      const results = filterByDomain(parseSearchResults(text, 10), params.allowed_domains, params.blocked_domains).slice(0, limit)
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
    description: 'Fetch a URL and return its content converted to markdown. Pass `prompt` to get a focused answer extracted from the page instead of the raw content. Responses are cached for 15 minutes per URL.',
    parameters: Type.Object({
      url: Type.String({ description: 'Absolute http(s) URL to fetch' }),
      prompt: Type.Optional(Type.String({ description: 'What to extract or answer from the page; returns the model’s answer instead of the raw markdown' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!/^https?:\/\//.test(params.url)) {
        return { content: [{ type: 'text' as const, text: 'Only http(s) URLs are supported.' }], details: {} }
      }
      const now = Date.now()
      // The cache holds the raw markdown, so a second fetch with a different prompt
      // still reuses it: retrieval and the optional prompt step are separate.
      const cached = fetchCache.get(params.url)
      let body: string
      if (cached && cached.expires > now) {
        body = cached.body
      } else {
        const { text, contentType } = await fetchText(params.url)
        body = capFetchChars(contentType.includes('html') ? htmlToMarkdown(text) : text)
        // Only a delivered body is cached; a thrown fetch must retry next call.
        // Drop expired entries first, then evict the oldest live one if still full;
        // deleting before set keeps Map insertion order a true recency order, so a
        // refreshed URL moves to the newest slot instead of keeping its stale one.
        fetchCache.delete(params.url)
        for (const [url, entry] of fetchCache) {
          if (entry.expires <= now) fetchCache.delete(url)
        }
        if (fetchCache.size >= FETCH_CACHE_MAX_ENTRIES) {
          const oldest = fetchCache.keys().next().value
          if (oldest !== undefined) fetchCache.delete(oldest)
        }
        fetchCache.set(params.url, { expires: now + FETCH_CACHE_TTL_MS, body })
      }

      // Claude's WebFetch runs the prompt over the page with a fast model and returns
      // that answer, not the raw page. Best-effort: any failure (no model, provider
      // error) falls back to the markdown, so web_fetch always returns something.
      if (params.prompt && ctx?.model) {
        try {
          const answer = await completeText(ctx.model, `${params.prompt}\n\nAnswer using only the page content below, fetched from ${params.url}:\n\n${body}`, {
            system: 'You extract and answer questions from a web page. Answer only from the provided content, concisely. If the content does not contain the answer, say so.',
            maxTokens: 1024,
            signal,
          })
          if (answer) return { content: [{ type: 'text' as const, text: answer }], details: {} }
        } catch {
          // fall through to the raw markdown
        }
      }
      // The char cap alone admits thousands of short lines; pi's tool-output budget
      // bounds lines too, which the shared guard enforces.
      return { content: [{ type: 'text' as const, text: capForContext(body) || '(empty response)' }], details: {} }
    },
  })
}
