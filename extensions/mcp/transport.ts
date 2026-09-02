/**
 * MCP transport: the connect/call timeouts, the SDK request options for pi's two-tier
 * timeout, the stdio and HTTP-family (streamable with SSE fallback) connect paths, the
 * headersHelper, and the auth primitives shared with the interactive OAuth flow.
 */

import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
// SSE is deprecated in favour of Streamable HTTP, but the SDK notes servers still on
// the old spec exist, so this stays as a fallback for the migration period.
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js' // NOSONAR
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { FileOAuthProvider, type OAuthServerConfig } from '../internal/mcp-oauth.js'
import { resolveShell } from '../internal/shell-resolve.js'
import { expandCwd, type HttpServerConfig, interpolateEnv, type ServerConfig, type StdioServerConfig } from './config.js'
import { runInteractiveOAuth, serializeInteractiveOAuth } from './oauth-flow.js'

// Claude's MCP_TIMEOUT default: 30 seconds per connect attempt.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
// Claude's MCP_TOOL_TIMEOUT default is effectively hours: the per-call wall-clock budget
// is only a ceiling, and the idle timeout below is the real guard. 4h matches that model,
// so a legitimately slow-but-progressing tool is not killed at the old 2 minutes.
const DEFAULT_CALL_TIMEOUT_MS = 14_400_000
// The idle timeout: the longest a call may go with no response or progress before it is
// abandoned. Claude uses a separate idle guard rather than the hours-long wall-clock
// budget, defaulting to five minutes for remote transports and 30 minutes for stdio
// servers; the SDK resets this window on every progress notification.
const DEFAULT_CALL_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_STDIO_CALL_IDLE_TIMEOUT_MS = 1_800_000

/** Claude's numeric env vars accept scientific notation and digit-separator spellings
 * (2e3 as 2000, 64_000 as 64000). A non-numeric value is undefined, not zero. */
function parseNumericEnv(raw: string): number | undefined {
  const cleaned = raw.replaceAll('_', '')
  if (cleaned.trim() === '') return undefined
  const value = Number(cleaned)
  return Number.isFinite(value) ? Math.floor(value) : undefined
}

/** A positive-integer env override, or the default when unset or unparseable. */
function envTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = parseNumericEnv(raw)
  return value !== undefined && value > 0 ? value : fallback
}

// Claude honors MCP_TIMEOUT (connect) and MCP_TOOL_TIMEOUT (per-call), both in ms.
export const connectTimeoutMs = (): number => envTimeout('MCP_TIMEOUT', DEFAULT_CONNECT_TIMEOUT_MS)
export const callTimeoutMs = (): number => envTimeout('MCP_TOOL_TIMEOUT', DEFAULT_CALL_TIMEOUT_MS)

/** Per-server inputs to the idle-window choice: the transport kind picks the default
 * tier, and a per-server `timeout` of at least 1000 also floors the idle window. */
export interface ServerCallTuning {
  stdio?: boolean
  serverTimeoutMs?: number
}

/** The idle timeout in ms: the longest a call may go with no response or progress before
 * it is abandoned. Defaults to Claude's tiers (five minutes remote, 30 minutes stdio),
 * overridable by CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, with 0 disabling it (leaving only
 * the wall-clock budget). Unlike envTimeout, an explicit 0 is honored as "disabled"
 * rather than falling back to the default. A per-server timeout of at least 1000 floors
 * the enabled window, so a server granted a long wall budget is not idled out earlier. */
function idleTimeoutMs(tuning: ServerCallTuning): number {
  const raw = process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT
  const override = raw === undefined ? undefined : parseNumericEnv(raw)
  if (override === 0) return 0
  const tierDefault = tuning.stdio ? DEFAULT_STDIO_CALL_IDLE_TIMEOUT_MS : DEFAULT_CALL_IDLE_TIMEOUT_MS
  const base = override !== undefined && override > 0 ? override : tierDefault
  const floor = tuning.serverTimeoutMs !== undefined && tuning.serverTimeoutMs >= 1000 ? tuning.serverTimeoutMs : 0
  return Math.max(base, floor)
}

/** The SDK RequestOptions for a call under pi's two-tier timeout: a wall-clock ceiling and,
 * under it, an idle timeout the SDK resets on every progress notification. When the idle
 * window is enabled and tighter than the wall budget, `timeout` is that per-quiet-period
 * deadline (resetTimeoutOnProgress), maxTotalTimeout caps the wall clock, and an onprogress
 * handler is required: it makes the server address progress to this request and lets the
 * SDK reset the timer on it. When the idle timeout is disabled, or already looser than the
 * wall budget, only the wall budget applies. The outer withTimeout race is a wall-clock
 * backstop and must be raced against `wall`, never the idle window, so a legitimately
 * progressing call is not cut off. */
export function callRequestOptions(wall: number, tuning: ServerCallTuning = {}): { timeout: number; resetTimeoutOnProgress?: boolean; maxTotalTimeout?: number; onprogress?: () => void } {
  const idle = idleTimeoutMs(tuning)
  if (idle === 0 || idle >= wall) return { timeout: wall }
  return { timeout: idle, resetTimeoutOnProgress: true, maxTotalTimeout: wall, onprogress: () => {} }
}

/** The tuning one server's config yields: its transport kind, and its declared
 * per-server timeout. Per Claude, timeout values below 1000 are ignored and fall
 * through to MCP_TOOL_TIMEOUT. */
export function serverCallTuning(config: ServerConfig): ServerCallTuning {
  const declared = typeof config.timeout === 'number' && config.timeout >= 1000 ? config.timeout : undefined
  return { stdio: isStdio(config), ...(declared !== undefined ? { serverTimeoutMs: declared } : {}) }
}

/** Claude reports a config entry that has a url but no type as an error; pi-code
 * still connects (streamable HTTP with SSE fallback) but says the entry is wrong. */
/** An inline bearerToken (interpolated) wins over bearerTokenEnv, which names an
 * environment variable read as-is. */
export function resolveBearerToken(config: { bearerToken?: string; bearerTokenEnv?: string }): string | undefined {
  if (config.bearerToken) return interpolateEnv(config.bearerToken)
  if (config.bearerTokenEnv) return process.env[config.bearerTokenEnv]
  return undefined
}

/** Claude's `headersHelper` output: a flat JSON object of header name -> string,
 * merged into the connect headers. Non-string values and non-object output are
 * ignored so a broken helper cannot poison the request. */
export function parseHelperHeaders(stdout: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') out[key] = value
  return out
}

function isStdio(config: ServerConfig): config is StdioServerConfig {
  // An explicit type wins; without one, a command field means stdio.
  return 'command' in config && (config.type === undefined || config.type === 'stdio')
}

/** The session's directories: the launch directory answers roots/list, and the
 * project root becomes CLAUDE_PROJECT_DIR in a stdio server's environment. */
export interface SessionDirs {
  projectDir: string
  launchDir: string
}

/** A client that, like Claude, declares the roots capability and answers roots/list
 * with the session's launch directory. pi's directory set is static, so no
 * roots/list_changed notification is ever sent. */
function makeClient(session?: SessionDirs): Client {
  if (!session) return new Client({ name: 'pi-code-mcp', version: '0.1.0' })
  const client = new Client({ name: 'pi-code-mcp', version: '0.1.0' }, { capabilities: { roots: {} } })
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(session.launchDir).href }] }))
  return client
}

/** Claude's credential heuristic for helper environments: any name with TOKEN,
 * SECRET, PASSWORD, KEY, or AUTH in it in either case (Git's GIT_CONFIG_KEY_<n>
 * excepted), plus a fixed list of credential names outside the pattern. */
const CREDENTIAL_NAME_EXTRAS = new Set(['ANTHROPIC_CUSTOM_HEADERS'])
function isCredentialEnvName(name: string): boolean {
  if (/^GIT_CONFIG_KEY_\d+$/.test(name)) return false
  return /TOKEN|SECRET|PASSWORD|KEY|AUTH/i.test(name) || CREDENTIAL_NAME_EXTRAS.has(name)
}

/** process.env with every credential-named value replaced by REDACTED, used to
 * expand the url a helper is shown without handing it the credential. */
function redactedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, isCredentialEnvName(key) ? 'REDACTED' : value]))
}

/** The environment a headersHelper runs with: Claude's CLAUDE_CODE_MCP_SERVER_NAME
 * and CLAUDE_CODE_MCP_SERVER_URL (credential-expanded url parts REDACTED), plus
 * CLAUDE_PLUGIN_ROOT for a plugin's server. A helper a repository or plugin
 * supplies is a command the user did not write, so it runs without the
 * credential-named variables; a user-scope helper keeps them. */
function helperEnv(name: string, config: HttpServerConfig): NodeJS.ProcessEnv {
  const stripped = config.projectScope === true || config.pluginRoot !== undefined
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped && isCredentialEnvName(key)) continue
    env[key] = value
  }
  env.CLAUDE_CODE_MCP_SERVER_NAME = name
  env.CLAUDE_CODE_MCP_SERVER_URL = interpolateEnv(config.url, redactedEnv())
  if (config.pluginRoot !== undefined) env.CLAUDE_PLUGIN_ROOT = config.pluginRoot
  return env
}

/** The env a stdio server process starts with: the SDK allowlist, the config's own
 * env block, and Claude's path variables (CLAUDE_PROJECT_DIR, and CLAUDE_PLUGIN_ROOT
 * for a plugin's server). */
function stdioEnv(config: StdioServerConfig, fill: (value: string) => string, session?: SessionDirs): Record<string, string> {
  // CLAUDECODE marks every subprocess; the long-lived server deliberately gets no
  // CLAUDE_CODE_CHILD_SESSION, which Claude reserves for per-call children.
  const env: Record<string, string> = { ...getDefaultEnvironment(), CLAUDECODE: '1' }
  for (const [key, value] of Object.entries(config.env ?? {})) env[key] = fill(value)
  if (session) env.CLAUDE_PROJECT_DIR = session.projectDir
  if (config.pluginRoot !== undefined) env.CLAUDE_PLUGIN_ROOT = config.pluginRoot
  return env
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  // If the timeout wins, `promise` stays pending; swallow any late rejection so it can never
  // surface as an unhandled rejection that crashes the host.
  promise.catch(() => {})
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function connect(name: string, config: ServerConfig, authUi?: AuthUi, session?: SessionDirs): Promise<Client> {
  const client = makeClient(session)
  // Names referenced by ${VAR} with no value and no default, gathered across this
  // server's interpolated fields so the connect can warn once rather than fail with a
  // mystery 401 or a command that lost an argument.
  const missing = new Set<string>()
  const fill = (value: string): string => interpolateEnv(value, process.env, (varName) => missing.add(varName))
  const warnMissing = (): void => {
    if (missing.size > 0) console.warn(`pi-code-mcp: server ${name} references undefined variable(s) ${[...missing].join(', ')}; leaving them unexpanded`)
  }
  if (isStdio(config)) {
    // Start from the SDK's allowlist (PATH, HOME, SHELL, ...) rather than the whole
    // process env: a server should not receive ANTHROPIC_API_KEY or GITHUB_TOKEN just
    // for being launched. A server that needs a variable names it in its own env block.
    const transport = new StdioClientTransport({
      command: fill(config.command),
      args: (config.args ?? []).map((arg) => fill(arg)),
      env: stdioEnv(config, fill, session),
      cwd: expandCwd(config.cwd),
      stderr: 'ignore',
    })
    warnMissing()
    await connectWithTimeout(client, transport, `connect ${name}`)
    return client
  }
  const url = new URL(fill(config.url))
  if (config.type === 'ws' || config.type === 'websocket') {
    // The SDK's WebSocket transport takes only a url: it carries no headers, bearer
    // token, or headersHelper output. Warn rather than silently dropping configured
    // auth, and skip the helper entirely (running it would block the connect for up to
    // 10s while contributing nothing). Divergence: Claude documents header auth as the
    // ws mechanism ("Authentication is header-only"); under pi an authenticated ws
    // server cannot be used until the SDK transport grows header support.
    if (config.headers || config.bearerToken || config.bearerTokenEnv || config.headersHelper) {
      console.warn(`pi-code-mcp: server ${name} is a WebSocket server; the SDK ws transport is url-only, so its headers/bearerToken/headersHelper are ignored`)
    }
    const transport = new WebSocketClientTransport(url)
    warnMissing()
    await connectWithTimeout(client, transport, `connect ${name} (ws)`)
    return client
  }
  // The SDK's OAuth discovery has no override seam, so a configured metadata URL
  // cannot be honored; say so instead of silently using standard discovery.
  if (config.oauth?.authServerMetadataUrl) {
    console.warn(`pi-code-mcp: server ${name} sets oauth.authServerMetadataUrl, which the MCP SDK cannot override; using standard discovery`)
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = fill(value)
  const token = resolveBearerToken(config)
  if (token) headers.Authorization = `Bearer ${token}`
  // A headersHelper generates connect-time headers for non-OAuth auth schemes; its
  // JSON stdout merges over the static headers. The command text is NOT interpolated:
  // Claude expands ${VAR} in command, args, env, url and headers, and expanding it here
  // would read the parent environment, which is the credential set a repository- or
  // plugin-supplied helper must not see. The helper's own shell expands it against the
  // stripped environment instead. Plugin path variables are already substituted in
  // mcp/config.ts, which also refuses ${user_config.*} in a helper.
  if (config.headersHelper) Object.assign(headers, await runHeadersHelper(config.headersHelper, helperEnv(name, config)))
  warnMissing()
  // Claude: a configured Authorization header, whether static, a bearer token, or
  // helper output, is the server's authentication; there is no OAuth fallback for it.
  const configuredAuth = Boolean(token) || Object.keys(headers).some((header) => header.toLowerCase() === 'authorization')
  const sseTransport = (authProvider?: OAuthClientProvider) => new SSEClientTransport(url, { requestInit: { headers }, authProvider }) // NOSONAR: explicitly declared or deliberate legacy transport
  if (config.type === 'sse') {
    return await connectHttpFamily(name, config, sseTransport, `connect ${name} (sse)`, configuredAuth, authUi, session)
  }
  try {
    return await connectHttpFamily(name, config, (authProvider) => new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider }), `connect ${name}`, configuredAuth, authUi, session)
  } catch (error) {
    // An explicitly declared streamable transport must not silently degrade to SSE.
    if (config.type !== undefined || isUnauthorized(error)) throw error
    return await connectHttpFamily(name, config, sseTransport, `connect ${name} (sse)`, configuredAuth, authUi, session)
  }
}

/** Transport-level failure codes worth another attempt. */
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])

/** Every `code` reachable from an error: its own, those of its `cause` chain, and those
 * of an AggregateError's members. fetch reports a refused connection as a bare
 * `TypeError: fetch failed` whose cause carries ECONNREFUSED, so the text says nothing. */
function errorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || typeof error !== 'object' || seen.has(error)) return []
  seen.add(error)
  const codes: string[] = []
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') codes.push(code)
  const inner = (error as { errors?: unknown }).errors
  if (Array.isArray(inner)) for (const one of inner) codes.push(...errorCodes(one, seen))
  codes.push(...errorCodes((error as { cause?: unknown }).cause, seen))
  return codes
}

/** Whether a connect failure is worth retrying: a 5xx response, a refused or reset
 * connection, or a timeout, per Claude's "a 5xx response, a connection refused, or a
 * timeout ... retries up to three times". Auth and not-found errors need a configuration
 * change instead. Exported for the test that pins the shape node actually throws. */
export function isTransientConnectError(error: unknown): boolean {
  if (isUnauthorized(error)) return false
  const status = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (typeof status === 'number') return status >= 500
  if (errorCodes(error).some((code) => TRANSIENT_CODES.has(code))) return true
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out after/.test(String(error))
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Connect with Claude's first-connection retry: an HTTP or SSE server's transient
 * failure (5xx, connection refused, timeout) is retried up to three times with a
 * 1s-doubling delay. Stdio and WebSocket connects are attempted once, as are auth
 * and not-found failures. */
export async function connectWithRetries(name: string, config: ServerConfig, authUi?: AuthUi, session?: SessionDirs): Promise<Client> {
  const retriable = !isStdio(config) && config.type !== 'ws' && config.type !== 'websocket'
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect(name, config, authUi, session)
    } catch (error) {
      if (!retriable || attempt >= 3 || !isTransientConnectError(error)) throw error
      await delay(1000 * 2 ** attempt)
    }
  }
}

/** Run a headersHelper command and parse its JSON stdout into headers, under the
 * environment helperEnv built. It runs through the platform shell (/bin/sh; Git Bash
 * or PowerShell on Windows). A failure, a 10s timeout, or a machine with no shell
 * yields no extra headers rather than blocking the connection. */
function runHeadersHelper(command: string, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const shell = resolveShell(undefined)
    if (!shell) {
      resolve({})
      return
    }
    execFile(shell.file, shell.argsFor(command), { timeout: 10_000, env }, (error, stdout) => {
      resolve(error ? {} : parseHelperHeaders(stdout))
    })
  })
}

/** UI seams the OAuth flow needs; absent in headless runs, which fail with advice. */
export interface AuthUi {
  confirm: (title: string, body: string) => Promise<boolean>
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
}

/** A server needs OAuth pi could not complete (headless, declined, or the flow
 * failed). A typed marker so the SSE-fallback caller can tell an auth failure
 * from a transport mismatch without matching on message text. */
export class OAuthRequiredError extends Error {}

/** Whether a connect failure is an authentication problem: the SDK's own
 * UnauthorizedError, a transport error carrying HTTP 401 or 403 (Claude: "either
 * status code flags it" for OAuth), or our own marker. */
export function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof OAuthRequiredError) return true
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 401 || code === 403
}

// SSEClientTransport is deprecated in favour of Streamable HTTP, but both concrete
// transports expose finishAuth (the base Transport interface does not), so the union
// stays as the http-family fallback type through the migration period.
type HttpFamilyTransport = SSEClientTransport | StreamableHTTPClientTransport // NOSONAR typescript:S1874 - SSE fallback still required by the MCP SDK

export type MakeTransport = (authProvider?: OAuthClientProvider) => HttpFamilyTransport

/**
 * Connect an http-family server, running Claude's OAuth login when the server
 * demands one. Stored tokens ride the first attempt so the SDK refreshes
 * silently; a 401 without tokens asks the user, opens the browser, catches the
 * loopback redirect, and exchanges the code via the SDK's finishAuth.
 * A server with configured authentication (a bearer token, a static Authorization
 * header, or one from a headersHelper) never enters the OAuth path: the credential
 * to fix is the configured one, so an auth failure reports as a failed connection.
 */
async function connectHttpFamily(name: string, config: { url: string; oauth?: OAuthServerConfig }, makeTransport: MakeTransport, label: string, hasConfiguredAuth: boolean, authUi: AuthUi | undefined, session?: SessionDirs): Promise<Client> {
  const newClient = () => makeClient(session)
  // Stored tokens ride the first attempt so the SDK refreshes them; with none, no
  // provider is attached, so a 401 surfaces as a transport error carrying code 401
  // (isUnauthorized detects it) and only the interactive provider below ever runs
  // dynamic registration, keeping it bound to the real callback port. A
  // pre-configured client (oauth.clientId) rides the silent provider too, so its
  // stored tokens refresh with the configured credentials.
  const silent = hasConfiguredAuth ? undefined : new FileOAuthProvider(name, () => {}, config.oauth, config.url)
  try {
    const client = newClient()
    await connectWithTimeout(client, makeTransport(silent?.hasTokens() ? silent : undefined), label)
    return client
  } catch (error) {
    if (hasConfiguredAuth || !isUnauthorized(error)) throw error
    if (!authUi) throw new OAuthRequiredError(`${name} requires a login; run pi interactively to authenticate`)
    return await serializeInteractiveOAuth(() => runInteractiveOAuth(name, config, makeTransport, label, authUi, newClient))
  }
}

/**
 * Connect with a deadline, closing the client if the deadline (not a connect error) wins.
 * Without this, a slow-but-successful server finishes connecting after the race is lost and
 * lingers unreferenced: process/socket alive, never in `clients`, invisible to shutdown.
 */
export async function connectWithTimeout(client: Client, transport: Parameters<Client['connect']>[0], label: string): Promise<void> {
  const connecting = client.connect(transport)
  try {
    await withTimeout(connecting, connectTimeoutMs(), label)
  } catch (error) {
    // Only a timeout can orphan a still-opening transport; a connect rejection means the
    // SDK already tore it down, so closing again would be redundant.
    if (String(error).includes('timed out after')) {
      connecting.catch(() => {}) // a late rejection must not surface as unhandled
      void client.close().catch(() => {})
    }
    throw error
  }
}
