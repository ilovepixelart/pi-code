import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileOAuthProvider, startCallbackServer, waitForAuthCode } from '../extensions/internal/mcp-oauth.ts'

let savedAgentDir: string | undefined
beforeEach(() => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'oauth-agent-'))
})
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
})

describe('FileOAuthProvider', () => {
  it('persists client information, tokens and the code verifier across instances', async () => {
    const first = new FileOAuthProvider('linear', () => {})
    await first.saveClientInformation({ client_id: 'cid-1' })
    await first.saveTokens({ access_token: 'at-1', token_type: 'bearer', refresh_token: 'rt-1' })
    await first.saveCodeVerifier('ver-1')

    const second = new FileOAuthProvider('linear', () => {})
    expect(second.clientInformation()).toEqual({ client_id: 'cid-1' })
    expect(second.tokens()).toEqual({ access_token: 'at-1', token_type: 'bearer', refresh_token: 'rt-1' })
    expect(await second.codeVerifier()).toBe('ver-1')
  })

  it('keeps the token store private and slugs hostile server names into the store dir', async () => {
    const provider = new FileOAuthProvider('../../etc/passwd', () => {})
    await provider.saveTokens({ access_token: 'x', token_type: 'bearer' })

    const storeDir = join(process.env.PI_CODING_AGENT_DIR as string, 'mcp-oauth')
    expect(statSync(storeDir).isDirectory()).toBe(true)
    // The store file must live inside the store dir, not where the traversal pointed.
    const entries = readdirSync(storeDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toContain('..')
    const mode = statSync(join(storeDir, entries[0])).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('describes itself as a public PKCE client with the bound port as redirect uri', () => {
    const provider = new FileOAuthProvider('linear', () => {})
    provider.bindRedirectPort(4242)
    expect(provider.redirectUrl).toBe('http://127.0.0.1:4242/callback')
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:4242/callback'])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('persists the redirect port so a re-login can reuse it', () => {
    const first = new FileOAuthProvider('linear', () => {})
    expect(first.savedRedirectPort()).toBeUndefined()
    first.bindRedirectPort(51000)
    expect(new FileOAuthProvider('linear', () => {}).savedRedirectPort()).toBe(51000)
  })

  it('reports whether a server has stored tokens', async () => {
    const provider = new FileOAuthProvider('github', () => {})
    expect(provider.hasTokens()).toBe(false)
    await provider.saveTokens({ access_token: 'x', token_type: 'bearer' })
    expect(new FileOAuthProvider('github', () => {}).hasTokens()).toBe(true)
  })

  it('generates a distinct, stable CSRF state per login attempt', () => {
    const a = new FileOAuthProvider('srv-a', () => {})
    const b = new FileOAuthProvider('srv-b', () => {})
    expect(a.state()).toMatch(/^[0-9a-f]{32}$/)
    expect(a.state()).toBe(a.state()) // stable within a single login
    expect(a.state()).not.toBe(b.state()) // a fresh token per attempt
  })
})

describe('callback server', () => {
  it('resolves the authorization code from the redirect and answers the browser', async () => {
    const { server, port } = await startCallbackServer()
    const pending = waitForAuthCode(server, 5000)
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=auth-123&state=xyz`)

    expect(response.status).toBe(200)
    expect(await pending).toBe('auth-123')
    server.close()
  })

  it('rejects when the provider returns an error instead of a code', async () => {
    const { server, port } = await startCallbackServer()
    const pending = waitForAuthCode(server, 5000)
    // Attach the rejection expectation before triggering the redirect, so the
    // rejection is never momentarily unhandled while the fetch is in flight.
    const assertion = expect(pending).rejects.toThrow(/access_denied/)
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=nope`)
    await assertion
    server.close()
  })

  it('rejects on timeout so a stalled login cannot hang the session forever', async () => {
    const { server } = await startCallbackServer()
    await expect(waitForAuthCode(server, 50)).rejects.toThrow(/timed out/i)
    server.close()
  })

  it('prefers a given port and falls back to ephemeral when it is taken', async () => {
    const first = await startCallbackServer()
    // Re-requesting the same port must not throw: it is already bound.
    const second = await startCallbackServer(first.port)
    expect(second.port).not.toBe(first.port)
    first.server.close()
    second.server.close()
  })

  it('ignores a request to a non-callback path so a stray hit cannot settle the login', async () => {
    const { server, port } = await startCallbackServer()
    const pending = waitForAuthCode(server, 5000, 'st8')
    const stray = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
    expect(stray.status).toBe(404)
    // The stray did not settle the promise: the genuine redirect still resolves it.
    await fetch(`http://127.0.0.1:${port}/callback?code=real&state=st8`)
    expect(await pending).toBe('real')
    server.close()
  })

  it('ignores a callback whose state does not match, then accepts the genuine one', async () => {
    const { server, port } = await startCallbackServer()
    const pending = waitForAuthCode(server, 5000, 'expected-state')
    // A forged redirect from another local process cannot inject its code or abort the login.
    const forged = await fetch(`http://127.0.0.1:${port}/callback?code=attacker&state=wrong`)
    expect(forged.status).toBe(400)
    await fetch(`http://127.0.0.1:${port}/callback?code=genuine&state=expected-state`)
    expect(await pending).toBe('genuine')
    server.close()
  })
})
