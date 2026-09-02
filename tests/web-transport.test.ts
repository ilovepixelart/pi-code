import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { httpFetch } from '../extensions/internal/web-transport.ts'

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
    // A bind-then-closed port is guaranteed refusing on any machine, unlike a
    // fixed port that a local server could be listening on. The specific code
    // proves the pin carried the socket to the address (a DNS failure or URL
    // error would reject with a different code and mean the pin was bypassed).
    const server = createHttpServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const deadPort = (server.address() as AddressInfo).port
    await new Promise<void>((r) => server.close(() => r()))

    await expect(httpFetch(new URL(`http://blocked.internal.test:${deadPort}/`), { signal: signal(), lookup: pinTo('127.0.0.1'), userAgent: 'pin-test/1' })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it.each([204, 205, 304])('returns a bodyless response for null-body status %i without crashing', async (status) => {
    // The WHATWG Response constructor throws for a non-null body on these statuses; the
    // throw fires in the http callback, off the executor, so it would escape as an
    // uncaughtException and pi's handler would exit the process.
    const server = createHttpServer((_req, res) => {
      res.writeHead(status)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    closers.push(() => server.close())
    const port = (server.address() as AddressInfo).port

    const response = await httpFetch(new URL(`http://blocked.internal.test:${port}/`), { signal: signal(), lookup: pinTo('127.0.0.1'), userAgent: 'pin-test/1' })
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('')
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
