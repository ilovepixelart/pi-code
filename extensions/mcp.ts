/**
 * MCP Adapter Extension
 *
 * Connects MCP (Model Context Protocol) servers and registers their tools in pi
 * as `<server>_<tool>`. Connects on `session_start`, not from the factory (pi runs
 * the factory for invocations that never start a session); per-server timeout,
 * failures skip with a notice; stdio and HTTP (streamable with SSE fallback)
 * transports; /mcp shows status.
 *
 * Reads Claude Code's MCP config too. User config (~/.claude.json,
 * ~/.pi/agent/mcp.json) is the user's own and loads on the first session. Project
 * config (.mcp.json, .pi/mcp.json) can run arbitrary commands on connect, so it
 * loads only once the project is approved (see project-approval). The two scopes
 * are loaded separately, not merged; user config connects first, so a project
 * server cannot take the name of a user server that connected.
 * Values support ${VAR} interpolation, and a stdio server receives only the SDK's
 * default environment plus its own `env` block, not the whole process environment.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
// SSE is deprecated in favour of Streamable HTTP, but the SDK notes servers still on
// the old spec exist, so this stays as a fallback for the migration period.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js' // NOSONAR
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Type } from 'typebox'
import { capForContext } from './internal/output-guard.js'
import { isProjectApproved } from './internal/project-approval.js'

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 120_000
// Tool names an MCP server must never take over. formatToolName always emits
// `<server>_<tool>`, so only names containing an underscore are actually reachable:
// pi's own built-ins (read, bash, edit, ...) cannot be produced and are not listed.
// These are pi-code's own tools, and mcp.ts registers before the extensions owning
// them, so without this guard a server named `web` would replace the SSRF-checked fetch.
const RESERVED_NAMES = new Set(['web_fetch', 'web_search', 'plan_mode_complete'])

export interface StdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface HttpServerConfig {
  type?: 'http' | 'streamable-http' | 'sse'
  url: string
  headers?: Record<string, string>
  bearerToken?: string
  bearerTokenEnv?: string
}

export type ServerConfig = StdioServerConfig | HttpServerConfig

/** Claude's .mcp.json expansion: ${VAR}, and ${VAR:-default}. The syntax borrows
 * shell's `:-`, which substitutes when the variable is unset OR empty. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)(:-([^}]*))?\}/g, (_, name, hasDefault, fallback) => {
    const current = env[name]
    if (hasDefault !== undefined) return current || fallback
    return current ?? ''
  })
}

/** User-scoped MCP config (the user's own; safe to load without project trust). */
export function userConfigPaths(home: string): string[] {
  return [path.join(home, '.claude.json'), path.join(home, '.pi', 'agent', 'mcp.json')]
}

/** Project-scoped MCP config. Loaded only for trusted projects: a server's `command` runs on connect. */
export function projectConfigPaths(cwd: string): string[] {
  return [path.join(cwd, '.mcp.json'), path.join(cwd, '.pi', 'mcp.json')]
}

export function loadConfigFrom(files: string[]): Record<string, ServerConfig> {
  const servers: Record<string, ServerConfig> = {}
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      Object.assign(servers, parsed.mcpServers ?? {})
    } catch {
      // missing or invalid file: skip silently, /mcp reports what loaded
    }
  }
  return servers
}

export function formatToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replaceAll('-', '_')
}

export function normalizeSchema(schema: unknown): object {
  const base = (schema as Record<string, unknown>) ?? {}
  const { $schema: _dropSchema, additionalProperties: _dropAdditional, ...rest } = base
  if (!rest.type) return { type: 'object', properties: {} }
  return rest
}

interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri?: string; text?: string }
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export function mapContent(content: McpContentBlock[] | undefined, structured?: unknown): ToolContent[] {
  // capForContext every text output, whatever its source: a server can blow the tool-output
  // budget through a resource block, a JSON-stringified block, or the structured fallback,
  // not only a text block.
  const text = (value: string): ToolContent => ({ type: 'text', text: capForContext(value) })
  if (!content || content.length === 0) {
    return [text(structured !== undefined ? JSON.stringify(structured, null, 2) : '(empty result)')]
  }
  return content.map((block) => {
    if (block.type === 'text') {
      return text(block.text ?? '')
    }
    if (block.type === 'image' && block.data) {
      return { type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' }
    }
    if (block.type === 'resource' && block.resource) {
      return text(`[Resource: ${block.resource.uri ?? 'unknown'}]\n${block.resource.text ?? ''}`)
    }
    return text(JSON.stringify(block))
  })
}

function isStdio(config: ServerConfig): config is StdioServerConfig {
  // An explicit type wins; without one, a command field means stdio.
  return 'command' in config && (config.type === undefined || config.type === 'stdio')
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

async function connect(name: string, config: ServerConfig): Promise<Client> {
  const client = new Client({ name: 'pi-code-mcp', version: '0.1.0' })
  if (isStdio(config)) {
    // Start from the SDK's allowlist (PATH, HOME, SHELL, ...) rather than the whole
    // process env: a server should not receive ANTHROPIC_API_KEY or GITHUB_TOKEN just
    // for being launched. A server that needs a variable names it in its own env block.
    const env: Record<string, string> = { ...getDefaultEnvironment() }
    for (const [key, value] of Object.entries(config.env ?? {})) env[key] = interpolateEnv(value)
    const transport = new StdioClientTransport({
      command: interpolateEnv(config.command),
      args: (config.args ?? []).map((arg) => interpolateEnv(arg)),
      env,
      cwd: config.cwd?.replace(/^~(?=\/|$)/, os.homedir()),
      stderr: 'ignore',
    })
    await connectWithTimeout(client, transport, `connect ${name}`)
    return client
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = interpolateEnv(value)
  const token = config.bearerToken ? interpolateEnv(config.bearerToken) : config.bearerTokenEnv ? process.env[config.bearerTokenEnv] : undefined
  if (token) headers.Authorization = `Bearer ${token}`
  const url = new URL(interpolateEnv(config.url))
  if (config.type === 'sse') {
    const transport = new SSEClientTransport(url, { requestInit: { headers } }) // NOSONAR: explicitly declared legacy transport
    await connectWithTimeout(client, transport, `connect ${name} (sse)`)
    return client
  }
  try {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } })
    await connectWithTimeout(client, transport, `connect ${name}`)
    return client
  } catch (error) {
    // An explicitly declared streamable transport must not silently degrade to SSE.
    if (config.type !== undefined || String(error).includes('Unauthorized')) throw error
    const fallback = new Client({ name: 'pi-code-mcp', version: '0.1.0' })
    const transport = new SSEClientTransport(url, { requestInit: { headers } }) // NOSONAR: deliberate legacy fallback
    await connectWithTimeout(fallback, transport, `connect ${name} (sse)`)
    return fallback
  }
}

/**
 * Connect with a deadline, closing the client if the deadline (not a connect error) wins.
 * Without this, a slow-but-successful server finishes connecting after the race is lost and
 * lingers unreferenced: process/socket alive, never in `clients`, invisible to shutdown.
 */
async function connectWithTimeout(client: Client, transport: Parameters<Client['connect']>[0], label: string): Promise<void> {
  const connecting = client.connect(transport)
  try {
    await withTimeout(connecting, CONNECT_TIMEOUT_MS, label)
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

async function listAllTools(client: Client): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = []
  let cursor: string | undefined
  do {
    const page = await client.listTools({ cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

export default async function mcpExtension(pi: ExtensionAPI) {
  const clients = new Map<string, Client>()
  const status = new Map<string, { state: string; tools: number }>()
  const registered = new Set<string>()

  async function connectServers(servers: Record<string, ServerConfig>): Promise<void> {
    for (const [name, config] of Object.entries(servers)) {
      // A later scope must not take the name of a server that already connected: it
      // would evict that client from the map, leaking it at shutdown, and misreport
      // the earlier server's status.
      if (clients.has(name)) {
        console.warn(`pi-code-mcp: skipping duplicate server name ${name}`)
        continue
      }
      try {
        const client = await connect(name, config)
        clients.set(name, client)
        const tools = await withTimeout(listAllTools(client), CONNECT_TIMEOUT_MS, `list tools ${name}`)
        let count = 0
        for (const tool of tools) {
          const toolName = formatToolName(name, tool.name)
          if (RESERVED_NAMES.has(toolName) || registered.has(toolName)) {
            console.warn(`pi-code-mcp: skipping colliding tool name ${toolName}`)
            continue
          }
          registered.add(toolName)
          count++
          pi.registerTool({
            name: toolName,
            label: `${name}: ${tool.name}`,
            description: tool.description ?? `MCP tool ${tool.name} from ${name}`,
            parameters: Type.Unsafe(normalizeSchema(tool.inputSchema)),
            async execute(_id, params) {
              // Pass the timeout to the SDK too: its own default request timeout is 60s and
              // would otherwise reject first, so the outer race at CALL_TIMEOUT_MS was dead.
              const result = await withTimeout(client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { timeout: CALL_TIMEOUT_MS }), CALL_TIMEOUT_MS, toolName)
              const content = mapContent(result.content as McpContentBlock[], result.structuredContent)
              const details: { error?: string } = {}
              if (result.isError) {
                details.error = 'tool_error'
                const hint = JSON.stringify(normalizeSchema(tool.inputSchema))
                content.push({ type: 'text', text: `Tool reported an error. Expected input schema: ${hint}` })
              }
              return { content, details }
            },
          })
        }
        status.set(name, { state: 'connected', tools: count })
      } catch (error) {
        status.set(name, { state: `failed: ${error instanceof Error ? error.message : String(error)}`, tools: 0 })
      }
    }
  }

  let userConnected = false
  let projectConnected = false

  pi.on('session_start', async (_event, ctx) => {
    // Connecting spawns processes and opens sockets, so it belongs here rather than in
    // the factory: pi runs the factory for invocations that never start a session.
    if (!userConnected) {
      userConnected = true
      await connectServers(loadConfigFrom(userConfigPaths(os.homedir())))
    }
    // A project .mcp.json can run arbitrary commands on connect, so only honor it once the project is trusted.
    // isProjectTrusted alone is true for a repo pi never asked about; see project-approval.
    if (!projectConnected && (await isProjectApproved(ctx))) {
      projectConnected = true
      await connectServers(loadConfigFrom(projectConfigPaths(ctx.cwd)))
    }

    const connected = [...status.values()].filter((s) => s.state === 'connected')
    const failed = [...status.entries()].filter(([, s]) => s.state !== 'connected')
    if (connected.length > 0 || failed.length > 0) {
      const total = connected.reduce((sum, s) => sum + s.tools, 0)
      const failNote = failed.length > 0 ? `, ${failed.length} failed` : ''
      ctx.ui.notify(`MCP: ${total} tools from ${connected.length} servers${failNote}`, failed.length > 0 ? 'warning' : 'info')
    }
  })

  pi.on('session_shutdown', async () => {
    // Close in parallel with a per-client timeout so one hung server can't stall pi's exit.
    await Promise.all([...clients.values()].map((client) => withTimeout(client.close(), 3000, 'close').catch(() => {})))
  })

  pi.registerCommand('mcp', {
    description: 'Show MCP server status and tools',
    handler: async (_args, ctx) => {
      if (status.size === 0) {
        ctx.ui.notify('No MCP servers configured. Add them to .mcp.json, .pi/mcp.json, ~/.claude.json, or ~/.pi/agent/mcp.json', 'info')
        return
      }
      const lines = [...status.entries()].map(([name, s]) => `${name}: ${s.state} (${s.tools} tools)`)
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}
