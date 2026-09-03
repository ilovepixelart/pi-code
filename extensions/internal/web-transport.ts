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

/** Statuses the WHATWG Response constructor forbids a body on (per the fetch spec). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/** One request, no redirect following (the caller re-validates and re-pins per hop). */
export function httpFetch(url: URL, opts: TransportOptions): Promise<Response> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        // Prefer markdown, as Claude's WebFetch does, so a content-negotiating
        // server can return markdown directly and skip the lossy HTML conversion.
        headers: { 'User-Agent': opts.userAgent, Accept: 'text/markdown, text/html;q=0.9, */*;q=0.8' },
        signal: opts.signal,
        lookup: opts.lookup,
        // servername is left to default to url.hostname, so SNI and certificate
        // validation use the real host even though the socket connects to the pinned IP.
      },
      (res) => {
        try {
          const headers = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers.set(key, value)
            else if (Array.isArray(value)) headers.set(key, value.join(', '))
          }
          const status = res.statusCode ?? 0
          // The Response constructor throws for a non-null body on a null-body status
          // (204/205/304) and for status 0. That throw fires here, off the Promise
          // executor, so without this guard it escapes as an uncaughtException and pi
          // exits. Give those statuses a null body; reject anything else that throws.
          //
          // The catch below has no test and cannot get one through this function: the
          // only two throw sources are the null-body statuses, which the line under this
          // comment handles, and a status outside 200-599, which never reaches this
          // callback at all (node routes 1xx to the `information` event and rejects a
          // malformed status line in the parser). It stays as depth, not dead code, but
          // do not chase its coverage with a test that reaches it some other way.
          const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
          resolve(new Response(body, { status, headers }))
        } catch (err) {
          res.resume() // drain so the socket can close
          reject(err)
        }
      },
    )
    req.on('error', reject)
    req.end()
  })
}
