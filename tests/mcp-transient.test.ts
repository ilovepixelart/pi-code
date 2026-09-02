import { createServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import { isTransientConnectError } from '../extensions/mcp/transport.ts'

describe('isTransientConnectError', () => {
  it('classifies a refused connection as transient, however node wraps it', async () => {
    // Claude retries a first connection that fails with "a 5xx response, a connection
    // refused, or a timeout". Node reports a refused connection as `TypeError: fetch
    // failed` and puts the code on error.cause, so reading the message alone missed the
    // very case the docs name.
    // A port that is closed right now: bind one, learn its number, release it. A fixed
    // low port would hit undici's blocked-port list and fail for another reason entirely.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as { port: number }
        probe.close(() => resolve(address.port))
      })
    })
    const refused = await fetch(`http://127.0.0.1:${port}/mcp`).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(String(refused)).not.toContain('ECONNREFUSED') // the message really is opaque
    expect(isTransientConnectError(refused)).toBe(true)
  })

  it('leaves a configuration error alone', () => {
    expect(isTransientConnectError(new Error('Not Found'))).toBe(false)
    expect(isTransientConnectError(Object.assign(new Error('server error'), { code: 503 }))).toBe(true)
  })
})

describe('runHeadersHelper', () => {
  // Both outcomes on every platform: the resolver is injected, so the shell-less case
  // does not depend on the host lacking Git Bash and PowerShell.
  it('runs the helper through the resolved shell and parses its JSON', async () => {
    const { runHeadersHelper } = await import('../extensions/mcp/transport.ts')
    const sh = () => ({ kind: 'bash' as const, file: process.execPath, argsFor: (command: string) => ['-e', command] })

    const headers = await runHeadersHelper('process.stdout.write(JSON.stringify({ "X-From": "helper" }))', process.env, sh)

    expect(headers).toEqual({ 'X-From': 'helper' })
  })

  it('yields no headers when the machine has no shell to run it with', async () => {
    const { runHeadersHelper } = await import('../extensions/mcp/transport.ts')

    const headers = await runHeadersHelper('process.stdout.write(JSON.stringify({ "X-From": "helper" }))', process.env, () => undefined)

    // The server still connects, with whatever static headers it was configured with.
    expect(headers).toEqual({})
  })
})
