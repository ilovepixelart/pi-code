/**
 * MCP server policy: the per-project .mcp.json approvals, the managed allow/deny
 * lists, and the managed-mcp.json exclusive-control loader. The managed settings
 * path (and its test-seam override) is owned by internal/managed-settings.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { claudeConfigDir } from '../internal/config-dir.js'
import { managedSettingsFile } from '../internal/managed-settings.js'
import { findNearestFile } from '../internal/project-root.js'
import { interpolateEnv, type ServerConfig } from './config.js'

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
  const userSettings = read(path.join(claudeConfigDir(home), 'settings.json'))
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

/** One allow/deny list entry, keyed by exactly one of Claude's three match kinds. */
export interface McpPolicyEntry {
  /** Exact user-assigned label; never expanded. */
  serverName?: string
  /** Remote server URL, exact or with `*` wildcards anywhere. */
  serverUrl?: string
  /** Exact command and arguments that start a stdio server. */
  serverCommand?: string[]
}

export interface McpPolicy {
  /** null when no honored scope sets allowedMcpServers: every server passing the denylist loads. */
  allowed: McpPolicyEntry[] | null
  denied: McpPolicyEntry[]
}

/** A raw list entry into its typed form. A bare string is a name (Claude tolerates it);
 * an object is keyed serverUrl > serverCommand > serverName; anything else is dropped. */
function parsePolicyEntry(entry: unknown): McpPolicyEntry | undefined {
  if (typeof entry === 'string') return entry.length > 0 ? { serverName: entry } : undefined
  if (entry === null || typeof entry !== 'object') return undefined
  const { serverName, serverUrl, serverCommand } = entry as Record<string, unknown>
  if (typeof serverUrl === 'string' && serverUrl.length > 0) return { serverUrl }
  if (Array.isArray(serverCommand) && serverCommand.length > 0 && serverCommand.every((part): part is string => typeof part === 'string')) return { serverCommand: serverCommand as string[] }
  if (typeof serverName === 'string' && serverName.length > 0) return { serverName }
  return undefined
}

/** Claude's `allowedMcpServers`/`deniedMcpServers`. Both lists merge from every honored
 * settings scope (the caller passes the trust-gated chain, so a repo's file counts only
 * once the project is approved); managed `allowManagedMcpServersOnly: true` keeps only
 * the managed allowlist, while the denylist always merges from every scope, as Claude
 * documents. An allowlist `serverName` entry is limited to letters, numbers, hyphens and
 * underscores (a denylist name accepts any non-empty string). `allowed` is null when no
 * honored scope sets the key; an empty list is an explicit lockdown (deny all). */
export function mcpAllowDeny(scopeFiles: string[] = [], managedFile: string = managedSettingsFile()): McpPolicy {
  const read = (file: string): Record<string, unknown> => {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      return {} // no such file: genuinely no policy
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      // Present but unreadable: its allow and deny lists are not in force, and a deny list
      // silently dropped leaves every server allowed.
      console.warn(`pi-code-mcp: ignoring ${file}: not valid JSON; its MCP allow and deny lists are not applied`)
      return {}
    }
  }
  const entries = (value: unknown): McpPolicyEntry[] => (Array.isArray(value) ? value.map(parsePolicyEntry).filter((entry): entry is McpPolicyEntry => entry !== undefined) : [])
  const managed = read(managedFile)
  const scopes = scopeFiles.map(read)
  const allowSources = managed.allowManagedMcpServersOnly === true ? [managed] : [managed, ...scopes]
  const allowSet = allowSources.some((settings) => Array.isArray(settings.allowedMcpServers))
  return {
    allowed: allowSet ? allowSources.flatMap((settings) => entries(settings.allowedMcpServers)).filter((entry) => entry.serverName === undefined || /^[A-Za-z0-9_-]+$/.test(entry.serverName)) : null,
    denied: [managed, ...scopes].flatMap((settings) => entries(settings.deniedMcpServers)),
  }
}

/** `*` in a policy URL pattern matches any run of characters; everything else is literal. */
function wildcardRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('.*')
  return new RegExp(`^${source}$`)
}

/** Claude's URL pattern match: `*` anywhere including the scheme; the scheme/host/port
 * part compares case-insensitively and ignores a trailing FQDN dot, the path stays
 * case-sensitive, and a pattern with no path matches any path. */
export function urlPatternMatches(pattern: string, url: string): boolean {
  const split = (value: string): { pre: string; path: string | undefined } => {
    const schemeEnd = value.indexOf('://')
    const slash = value.indexOf('/', schemeEnd === -1 ? 0 : schemeEnd + 3)
    if (slash === -1) return { pre: value, path: undefined }
    return { pre: value.slice(0, slash), path: value.slice(slash) }
  }
  const pre = (value: string): string => value.toLowerCase().replace(/\.(?=:\d+$|$)/, '')
  const patternParts = split(pattern)
  const urlParts = split(url)
  if (!wildcardRegExp(pre(patternParts.pre)).test(pre(urlParts.pre))) return false
  if (patternParts.path === undefined) return true
  return wildcardRegExp(patternParts.path).test(urlParts.path ?? '/')
}

const configUrl = (config: ServerConfig): string | undefined => (config as { url?: string }).url
const configArgv = (config: ServerConfig): string[] | undefined => {
  const command = (config as { command?: string }).command
  if (typeof command !== 'string') return undefined
  const args = (config as { args?: unknown }).args
  return [command, ...(Array.isArray(args) ? args.filter((part): part is string => typeof part === 'string') : [])]
}
const argvEqual = (a: string[], b: string[]): boolean => a.length === b.length && a.every((part, i) => part === b[i])
/** Policy-side expansion. Divergence from Claude, documented: Claude expands policy
 * entries from a pinned startup environment; pi-code expands from the live process env.
 * The deny path compensates by also matching the unexpanded forms (see entryMatches),
 * which can only widen a deny, never weaken it. */
const expand = (value: string): string => interpolateEnv(value)

/** Whether one policy entry matches a server. `includeRawForms` is the deny-side rule:
 * raw and expanded forms both count, so expansion drift can only widen a deny. The
 * allow side matches expanded forms only, mirroring Claude ignoring an allow entry
 * whose expansion would change what it means. */
function entryMatches(entry: McpPolicyEntry, name: string, config: ServerConfig, includeRawForms: boolean): boolean {
  if (entry.serverUrl !== undefined) {
    const url = configUrl(config)
    if (url === undefined) return false
    return urlPatternMatches(expand(entry.serverUrl), expand(url)) || (includeRawForms && urlPatternMatches(entry.serverUrl, url))
  }
  if (entry.serverCommand !== undefined) {
    const argv = configArgv(config)
    if (argv === undefined) return false
    return argvEqual(entry.serverCommand.map(expand), argv.map(expand)) || (includeRawForms && argvEqual(entry.serverCommand, argv))
  }
  return entry.serverName === name
}

/** Claude's allowlist rule per server type: a remote server must match a `serverUrl`
 * entry and a stdio server a `serverCommand` entry; a `serverName` match counts only
 * when the allowlist contains no typed entries for that transport. */
function serverAllowed(name: string, config: ServerConfig, allowed: McpPolicyEntry[] | null): boolean {
  if (allowed === null) return true
  const remote = configUrl(config) !== undefined
  const typed = allowed.filter((entry) => (remote ? entry.serverUrl !== undefined : entry.serverCommand !== undefined))
  if (typed.some((entry) => entryMatches(entry, name, config, false))) return true
  if (typed.length > 0) return false
  return allowed.some((entry) => entry.serverName === name)
}

/** The managed-mcp.json path: a sibling of managed-settings.json (same directory). Derived
 * through the same test seam so a test can write both into one temp dir. */
export function managedMcpPath(managedFile: string = managedSettingsFile()): string {
  return path.join(path.dirname(managedFile), 'managed-mcp.json')
}

/** Claude's managed-mcp.json: when it exists beside managed-settings.json it takes
 * exclusive control of MCP. Only its `mcpServers` load; user, project, and plugin servers
 * are all suppressed (and the project-approval flow with them), and an empty map disables
 * MCP entirely. Returns the managed server map (possibly empty) when the file exists and
 * parses, or null only when the file is absent, in which case MCP loads from the usual
 * scopes exactly as before. A file that parses but carries no `mcpServers` object is an
 * empty managed set, so a deployed-but-bodyless policy locks down rather than silently
 * reopening the other scopes. A file that is PRESENT but not valid JSON fails closed to
 * the same empty set (deny-all) rather than reopening those scopes: the lockdown intent
 * means a corrupt or truncated policy file must not become an allow-all. The allow/deny
 * lists still filter the returned set. */
export function loadManagedMcpServers(managedFile: string = managedSettingsFile()): Record<string, ServerConfig> | null {
  const file = managedMcpPath(managedFile)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    // Absent (or unreadable) managed-mcp.json: no managed MCP control, load normally.
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // Present but corrupt: fail closed to an empty managed set, exactly like an empty map,
    // rather than reopening the user/project/plugin scopes.
    console.warn(`pi-code-mcp: managed-mcp.json is present but not valid JSON (${file}); failing closed to no MCP servers: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return {}
  return servers as Record<string, ServerConfig>
}

/** Claude's allow/deny lists: a denylist match by URL, command or name blocks, and
 * nothing overrides it; then a null allowlist keeps all, while a present one (even
 * empty) is exclusive per the typed rule in serverAllowed. */
export function applyServerPolicy(servers: Record<string, ServerConfig>, policy: McpPolicy): Record<string, ServerConfig> {
  const out: Record<string, ServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (policy.denied.some((entry) => entryMatches(entry, name, config, true))) continue
    if (!serverAllowed(name, config, policy.allowed)) continue
    out[name] = config
  }
  return out
}
