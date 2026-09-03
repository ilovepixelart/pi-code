/**
 * OAuth for remote MCP servers, through the MCP SDK's authProvider seam.
 *
 * Claude Code authenticates remote HTTP servers via OAuth from its /mcp panel;
 * here the flow runs at connect time: a 401 surfaces as UnauthorizedError, the
 * user approves opening the browser, a one-shot localhost listener catches the
 * redirect, and the SDK's finishAuth exchanges the code. Tokens, the dynamic
 * client registration and the PKCE verifier persist per server under pi's agent
 * directory with owner-only permissions, so later sessions reconnect silently
 * and refresh through the SDK without a browser round-trip.
 */

import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { errorMessage } from './values.js'

interface StoredAuth {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  verifier?: string
  /** The loopback port a prior login registered, reused so a strict server that
   * pins redirect_uris still accepts a re-login after tokens are revoked. */
  redirectPort?: number
}

/** Claude's per-server `oauth` config object: a pre-registered client (secret via
 * MCP_CLIENT_SECRET), a fixed callback port for pre-registered redirect URIs, and
 * pinned scopes. authServerMetadataUrl is accepted but unsupported (the MCP SDK
 * offers no discovery override); the connect path warns when it is set. */
export interface OAuthServerConfig {
  clientId?: string
  callbackPort?: number
  scopes?: string
  authServerMetadataUrl?: string
}

/** The origin a sign-in belongs to, so the same server name at a different endpoint gets
 * its own store. An unparseable url falls back to its raw text rather than to nothing. */
function endpointKey(endpoint: string | undefined): string {
  if (!endpoint) return ''
  try {
    return new URL(endpoint).origin
  } catch {
    return endpoint
  }
}

/** A server name is config-controlled text; the digest keeps hostile names inside
 * the store directory and distinct names from colliding after sanitization. The endpoint
 * rides the digest so a second project reusing a name cannot read the first one's tokens. */
function storeFileFor(serverName: string, endpoint?: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${serverName}\n${endpointKey(endpoint)}`)
    .digest('hex')
    .slice(0, 8)
  // Collapse disallowed runs to a single hyphen, then strip leading and trailing
  // hyphens by index. The old /^-+|-+$/g trim rescanned on every hyphen of a long run
  // (its trailing-anchored branch backtracks per start position), which is quadratic.
  const collapsed = serverName.replace(/[^A-Za-z0-9_-]+/g, '-')
  let start = 0
  let end = collapsed.length
  while (start < end && collapsed[start] === '-') start++
  while (end > start && collapsed[end - 1] === '-') end--
  const safe = collapsed.slice(start, end).slice(0, 40) || 'server'
  return path.join(getAgentDir(), 'mcp-oauth', `${safe}-${digest}.json`)
}

/** MCP_OAUTH_CALLBACK_PORT parsed, or undefined when unset or not a plain integer. */
function envCallbackPort(): number | undefined {
  const raw = process.env.MCP_OAUTH_CALLBACK_PORT
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export class FileOAuthProvider implements OAuthClientProvider {
  private readonly storePath: string
  private readonly data: StoredAuth
  private port = 0
  private readonly onRedirect: (authorizationUrl: URL) => void
  // A fresh random CSRF token per login attempt. The SDK puts it in the authorization
  // URL's `state` param, the server echoes it back on the redirect, and waitForAuthCode
  // rejects any callback that does not carry it, so another local process or an open web
  // page cannot inject an authorization code into this login (RFC 8252 8.9).
  private readonly loginState = crypto.randomBytes(16).toString('hex')

  constructor(serverName: string, onRedirect: (authorizationUrl: URL) => void, oauth?: OAuthServerConfig, endpoint?: string) {
    this.storePath = storeFileFor(serverName, endpoint)
    this.onRedirect = onRedirect
    this.oauth = oauth
    try {
      this.data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
    } catch {
      this.data = {}
    }
  }

  private readonly oauth?: OAuthServerConfig

  /** The client secret for a pre-configured client, from Claude's MCP_CLIENT_SECRET. */
  private clientSecret(): string | undefined {
    return this.oauth?.clientId ? process.env.MCP_CLIENT_SECRET : undefined
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true })
    fs.writeFileSync(this.storePath, JSON.stringify(this.data), { mode: 0o600 })
  }

  /** The configured callbackPort alone, absent when only a remembered port exists.
   * The caller needs the two apart: a configured port is a hard requirement. Falls
   * back to MCP_OAUTH_CALLBACK_PORT, Claude's "alternative to --callback-port when
   * adding an MCP server with pre-configured credentials"; pi-code has no `mcp add`
   * command, so the env var applies as a default for any server naming no port of
   * its own rather than only ones added that way. */
  configuredRedirectPort(): number | undefined {
    return this.oauth?.callbackPort ?? envCallbackPort()
  }

  /** The configured callbackPort (Claude: for pre-registered redirect URIs), else
   * the port a prior login registered, so a re-login can bind the same one. */
  savedRedirectPort(): number | undefined {
    return this.oauth?.callbackPort ?? envCallbackPort() ?? this.data.redirectPort
  }

  /** Record the loopback port the callback server actually bound; the redirect
   * URL and the registered redirect_uri both derive from it. */
  bindRedirectPort(port: number): void {
    this.port = port
    if (this.data.redirectPort !== port) {
      this.data.redirectPort = port
      this.persist()
    }
  }

  /** The localhost spelling, which is what a server with a pre-registered redirect URI
   * expects: Claude sent the 127.0.0.1 form for one version and "servers that exact-match
   * the registered redirect URI rejected the sign-in with a redirect URI mismatch". */
  get redirectUrl(): string {
    return `http://localhost:${this.port}/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'pi-code',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A local CLI is a public client; PKCE carries the proof instead of a secret.
      // A pre-configured client with an MCP_CLIENT_SECRET authenticates with it.
      token_endpoint_auth_method: this.clientSecret() ? 'client_secret_post' : 'none',
      // Claude: oauth.scopes pins the scopes requested during authorization.
      ...(this.oauth?.scopes ? { scope: this.oauth.scopes } : {}),
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // A pre-configured clientId replaces dynamic registration entirely.
    if (this.oauth?.clientId) {
      const secret = this.clientSecret()
      return { client_id: this.oauth.clientId, ...(secret ? { client_secret: secret } : {}) }
    }
    return this.data.client
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.data.client = client
    this.persist()
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens
    this.persist()
  }

  hasTokens(): boolean {
    return this.data.tokens !== undefined
  }

  /** The CSRF token the SDK adds to the authorization URL as `state`; waitForAuthCode
   * verifies the redirect echoes exactly this value. */
  state(): string {
    return this.loginState
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onRedirect(authorizationUrl)
  }

  saveCodeVerifier(verifier: string): void {
    this.data.verifier = verifier
    this.persist()
  }

  codeVerifier(): string {
    if (!this.data.verifier) throw new Error('no code verifier saved for this authorization')
    return this.data.verifier
  }
}

/** A one-shot loopback listener for the authorization redirect. Loopback redirect
 * URIs are the RFC 8252 pattern for native apps. A preferred port (from a prior
 * login) is tried first so a re-login keeps the registered redirect_uri; if it is
 * taken, an ephemeral port is used.
 *
 * `portRequired` marks the port as configured rather than remembered. A configured
 * `oauth.callbackPort` names the redirect_uri the IdP has registered, so quietly
 * binding a different one sends the user to an opaque redirect_uri mismatch at the
 * IdP; the bind failure is reported here instead, where it can name the real cause. */
export async function startCallbackServer(preferredPort?: number, portRequired = false): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer()
  const listen = (port: number, host: string): Promise<void> => new Promise((resolve, reject) => server.listen(port, host, resolve).once('error', reject))
  try {
    await listen(preferredPort ?? 0, '127.0.0.1')
  } catch (error) {
    if (portRequired) throw new Error(`oauth.callbackPort ${preferredPort} is in use, so the registered redirect URI cannot be served: free that port or change oauth.callbackPort (${errorMessage(error)})`)
    await listen(0, '127.0.0.1')
  }
  const port = (server.address() as { port: number }).port
  // The redirect names localhost, which resolves to ::1 first on a host with IPv6, so a
  // second listener answers there too. Best effort: where it cannot bind, the IPv4
  // listener above still answers every browser that resolves localhost to 127.0.0.1.
  const ipv6 = http.createServer()
  ipv6.on('error', () => {})
  await new Promise<void>((resolve) => {
    ipv6.listen(port, '::1', () => resolve()).once('error', () => resolve())
  })
  server.on('close', () => ipv6.close())
  ipv6.on('request', (request, response) => server.emit('request', request, response))
  return { server, port }
}

export function waitForAuthCode(server: http.Server, timeoutMs: number, expectedState?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`authorization timed out after ${timeoutMs}ms`)), timeoutMs)
    // Do not let the pending timer keep the process alive on its own: if the login is
    // abandoned or resolved out of band, the event loop can still drain.
    timer.unref?.()
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      // Only the redirect path settles the login. A stray request (a favicon fetch, a
      // local port scan, or a forged redirect from another process or an open web page)
      // is answered but ignored, so it can neither inject a code nor abort the login by
      // rejecting the promise (a repeatable DoS on a stable, guessable loopback port).
      if (url.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found')
        return
      }
      // The CSRF check: a callback that does not echo this login's state is rejected
      // without settling, so an attacker who cannot read the state cannot complete it.
      if (expectedState !== undefined && url.searchParams.get('state') !== expectedState) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end('state mismatch')
        return
      }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><body>pi-code: you can close this tab and return to the terminal.</body></html>')
      clearTimeout(timer)
      if (code) resolve(code)
      else reject(new Error(`authorization failed: ${error ?? 'no code in redirect'} ${url.searchParams.get('error_description') ?? ''}`.trim()))
    })
  })
}

/** Best-effort browser launch; the caller also surfaces the URL as text. */
export function openBrowser(url: string): void {
  let command = 'xdg-open'
  if (process.platform === 'darwin') command = 'open'
  else if (process.platform === 'win32') command = 'cmd'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    // A missing launcher (a container or an SSH session with no xdg-open) reports itself
    // asynchronously through 'error'; with no listener node raises it as an
    // uncaughtException and pi exits. The caller has already shown the URL to open by hand.
    child.on('error', () => {})
    child.unref()
  } catch {
    // the notified URL is the fallback
  }
}
