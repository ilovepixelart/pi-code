/**
 * MCP Adapter Extension
 *
 * Connects MCP (Model Context Protocol) servers and registers their tools in pi
 * as `<server>_<tool>`. Connects on `session_start`, not from the factory (pi runs
 * the factory for invocations that never start a session); per-server timeout,
 * failures skip with a notice; stdio and HTTP (streamable with SSE fallback)
 * transports; /mcp shows status.
 *
 * Reads Claude Code's MCP config too. User config (~/.claude.json top-level plus its
 * per-project `projects[cwd].mcpServers` local scope, and ~/.pi/agent/mcp.json) is the
 * user's own and loads on the first session. Project config (.mcp.json, .pi/mcp.json)
 * can run arbitrary commands on connect, so it loads only once the project is approved
 * (see project-approval). The two scopes are loaded separately, not merged. Claude's
 * precedence is project over user for a duplicate name, so a project server the user has
 * consented to (or an approved project's) wins; a merely-present untrusted project entry
 * cannot shadow a user server, and a gated project server does not preempt it.
 * Values support ${VAR} / ${VAR:-default} interpolation, connect and per-call timeouts
 * honor MCP_TIMEOUT / MCP_TOOL_TIMEOUT, and a stdio server receives only the SDK's default
 * environment plus its own `env` block, not the whole process environment.
 *
 * Servers advertising the `prompts` capability get their prompts registered as Claude's
 * /mcp__<server>__<prompt> slash commands (server-name characters outside A-Za-z0-9_-
 * fold to underscores, args split on whitespace and mapped positionally, one token
 * per declared argument); the prompt result drives a turn via
 * sendUserMessage, exactly how custom slash commands do. Servers advertising `resources`
 * make the global list_mcp_resources / read_mcp_resource tools available, mirroring
 * Claude's automatic resource tools. Resource and prompt output rides the same
 * mapContent/capForContext budget as tool output. That budget is byte/line based
 * (pi's DEFAULT_MAX_BYTES in the shared output guard); Claude's MAX_MCP_OUTPUT_TOKENS
 * is a token budget and cannot be folded into it without making the guard token-aware,
 * so the byte cap stands in for it.
 */

import * as os from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { Type } from 'typebox'
import { MCP_TOOLS_CHANNEL, type McpToolAlias } from '../internal/mcp-alias.js'
import { setMcpToolCaller } from '../internal/mcp-call.js'
import { capForContext } from '../internal/output-guard.js'
import { installedPlugins } from '../internal/plugins.js'
import { isProjectApproved, isProjectApprovedSilently } from '../internal/project-approval.js'
import { repoRoot } from '../internal/project-root.js'
import { claudeSettingsChain } from '../internal/settings-chain.js'
import { errorMessage } from '../internal/values.js'
import { disabledServerNames, loadConfigFrom, loadPluginServers, loadUserScope, localScopeServerNames, projectConfigPaths, type ServerConfig, warnOnTypelessUrl } from './config.js'
import { collectServerResourceEntries, listAllPrompts, listAllTools, type McpToolInfo, resourceServerFilter } from './listing.js'
import { formatPromptCommandName, formatToolName, type McpContentBlock, type McpPromptInfo, mapContent, mapPromptArguments, normalizeSchema, promptMessageContent } from './mapping.js'
import { applyServerPolicy, loadManagedMcpServers, type McpPolicy, mcpAllowDeny, projectServerPolicy, splitByPolicy } from './policy.js'
import { type AuthUi, callRequestOptions, callTimeoutMs, connect, connectTimeoutMs, connectWithRetries, isUnauthorized, mcpConnectTimeoutMs, type ServerCallTuning, type SessionDirs, serverCallTuning, withTimeout } from './transport.js'

export { managedSettingsPath, setManagedSettingsPath } from '../internal/managed-settings.js'
// Re-exports for consumers: the module split keeps the extension's public surface
// (imported by the test suite) reachable from this entry point unchanged. The managed
// settings path helpers now live in the shared internal module.
export type { HttpServerConfig, ServerConfig, StdioServerConfig } from './config.js'
export { expandCwd, interpolateEnv, loadConfigFrom, loadPluginServers, loadUserScope, projectConfigPaths, userConfigPaths, warnOnTypelessUrl } from './config.js'
export type { McpToolInfo } from './listing.js'
export type { McpPromptArgumentInfo, McpPromptInfo, ToolContent } from './mapping.js'
export { capTotal, formatPromptCommandName, formatToolName, mapContent, mapPromptArguments, normalizeSchema, promptMessageContent } from './mapping.js'
export type { ProjectServerPolicy } from './policy.js'
export { applyServerPolicy, loadManagedMcpServers, type McpPolicy, type McpPolicyEntry, managedMcpPath, mcpAllowDeny, projectServerPolicy, splitByPolicy, urlPatternMatches } from './policy.js'
export type { AuthUi } from './transport.js'
export { parseHelperHeaders, resolveBearerToken } from './transport.js'

// Tool names an MCP server must never take over. formatToolName always emits
// `<server>_<tool>`, so only names containing an underscore are actually reachable:
// pi's own built-ins (read, bash, edit, ...) cannot be produced and are not listed.
// These are pi-code's own tools, and mcp.ts registers before the extensions owning
// them, so without this guard a server named `web` would replace the SSRF-checked fetch.
// The resource tools are this extension's own globals; a server named `list` or `read`
// must not take their names either.
const RESERVED_NAMES = new Set(['web_fetch', 'web_search', 'plan_mode_complete', 'list_mcp_resources', 'read_mcp_resource'])

/** The OAuth flow's UI seams, absent in headless runs. */
function authUiFor(ctx: ExtensionContext): AuthUi | undefined {
  if (!ctx.hasUI) return undefined
  return {
    confirm: (title, body) => ctx.ui.confirm(title, body),
    notify: (message, level) => ctx.ui.notify(message, level),
  }
}

export default async function mcpExtension(pi: ExtensionAPI) {
  const clients = new Map<string, Client>()
  // The session's OAuth UI seams, captured at session_start. The reconnect paths below
  // run outside that handler, and passing undefined there made an INTERACTIVE session
  // report the headless "cannot log in" advice on a re-auth it could actually perform.
  let sessionAuthUi: AuthUi | undefined
  const status = new Map<string, { state: string; tools: number }>()
  // Config per server name, kept for call-time timeout tuning: the idle tier follows
  // the transport kind, and a declared per-server timeout governs the wall budget.
  const serverConfigs = new Map<string, ServerConfig>()
  // The session's directories, set at session_start before any connect: the launch
  // directory answers roots/list, the project root feeds CLAUDE_PROJECT_DIR.
  let sessionDirs: SessionDirs | undefined
  // Shutdown closes clients while they are still in the map; the onclose handlers
  // must not schedule reconnects for that deliberate teardown.
  let shuttingDown = false
  const callTuning = (name: string): ServerCallTuning => {
    const config = serverConfigs.get(name)
    return config ? serverCallTuning(config) : {}
  }
  // Let other extensions (hooks' mcp_tool type) call a connected server's tool.
  // The same 401/403 reconnect-and-retry-once as registered tools, when the
  // server's config is known; a name with no stored config calls through once.
  setMcpToolCaller(async (server, tool, input) => {
    const config = serverConfigs.get(server)
    const result = config
      ? await callToolWithAuthRetry(server, config, { name: tool, arguments: input }, `${server}: ${tool}`)
      : await (async () => {
          const client = clients.get(server)
          if (!client) throw new Error(`MCP server "${server}" is not connected`)
          return await client.callTool({ name: tool, arguments: input }, undefined, callRequestOptions(callTimeoutMs()))
        })()
    const text = mapContent(result.content as McpContentBlock[], result.structuredContent)
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    return { text, isError: result.isError === true }
  })
  // pi tool name -> owning server, so a refresh can tell its own tools from a conflict.
  const registered = new Map<string, string>()
  // Original server/tool names per registered pi name, for Claude-style hook matchers.
  const aliases: McpToolAlias[] = []

  /** How many tools a server actually has registered. Counted from `registered` (the
   * durable owner map) rather than registerTools' return, so a reconnect on a second
   * session, where every tool is already registered and registerTools adds 0, still
   * reports the true count in /mcp and the startup banner instead of zero. */
  const serverToolCount = (name: string): number => [...registered.values()].filter((owner) => owner === name).length

  /** Register every not-yet-registered tool of a server; returns how many were added. */
  function registerTools(name: string, config: ServerConfig, tools: McpToolInfo[]): number {
    let count = 0
    for (const tool of tools) {
      // A plugin server's registry key carries its plugin: scope; its tools keep the bare
      // server name, as their Claude alias does.
      const toolName = formatToolName(config.baseName ?? name, tool.name)
      const owner = registered.get(toolName)
      if (owner === name) continue // already registered for this server: a refresh re-listing it
      if (RESERVED_NAMES.has(toolName) || owner !== undefined) {
        console.warn(`pi-code-mcp: skipping colliding tool name ${toolName}`)
        continue
      }
      registered.set(toolName, name)
      aliases.push({ pi: toolName, claude: config.aliasPrefix ? `${config.aliasPrefix}${tool.name}` : `mcp__${name}__${tool.name}` })
      count++
      pi.registerTool({
        name: toolName,
        label: `${name}: ${tool.name}`,
        description: tool.description ?? `MCP tool ${tool.name} from ${name}`,
        parameters: Type.Unsafe(normalizeSchema(tool.inputSchema)),
        async execute(_id, params) {
          // Resolve the live client by name at call time rather than capturing the one
          // present at registration: pi has no tool unregister, so after a server drops
          // and a later session_start reconnects it, registerTools skips re-registration
          // and this closure would otherwise keep calling the old, closed client.
          // The per-server timeout (Claude's, 1s floor) or MCP_TOOL_TIMEOUT is the
          // wall-clock ceiling; callRequestOptions layers the idle timeout under it, which
          // the SDK enforces (resetting on progress). The outer race uses the wall
          // budget, never the idle window, so a progressing call is not cut off at the
          // idle timeout. A 401/403 reconnects once (fresh helper headers or refreshed
          // OAuth tokens) and retries once.
          const result = await callToolWithAuthRetry(name, config, { name: tool.name, arguments: params as Record<string, unknown> }, toolName)
          const content = mapContent(result.content as McpContentBlock[], result.structuredContent)
          const details: { error?: string } = {}
          if (result.isError) {
            details.error = 'tool_error'
            const hint = JSON.stringify(normalizeSchema(tool.inputSchema))
            content.push({ type: 'text', text: capForContext(`Tool reported an error. Expected input schema: ${hint}`) })
          }
          return { content, details }
        },
      })
    }
    return count
  }

  /** Claude's mid-session reconnect for a dropped remote server: five attempts with
   * a delay doubling from one second. connectServers redoes the full bring-up
   * (tools, prompts, subscriptions, a fresh onclose) and its duplicate guard skips
   * out if another path already reconnected the name. Uses the session's authUi, so a
   * server that now needs a login can prompt for it in an interactive session; headless
   * still ends failed, and after the fifth failure the last attempt's failed status
   * stands, with a session restart as the manual retry. */
  async function reconnectWithBackoff(name: string, config: ServerConfig): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      if (shuttingDown || clients.has(name)) return
      await connectServers({ [name]: config }, sessionAuthUi, true)
      if (clients.has(name)) return
    }
  }

  /** Claude's 401/403 tool-call recovery: drop the client and reconnect once, so the
   * headersHelper re-runs (fresh credential) or the OAuth tokens refresh, then the
   * caller retries the call once. The map delete precedes the close so the onclose
   * guard does not also schedule a backoff reconnect. */
  async function reconnectForAuth(name: string, config: ServerConfig): Promise<void> {
    const old = clients.get(name)
    if (old) {
      clients.delete(name)
      await withTimeout(old.close(), 3000, 'close').catch(() => {})
    }
    await connectServers({ [name]: config }, sessionAuthUi, true)
  }

  /** A tool call with the auth retry: on a 401/403 rejection, reconnect once and
   * retry once; a second auth failure surfaces to the caller. */
  async function callToolWithAuthRetry(name: string, config: ServerConfig, args: { name: string; arguments: Record<string, unknown> }, label: string): Promise<Awaited<ReturnType<Client['callTool']>>> {
    const tuning = serverCallTuning(config)
    const wall = tuning.serverTimeoutMs ?? callTimeoutMs()
    const callOnce = async () => {
      const current = clients.get(name)
      if (!current) throw new Error(`MCP server "${name}" is not connected`)
      return await withTimeout(current.callTool(args, undefined, callRequestOptions(wall, tuning)), wall, label)
    }
    try {
      return await callOnce()
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      await reconnectForAuth(name, config)
      return await callOnce()
    }
  }

  // Prompt command name -> the server and prompt that own it, so a refresh re-listing
  // the same prompt is told apart both from a cross-server collision and from a second
  // prompt on the same server whose name normalizes to the one already taken (e.g.
  // `deploy-prod` and `deploy_prod`), mirroring `registered` for tools.
  const registeredPrompts = new Map<string, { server: string; prompt: string }>()

  /** Register a slash command for every not-yet-registered prompt of a server. pi has
   * no command unregister, so, like tools, a withdrawn prompt keeps its registration
   * and surfaces the server's own error when invoked; an edit to a prompt's declared
   * arguments only lands on new names, since an existing command keeps its binding. */
  function registerPrompts(name: string, prompts: McpPromptInfo[]): void {
    for (const prompt of prompts) {
      const commandName = formatPromptCommandName(name, prompt.name)
      const owner = registeredPrompts.get(commandName)
      if (owner) {
        if (owner.server === name && owner.prompt === prompt.name) continue // a refresh re-listing the same prompt
        console.warn(`pi-code-mcp: skipping colliding prompt command ${commandName}`)
        continue
      }
      registeredPrompts.set(commandName, { server: name, prompt: prompt.name })
      const hint = (prompt.arguments ?? []).map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)).join(' ')
      const base = prompt.description ?? `MCP prompt ${prompt.name} from ${name}`
      pi.registerCommand(commandName, {
        description: hint ? `${base} ${hint}` : base,
        handler: async (args, ctx) => {
          try {
            // Resolve the live client at call time, not the one captured at registration:
            // pi has no command unregister, so after a reconnect this closure must not keep
            // calling the old, closed client (see registerTools for the same reason).
            const current = clients.get(name)
            if (!current) {
              ctx.ui.notify(`${commandName}: MCP server "${name}" is not connected`, 'error')
              return
            }
            const promptArgs = mapPromptArguments(prompt.arguments, args)
            const params: { name: string; arguments?: Record<string, string> } = { name: prompt.name }
            if (Object.keys(promptArgs).length > 0) params.arguments = promptArgs
            const wall = callTimeoutMs()
            const result = await withTimeout(current.getPrompt(params, callRequestOptions(wall, callTuning(name))), wall, commandName)
            // The prompt drives a turn exactly the way a custom slash command does
            // (see commands.ts), carrying its image blocks through. A prompt that
            // yields no content is reported rather than sent as an empty turn.
            const content = promptMessageContent(result.messages)
            if (content.length === 0) {
              ctx.ui.notify(`${commandName}: prompt returned no content`, 'info')
              return
            }
            // A bare send throws (and is silently swallowed) while the agent is
            // streaming, so mid-stream invocations queue as a follow-up turn.
            pi.sendUserMessage(content, ctx.isIdle() ? {} : { deliverAs: 'followUp' })
          } catch (error) {
            ctx.ui.notify(`${commandName}: ${errorMessage(error)}`, 'error')
          }
        },
      })
    }
  }

  /** Claude exposes prompts as slash commands only for servers advertising the
   * prompts capability; a listing failure loses the prompts, not the server. */
  async function connectPrompts(name: string, client: Client): Promise<void> {
    if (!client.getServerCapabilities()?.prompts) return
    try {
      registerPrompts(name, await withTimeout(listAllPrompts(client), connectTimeoutMs(), `list prompts ${name}`))
    } catch (error) {
      console.warn(`pi-code-mcp: prompt listing failed for ${name}: ${errorMessage(error)}`)
    }
  }

  /** Mirror of subscribeToToolChanges for the prompt list: a newly announced prompt
   * registers without a restart, a withdrawn one keeps its registration. */
  function subscribeToPromptChanges(name: string, client: Client): void {
    try {
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        try {
          registerPrompts(name, await withTimeout(listAllPrompts(client), connectTimeoutMs(), `list prompts ${name}`))
        } catch (error) {
          console.warn(`pi-code-mcp: prompt refresh failed for ${name}: ${errorMessage(error)}`)
        }
      })
    } catch {
      // a transport or client without notification support simply never refreshes
    }
  }

  /** Servers currently connected that advertise the resources capability. */
  const resourceServers = (): Array<[string, Client]> => [...clients.entries()].filter(([, client]) => Boolean(client.getServerCapabilities()?.resources))

  let resourceToolsRegistered = false

  /** Claude auto-provides tools to list and read MCP resources when servers support
   * them. Registered once, globally, the first time a connected server advertises the
   * resources capability: the tools span servers, taking the server name as an
   * argument, so per-server registration would only produce duplicates. Listings are
   * fetched live on every call, so a resources list_changed needs no cache
   * invalidation; its handler only re-checks this gate (see subscribeToResourceChanges). */
  function ensureResourceTools(): void {
    if (resourceToolsRegistered || resourceServers().length === 0) return
    resourceToolsRegistered = true
    pi.registerTool({
      name: 'list_mcp_resources',
      label: 'List MCP resources',
      description: 'List available resources and resource templates from connected MCP servers. Optionally filter to a single server by name.',
      parameters: Type.Object({ server: Type.Optional(Type.String({ description: 'Only list resources from this server' })) }),
      async execute(_id, params) {
        const filter = resourceServerFilter(params)
        if (filter && !clients.has(filter)) throw new Error(`MCP server "${filter}" is not connected`)
        const entries: Array<Record<string, unknown>> = []
        for (const [name, client] of resourceServers()) {
          if (filter && name !== filter) continue
          await collectServerResourceEntries(entries, name, client, callTimeoutMs())
        }
        return { content: mapContent([{ type: 'text', text: JSON.stringify(entries, null, 2) }]), details: {} }
      },
    })
    pi.registerTool({
      name: 'read_mcp_resource',
      label: 'Read MCP resource',
      description: 'Read a resource from a connected MCP server by URI.',
      parameters: Type.Object({ server: Type.String({ description: 'The MCP server name' }), uri: Type.String({ description: 'The resource URI to read' }) }),
      async execute(_id, params) {
        const { server, uri } = params as { server: string; uri: string }
        const client = clients.get(server)
        if (!client) throw new Error(`MCP server "${server}" is not connected`)
        const wall = callTimeoutMs()
        const result = await withTimeout(client.readResource({ uri }, callRequestOptions(wall, callTuning(server))), wall, `read ${uri}`)
        const blocks = (result.contents as Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>).map((entry): McpContentBlock => {
          if (typeof entry.text === 'string') return { type: 'resource', resource: { uri: entry.uri, text: entry.text } }
          if (entry.blob && entry.mimeType?.startsWith('image/')) return { type: 'image', data: entry.blob, mimeType: entry.mimeType }
          // Non-image binary has no useful text form; a placeholder beats megabytes
          // of base64 reaching the model as JSON.
          return { type: 'text', text: `[Binary resource ${entry.uri} (${entry.mimeType ?? 'unknown type'})]` }
        })
        return { content: mapContent(blocks), details: {} }
      },
    })
  }

  /** Resource listings are fetched live per call, so the notification has no cache to
   * invalidate; re-checking the registration gate covers a server whose capabilities
   * settled after the connect-time check. */
  function subscribeToResourceChanges(client: Client): void {
    try {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        ensureResourceTools()
      })
    } catch {
      // a transport or client without notification support simply never refreshes
    }
  }

  /** Claude refreshes tools on a server's list_changed notification. pi has no
   * unregister, so a withdrawn tool keeps its registration and surfaces the server's
   * own error when called; a newly announced one is registered without a restart. */
  function subscribeToToolChanges(name: string, config: ServerConfig, client: Client): void {
    try {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          const refreshed = await withTimeout(listAllTools(client), connectTimeoutMs(), `list tools ${name}`)
          const added = registerTools(name, config, refreshed)
          if (added === 0) return
          const current = status.get(name)
          status.set(name, { state: current?.state ?? 'connected', tools: serverToolCount(name) })
          pi.events.emit(MCP_TOOLS_CHANNEL, [...aliases])
        } catch (error) {
          console.warn(`pi-code-mcp: tool refresh failed for ${name}: ${errorMessage(error)}`)
        }
      })
    } catch {
      // a transport or client without notification support simply never refreshes
    }
  }

  async function connectServers(servers: Record<string, ServerConfig>, authUi?: AuthUi, noRetry = false): Promise<void> {
    const pending: [string, ServerConfig][] = []
    for (const [name, config] of Object.entries(servers)) {
      // A later scope must not take the name of a server that already connected: it
      // would evict that client from the map, leaking it at shutdown, and misreport
      // the earlier server's status.
      if (clients.has(name)) {
        console.warn(`pi-code-mcp: skipping duplicate server name ${name}`)
        continue
      }
      // Seed in config order before connecting: parallel connects settle in completion
      // order, and /mcp plus the session summary iterate the map's insertion order.
      status.set(name, { state: 'connecting', tools: 0 })
      serverConfigs.set(name, config)
      pending.push([name, config])
    }
    await Promise.all(
      pending.map(async ([name, config]) => {
        warnOnTypelessUrl(name, config)
        try {
          // First connections retry transient failures (Claude: up to three times for
          // HTTP/SSE); the backoff reconnect below carries its own schedule instead.
          const client = noRetry ? await connect(name, config, authUi, sessionDirs) : await connectWithRetries(name, config, authUi, sessionDirs)
          clients.set(name, client)
          const tools = await withTimeout(listAllTools(client), connectTimeoutMs(), `list tools ${name}`)
          registerTools(name, config, tools)
          subscribeToToolChanges(name, config, client)
          // Prompts and resources are additive surfaces: their failures warn (inside
          // connectPrompts) rather than flipping a tool-serving server to failed.
          await connectPrompts(name, client)
          subscribeToPromptChanges(name, client)
          ensureResourceTools()
          subscribeToResourceChanges(client)
          // Count from `registered`, not registerTools' return: a reconnect re-lists tools
          // that are already registered (return 0) but still serves them, so the banner
          // must reflect the true count.
          status.set(name, { state: 'connected', tools: serverToolCount(name) })
          // A server that dies mid-session would otherwise stay "connected" in /mcp
          // while every call fails with the SDK's bare "Not connected"; flip the
          // status and free the name so a later session start can reconnect it.
          client.onclose = () => {
            if (clients.get(name) !== client) return
            clients.delete(name)
            status.set(name, { state: 'disconnected', tools: 0 })
            // Claude reconnects a dropped remote server with exponential backoff;
            // stdio servers are local processes and are not reconnected. Shutdown
            // closes clients while they are still in the map, so the flag guards
            // against scheduling a reconnect for a deliberate teardown.
            if (!shuttingDown && !serverCallTuning(config).stdio) void reconnectWithBackoff(name, config)
          }
        } catch (error) {
          status.set(name, { state: `failed: ${errorMessage(error)}`, tools: 0 })
          // Connected but failed after (tool listing hung or errored): left in the
          // map, the client idles its process for the whole session and the
          // duplicate-name guard blocks the name for every later attempt.
          const leaked = clients.get(name)
          if (leaked) {
            clients.delete(name)
            void leaked.close().catch(() => {})
          }
        }
      }),
    )
  }

  /** Connect the approval-gated project servers, behind the whole-project confirm.
   * Returns whether the scope is settled, so a refused confirm can be retried on a
   * later session start. The consented half of the project scope connects earlier,
   * concurrently with the user scope, from session_start itself. */
  async function connectGatedProjectServers(ctx: ExtensionContext, gated: Record<string, ServerConfig>, authUi?: AuthUi): Promise<boolean> {
    if (Object.keys(gated).length === 0) return true
    if (!(await isProjectApproved(ctx))) return false
    await connectServers(gated, authUi)
    return true
  }

  let projectConnected = false

  /** managed-mcp.json exclusive mode: a policy deployed mid-process must not leave
   * already-connected user/project servers running alongside the managed set. Evict every
   * connected client not in the managed set (delete it from the map first so the onclose
   * handler's guard sees it gone and does not overwrite the status, then close it
   * best-effort and mark it disabled), then connect only the managed servers. */
  async function connectManagedExclusive(managed: Record<string, ServerConfig>, policy: McpPolicy, authUi?: AuthUi): Promise<void> {
    const managedServers = applyServerPolicy(managed, policy)
    const managedNames = new Set(Object.keys(managedServers))
    for (const [name, client] of Array.from(clients.entries())) {
      if (managedNames.has(name)) continue
      clients.delete(name)
      // Bound the close like session_shutdown does: a hung server must not stall the new
      // session start, which awaits this eviction before connecting the managed set.
      await withTimeout(client.close(), 3000, 'close').catch(() => {})
      status.set(name, { state: 'disabled by managed policy', tools: 0 })
    }
    await connectServers(managedServers, authUi)
  }

  /** The normal user + plugin + project scopes, when no managed-mcp.json is present.
   * Connecting spawns processes and opens sockets, so it belongs here rather than in the
   * factory: pi runs the factory for invocations that never start a session. Names still
   * connected are filtered out, so a later session start only retries servers that failed
   * or whose transport dropped, without duplicate-name warnings. */
  /** A project server's headersHelper, dropped while the project is unapproved. */
  function withoutUntrustedHelper(name: string, config: ServerConfig): ServerConfig {
    if (!('headersHelper' in config) || config.headersHelper === undefined) return config
    console.warn(`pi-code-mcp: headersHelper not run for server ${name}: the project is not trusted yet; connecting with its static headers alone`)
    const { headersHelper: _dropped, ...rest } = config
    return rest as ServerConfig
  }

  async function connectNormalScopes(ctx: ExtensionContext, policy: McpPolicy, authUi?: AuthUi): Promise<void> {
    // Plugin servers merge under the user scope (plugins are user-installed);
    // the user's own entry wins a name clash with a plugin's. A server toggled off
    // in ~/.claude.json's per-project disabledMcpServers list never connects.
    const pluginServers = loadPluginServers(installedPlugins(os.homedir()), repoRoot(ctx.cwd) ?? ctx.cwd)
    const disabled = disabledServerNames(os.homedir(), ctx.cwd)
    const merged = Object.fromEntries(Object.entries({ ...pluginServers, ...loadUserScope(os.homedir(), ctx.cwd) }).filter(([name]) => !disabled.has(name)))
    const scoped = applyServerPolicy(merged, policy)
    // Claude's precedence is project over user for a duplicate name. A project .mcp.json
    // server only outranks the user's own when it will actually connect (the user already
    // consented to it, or an approved project's), so a merely-present untrusted project
    // entry cannot shadow a trusted user server by reusing its name. A gated project
    // server still awaiting the approval prompt does not preempt the user server: that is
    // a deliberate narrowing of Claude's rule to keep the safe default.
    // The stored project decision, read without prompting: consent recorded inside
    // the project only counts once the project itself has been approved.
    const projectApproved = isProjectApprovedSilently(ctx)
    const projectPolicy = projectServerPolicy(ctx.cwd, os.homedir(), projectApproved)
    // Tag the scope on each project server: a repository-supplied headersHelper runs
    // with credential variables stripped, unlike a user-scope one.
    const projectServers = Object.fromEntries(Object.entries(loadConfigFrom(projectConfigPaths(ctx.cwd))).map(([name, config]) => [name, { ...config, projectScope: true }]))
    const { consented: consentedRaw, gated } = splitByPolicy(applyServerPolicy(projectServers, policy), projectPolicy)
    // Claude's scope precedence is local over project: a name the local scope defines
    // stays with the local (user-side) definition, so the project's entry is dropped
    // here rather than allowed to shadow it.
    const localNames = localScopeServerNames(os.homedir(), ctx.cwd)
    // Claude: until the folder is trusted, a project server connects with its static
    // headers alone. Consenting to the server is not consenting to run the command it
    // ships, so the helper is dropped (and named once) while the project is unapproved.
    const consented = Object.fromEntries(
      Object.entries(consentedRaw)
        .filter(([name]) => !localNames.has(name))
        .map(([name, config]) => [name, projectApproved ? config : withoutUntrustedHelper(name, config)]),
    )
    const projectWinners = new Set(Object.keys(consented))
    const userServers = Object.fromEntries(Object.entries(scoped).filter(([name]) => !clients.has(name) && !projectWinners.has(name)))
    // The consented project servers carry no ordering dependency on the user scope:
    // projectWinners already excludes their names from userServers, so the two batches
    // are disjoint and connect concurrently, and startup pays the slower scope rather
    // than the sum of both. Reconnect attempts after a refused confirm are safe:
    // connectServers skips names that already connected.
    const connects: Promise<void>[] = []
    if (Object.keys(userServers).length > 0) connects.push(connectServers(userServers, authUi))
    if (!projectConnected && Object.keys(consented).length > 0) connects.push(connectServers(consented, authUi))
    await Promise.all(connects)
    // A project .mcp.json can run arbitrary commands on connect, so only honor it once
    // the project is trusted. Per-server settings refine that: disabled servers never
    // connect, servers the user consented to individually connected above without the
    // whole-project confirm, and the rest stay behind it, sequentially after both
    // scopes so the confirm dialog never races a connect.
    if (!projectConnected) projectConnected = await connectGatedProjectServers(ctx, gated, authUi)
  }

  /** Publishes the current alias set and the connection banner. `'connecting'`
   * servers are excluded from both connected and failed counts: they are neither,
   * and while the non-blocking startup race below is still in flight some legitimately
   * are. Called once right after startup (whether or not every server settled by
   * then) and again when a still-connecting tail finishes, so a server that connects
   * late still gets its aliases published and counted. */
  function publishConnectionSummary(ctx: ExtensionContext): void {
    pi.events.emit(MCP_TOOLS_CHANNEL, [...aliases])
    const connected = [...status.values()].filter((s) => s.state === 'connected')
    const failed = [...status.entries()].filter(([, s]) => s.state !== 'connected' && s.state !== 'connecting')
    if (connected.length > 0 || failed.length > 0) {
      const total = connected.reduce((sum, s) => sum + s.tools, 0)
      const failNote = failed.length > 0 ? `, ${failed.length} failed` : ''
      ctx.ui.notify(`MCP: ${total} tools from ${connected.length} servers${failNote}`, failed.length > 0 ? 'warning' : 'info')
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    // Reset the status map so /mcp and the banner reflect only this session's config: a
    // server present last session but not this one must not linger as "connected". The
    // registered tools, aliases, and prompt commands stay: pi has no unregister (a
    // withdrawn tool keeps its registration and surfaces the server's own error), which
    // is why serverToolCount reads from `registered` to recover the true count here.
    status.clear()
    // A same-process session switch (/new, /resume) shut the last session down;
    // this one may reconnect again. projectConnected guards against connecting the project
    // scope twice within one session, so it belongs to the session that set it: leaving it
    // set here left every project server disconnected for the rest of the process, since
    // the shutdown had already dropped their clients.
    shuttingDown = false
    projectConnected = false
    // Claude answers roots/list with the session's launch directory and exports the
    // project root as CLAUDE_PROJECT_DIR to stdio servers; both derive from ctx.cwd.
    sessionDirs = { projectDir: repoRoot(ctx.cwd) ?? ctx.cwd, launchDir: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId?.() }
    const authUi = authUiFor(ctx)
    sessionAuthUi = authUi
    // The allow/deny lists filter every scope, including a managed-mcp.json set. They
    // merge from managed settings plus the trust-gated settings chain, as Claude
    // documents (a repo's file counts only once the project is approved).
    const policy = mcpAllowDeny(claudeSettingsChain(ctx.cwd, os.homedir(), isProjectApprovedSilently(ctx)))
    // managed-mcp.json (beside managed-settings.json) takes exclusive control when present:
    // only its servers load, and the user, project, and plugin scopes plus the whole
    // project-approval flow below are skipped. An empty map disables MCP entirely. An absent
    // file leaves the normal scopes untouched; a present but corrupt file fails closed to an
    // empty set (see loadManagedMcpServers).
    const managed = loadManagedMcpServers()
    const connecting = managed !== null ? connectManagedExclusive(managed, policy, authUi) : connectNormalScopes(ctx, policy, authUi)
    // Claude: "MCP startup is non-blocking by default: servers connect in the
    // background and their tools become available as they finish." A slow or
    // unreachable server no longer costs the whole session's startup its own
    // MCP_TIMEOUT x retries; alwaysLoad-style forced waiting and the ToolSearch/
    // WaitForMcpServers mechanism that lets the model itself wait on a pending
    // server's tools are not implemented, so a call to a tool that has not
    // registered yet still just finds no such tool, same as before it connected.
    //
    // Claude also states non-interactive mode "waits for still-pending servers
    // before the first turn regardless of this variable", because a -p run has no
    // later turn to react to late-arriving tools; a headless ctx (no UI) keeps the
    // prior fully-blocking wait for the same reason.
    const settled = !ctx.hasUI
      ? await connecting.then(() => true)
      : await withTimeout(connecting, mcpConnectTimeoutMs(), 'mcp startup').then(
          () => true,
          () => false,
        )
    publishConnectionSummary(ctx)
    if (!settled) void connecting.then(() => publishConnectionSummary(ctx))
  })

  pi.on('session_shutdown', async () => {
    // Closing fires each client's onclose while it is still in the map; the flag
    // stops those handlers (and any in-flight backoff loop) from reconnecting.
    shuttingDown = true
    // Close in parallel with a per-client timeout so one hung server can't stall pi's exit.
    await Promise.all([...clients.values()].map((client) => withTimeout(client.close(), 3000, 'close').catch(() => {})))
    // Drop the closed clients and their status now rather than waiting on each client's
    // onclose, which the SDK fires late: a same-process session switch (/new, /resume,
    // /fork) runs the next session_start right after this, and a lingering dead client
    // there would make connectServers skip reconnecting the name, stranding every tool
    // closure on a closed client. session_start resets status too, so a switch rebuilds it.
    clients.clear()
    status.clear()
  })

  // Claude references MCP resources with @server:uri mentions, fetched into the
  // conversation when referenced. Only mentions naming a connected server expand;
  // anything else (an email, a handle) stays untouched.
  pi.on('input', async (event) => {
    if (event.source === 'extension') return
    const mentions = [...event.text.matchAll(/@([A-Za-z0-9_-]+):(\S+)/g)].filter((match) => clients.has(match[1]))
    if (mentions.length === 0) return
    const sections: string[] = []
    for (const match of mentions) {
      const [, server, uri] = match
      try {
        const client = clients.get(server)
        if (!client) continue
        const wall = callTimeoutMs()
        const result = await withTimeout(client.readResource({ uri }, callRequestOptions(wall, callTuning(server))), wall, `read ${uri}`)
        const text = (result.contents as Array<{ text?: string }>)
          .map((entry) => entry.text)
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
        if (text) sections.push(capForContext(`<mcp-resource server="${server}" uri="${uri}">\n${text}\n</mcp-resource>`))
      } catch {
        // An unreadable resource leaves the mention as plain text.
      }
    }
    if (sections.length === 0) return
    return { action: 'transform', text: `${event.text}\n\n${sections.join('\n\n')}` }
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
