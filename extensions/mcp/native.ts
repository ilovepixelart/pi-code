/**
 * pi's native MCP (pi 0.99 and later): translation of pi-code's server configs into the
 * `McpServerConfig` pi.registerMcpServer() takes.
 */

import * as os from 'node:os'
import type { McpServerConfig } from '@earendil-works/pi-coding-agent'
import type { McpToolAlias } from '../internal/mcp-alias.js'
import { envCallbackPort } from '../internal/mcp-oauth.js'
import { type HttpServerConfig, interpolateEnv, type ServerConfig, type StdioServerConfig } from './config.js'
import type { McpPolicy } from './policy.js'
import { callBudgetMs, MAX_TIMER_MS, type SessionDirs } from './transport.js'

export interface NativeServer {
  name: string
  config: McpServerConfig
}

/** A server pi can connect, or why it stays on pi-code's client. */
export type NativeTranslation = { native: NativeServer } | { reason: string }

// pi's server names; its tools become mcp__<name>__<tool>.
const NATIVE_NAME = /^[A-Za-z0-9_-]+$/

/** pi resolves env and header values itself: a leading `!` runs the value as a shell
 * command and `$NAME` / `${NAME}` expand. pi-code has already applied Claude's expansion,
 * so the result is escaped to reach the server as written (`$$` is `$`, `$!` is `!`). */
function literal(value: string): string {
  return value.replaceAll('$', () => '$$').replace(/^!/, () => '$!')
}

function mapValues(record: Record<string, string>, map: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
}

/** Plugin servers register as plugin_<plugin>_<server>, so pi's tool names match
 * Claude's mcp__plugin_<plugin>_<server>__<tool>. */
function nativeName(name: string, config: ServerConfig): string {
  return config.aliasPrefix?.replace(/^mcp__/, '').replace(/__$/, '') ?? name
}

function stdioConfig(config: StdioServerConfig, fill: (value: string) => string, session?: SessionDirs): McpServerConfig {
  // The variables pi-code's own client exports to a stdio server (transport.ts stdioEnv).
  const env: Record<string, string> = { ...mapValues(config.env ?? {}, fill), CLAUDECODE: '1' }
  if (session) env.CLAUDE_PROJECT_DIR = session.projectDir
  if (session?.sessionId) env.CLAUDE_CODE_SESSION_ID = session.sessionId
  if (config.pluginRoot !== undefined) env.CLAUDE_PLUGIN_ROOT = config.pluginRoot
  if (config.pluginDataDir !== undefined) env.CLAUDE_PLUGIN_DATA = config.pluginDataDir
  const cwd = config.cwd ? fill(config.cwd).replace(/^~(?=\/|$)/, os.homedir()) : undefined
  return {
    command: fill(config.command),
    args: (config.args ?? []).map(fill),
    env: mapValues(env, literal),
    ...(cwd === undefined ? {} : { cwd }),
  }
}

/** An inline bearerToken (expanded) wins over bearerTokenEnv, which names a variable read as is. */
function bearerToken(config: HttpServerConfig, fill: (value: string) => string, env: NodeJS.ProcessEnv): string | undefined {
  if (config.bearerToken) return fill(config.bearerToken)
  return config.bearerTokenEnv ? env[config.bearerTokenEnv] : undefined
}

function httpConfig(config: HttpServerConfig, fill: (value: string) => string, env: NodeJS.ProcessEnv): McpServerConfig {
  const headers = mapValues(config.headers ?? {}, fill)
  const token = bearerToken(config, fill, env)
  if (token) headers.Authorization = `Bearer ${token}`
  const oauth = config.oauth
  const secret = env.MCP_CLIENT_SECRET
  // pi's own redirect host is 127.0.0.1; pi-code's client sends localhost (mcp-oauth.ts
  // redirectUrl), the form a pre-registered redirect URI is matched against.
  const port = oauth?.callbackPort ?? envCallbackPort(env)
  const redirect = port === undefined ? {} : { callbackUrl: `http://localhost:${port}/callback` }
  return {
    url: fill(config.url),
    ...(Object.keys(headers).length > 0 ? { headers: mapValues(headers, literal) } : {}),
    ...(oauth || port !== undefined
      ? {
          oauth: {
            ...(oauth?.clientId === undefined ? {} : { clientId: oauth.clientId }),
            ...(oauth?.clientId !== undefined && secret ? { clientSecret: literal(secret) } : {}),
            ...redirect,
            ...(oauth?.scopes === undefined ? {} : { scope: oauth.scopes }),
          },
        }
      : {}),
  }
}

function unsupported(config: ServerConfig): string | undefined {
  if ('url' in config) {
    if (config.type === 'sse' || config.type === 'ws' || config.type === 'websocket') return `${config.type} transport`
    if (config.headersHelper !== undefined) return 'headersHelper'
    // The port becomes part of the redirect URI pi sends, so only a real port is passed on.
    const port = config.oauth?.callbackPort
    if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return 'oauth.callbackPort'
  }
  return undefined
}

/** pi's timeout is in seconds and arms a timer in ms, which fires at once past the 32-bit
 * limit, so the budget is capped below it. */
function timeoutSeconds(config: ServerConfig): number {
  return Math.min(Math.ceil(callBudgetMs(config) / 1000), Math.floor(MAX_TIMER_MS / 1000))
}

/** The config pi connects for this server, or the reason pi-code keeps it: pi has no SSE
 * or WebSocket transport, no header helper, and accepts only [A-Za-z0-9_-] names. */
export function toNativeServer(name: string, config: ServerConfig, session?: SessionDirs, env: NodeJS.ProcessEnv = process.env): NativeTranslation {
  const reason = unsupported(config)
  if (reason) return { reason }
  const registered = nativeName(name, config)
  if (!NATIVE_NAME.test(registered)) return { reason: 'server name' }
  const fill = (value: string): string => interpolateEnv(value, env)
  const transport = 'url' in config ? httpConfig(config, fill, env) : stdioConfig(config, fill, session)
  return { native: { name: registered, config: { ...transport, exposure: 'direct', timeout: timeoutSeconds(config) } as McpServerConfig } }
}

/** Whether pi connects the servers: its API exists (pi 0.99 and later) and no MCP policy
 * is configured. pi also connects the servers in its own mcp.json files, which Claude's
 * managed-mcp.json and allow and deny lists would not reach, so a policy keeps pi-code's
 * own client for everything. */
export function nativeMode(api: object, managed: unknown, policy: McpPolicy): boolean {
  if (typeof (api as { registerMcpServer?: unknown }).registerMcpServer !== 'function') return false
  return managed === null && policy.allowed === null && policy.denied.length === 0
}

/** Whether pi's own /mcp is loaded, i.e. its MCP extension was neither disabled
 * (`-builtin:mcp`) nor replaced by another extension's /mcp. */
export function piMcpRunning(commands: ReadonlyArray<{ name: string; sourceInfo?: { path?: string } }>): boolean {
  return commands.some((command) => command.name === 'mcp' && command.sourceInfo?.path === 'builtin:mcp')
}

/** pi's MCP tools already carry Claude's mcp__<server>__<tool> names, so each is its own alias. */
export function nativeToolAliases(tools: ReadonlyArray<{ name: string }>): McpToolAlias[] {
  return tools.filter((tool) => tool.name.startsWith('mcp__')).map((tool) => ({ pi: tool.name, claude: tool.name }))
}
