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
 * /mcp__<server>__<prompt> slash commands (names normalized dashes/spaces to underscores,
 * args space-separated and mapped positionally); the prompt result drives a turn via
 * sendUserMessage, exactly how custom slash commands do. Servers advertising `resources`
 * make the global list_mcp_resources / read_mcp_resource tools available, mirroring
 * Claude's automatic resource tools. Resource and prompt output rides the same
 * mapContent/capForContext budget as tool output. That budget is byte/line based
 * (pi's DEFAULT_MAX_BYTES in the shared output guard); Claude's MAX_MCP_OUTPUT_TOKENS
 * is a token budget and cannot be folded into it without making the guard token-aware,
 * so the byte cap stands in for it.
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
// SSE is deprecated in favour of Streamable HTTP, but the SDK notes servers still on
// the old spec exist, so this stays as a fallback for the migration period.
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js' // NOSONAR
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import { PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { Type } from 'typebox'
import { splitArgs } from './internal/command-file.js'
import { MCP_TOOLS_CHANNEL, type McpToolAlias } from './internal/mcp-alias.js'
import { setMcpToolCaller } from './internal/mcp-call.js'
import { FileOAuthProvider, openBrowser, startCallbackServer, waitForAuthCode } from './internal/mcp-oauth.js'
import { capForContext } from './internal/output-guard.js'
import { type InstalledPlugin, installedPlugins, substitutePluginVars } from './internal/plugins.js'
import { isProjectApproved, isProjectApprovedSilently } from './internal/project-approval.js'
import { findNearestFile } from './internal/project-root.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000

/** A positive-integer env override, or the default when unset or unparseable. */
function envTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

// Claude honors MCP_TIMEOUT (connect) and MCP_TOOL_TIMEOUT (per-call), both in ms.
const connectTimeoutMs = (): number => envTimeout('MCP_TIMEOUT', DEFAULT_CONNECT_TIMEOUT_MS)
const callTimeoutMs = (): number => envTimeout('MCP_TOOL_TIMEOUT', DEFAULT_CALL_TIMEOUT_MS)
// Tool names an MCP server must never take over. formatToolName always emits
// `<server>_<tool>`, so only names containing an underscore are actually reachable:
// pi's own built-ins (read, bash, edit, ...) cannot be produced and are not listed.
// These are pi-code's own tools, and mcp.ts registers before the extensions owning
// them, so without this guard a server named `web` would replace the SSRF-checked fetch.
// The resource tools are this extension's own globals; a server named `list` or `read`
// must not take their names either.
const RESERVED_NAMES = new Set(['web_fetch', 'web_search', 'plan_mode_complete', 'list_mcp_resources', 'read_mcp_resource'])

export interface StdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Per-call wall-clock budget in ms, overriding MCP_TOOL_TIMEOUT for this server. */
  timeout?: number
  /** Plugin servers alias their tools mcp__plugin_<plugin>_<server>__<tool>. */
  aliasPrefix?: string
}

export interface HttpServerConfig {
  type?: 'http' | 'streamable-http' | 'sse' | 'ws' | 'websocket'
  url: string
  headers?: Record<string, string>
  bearerToken?: string
  bearerTokenEnv?: string
  /** A command whose JSON stdout is merged into the connect headers, for auth
   * schemes other than OAuth/static tokens (Claude's headersHelper). */
  headersHelper?: string
  /** Per-call wall-clock budget in ms, overriding MCP_TOOL_TIMEOUT for this server. */
  timeout?: number
  /** Plugin servers alias their tools mcp__plugin_<plugin>_<server>__<tool>. */
  aliasPrefix?: string
}

export type ServerConfig = StdioServerConfig | HttpServerConfig

/** Claude's .mcp.json expansion: ${VAR}, and ${VAR:-default}. The syntax borrows
 * shell's `:-`, which substitutes when the variable is unset OR empty. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env, onMissing?: (name: string) => void): string {
  return value.replace(/\$\{(\w+)(:-([^}]*))?\}/g, (fullMatch, name, hasDefault, fallback) => {
    const current = env[name]
    if (hasDefault !== undefined) return current || fallback
    if (current === undefined) {
      // A referenced variable with no value and no default: keep the literal ${VAR} and
      // report it, matching Claude, rather than silently substituting an empty string that
      // turns `Bearer ${TOKEN}` into a confusing `Bearer ` and a mystery 401.
      onMissing?.(name)
      return fullMatch
    }
    return current
  })
}

/** User-scoped MCP config (the user's own; safe to load without project trust). */
export function userConfigPaths(home: string): string[] {
  return [path.join(home, '.claude.json'), path.join(home, '.pi', 'agent', 'mcp.json')]
}

/** Project-scoped MCP config, each file the nearest of its name at or above cwd
 * (bounded at the repository root, matching the approval walk). Loaded only for
 * trusted projects: a server's `command` runs on connect. */
export function projectConfigPaths(cwd: string): string[] {
  return ['.mcp.json', path.join('.pi', 'mcp.json')].map((rel) => findNearestFile(cwd, rel) ?? path.join(cwd, rel))
}

export interface ProjectServerPolicy {
  disabled: Set<string>
  consented: Set<string>
  consentAll: boolean
}

/** Claude's per-server approvals for project .mcp.json servers.
 *
 * Consent-granting keys (enabledMcpjsonServers, enableAllProjectMcpServers) count
 * from the user's own settings always, and from the project's settings.local.json
 * only once the project itself is approved. That file is gitignored by convention,
 * not by enforcement: a repository can commit one, and honoring it unconditionally
 * let a hostile repo self-approve a server whose `command` runs on connect, even
 * after the user declined the trust prompt.
 *
 * disabledMcpjsonServers counts from every file, including the repo's own, and wins
 * over consent: a repo may always restrict itself further, never less. */
export function projectServerPolicy(cwd: string, home: string, projectApproved: boolean): ProjectServerPolicy {
  const read = (file: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      return {}
    }
  }
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
  const userSettings = read(path.join(home, '.claude', 'settings.json'))
  const projectSettings = read(findNearestFile(cwd, path.join('.claude', 'settings.json')) ?? path.join(cwd, '.claude', 'settings.json'))
  const localSettings = read(findNearestFile(cwd, path.join('.claude', 'settings.local.json')) ?? path.join(cwd, '.claude', 'settings.local.json'))
  const disabled = new Set([...names(userSettings.disabledMcpjsonServers), ...names(projectSettings.disabledMcpjsonServers), ...names(localSettings.disabledMcpjsonServers)])
  const consentSources = projectApproved ? [userSettings, localSettings] : [userSettings]
  const consented = new Set(consentSources.flatMap((settings) => names(settings.enabledMcpjsonServers)))
  const consentAll = consentSources.some((settings) => settings.enableAllProjectMcpServers === true)
  return { disabled, consented, consentAll }
}

/** Split project servers by the per-server policy: never-connect, connect without the
 * whole-project confirm, and still gated behind it. */
export function splitByPolicy(candidates: Record<string, ServerConfig>, policy: ProjectServerPolicy): { consented: Record<string, ServerConfig>; gated: Record<string, ServerConfig> } {
  const consented: Record<string, ServerConfig> = {}
  const gated: Record<string, ServerConfig> = {}
  for (const [name, config] of Object.entries(candidates)) {
    if (policy.disabled.has(name)) continue
    if (policy.consentAll || policy.consented.has(name)) consented[name] = config
    else gated[name] = config
  }
  return { consented, gated }
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

/**
 * All user-owned servers for this session: the global user servers plus Claude's "local"
 * scope, the per-project user servers under `projects[cwd].mcpServers` in ~/.claude.json.
 * Both are the user's own config, so neither needs project trust; local wins on a name
 * clash (Claude's precedence is local over user).
 */
export function loadUserScope(home: string, cwd: string): Record<string, ServerConfig> {
  const servers = loadConfigFrom(userConfigPaths(home))
  try {
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'))
    Object.assign(servers, claudeJson.projects?.[cwd]?.mcpServers ?? {})
  } catch {
    // missing or invalid ~/.claude.json: the top-level user servers already loaded
  }
  return servers
}

/** The mcpServers one plugin declares: an inline map on the manifest, or the file it
 * points to (default .mcp.json at the plugin root), with ${CLAUDE_PLUGIN_*} substituted
 * before parsing. Malformed or missing JSON yields no entries. */
function pluginServerEntries(plugin: InstalledPlugin): Record<string, ServerConfig> {
  const declared = plugin.manifest.mcpServers
  // An inline map of name -> config; an array is not a valid mcpServers map (it
  // would register a server named '0'), so it falls through to the path branch.
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    try {
      return JSON.parse(substitutePluginVars(JSON.stringify(declared), plugin))
    } catch {
      return {}
    }
  }
  const file = path.resolve(plugin.root, typeof declared === 'string' ? declared : '.mcp.json')
  try {
    const parsed = JSON.parse(substitutePluginVars(fs.readFileSync(file, 'utf-8'), plugin))
    return parsed.mcpServers ?? {}
  } catch {
    return {}
  }
}

/** Servers shipped by enabled plugins (.mcp.json or the manifest's `mcpServers`,
 * inline or by path), with ${CLAUDE_PLUGIN_*} substituted before parsing. Their
 * tools alias as mcp__plugin_<plugin>_<server>__<tool> for hook matchers, as
 * Claude scopes them. */
export function loadPluginServers(plugins: InstalledPlugin[]): Record<string, ServerConfig> {
  const fold = (name: string): string => name.replaceAll('-', '_')
  const servers: Record<string, ServerConfig> = {}
  for (const plugin of plugins) {
    for (const [name, config] of Object.entries(pluginServerEntries(plugin))) {
      servers[name] = { ...config, aliasPrefix: `mcp__plugin_${fold(plugin.name)}_${fold(name)}__` }
    }
  }
  return servers
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

/** The OS managed-settings.json path, where Claude sources `allowedMcpServers`/
 * `deniedMcpServers` (an enterprise policy file deployed by IT, not user- or
 * repo-writable in the normal flow). */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  // The legacy C:\ProgramData\ClaudeCode path was dropped in Claude Code v2.1.75.
  if (platform === 'win32') return String.raw`C:\Program Files\ClaudeCode\managed-settings.json`
  return '/etc/claude-code/managed-settings.json'
}

/** Test seam: override the managed-settings.json path the extension reads. */
let managedSettingsFileOverride: string | undefined
export function setManagedSettingsPath(file: string | undefined): void {
  managedSettingsFileOverride = file
}

/** Claude's `allowedMcpServers`/`deniedMcpServers`, read from managed settings only
 * (not user or project settings, so a repo can neither widen nor narrow the policy),
 * applied globally to every server across scopes. Entries are `{ serverName }` objects
 * (bare strings tolerated). `allowed` is null when unset (no restriction); an empty
 * set is an explicit lockdown, as Claude documents (empty allow array = deny all). */
export function mcpAllowDeny(managedFile: string = managedSettingsFileOverride ?? managedSettingsPath()): { allowed: Set<string> | null; denied: Set<string> } {
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(managedFile, 'utf-8'))
    if (parsed && typeof parsed === 'object') settings = parsed
  } catch {
    // No managed policy on this machine: no restriction.
  }
  const entryName = (entry: unknown): string | undefined => {
    if (typeof entry === 'string') return entry
    const serverName = (entry as { serverName?: unknown })?.serverName
    return typeof serverName === 'string' ? serverName : undefined
  }
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.map(entryName).filter((name): name is string => typeof name === 'string' && name.length > 0) : [])
  return {
    allowed: Array.isArray(settings.allowedMcpServers) ? new Set(names(settings.allowedMcpServers)) : null,
    denied: new Set(names(settings.deniedMcpServers)),
  }
}

/** Claude's managed allow/deny lists: `allowed` null means no allow list (keep all);
 * a set (even empty) is exclusive, so only its members survive; a deny list removes
 * servers on top, deny winning over allow. */
export function applyServerPolicy(servers: Record<string, ServerConfig>, allowed: ReadonlySet<string> | null, denied: ReadonlySet<string>): Record<string, ServerConfig> {
  const out: Record<string, ServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (denied.has(name)) continue
    if (allowed !== null && !allowed.has(name)) continue
    out[name] = config
  }
  return out
}

/** A server cwd expands ${VAR} then a leading ~, or stays unset. */
export function expandCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  return interpolateEnv(cwd).replace(/^~(?=\/|$)/, os.homedir())
}

export function warnOnTypelessUrl(name: string, config: ServerConfig): void {
  if ('url' in config && config.type === undefined) {
    console.warn(`pi-code-mcp: server ${name} declares a url with no "type"; add "type": "http" or "sse"`)
  }
}

export function formatToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replaceAll('-', '_')
}

/** Claude exposes server prompts as /mcp__<server>__<prompt> slash commands. Both
 * names normalize like formatToolName, extended to spaces: dashes and spaces each
 * become an underscore. */
export function formatPromptCommandName(server: string, prompt: string): string {
  const normalize = (name: string): string => name.replace(/[\s-]/g, '_')
  return `mcp__${normalize(server)}__${normalize(prompt)}`
}

export interface McpPromptArgumentInfo {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: McpPromptArgumentInfo[]
}

/** Claude passes prompt arguments space-separated after the command. Tokens map
 * positionally onto the declared arguments, split the way slash-command args are
 * (quoted runs stay together); the last declared argument absorbs any trailing
 * tokens so free text at the end is not silently dropped. Declared arguments with
 * no token are omitted, and the server enforces its own `required`. */
export function mapPromptArguments(declared: ReadonlyArray<{ name: string }> | undefined, args: string): Record<string, string> {
  const tokens = splitArgs(args)
  const names = (declared ?? []).map((argument) => argument.name)
  const mapped: Record<string, string> = {}
  for (let index = 0; index < names.length && index < tokens.length; index++) {
    mapped[names[index]] = index === names.length - 1 ? tokens.slice(index).join(' ') : tokens[index]
  }
  return mapped
}

/** The content blocks a getPrompt result injects. Each message carries one content
 * block; the blocks ride the same mapContent budget as tool output, and image blocks
 * are carried through rather than dropped, since sendUserMessage accepts them and a
 * vision prompt is worthless flattened to text. An empty message list yields no
 * blocks, and messages that carry only empty text yield none either, so the caller
 * can skip the turn rather than drive it on an empty or sentinel message. */
export function promptMessageContent(messages: ReadonlyArray<{ content: unknown }>): ToolContent[] {
  if (messages.length === 0) return []
  return mapContent(messages.map((message) => message.content as McpContentBlock)).filter((block) => block.type !== 'text' || block.text.trim() !== '')
}

/** Merge the `properties` (and, for allOf, the `required`) of a root-level combinator's
 * branches into one flat object schema. Without this a tool whose input schema is a bare
 * anyOf/oneOf/allOf (no top-level `type`) would present no properties at all, so the model
 * would be forced to call it with no arguments. */
function mergeCombinatorBranches(branches: unknown[]): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const branch of branches) {
    if (!branch || typeof branch !== 'object') continue
    const b = branch as Record<string, unknown>
    if (b.properties && typeof b.properties === 'object') Object.assign(properties, b.properties as Record<string, unknown>)
    if (Array.isArray(b.required)) for (const name of b.required) if (typeof name === 'string') required.add(name)
  }
  return { properties, required: [...required] }
}

export function normalizeSchema(schema: unknown): object {
  const base = (schema as Record<string, unknown>) ?? {}
  const { $schema: _dropSchema, additionalProperties: _dropAdditional, ...rest } = base
  if (rest.type) return rest
  // A root-level combinator carries the real parameters in its branches; flatten them
  // into one object schema rather than emptying it. allOf means every branch applies, so
  // its required union is kept; anyOf/oneOf branches are alternatives, so required is left
  // open (the server still enforces its own).
  const allOf = Array.isArray(rest.allOf) ? rest.allOf : undefined
  let branches = allOf
  if (!branches && Array.isArray(rest.anyOf)) branches = rest.anyOf
  if (!branches && Array.isArray(rest.oneOf)) branches = rest.oneOf
  if (!branches) return { type: 'object', properties: {} }
  const { properties, required } = mergeCombinatorBranches(branches)
  const merged: Record<string, unknown> = { type: 'object', properties }
  if (typeof rest.description === 'string') merged.description = rest.description
  if (allOf && required.length > 0) merged.required = required
  return merged
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
  // not only a text block. The per-block cap alone is not a budget, though: a server
  // answering with one block per file multiplies it by the block count, so the blocks
  // are capped again as a whole below.
  const text = (value: string): ToolContent => ({ type: 'text', text: capForContext(value) })
  if (!content || content.length === 0) {
    return [text(structured !== undefined ? JSON.stringify(structured, null, 2) : '(empty result)')]
  }
  const mapped: ToolContent[] = content.map((block): ToolContent => {
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
  return capTotal(mapped)
}

/**
 * Bound a result's text as a whole, not each block. The per-block cap multiplies by
 * the block count, so a server answering with one block per file still injects
 * megabytes.
 *
 * Blocks are kept whole. Each has already been capped on its own, so keeping the one
 * that crosses the budget bounds the text at roughly a single cap rather than at the
 * block count times it, and it preserves that block's own truncation notice, which
 * states how much of it was dropped. Blocks after it are omitted rather than skipped
 * over, so what reaches the model is a prefix of what the server sent, and the number
 * omitted is stated so a truncated set is distinguishable from a complete one.
 *
 * Images pass through uncut and do not spend the budget: base64 cut short is a broken
 * image rather than a smaller one, so nothing here can bound them, and charging the
 * budget for one would only delete the caption that accompanies a screenshot.
 */
export function capTotal(blocks: ToolContent[]): ToolContent[] {
  const kept: ToolContent[] = []
  let spent = 0
  let full = false
  let dropped = 0
  for (const block of blocks) {
    if (block.type !== 'text') {
      kept.push(block)
      continue
    }
    const size = Buffer.byteLength(block.text, 'utf-8')
    // The first text block always goes through: a lone oversized one is better read
    // truncated, with its own notice, than replaced by a marker saying it existed.
    if (full || (spent > 0 && spent + size > DEFAULT_MAX_BYTES)) {
      full = true
      dropped++
      continue
    }
    kept.push(block)
    spent += size
  }
  if (dropped > 0) {
    kept.push({ type: 'text', text: `[${dropped} further content block${dropped === 1 ? '' : 's'} omitted: tool output budget spent]` })
  }
  return kept
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

async function connect(name: string, config: ServerConfig, authUi?: AuthUi): Promise<Client> {
  const client = new Client({ name: 'pi-code-mcp', version: '0.1.0' })
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
    const env: Record<string, string> = { ...getDefaultEnvironment() }
    for (const [key, value] of Object.entries(config.env ?? {})) env[key] = fill(value)
    const transport = new StdioClientTransport({
      command: fill(config.command),
      args: (config.args ?? []).map((arg) => fill(arg)),
      env,
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
    // 10s while contributing nothing). A ws server must be reachable without auth.
    if (config.headers || config.bearerToken || config.bearerTokenEnv || config.headersHelper) {
      console.warn(`pi-code-mcp: server ${name} is a WebSocket server; the SDK ws transport is url-only, so its headers/bearerToken/headersHelper are ignored`)
    }
    const transport = new WebSocketClientTransport(url)
    warnMissing()
    await connectWithTimeout(client, transport, `connect ${name} (ws)`)
    return client
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = fill(value)
  const token = resolveBearerToken(config)
  if (token) headers.Authorization = `Bearer ${token}`
  // A headersHelper generates connect-time headers for non-OAuth auth schemes; its
  // JSON stdout merges over the static headers.
  if (config.headersHelper) Object.assign(headers, await runHeadersHelper(fill(config.headersHelper)))
  warnMissing()
  const sseTransport = (authProvider?: OAuthClientProvider) => new SSEClientTransport(url, { requestInit: { headers }, authProvider }) // NOSONAR: explicitly declared or deliberate legacy transport
  if (config.type === 'sse') {
    return await connectHttpFamily(name, config, sseTransport, `connect ${name} (sse)`, token, authUi)
  }
  try {
    return await connectHttpFamily(name, config, (authProvider) => new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider }), `connect ${name}`, token, authUi)
  } catch (error) {
    // An explicitly declared streamable transport must not silently degrade to SSE.
    if (config.type !== undefined || isUnauthorized(error)) throw error
    return await connectHttpFamily(name, config, sseTransport, `connect ${name} (sse)`, token, authUi)
  }
}

/** Run a headersHelper command and parse its JSON stdout into headers. A failure or
 * a 10s timeout yields no extra headers rather than blocking the connection. */
function runHeadersHelper(command: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? {} : parseHelperHeaders(stdout))
    })
  })
}

/** UI seams the OAuth flow needs; absent in headless runs, which fail with advice. */
export interface AuthUi {
  confirm: (title: string, body: string) => Promise<boolean>
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
}

/** The OAuth flow's UI seams, absent in headless runs. */
function authUiFor(ctx: ExtensionContext): AuthUi | undefined {
  if (!ctx.hasUI) return undefined
  return {
    confirm: (title, body) => ctx.ui.confirm(title, body),
    notify: (message, level) => ctx.ui.notify(message, level),
  }
}

/** Browser logins are human-paced; a connect-sized timeout would cut them off. */
const OAUTH_FLOW_TIMEOUT_MS = 180_000

/** A server needs OAuth pi could not complete (headless, declined, or the flow
 * failed). A typed marker so the SSE-fallback caller can tell an auth failure
 * from a transport mismatch without matching on message text. */
class OAuthRequiredError extends Error {}

/** Wrap a login-flow failure as OAuthRequiredError, passing an existing one through
 * unchanged so its message is not doubled. */
function asOAuthRequiredError(name: string, error: unknown): OAuthRequiredError {
  if (error instanceof OAuthRequiredError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new OAuthRequiredError(`login for ${name} failed: ${detail}`)
}

/** Whether a connect failure is an authentication problem: the SDK's own
 * UnauthorizedError, a transport error carrying HTTP 401 (which is what a 401
 * throws when no authProvider was attached, so a first-time login is detected),
 * or our own marker. */
function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof OAuthRequiredError) return true
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 401
}

// SSEClientTransport is deprecated in favour of Streamable HTTP, but both concrete
// transports expose finishAuth (the base Transport interface does not), so the union
// stays as the http-family fallback type through the migration period.
type HttpFamilyTransport = SSEClientTransport | StreamableHTTPClientTransport // NOSONAR typescript:S1874 - SSE fallback still required by the MCP SDK

type MakeTransport = (authProvider?: OAuthClientProvider) => HttpFamilyTransport

/**
 * Connect an http-family server, running Claude's OAuth login when the server
 * demands one. Stored tokens ride the first attempt so the SDK refreshes
 * silently; a 401 without tokens asks the user, opens the browser, catches the
 * loopback redirect, and exchanges the code via the SDK's finishAuth.
 * Bearer-token servers never enter the OAuth path: an explicit token is the
 * user saying how auth works.
 */
async function connectHttpFamily(name: string, config: { url: string }, makeTransport: MakeTransport, label: string, bearerToken: string | undefined, authUi: AuthUi | undefined): Promise<Client> {
  const newClient = () => new Client({ name: 'pi-code-mcp', version: '0.1.0' })
  // Stored tokens ride the first attempt so the SDK refreshes them; with none, no
  // provider is attached, so a 401 surfaces as a transport error carrying code 401
  // (isUnauthorized detects it) and only the interactive provider below ever runs
  // dynamic registration, keeping it bound to the real callback port.
  const silent = bearerToken ? undefined : new FileOAuthProvider(name, () => {})
  try {
    const client = newClient()
    await connectWithTimeout(client, makeTransport(silent?.hasTokens() ? silent : undefined), label)
    return client
  } catch (error) {
    if (bearerToken || !isUnauthorized(error)) throw error
    if (!authUi) throw new OAuthRequiredError(`${name} requires a login; run pi interactively to authenticate`)
    return await runInteractiveOAuth(name, config, makeTransport, label, authUi, newClient)
  }
}

/**
 * The interactive half of the OAuth login, reached only once a silent connect has
 * failed with a 401 and a UI is present: confirm, open the browser, catch the loopback
 * redirect, and exchange the code via the SDK's finishAuth. Past the confirm the server
 * is known to need OAuth, so any failure here (a denied consent page, the 180s wait, a
 * token exchange error) is wrapped as an auth failure, not a transport mismatch: that
 * keeps the typeless-url caller from retrying over SSE and prompting for a second login.
 */
async function runInteractiveOAuth(name: string, config: { url: string }, makeTransport: MakeTransport, label: string, authUi: AuthUi, newClient: () => Client): Promise<Client> {
  const approved = await authUi.confirm(`MCP server "${name}" requires login`, `Open your browser to authorize ${config.url}?`)
  if (!approved) throw new OAuthRequiredError(`login declined for ${name}`)
  const provider = new FileOAuthProvider(name, (authorizationUrl) => {
    openBrowser(String(authorizationUrl))
    authUi.notify(`Authorize "${name}" in the browser. If it did not open: ${authorizationUrl}`, 'info')
  })
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

/**
 * Connect with a deadline, closing the client if the deadline (not a connect error) wins.
 * Without this, a slow-but-successful server finishes connecting after the race is lost and
 * lingers unreferenced: process/socket alive, never in `clients`, invisible to shutdown.
 */
async function connectWithTimeout(client: Client, transport: Parameters<Client['connect']>[0], label: string): Promise<void> {
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

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools({ cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

async function listAllPrompts(client: Client): Promise<McpPromptInfo[]> {
  const prompts: McpPromptInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.listPrompts({ cursor })
    prompts.push(...page.prompts)
    cursor = page.nextCursor
  } while (cursor)
  return prompts
}

/** One resource's flat record for the list_mcp_resources output, dropping the optional
 * description/mimeType when the server omits them. */
function resourceEntry(server: string, resource: { uri: string; name: string; description?: string; mimeType?: string }): Record<string, unknown> {
  return { server, uri: resource.uri, name: resource.name, ...(resource.description ? { description: resource.description } : {}), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) }
}

/** One resource template's flat record, likewise dropping absent optional fields. */
function resourceTemplateEntry(server: string, template: { uriTemplate: string; name: string; description?: string; mimeType?: string }): Record<string, unknown> {
  return { server, uriTemplate: template.uriTemplate, name: template.name, ...(template.description ? { description: template.description } : {}), ...(template.mimeType ? { mimeType: template.mimeType } : {}) }
}

/** Page a server's resources to exhaustion under the call budget, appending each as a
 * flat record. Pushed into the caller's array incrementally so a mid-pagination failure
 * still leaves the earlier pages in place. */
async function collectResources(entries: Array<Record<string, unknown>>, name: string, client: Client, budget: number): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await withTimeout(client.listResources({ cursor }, { timeout: budget }), budget, `list resources ${name}`)
    for (const resource of page.resources) entries.push(resourceEntry(name, resource))
    cursor = page.nextCursor
  } while (cursor)
}

/** Page a server's resource templates to exhaustion under the call budget. */
async function collectResourceTemplates(entries: Array<Record<string, unknown>>, name: string, client: Client, budget: number): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await withTimeout(client.listResourceTemplates({ cursor }, { timeout: budget }), budget, `list resource templates ${name}`)
    for (const template of page.resourceTemplates) entries.push(resourceTemplateEntry(name, template))
    cursor = page.nextCursor
  } while (cursor)
}

/** Append every resource and template one server exposes. A resource-listing failure
 * surfaces inline as an error record, so one server cannot empty the whole listing; a
 * template-listing failure is silent, templates being optional (a server with the
 * resources capability but no templates answers method-not-found). */
async function collectServerResourceEntries(entries: Array<Record<string, unknown>>, name: string, client: Client, budget: number): Promise<void> {
  try {
    await collectResources(entries, name, client, budget)
  } catch (error) {
    entries.push({ server: name, error: error instanceof Error ? error.message : String(error) })
  }
  try {
    await collectResourceTemplates(entries, name, client, budget)
  } catch {
    // Templates are optional: a method-not-found here is not worth reporting.
  }
}

/** The optional server-name filter for list_mcp_resources: a non-empty string, else undefined. */
function resourceServerFilter(params: unknown): string | undefined {
  const server = (params as { server?: unknown }).server
  return typeof server === 'string' && server.length > 0 ? server : undefined
}

export default async function mcpExtension(pi: ExtensionAPI) {
  const clients = new Map<string, Client>()
  const status = new Map<string, { state: string; tools: number }>()
  // Let other extensions (hooks' mcp_tool type) call a connected server's tool.
  setMcpToolCaller(async (server, tool, input) => {
    const client = clients.get(server)
    if (!client) throw new Error(`MCP server "${server}" is not connected`)
    const result = await client.callTool({ name: tool, arguments: input }, undefined, { timeout: callTimeoutMs() })
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

  /** Register every not-yet-registered tool of a server; returns how many were added. */
  function registerTools(name: string, config: ServerConfig, tools: McpToolInfo[]): number {
    let count = 0
    for (const tool of tools) {
      const toolName = formatToolName(name, tool.name)
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
          const current = clients.get(name)
          if (!current) throw new Error(`MCP server "${name}" is not connected`)
          // Pass the timeout to the SDK too: its own default request timeout is 60s and
          // would otherwise reject first, so the outer race at CALL_TIMEOUT_MS was dead.
          // Claude's per-server timeout wins over MCP_TOOL_TIMEOUT, with a 1s floor.
          const declared = typeof config.timeout === 'number' && config.timeout >= 1000 ? config.timeout : undefined
          const budget = declared ?? callTimeoutMs()
          const result = await withTimeout(current.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { timeout: budget }), budget, toolName)
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
            const budget = callTimeoutMs()
            const result = await withTimeout(current.getPrompt(params, { timeout: budget }), budget, commandName)
            // The prompt drives a turn exactly the way a custom slash command does
            // (see commands.ts), carrying its image blocks through. A prompt that
            // yields no content is reported rather than sent as an empty turn.
            const content = promptMessageContent(result.messages)
            if (content.length === 0) {
              ctx.ui.notify(`${commandName}: prompt returned no content`, 'info')
              return
            }
            pi.sendUserMessage(content)
          } catch (error) {
            ctx.ui.notify(`${commandName}: ${error instanceof Error ? error.message : String(error)}`, 'error')
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
      console.warn(`pi-code-mcp: prompt listing failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
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
          console.warn(`pi-code-mcp: prompt refresh failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
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
        const budget = callTimeoutMs()
        const result = await withTimeout(client.readResource({ uri }, { timeout: budget }), budget, `read ${uri}`)
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
          status.set(name, { state: current?.state ?? 'connected', tools: (current?.tools ?? 0) + added })
          pi.events.emit(MCP_TOOLS_CHANNEL, [...aliases])
        } catch (error) {
          console.warn(`pi-code-mcp: tool refresh failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } catch {
      // a transport or client without notification support simply never refreshes
    }
  }

  async function connectServers(servers: Record<string, ServerConfig>, authUi?: AuthUi): Promise<void> {
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
      pending.push([name, config])
    }
    await Promise.all(
      pending.map(async ([name, config]) => {
        warnOnTypelessUrl(name, config)
        try {
          const client = await connect(name, config, authUi)
          clients.set(name, client)
          const tools = await withTimeout(listAllTools(client), connectTimeoutMs(), `list tools ${name}`)
          const count = registerTools(name, config, tools)
          subscribeToToolChanges(name, config, client)
          // Prompts and resources are additive surfaces: their failures warn (inside
          // connectPrompts) rather than flipping a tool-serving server to failed.
          await connectPrompts(name, client)
          subscribeToPromptChanges(name, client)
          ensureResourceTools()
          subscribeToResourceChanges(client)
          status.set(name, { state: 'connected', tools: count })
          // A server that dies mid-session would otherwise stay "connected" in /mcp
          // while every call fails with the SDK's bare "Not connected"; flip the
          // status and free the name so a later session start can reconnect it.
          client.onclose = () => {
            if (clients.get(name) !== client) return
            clients.delete(name)
            status.set(name, { state: 'disconnected', tools: 0 })
          }
        } catch (error) {
          status.set(name, { state: `failed: ${error instanceof Error ? error.message : String(error)}`, tools: 0 })
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

  /** Connect the project scope under the per-server policy. Returns whether the scope
   * is settled, so a refused confirm can be retried on a later session start. */
  async function connectProjectScope(ctx: ExtensionContext): Promise<boolean> {
    // The stored decision, read without prompting: consent recorded inside the
    // project only counts once the project itself has been approved.
    const approved = isProjectApprovedSilently(ctx)
    const policy = projectServerPolicy(ctx.cwd, os.homedir(), approved)
    const { allowed, denied } = mcpAllowDeny()
    const { consented, gated } = splitByPolicy(applyServerPolicy(loadConfigFrom(projectConfigPaths(ctx.cwd)), allowed, denied), policy)
    const authUi = authUiFor(ctx)
    if (Object.keys(consented).length > 0) await connectServers(consented, authUi)
    if (Object.keys(gated).length === 0) return true
    if (!(await isProjectApproved(ctx))) return false
    await connectServers(gated, authUi)
    return true
  }

  let projectConnected = false

  pi.on('session_start', async (_event, ctx) => {
    // Connecting spawns processes and opens sockets, so it belongs here rather than in
    // the factory: pi runs the factory for invocations that never start a session.
    // Names still connected are filtered out, so a later session start only retries
    // servers that failed or whose transport dropped, without duplicate-name warnings.
    // Plugin servers merge under the user scope (plugins are user-installed);
    // the user's own entry wins a name clash with a plugin's.
    const pluginServers = loadPluginServers(installedPlugins(os.homedir()))
    const { allowed, denied } = mcpAllowDeny()
    const scoped = applyServerPolicy({ ...pluginServers, ...loadUserScope(os.homedir(), ctx.cwd) }, allowed, denied)
    // Claude's precedence is project over user for a duplicate name. A project .mcp.json
    // server only outranks the user's own when it will actually connect (the user already
    // consented to it, or an approved project's), so a merely-present untrusted project
    // entry cannot shadow a trusted user server by reusing its name. A gated project
    // server still awaiting the approval prompt does not preempt the user server: that is
    // a deliberate narrowing of Claude's rule to keep the safe default.
    const projectPolicy = projectServerPolicy(ctx.cwd, os.homedir(), isProjectApprovedSilently(ctx))
    const projectWinners = new Set(Object.keys(splitByPolicy(applyServerPolicy(loadConfigFrom(projectConfigPaths(ctx.cwd)), allowed, denied), projectPolicy).consented))
    const userServers = Object.fromEntries(Object.entries(scoped).filter(([name]) => !clients.has(name) && !projectWinners.has(name)))
    if (Object.keys(userServers).length > 0) await connectServers(userServers, authUiFor(ctx))
    // A project .mcp.json can run arbitrary commands on connect, so only honor it once
    // the project is trusted. Per-server settings refine that: disabled servers never
    // connect, servers the user consented to individually connect without the
    // whole-project confirm, and the rest stay behind it. Reconnect attempts after a
    // refusal are safe: connectServers skips names that already connected.
    if (!projectConnected) projectConnected = await connectProjectScope(ctx)

    pi.events.emit(MCP_TOOLS_CHANNEL, [...aliases])

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
