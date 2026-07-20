/**
 * MCP Adapter Extension
 *
 * Connects MCP (Model Context Protocol) servers from mcp.json and registers
 * their tools in pi as `<server>_<tool>`. Async factory connects eagerly at
 * startup (per-server timeout, failures skip with a notice); stdio and HTTP
 * (streamable with SSE fallback) transports; /mcp shows status.
 *
 * Reads Claude Code's MCP config too. Merge order (later wins): ~/.claude.json,
 * ~/.pi/agent/mcp.json, .mcp.json, then .pi/mcp.json. User config connects at
 * startup; project config (.mcp.json / .pi/mcp.json) can run arbitrary commands,
 * so it connects only once the project is trusted.
 * Values support ${VAR} environment interpolation.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
// SSE is deprecated in favour of Streamable HTTP, but the SDK notes servers still on
// the old spec exist, so this stays as a fallback for the migration period.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js' // NOSONAR
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Type } from 'typebox'

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 120_000
const MAX_INLINE_RESULT = 50_000
// pi's built-in tool names must never be shadowed by an MCP tool
const RESERVED_NAMES = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'mcp'])

export interface StdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface HttpServerConfig {
  url: string
  headers?: Record<string, string>
  bearerToken?: string
  bearerTokenEnv?: string
}

export type ServerConfig = StdioServerConfig | HttpServerConfig

export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? '')
}

/** User-scoped MCP config (the user's own; safe to load without project trust). */
export function userConfigPaths(home: string): string[] {
  return [path.join(home, '.claude.json'), path.join(home, '.pi', 'agent', 'mcp.json')]
}

/** Project-scoped MCP config. Loaded only for trusted projects: a server's `command` runs on connect. */
export function projectConfigPaths(cwd: string): string[] {
  return [path.join(cwd, '.mcp.json'), path.join(cwd, '.pi', 'mcp.json')]
}

/** All config files, later winning: user first, then project. */
export function configPaths(cwd: string, home: string): string[] {
  return [...userConfigPaths(home), ...projectConfigPaths(cwd)]
}

export function loadConfig(cwd: string): Record<string, ServerConfig> {
  return loadConfigFrom(configPaths(cwd, os.homedir()))
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
  if (!content || content.length === 0) {
    return [{ type: 'text', text: structured !== undefined ? JSON.stringify(structured, null, 2) : '(empty result)' }]
  }
  return content.map((block) => {
    if (block.type === 'text') {
      const text = block.text ?? ''
      return text.length > MAX_INLINE_RESULT ? { type: 'text', text: `${text.slice(0, MAX_INLINE_RESULT)}\n[truncated ${text.length - MAX_INLINE_RESULT} chars]` } : { type: 'text', text }
    }
    if (block.type === 'image' && block.data) {
      return { type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' }
    }
    if (block.type === 'resource' && block.resource) {
      return { type: 'text', text: `[Resource: ${block.resource.uri ?? 'unknown'}]\n${block.resource.text ?? ''}` }
    }
    return { type: 'text', text: JSON.stringify(block) }
  })
}

function isStdio(config: ServerConfig): config is StdioServerConfig {
  return 'command' in config
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
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    for (const [key, value] of Object.entries(config.env ?? {})) env[key] = interpolateEnv(value)
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env,
      cwd: config.cwd?.replace(/^~(?=\/|$)/, os.homedir()),
      stderr: 'ignore',
    })
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${name}`)
    return client
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = interpolateEnv(value)
  const token = config.bearerToken ?? (config.bearerTokenEnv ? process.env[config.bearerTokenEnv] : undefined)
  if (token) headers.Authorization = `Bearer ${token}`
  const url = new URL(interpolateEnv(config.url))
  try {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } })
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${name}`)
    return client
  } catch (error) {
    if (String(error).includes('Unauthorized')) throw error
    const fallback = new Client({ name: 'pi-code-mcp', version: '0.1.0' })
    const transport = new SSEClientTransport(url, { requestInit: { headers } }) // NOSONAR: deliberate legacy fallback
    await withTimeout(fallback.connect(transport), CONNECT_TIMEOUT_MS, `connect ${name} (sse)`)
    return fallback
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
              const result = await withTimeout(client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }), CALL_TIMEOUT_MS, toolName)
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

  // User config is the user's own, so connect it eagerly.
  await connectServers(loadConfigFrom(userConfigPaths(os.homedir())))

  let projectConnected = false
  pi.on('session_start', async (_event, ctx) => {
    // A project .mcp.json can run arbitrary commands on connect, so only honor it once the project is trusted.
    if (!projectConnected && ctx.isProjectTrusted?.()) {
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
