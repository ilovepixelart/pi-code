import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Record spawn so openBrowser's per-platform launch can be asserted without opening a browser.
// importOriginal keeps the rest of child_process intact for any other consumer in the graph.
const spawnMock = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[] }>, throwOnCall: false, emitErrorOnCall: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnMock.calls.push({ command, args })
      if (spawnMock.throwOnCall) throw new Error('spawn failed')
      const child = Object.assign(new EventEmitter(), { unref: () => {} })
      // A launcher that is missing reports it here, one tick after spawn returns.
      if (spawnMock.emitErrorOnCall) setTimeout(() => child.emit('error', new Error('spawn xdg-open ENOENT')), 0)
      return child
    },
  }
})

const { FileOAuthProvider, openBrowser, startCallbackServer, waitForAuthCode } = await import('../extensions/internal/mcp-oauth.ts')

let savedAgentDir: string | undefined
beforeEach(async () => {
  // Module state: without this a pending login from one test would queue the next.
  const { resetOAuthQueue } = await import('../extensions/mcp/oauth-flow.ts')
  resetOAuthQueue()
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
    // POSIX-only: Windows has no 0o600 file mode; stat reports a synthetic 0o666 there.
    if (process.platform !== 'win32') {
      const mode = statSync(join(storeDir, entries[0])).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('describes itself as a public PKCE client with the bound port as redirect uri', () => {
    const provider = new FileOAuthProvider('linear', () => {})
    provider.bindRedirectPort(4242)
    // Claude sends the localhost form: it sent 127.0.0.1 for one version and "servers
    // that exact-match the registered redirect URI rejected the sign-in with a redirect
    // URI mismatch", which is exactly the case oauth.callbackPort exists for.
    expect(provider.redirectUrl).toBe('http://localhost:4242/callback')
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://localhost:4242/callback'])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('answers a malformed request target with 400 instead of throwing out of the listener', async () => {
    // Node's parser passes an absolute-form target through unvalidated; `new URL` on
    // one with an out-of-range port throws, and a throw from a 'request' listener is
    // not caught by node:http: it was an uncaughtException during the login window.
    const { server, port } = await startCallbackServer()
    const code = waitForAuthCode(server, 2000)
    code.catch(() => {})
    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET http://x:99999/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      })
      let raw = ''
      socket.on('data', (chunk) => {
        raw += chunk.toString()
      })
      socket.on('end', () => resolve(raw.split('\r\n')[0] ?? ''))
      socket.on('error', reject)
    })
    server.close()

    expect(status).toContain(' 400 ')
  })

  it('answers the callback on both loopback families, since localhost may resolve to either', async () => {
    // The redirect URL names localhost. On a host with IPv6 the browser may reach ::1
    // while the listener sat on 127.0.0.1 alone, and the login would hang on a connection
    // refused with the code already granted.
    // Probe first: on a host that can bind ::1 the answer must be 200, since "refused"
    // there is exactly the hang the second listener exists to prevent. Accepting
    // refused unconditionally let the listener be deleted without a test noticing.
    const canBindIpv6 = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(0, '::1', () => probe.close(() => resolve(true)))
    })
    const { server, port } = await startCallbackServer()
    const code = waitForAuthCode(server, 2000)
    const viaIpv6 = await fetch(`http://[::1]:${port}/callback?code=v6-code`).then(
      (response) => response.status,
      () => 'refused',
    )
    server.close()

    if (!canBindIpv6) return
    expect(viaIpv6).toBe(200)
    expect(await code).toBe('v6-code')
  })

  it('falls back to MCP_OAUTH_CALLBACK_PORT when no per-server oauth.callbackPort is set', () => {
    // Claude: "Fixed port for the OAuth redirect callback, as an alternative to
    // --callback-port when adding an MCP server with pre-configured credentials."
    // pi-code has no `mcp add` command, so the env var applies as a default for any
    // server that names no port of its own; a per-server setting still wins.
    process.env.MCP_OAUTH_CALLBACK_PORT = '9100'
    try {
      const bare = new FileOAuthProvider('linear', () => {})
      expect(bare.configuredRedirectPort()).toBe(9100)
      expect(bare.savedRedirectPort()).toBe(9100)

      const named = new FileOAuthProvider('linear', () => {}, { callbackPort: 7000 })
      expect(named.configuredRedirectPort()).toBe(7000)
    } finally {
      delete process.env.MCP_OAUTH_CALLBACK_PORT
    }
  })

  it('ignores an unparseable MCP_OAUTH_CALLBACK_PORT', () => {
    process.env.MCP_OAUTH_CALLBACK_PORT = 'not-a-port'
    try {
      expect(new FileOAuthProvider('linear', () => {}).configuredRedirectPort()).toBeUndefined()
    } finally {
      delete process.env.MCP_OAUTH_CALLBACK_PORT
    }
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

  it('keeps tokens for one endpoint out of a same-named server at another endpoint', async () => {
    // A sign-in belongs to the endpoint it was granted for. Two repositories can each
    // define a server called "notion"; the second must not inherit the first one's bearer
    // token just by reusing the name.
    const real = new FileOAuthProvider('notion', () => {}, undefined, 'https://mcp.notion.com/mcp')
    await real.saveTokens({ access_token: 'at-real', token_type: 'bearer' })

    expect(new FileOAuthProvider('notion', () => {}, undefined, 'https://evil.example/mcp').hasTokens()).toBe(false)
    // Same endpoint, a later session: the sign-in is still there (no forced re-login).
    expect(new FileOAuthProvider('notion', () => {}, undefined, 'https://mcp.notion.com/other').tokens()).toEqual({ access_token: 'at-real', token_type: 'bearer' })
  })

  it('generates a distinct, stable CSRF state per login attempt', () => {
    const a = new FileOAuthProvider('srv-a', () => {})
    const b = new FileOAuthProvider('srv-b', () => {})
    expect(a.state()).toMatch(/^[0-9a-f]{32}$/)
    expect(a.state()).toBe(a.state()) // stable within a single login
    expect(a.state()).not.toBe(b.state()) // a fresh token per attempt
  })

  it('serves pre-configured oauth credentials from the config instead of dynamic registration', () => {
    // Claude's oauth object: clientId names a pre-registered client, and the client
    // secret comes from the MCP_CLIENT_SECRET environment variable.
    const saved = process.env.MCP_CLIENT_SECRET
    process.env.MCP_CLIENT_SECRET = 'shh'
    try {
      const provider = new FileOAuthProvider('pre', () => {}, { clientId: 'cid-9' })
      expect(provider.clientInformation()).toEqual({ client_id: 'cid-9', client_secret: 'shh' })
    } finally {
      if (saved === undefined) delete process.env.MCP_CLIENT_SECRET
      else process.env.MCP_CLIENT_SECRET = saved
    }
  })

  it('serves a public pre-configured client when no MCP_CLIENT_SECRET is set', () => {
    delete process.env.MCP_CLIENT_SECRET
    const provider = new FileOAuthProvider('pre', () => {}, { clientId: 'cid-9' })
    expect(provider.clientInformation()).toEqual({ client_id: 'cid-9' })
  })

  it('pins the requested scopes from oauth.scopes in the client metadata', () => {
    const provider = new FileOAuthProvider('scoped', () => {}, { scopes: 'channels:read chat:write' })
    expect(provider.clientMetadata.scope).toBe('channels:read chat:write')
  })

  it('prefers the configured callbackPort over a previously bound port', () => {
    const provider = new FileOAuthProvider('ported', () => {}, { callbackPort: 8123 })
    expect(provider.savedRedirectPort()).toBe(8123)
  })

  it('fails closed when the code verifier is read before one is saved', () => {
    // The SDK asks for the PKCE verifier during the token exchange; a fresh provider has
    // none, so it must throw rather than hand back an empty proof.
    const provider = new FileOAuthProvider('no-verifier', () => {})
    expect(() => provider.codeVerifier()).toThrow(/no code verifier saved/)
  })
})

describe('FileOAuthProvider.invalidateCredentials', () => {
  // The SDK calls this when the server rejects what is stored (`invalid_grant` for an expired
  // or revoked refresh token, `invalid_client` for a forgotten registration) and only then
  // restarts authorization. Without it the rejection propagated and the dead credentials
  // stayed on disk, so the server failed the same way on every connect.
  const hasVerifier = (provider: InstanceType<typeof FileOAuthProvider>): boolean => {
    try {
      provider.codeVerifier()
      return true
    } catch {
      return false
    }
  }

  const seeded = async (): Promise<InstanceType<typeof FileOAuthProvider>> => {
    const provider = new FileOAuthProvider('linear', () => {})
    await provider.saveClientInformation({ client_id: 'cid-1' })
    await provider.saveTokens({ access_token: 'at-1', token_type: 'bearer', refresh_token: 'rt-1' })
    await provider.saveCodeVerifier('ver-1')
    provider.bindRedirectPort(45678)
    return provider
  }

  it.each([
    ['tokens', { client: true, tokens: false, verifier: true }],
    ['client', { client: false, tokens: true, verifier: true }],
    ['verifier', { client: true, tokens: true, verifier: false }],
    ['all', { client: false, tokens: false, verifier: false }],
  ] as const)('drops %s and keeps the rest, on disk too', async (scope, kept) => {
    const provider = await seeded()

    await provider.invalidateCredentials(scope)

    const reloaded = new FileOAuthProvider('linear', () => {})
    expect(reloaded.clientInformation() !== undefined).toBe(kept.client)
    expect(reloaded.tokens() !== undefined).toBe(kept.tokens)
    expect(hasVerifier(reloaded)).toBe(kept.verifier)
    // A re-login must still bind the port the client was registered with.
    expect(reloaded.savedRedirectPort()).toBe(45678)
  })

  it('has nothing to drop for discovery state, which is not stored', async () => {
    const provider = await seeded()

    await provider.invalidateCredentials('discovery')

    expect(new FileOAuthProvider('linear', () => {}).tokens()).toBeDefined()
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

describe('openBrowser', () => {
  const realPlatform = process.platform
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => {
    setPlatform(realPlatform)
    spawnMock.calls.length = 0
    spawnMock.throwOnCall = false
    spawnMock.emitErrorOnCall = false
  })

  it('selects the launch command and args per platform', () => {
    // Several bare ampersands, as every real authorization URL has. On Windows no shell may
    // see them: cmd splits `start "" <url>` at each one, so the browser got a truncated URL
    // (the IdP then reports a missing client_id) and every segment after the first ran as
    // a command, the tail of a URL a server chose.
    const url = 'https://auth.example/authorize?response_type=code&client_id=abc&code_challenge=xyz'
    const cases: Array<[NodeJS.Platform, string, string[]]> = [
      ['darwin', 'open', [url]],
      ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
      ['linux', 'xdg-open', [url]],
    ]
    for (const [platform, command, args] of cases) {
      spawnMock.calls.length = 0
      setPlatform(platform)
      openBrowser(url)
      expect(spawnMock.calls).toEqual([{ command, args }])
    }
  })

  it('opens only web pages, whatever authorization URL the server names', () => {
    // authorization_endpoint comes from the server's metadata, and the SDK rejects only
    // javascript:, data: and vbscript:. A file: URL or a custom protocol handler handed to
    // the platform launcher opens a local file or launches an application.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      setPlatform(platform)
      for (const url of ['file:///C:/Windows/System32/calc.exe', 'file:///Applications/Calculator.app', 'ms-msdt:/id PCWDiagnostic', 'calc:', 'ftp://auth.example/x', 'not a url', '']) {
        spawnMock.calls.length = 0
        openBrowser(url)
        expect(spawnMock.calls, `${platform} ${url}`).toEqual([])
      }
      for (const url of ['https://auth.example/authorize', 'HTTPS://auth.example/authorize', 'http://localhost:8080/authorize']) {
        spawnMock.calls.length = 0
        openBrowser(url)
        expect(spawnMock.calls, `${platform} ${url}`).toHaveLength(1)
      }
    }
  })

  it('keeps a launcher that fails after spawn from taking the process down', async () => {
    // A child that cannot start, as in a container with no xdg-open, reports it
    // asynchronously through an 'error' event. With no listener node raises that as an
    // uncaughtException, and pi exits from what is only a best-effort browser launch.
    setPlatform('linux')
    spawnMock.emitErrorOnCall = true
    const uncaught: unknown[] = []
    const capture = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', capture)
    try {
      openBrowser('https://auth.example/authorize')
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('uncaughtException', capture)
    }

    expect(uncaught).toEqual([])
  })

  it('swallows a spawn failure so the notified url stays the only fallback', () => {
    // A machine with no launcher throws on spawn; openBrowser must not surface it, since
    // the caller already printed the URL for the user to open by hand.
    setPlatform('linux')
    spawnMock.throwOnCall = true
    expect(() => openBrowser('https://auth.example/authorize')).not.toThrow()
    expect(spawnMock.calls).toHaveLength(1)
  })
})

describe('runInteractiveOAuth failure typing', () => {
  // The typed OAuthRequiredError is what keeps the typeless-url caller from
  // retrying an auth failure over SSE and stacking a second login prompt; the
  // whole failure half of the flow had zero executions.
  const flow = async (over: { approve?: boolean; connect?: (attempt: number) => Promise<void> } = {}) => {
    const { runInteractiveOAuth } = await import('../extensions/mcp/oauth-flow.ts')
    const authUi = { confirm: async () => over.approve !== false, notify: () => {} }
    let attempts = 0
    const client = {
      connect: async () => {
        attempts += 1
        await over.connect?.(attempts)
      },
      close: async () => {},
    }
    const transport = { finishAuth: async () => {} }
    return runInteractiveOAuth(
      'srv',
      { url: 'https://mcp.example/' },
      () => transport as never,
      'connect srv',
      authUi as never,
      () => client as never,
    )
  }

  it('types a declined consent as OAuthRequiredError without opening anything', async () => {
    const { OAuthRequiredError } = await import('../extensions/mcp/transport.ts')
    await expect(flow({ approve: false })).rejects.toBeInstanceOf(OAuthRequiredError)
    await expect(flow({ approve: false })).rejects.toThrow('login declined for srv')
  })

  it('wraps a non-auth flow failure as OAuthRequiredError with the detail', async () => {
    const { OAuthRequiredError } = await import('../extensions/mcp/transport.ts')
    const failing = flow({
      connect: async () => {
        throw Object.assign(new Error('boom mid-flow'), { code: 500 })
      },
    })
    await expect(failing).rejects.toBeInstanceOf(OAuthRequiredError)
    const error = await flow({
      connect: async () => {
        throw Object.assign(new Error('boom mid-flow'), { code: 500 })
      },
    }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(error?.message).toBe('login for srv failed: boom mid-flow')
  })

  it('returns the client when the retry connects clean (authorized between attempts)', async () => {
    let attempts = 0
    const connected = await flow({
      connect: async (attempt) => {
        attempts = attempt
      },
    })

    // The flow hands back the client it connected, not a wrapper, and connects exactly
    // once after the authorization: a second connect would be a second login prompt.
    expect(typeof (connected as { close: unknown }).close).toBe('function')
    expect(attempts).toBe(1)
  })
})

describe('headless OAuth refusal', () => {
  it('reports a typed run-pi-interactively error for a 401 server with no UI', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const { connect, OAuthRequiredError } = await import('../extensions/mcp/transport.ts')
      const failing = connect('locked', { type: 'http', url: `http://127.0.0.1:${port}/` } as never)
      await expect(failing).rejects.toBeInstanceOf(OAuthRequiredError)
      await expect(connect('locked', { type: 'http', url: `http://127.0.0.1:${port}/` } as never)).rejects.toThrow('run pi interactively')
    } finally {
      server.close()
    }
  })
})

describe('credentials the server no longer accepts', () => {
  /** A protected MCP endpoint whose token endpoint rejects every refresh with `error`:
   * `invalid_grant` for an expired or revoked refresh token, `invalid_client` for a
   * registration the server forgot (which the SDK answers by registering again). */
  async function idp(error = 'invalid_grant'): Promise<{ url: string; close: () => void }> {
    const { createServer } = await import('node:http')
    const server = createServer((request, response) => {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers })
        response.end(JSON.stringify(body))
      }
      request.resume()
      if (request.url?.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
      if (request.url?.startsWith('/.well-known/oauth-authorization-server')) {
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'] })
      }
      if (request.url === '/token') return json(400, { error, error_description: 'rejected' })
      if (request.url === '/register') return json(201, { client_id: 'client-2', redirect_uris: ['http://localhost:45678/callback'] })
      if (request.url === '/mcp') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
      json(404, {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
      close: () => {
        server.closeAllConnections()
        server.close()
      },
    }
  }

  it.each(['invalid_grant', 'invalid_client'])('prompts a new login on %s instead of failing the same way every connect', async (error) => {
    // The SDK reported the rejection, isUnauthorized did not recognise it, so the server
    // failed as "InvalidGrantError: ..." without ever asking to log in, and the dead
    // credentials stayed in the store to fail the next connect the same way.
    const server = await idp(error)
    try {
      const seed = new FileOAuthProvider('stale', () => {}, undefined, server.url)
      await seed.saveClientInformation({ client_id: 'client-1', redirect_uris: ['http://localhost:45678/callback'] })
      await seed.saveTokens({ access_token: 'expired-access', token_type: 'Bearer', refresh_token: 'expired-refresh', expires_in: 3600 })
      const { connect, OAuthRequiredError } = await import('../extensions/mcp/transport.ts')
      const confirm = vi.fn(async () => false)

      const outcome = await connect('stale', { type: 'http', url: server.url } as never, { confirm, notify: () => {} }).then(
        () => undefined,
        (caught: unknown) => caught,
      )

      expect(confirm).toHaveBeenCalledTimes(1)
      expect(outcome).toBeInstanceOf(OAuthRequiredError)
      expect(new FileOAuthProvider('stale', () => {}, undefined, server.url).tokens()).toBeUndefined()
    } finally {
      server.close()
    }
  })

  it('tells a headless run to log in interactively, and forgets the dead token', async () => {
    const server = await idp()
    try {
      const seed = new FileOAuthProvider('stale', () => {}, undefined, server.url)
      await seed.saveClientInformation({ client_id: 'client-1', redirect_uris: ['http://localhost:45678/callback'] })
      await seed.saveTokens({ access_token: 'expired-access', token_type: 'Bearer', refresh_token: 'expired-refresh', expires_in: 3600 })
      const { connect } = await import('../extensions/mcp/transport.ts')

      await expect(connect('stale', { type: 'http', url: server.url } as never)).rejects.toThrow('run pi interactively')
      expect(new FileOAuthProvider('stale', () => {}, undefined, server.url).tokens()).toBeUndefined()
    } finally {
      server.close()
    }
  })
})

describe('startCallbackServer port requirements', () => {
  it('falls back to an ephemeral port when a remembered port is taken', async () => {
    // A port from a prior login is a convenience: losing it only means the IdP sees a
    // different loopback port, which a dynamically registered client accepts.
    const blocker = await startCallbackServer()
    const { server, port } = await startCallbackServer(blocker.port)
    expect(port).not.toBe(blocker.port)
    server.close()
    blocker.server.close()
  })

  it('fails loudly when a CONFIGURED callbackPort is taken', async () => {
    // oauth.callbackPort names the redirect_uri the IdP has registered. Silently using
    // another port sends the user to an opaque redirect_uri mismatch at the IdP instead
    // of a message naming the real problem.
    const blocker = await startCallbackServer()
    await expect(startCallbackServer(blocker.port, true)).rejects.toThrow(`oauth.callbackPort ${blocker.port} is in use`)
    blocker.server.close()
  })
})

describe('the authorization redirect the flow hands the SDK', () => {
  // This test spawns a browser launch through the same mock the openBrowser suite
  // asserts call counts on, so it clears the recorder rather than leaving its call
  // behind for whichever test the shuffled order runs next.
  afterEach(() => {
    spawnMock.calls.length = 0
  })

  it('opens the browser and tells the user where to authorize', async () => {
    // The SDK calls redirectToAuthorization on the provider it was handed, which is how
    // the login page opens. makeTransport receives that provider, so a stand-in transport
    // drives the real callback: this is the flow's own wiring, not a re-implementation.
    // It had never executed, so neither the browser launch nor the fallback notice that
    // carries the URL when the browser does not open was covered.
    const { runInteractiveOAuth } = await import('../extensions/mcp/oauth-flow.ts')
    const authUrl = 'https://idp.example/authorize?client_id=abc'
    const notices: string[] = []
    const authUi = { confirm: async () => true, notify: (message: string) => notices.push(message) }
    const client = { connect: async () => {}, close: async () => {} }

    await runInteractiveOAuth(
      'srv',
      { url: 'https://mcp.example/' },
      ((provider: { redirectToAuthorization: (url: URL) => void }) => {
        provider.redirectToAuthorization(new URL(authUrl))
        return { finishAuth: async () => {} }
      }) as never,
      'connect srv',
      authUi as never,
      () => client as never,
    )

    expect(spawnMock.calls).toHaveLength(1)
    expect(spawnMock.calls[0].args).toContain(authUrl)
    expect(notices.some((message) => message.includes(authUrl) && message.includes('srv'))).toBe(true)
  })
})
