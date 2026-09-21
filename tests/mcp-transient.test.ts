import { createServer } from 'node:net'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

import { isConnectionLost, isTransientConnectError } from '../extensions/mcp/transport.ts'

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

describe('isConnectionLost', () => {
  const refused = async (): Promise<unknown> => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as { port: number }
        probe.close(() => resolve(address.port))
      })
    })
    return await fetch(`http://127.0.0.1:${port}/mcp`).then(
      () => undefined,
      (error: unknown) => error,
    )
  }

  it('recognises the errors a call gets from a server that went away, as the SDK and node throw them', async () => {
    const lost: Array<[string, unknown]> = [
      ['a refused connection', await refused()],
      ['a reset connection', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })],
      ['the 404 for a forgotten session (Streamable HTTP)', new StreamableHTTPError(404, 'Error POSTing to endpoint: Session not found')],
      ['the 404 for a forgotten session (SSE)', new Error('Error POSTing to endpoint (HTTP 404): Not Found')],
      ['a connection the SDK closed under the call', McpError.fromError(ErrorCode.ConnectionClosed, 'Connection closed')],
      ['a client whose transport is gone', new Error('Not connected')],
    ]
    for (const [label, error] of lost) expect([label, isConnectionLost(error)]).toEqual([label, true])
  })

  it('leaves alone a failure that says nothing about the connection', () => {
    const kept: Array<[string, unknown]> = [
      ['a plain tool failure', new Error('boom')],
      ['a tool timeout', new Error('remote: go timed out after 60000ms')],
      ['a tool that returned a 5xx', Object.assign(new Error('server error'), { code: 503 })],
      ['bad input', new McpError(ErrorCode.InvalidParams, 'missing "path"')],
      ['a server error that reuses -32000', new McpError(ErrorCode.ConnectionClosed, 'Bad Request: Server not initialized')],
      ['an auth failure, which has its own recovery', Object.assign(new Error('expired'), { code: 401 })],
      ['a value that is not an error', undefined],
    ]
    for (const [label, error] of kept) expect([label, isConnectionLost(error)]).toEqual([label, false])
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

describe('runHeadersHelper failure reporting', () => {
  // A helper is how a server gets its Authorization when there is no OAuth. Silence here
  // means the connect proceeds unauthenticated and the server answers 401, which the user
  // then sees as a login problem rather than a broken helper.
  const nodeShell = () => ({ kind: 'bash' as const, file: process.execPath, argsFor: (command: string) => ['-e', command] })

  it('reports a helper that exits non-zero', async () => {
    const { runHeadersHelper } = await import('../extensions/mcp/transport.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const headers = await runHeadersHelper('process.exit(3)', { CLAUDE_CODE_MCP_SERVER_NAME: 'vault' }, nodeShell)

      expect(headers).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('vault'))
    } finally {
      warn.mockRestore()
    }
  })

  it('reports a helper whose output is not usable as headers', async () => {
    const { runHeadersHelper } = await import('../extensions/mcp/transport.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const headers = await runHeadersHelper('process.stdout.write("not json")', { CLAUDE_CODE_MCP_SERVER_NAME: 'vault' }, nodeShell)

      expect(headers).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('vault'))
    } finally {
      warn.mockRestore()
    }
  })
})
