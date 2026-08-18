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
import type { ServerConfig } from './config.js'

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

/** Claude's `allowedMcpServers`/`deniedMcpServers`, read from managed settings only
 * (not user or project settings, so a repo can neither widen nor narrow the policy),
 * applied globally to every server across scopes. Entries are `{ serverName }` objects
 * (bare strings tolerated). `allowed` is null when unset (no restriction); an empty
 * set is an explicit lockdown, as Claude documents (empty allow array = deny all). */
export function mcpAllowDeny(managedFile: string = managedSettingsFile()): { allowed: Set<string> | null; denied: Set<string> } {
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
