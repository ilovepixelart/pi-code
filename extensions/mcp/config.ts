/**
 * MCP server configuration: the config types, ${VAR} interpolation, the user and
 * project config paths and their loading, and the servers declared by plugins.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claudeConfigDir } from '../internal/config-dir.js'
import type { OAuthServerConfig } from '../internal/mcp-oauth.js'
import { type InstalledPlugin, pluginComponentPath } from '../internal/plugins.js'
import { findNearestFile } from '../internal/project-root.js'
import { errorMessage } from '../internal/values.js'

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
  /** The server name as its manifest declares it, without the plugin: scope the registry
   * key carries. pi-side tool names derive from this, so a plugin server contributes
   * <server>_<tool> the way a user server does. */
  baseName?: string
  /** Root of the plugin that supplied this server; exported as CLAUDE_PLUGIN_ROOT. */
  pluginRoot?: string
  /** ${CLAUDE_PLUGIN_DATA} for a plugin's server, exported alongside the root. */
  pluginDataDir?: string
  /** Loaded from the project scope, whose helpers run credential-stripped. */
  projectScope?: boolean
}

export interface HttpServerConfig {
  type?: 'http' | 'streamable-http' | 'sse' | 'ws' | 'websocket'
  url: string
  headers?: Record<string, string>
  bearerToken?: string
  bearerTokenEnv?: string
  /** Claude's oauth object: pre-registered client, fixed callback port, pinned scopes. */
  oauth?: OAuthServerConfig
  /** A command whose JSON stdout is merged into the connect headers, for auth
   * schemes other than OAuth/static tokens (Claude's headersHelper). */
  headersHelper?: string
  /** Per-call wall-clock budget in ms, overriding MCP_TOOL_TIMEOUT for this server. */
  timeout?: number
  /** Plugin servers alias their tools mcp__plugin_<plugin>_<server>__<tool>. */
  aliasPrefix?: string
  /** The server name as its manifest declares it, without the plugin: scope the registry
   * key carries. pi-side tool names derive from this, so a plugin server contributes
   * <server>_<tool> the way a user server does. */
  baseName?: string
  /** Root of the plugin that supplied this server; exported as CLAUDE_PLUGIN_ROOT. */
  pluginRoot?: string
  /** ${CLAUDE_PLUGIN_DATA} for a plugin's server, exported alongside the root. */
  pluginDataDir?: string
  /** Loaded from the project scope, whose helpers run credential-stripped. */
  projectScope?: boolean
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

/** The user's ~/.claude.json (top-level mcpServers plus the per-project `projects` map).
 * When CLAUDE_CONFIG_DIR is set, Claude relocates .claude.json inside that directory; by
 * default it stays at the home root, since .claude.json does NOT live inside ~/.claude. A
 * blank value is treated as unset, matching claudeConfigDir. */
function claudeJsonPath(home: string): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim().length > 0 ? path.join(claudeConfigDir(home), '.claude.json') : path.join(home, '.claude.json')
}

/** User-scoped MCP config (the user's own; safe to load without project trust). The .pi
 * tree is pi's own and is not relocated by CLAUDE_CONFIG_DIR. */
export function userConfigPaths(home: string): string[] {
  return [claudeJsonPath(home), path.join(home, '.pi', 'agent', 'mcp.json')]
}

/** Project-scoped MCP config, each file the nearest of its name at or above cwd
 * (bounded at the repository root, matching the approval walk). Loaded only for
 * trusted projects: a server's `command` runs on connect. */
export function projectConfigPaths(cwd: string): string[] {
  return ['.mcp.json', path.join('.pi', 'mcp.json')].map((rel) => findNearestFile(cwd, rel) ?? path.join(cwd, rel))
}

export function loadConfigFrom(files: string[]): Record<string, ServerConfig> {
  const servers: Record<string, ServerConfig> = {}
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      Object.assign(servers, parsed.mcpServers ?? {})
    } catch (error) {
      // A missing file is the normal case. A present file that does not parse is
      // not: one trailing comma silently disabled every server in it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`pi-code-mcp: ignoring ${file}: ${errorMessage(error)}`)
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
  Object.assign(servers, projectRecord(home, cwd).mcpServers ?? {})
  return servers
}

/** The per-project record for `cwd` in ~/.claude.json, or an empty one when the file
 * is missing, invalid, or has no entry for this project. */
function projectRecord(home: string, cwd: string): { mcpServers?: Record<string, ServerConfig>; disabledMcpServers?: unknown } {
  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath(home), 'utf-8'))
    return claudeJson.projects?.[cwd] ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`pi-code-mcp: ignoring ${claudeJsonPath(home)}: ${errorMessage(error)}`)
    return {}
  }
}

/** Names the local scope defines for this project. Claude's precedence is local over
 * project over user, so a local name must also outrank a project .mcp.json entry. */
export function localScopeServerNames(home: string, cwd: string): Set<string> {
  return new Set(Object.keys(projectRecord(home, cwd).mcpServers ?? {}))
}

/** The per-project `disabledMcpServers` toggle list from ~/.claude.json: Claude's /mcp
 * panel records a server toggled off here (an opt-out list for user-configured and
 * plugin servers) and does not connect to it. The `enabledMcpServers` opt-in list
 * covers only default-off built-in servers, which pi-code has none of. */
export function disabledServerNames(home: string, cwd: string): Set<string> {
  const listed = projectRecord(home, cwd).disabledMcpServers
  return new Set(Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === 'string') : [])
}

/** The mcpServers one plugin declares, parsed WITHOUT substitution: an inline map on
 * the manifest, or the file it points to (default .mcp.json at the plugin root).
 * Malformed or missing JSON yields no entries. Substitution happens per field
 * afterwards, so a user_config value with JSON-breaking characters cannot corrupt
 * the parse and headersHelper can be shielded. */
function rawPluginServerEntries(plugin: InstalledPlugin): Record<string, unknown> {
  const declared = plugin.manifest.mcpServers
  // An inline map of name -> config. The manifest field is string|array|object per
  // Claude's plugin reference; an array lists config file paths, merged in order.
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    return { ...(declared as Record<string, unknown>) }
  }
  const paths = Array.isArray(declared) ? declared.filter((entry): entry is string => typeof entry === 'string') : [typeof declared === 'string' ? declared : '.mcp.json']
  const servers: Record<string, unknown> = {}
  for (const entry of paths) {
    try {
      const file = pluginComponentPath(plugin, entry)
      if (file === undefined) continue
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      Object.assign(servers, parsed.mcpServers ?? {})
    } catch {
      // Malformed or missing JSON contributes no entries.
    }
  }
  return servers
}

/** Every string in the value mapped through `substitute`, arrays and objects walked. */
function mapStrings(value: unknown, substitute: (text: string) => string): unknown {
  if (typeof value === 'string') return substitute(value)
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, substitute))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, substitute)]))
  return value
}

/** One plugin server with Claude's substitutions applied: the plugin path variables
 * and ${CLAUDE_PROJECT_DIR} everywhere, ${user_config.*} everywhere EXCEPT
 * headersHelper (the command runs through a shell, so Claude reports such a server
 * as misconfigured rather than substituting a user-supplied value into it; pi-code
 * skips it with a warning). */
function substitutedPluginServer(plugin: InstalledPlugin, name: string, config: unknown, projectDir: string | undefined): ServerConfig | undefined {
  if (config === null || typeof config !== 'object') return undefined
  const helper = (config as { headersHelper?: unknown }).headersHelper
  if (typeof helper === 'string' && /\$\{user_config\./.test(helper)) {
    console.warn(`pi-code-mcp: plugin ${plugin.name} server ${name} is misconfigured: headersHelper references \${user_config.*}, which cannot be substituted into a shell command; the server was not loaded`)
    return undefined
  }
  const pathVars = (text: string): string => {
    const withPlugin = substitutePathPluginVars(text, plugin)
    return projectDir === undefined ? withPlugin : withPlugin.replaceAll('${CLAUDE_PROJECT_DIR}', projectDir)
  }
  const full = (text: string): string => pathVars(text).replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => plugin.userConfig?.[key] ?? '')
  const substituted = mapStrings(config, full) as ServerConfig
  if (typeof helper === 'string') (substituted as { headersHelper?: string }).headersHelper = pathVars(helper)
  return substituted
}

/** The plugin path variables only, without user_config. */
function substitutePathPluginVars(text: string, plugin: InstalledPlugin): string {
  return text.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.root).replaceAll('${CLAUDE_PLUGIN_DATA}', plugin.dataDir)
}

/** Servers shipped by enabled plugins (.mcp.json or the manifest's `mcpServers`,
 * inline or by path), with ${CLAUDE_PLUGIN_*} substituted before parsing. Their
 * tools alias as mcp__plugin_<plugin>_<server>__<tool> for hook matchers, as
 * Claude scopes them. */
export function loadPluginServers(plugins: InstalledPlugin[], projectDir?: string): Record<string, ServerConfig> {
  // Claude keeps hyphens in the alias; only characters outside A-Za-z0-9_- fold to _.
  const fold = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')
  const servers: Record<string, ServerConfig> = {}
  for (const plugin of plugins) {
    for (const [name, config] of Object.entries(rawPluginServerEntries(plugin))) {
      const substituted = substitutedPluginServer(plugin, name, config, projectDir)
      // Claude: "The server itself registers under the scoped name
      // plugin:<plugin-name>:<server-name>", which is what an mcp_tool hook names and what
      // keeps a same-named user server from replacing a plugin's. The tool alias keeps its
      // own flat spelling, mcp__plugin_<plugin>_<server>__<tool>.
      if (substituted) servers[`plugin:${plugin.name}:${name}`] = { ...substituted, aliasPrefix: `mcp__plugin_${fold(plugin.name)}_${fold(name)}__`, baseName: name, pluginRoot: plugin.root, pluginDataDir: plugin.dataDir }
    }
  }
  return servers
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
