/**
 * Web Extension
 *
 * Key-free web access: web_search scrapes the DuckDuckGo HTML endpoint (no
 * API key, no account) and web_fetch retrieves a URL as readable text.
 * Honors the local-only setup: no cloud accounts, plain HTTPS to public web.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q='
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) pi-code-web/0.1'
const MAX_FETCH_CHARS = 30_000
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
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Resolve DuckDuckGo's redirect links (/l/?uddg=<encoded>) to the target URL. */
export function resolveResultUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/)
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
  const text = decodeEntities(withoutBlocks.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
  return text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n[truncated ${text.length - MAX_FETCH_CHARS} chars]` : text
}

async function fetchText(url: string): Promise<{ text: string; contentType: string }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return { text: await response.text(), contentType: response.headers.get('content-type') ?? '' }
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
