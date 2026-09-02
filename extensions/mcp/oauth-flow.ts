/**
 * MCP interactive OAuth: the serialization queue that stops two browser logins from
 * stacking dialogs and tabs, and the interactive login itself (confirm, open the
 * browser, catch the loopback redirect, exchange the code via the SDK's finishAuth).
 * The FileOAuthProvider and callback server live in internal/mcp-oauth.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { FileOAuthProvider, type OAuthServerConfig, openBrowser, startCallbackServer, waitForAuthCode } from '../internal/mcp-oauth.js'
import { errorMessage } from '../internal/values.js'
import { type AuthUi, connectWithTimeout, isUnauthorized, type MakeTransport, OAuthRequiredError } from './transport.js'

/** Browser logins are human-paced; a connect-sized timeout would cut them off. */
const OAUTH_FLOW_TIMEOUT_MS = 180_000

/** Wrap a login-flow failure as OAuthRequiredError, passing an existing one through
 * unchanged so its message is not doubled. */
function asOAuthRequiredError(name: string, error: unknown): OAuthRequiredError {
  if (error instanceof OAuthRequiredError) return error
  const detail = errorMessage(error)
  return new OAuthRequiredError(`login for ${name} failed: ${detail}`)
}

/** Interactive OAuth logins block on a confirm dialog and open a browser tab, so two
 * at once (a user-scope and a consented project-scope server both 401ing, connecting in
 * parallel) would stack dialogs and browser tabs. This chains them so a second
 * interactive login waits for the first to settle; the tail is reset to a resolved
 * promise regardless of outcome, so a failed login never poisons the queue. Silent
 * (stored-token) connects do not pass through here and stay fully parallel. */
let oauthQueue: Promise<unknown> = Promise.resolve()

/** Test seam: the queue is module state that outlives a test, so one login left pending
 * would serialize every later login in the same file behind it. */
export function resetOAuthQueue(): void {
  oauthQueue = Promise.resolve()
}

export function serializeInteractiveOAuth<T>(run: () => Promise<T>): Promise<T> {
  const result = oauthQueue.then(run, run)
  oauthQueue = result.then(
    () => {},
    () => {},
  )
  return result
}

/**
 * The interactive half of the OAuth login, reached only once a silent connect has
 * failed with a 401 and a UI is present: confirm, open the browser, catch the loopback
 * redirect, and exchange the code via the SDK's finishAuth. Past the confirm the server
 * is known to need OAuth, so any failure here (a denied consent page, the 180s wait, a
 * token exchange error) is wrapped as an auth failure, not a transport mismatch: that
 * keeps the typeless-url caller from retrying over SSE and prompting for a second login.
 */
export async function runInteractiveOAuth(name: string, config: { url: string; oauth?: OAuthServerConfig }, makeTransport: MakeTransport, label: string, authUi: AuthUi, newClient: () => Client): Promise<Client> {
  const approved = await authUi.confirm(`MCP server "${name}" requires login`, `Open your browser to authorize ${config.url}?`)
  if (!approved) throw new OAuthRequiredError(`login declined for ${name}`)
  const provider = new FileOAuthProvider(
    name,
    (authorizationUrl) => {
      openBrowser(String(authorizationUrl))
      authUi.notify(`Authorize "${name}" in the browser. If it did not open: ${authorizationUrl}`, 'info')
    },
    config.oauth,
    config.url,
  )
  const { server, port } = await startCallbackServer(provider.savedRedirectPort())
  provider.bindRedirectPort(port)
  try {
    const transport = makeTransport(provider)
    // Verify the redirect echoes this login's state, so a stray or forged callback to the
    // loopback port cannot inject a code or abort the login (see waitForAuthCode).
    const pendingCode = waitForAuthCode(server, OAUTH_FLOW_TIMEOUT_MS, provider.state())
    pendingCode.catch(() => {}) // consumed below; an abandoned login must not surface as unhandled
    const client = newClient()
    try {
      await connectWithTimeout(client, transport, label)
      return client // authorized between attempts; nothing left to exchange
    } catch (retryError) {
      if (!isUnauthorized(retryError)) throw retryError
      const code = await pendingCode
      await transport.finishAuth(code)
      const authed = newClient()
      await connectWithTimeout(authed, makeTransport(provider), label)
      return authed
    }
  } catch (flowError) {
    throw asOAuthRequiredError(name, flowError)
  } finally {
    server.close()
  }
}
