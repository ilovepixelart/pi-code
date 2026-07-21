/**
 * Web transport
 *
 * A single HTTP(S) request pinned to a caller-supplied DNS resolution. Global `fetch`
 * resolves the hostname itself, independently of any prior guard, so a validate-then-fetch
 * SSRF check has a time-of-check/time-of-use gap: a zero-TTL record can answer public to
 * the guard and private to fetch's own lookup. `node:http`/`node:https` accept a `lookup`
 * option, which is the seam that closes the gap: the socket connects to exactly the address
 * the guard validated, while `servername` (SNI, certificate validation) and the `Host`
 * header stay the real hostname, so virtual hosts and TLS still work.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

export interface TransportOptions {
  signal: AbortSignal
  lookup: LookupFunction
  userAgent: string
}

/** One request, no redirect following (the caller re-validates and re-pins per hop). */
export function httpFetch(url: URL, opts: TransportOptions): Promise<Response> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': opts.userAgent },
        signal: opts.signal,
        lookup: opts.lookup,
        // servername is left to default to url.hostname, so SNI and certificate
        // validation use the real host even though the socket connects to the pinned IP.
      },
      (res) => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>
        resolve(new Response(body, { status: res.statusCode ?? 0, headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}
