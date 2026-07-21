import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { httpFetch } from '../extensions/web-transport.ts'

/** A lookup pinned to one address, exercising both the {all:true} and single-result shapes. */
const pinTo = (ip: string): LookupFunction =>
  ((_hostname: string, options: unknown, callback: (err: Error | null, address: unknown, family?: number) => void) => {
    const cb = (typeof options === 'function' ? options : callback) as (e: Error | null, a: unknown, f?: number) => void
    if (typeof options !== 'function' && (options as { all?: boolean }).all) return cb(null, [{ address: ip, family: 4 }])
    cb(null, ip, 4)
  }) as unknown as LookupFunction

const signal = () => AbortSignal.timeout(5000)

const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

describe('httpFetch pins the connection to the validated address', () => {
  it('connects to the pinned ip while sending the real host header', async () => {
    let seenHost: string | undefined
    let seenAgent: string | undefined
    const server = createHttpServer((req, res) => {
      seenHost = req.headers.host
      seenAgent = req.headers['user-agent']
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('reached')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closers.push(() => server.close())
    const port = (server.address() as AddressInfo).port

    // The hostname never resolves in DNS; only the pinned lookup makes this reachable.
    const response = await httpFetch(new URL(`http://blocked.internal.test:${port}/`), { signal: signal(), lookup: pinTo('127.0.0.1'), userAgent: 'pin-test/1' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('reached')
    expect(seenHost).toBe(`blocked.internal.test:${port}`)
    expect(seenAgent).toBe('pin-test/1')
  })

  it('surfaces a connection error when the pinned address refuses', async () => {
    // 127.0.0.1:1 is not listening; the pin sends the socket there and it fails.
    await expect(httpFetch(new URL('http://blocked.internal.test/'), { signal: signal(), lookup: pinTo('127.0.0.1'), userAgent: 'pin-test/1' })).rejects.toThrow()
  })

  it('joins a repeated response header into one value', async () => {
    const server = createHttpServer((_req, res) => {
      res.setHeader('set-cookie', ['a=1', 'b=2']) // node keeps repeated headers as an array
      res.end('ok')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closers.push(() => server.close())
    const port = (server.address() as AddressInfo).port

    const response = await httpFetch(new URL(`http://blocked.internal.test:${port}/`), { signal: signal(), lookup: pinTo('127.0.0.1'), userAgent: 'pin-test/1' })
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2')
  })
})
