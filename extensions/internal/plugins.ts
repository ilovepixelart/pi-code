/**
 * Discovery for installed Claude Code plugins.
 *
 * Marketplace installs live under ~/.claude/plugins/cache/<marketplace>/<name>/
 * <version>/, with an optional .claude-plugin/plugin.json manifest, and are
 * active only when `enabledPlugins` in the settings chain says true, under the
 * bare name or the marketplace-qualified `name@marketplace`. Only an explicit
 * true enables: Claude writes the entry on install, so a cached plugin with no
 * entry is not one the user turned on. With no version index on disk, the
 * newest version directory wins, matching the update-then-grace-period layout.
 * The persistent data directory (${CLAUDE_PLUGIN_DATA}) survives updates at
 * ~/.claude/plugins/data/<id>, id being the qualified name folded to dashes.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { claudeConfigDir } from './config-dir.js'
import { readManagedSettings } from './managed-settings.js'

export interface InstalledPlugin {
  name: string
  /** The version directory: ${CLAUDE_PLUGIN_ROOT}. */
  root: string
  /** ${CLAUDE_PLUGIN_DATA}; may not exist yet. */
  dataDir: string
  manifest: Record<string, unknown>
  /** Resolved `pluginConfigs[id].options` values, exposed as `${user_config.KEY}`. */
  userConfig?: Record<string, string>
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** One version string split for comparison: optional v prefix dropped, numeric
 * base segments, and whatever follows a dash as the prerelease tag. */
function parseVersion(version: string): { base: number[]; pre: string | undefined } {
  const stripped = version.replace(/^v/i, '')
  const dash = stripped.indexOf('-')
  const base = (dash === -1 ? stripped : stripped.slice(0, dash)).split('.').map((segment) => Number.parseInt(segment, 10) || 0)
  return { base, pre: dash === -1 ? undefined : stripped.slice(dash + 1) }
}

/** Semver ordering to the depth plugin cache dirs need: 1.10.0 beats 1.9.0,
 * 10.0.0 beats v2.0.0, and a release outranks its own prerelease (a plain
 * string sort got both of the latter wrong). */
function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < Math.max(left.base.length, right.base.length); i++) {
    const diff = (left.base[i] ?? 0) - (right.base[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre.localeCompare(right.pre, 'en', { numeric: true })
}

function newestVersion(versions: string[]): string | undefined {
  return [...versions].sort(compareVersions).at(-1)
}

/** The enablement map, later files winning per key, as settings scopes merge. */
function enabledMap(settingsFiles: string[]): Record<string, boolean> {
  const merged: Record<string, boolean> = {}
  for (const file of settingsFiles) {
    const entry = readJson(file).enabledPlugins
    if (entry === null || typeof entry !== 'object') continue
    for (const [name, value] of Object.entries(entry)) {
      if (typeof value === 'boolean') merged[name] = value
    }
  }
  return merged
}

/** Copy one plugin config's `options` into `target`, coercing scalars to strings and
 * ignoring the rest, later keys winning. */
function mergeOptionValues(target: Record<string, string>, options: object): void {
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string') target[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') target[key] = String(value)
  }
}

/** `pluginConfigs[id].options` per plugin id, later files winning per key. */
function pluginConfigsMap(settingsFiles: string[]): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {}
  for (const file of settingsFiles) {
    const entry = readJson(file).pluginConfigs
    if (entry === null || typeof entry !== 'object') continue
    for (const [id, config] of Object.entries(entry)) {
      const options = (config as Record<string, unknown>)?.options
      if (options === null || typeof options !== 'object') continue
      const values = merged[id] ?? {}
      mergeOptionValues(values, options)
      merged[id] = values
    }
  }
  return merged
}

/** Memoized discovery per (home, extra settings files), revalidated by fingerprint. */
const pluginCache = new Map<string, { fingerprint: string; plugins: InstalledPlugin[] }>()

/** Drop every memoized discovery; the next installedPlugins call walks afresh. */
export function resetInstalledPluginsCache(): void {
  pluginCache.clear()
}

/** mtime plus size; cheap, but blind to a same-size rewrite within one
 * timestamp tick, so only directory-tree entries use it. */
function statToken(target: string): string {
  try {
    const stat = fs.statSync(target)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/** Content hash for the small settings files: a same-size rewrite within one
 * mtime tick (the settings-watch flake class) must still invalidate the cache. */
function contentToken(target: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  } catch {
    return 'missing'
  }
}

/**
 * A cheap change signature for one home's plugin config: the settings files'
 * content hashes plus the cache tree's directory names and mtimes down through each plugin's
 * version directories, and the stat token of the resolved (newest) version's manifest
 * so an in-place edit of it invalidates the cache. Costs a few stats where the full
 * walk reads and parses the settings and every manifest.
 */
function pluginFingerprint(cacheDir: string, settingsFiles: string[]): string {
  const parts = settingsFiles.map(contentToken)
  for (const marketplace of listDirs(cacheDir)) {
    const marketplaceDir = path.join(cacheDir, marketplace)
    parts.push(`${marketplace}:${statToken(marketplaceDir)}`)
    for (const pluginDir of listDirs(marketplaceDir)) {
      const pluginPath = path.join(marketplaceDir, pluginDir)
      parts.push(`${marketplace}/${pluginDir}:${statToken(pluginPath)}`)
      const versions = listDirs(pluginPath)
      for (const version of versions) {
        parts.push(`${marketplace}/${pluginDir}/${version}:${statToken(path.join(pluginPath, version))}`)
      }
      // resolvePlugin reads only the newest version's manifest, so its stat token is
      // what an in-place edit (no directory entry changing) must move.
      const newest = newestVersion(versions)
      if (newest) parts.push(`${marketplace}/${pluginDir}/${newest}/manifest:${statToken(path.join(pluginPath, newest, '.claude-plugin', 'plugin.json'))}`)
    }
  }
  return parts.join('\n')
}

/**
 * Enabled plugins from the cache. Enablement is decided by the user's own
 * settings only: plugins install to the user's machine and carry code (hook
 * scripts, MCP server commands), so a checked-out repo must not be able to flip
 * which of them run. `extraSettingsFiles`, when given, are additional
 * user-controlled settings sources, not project files.
 *
 * Several extensions call this at session start and per discovery, so the walk
 * is memoized behind the fingerprint above; callers always see current data
 * because any settings edit or cache-tree change invalidates it.
 */
export function installedPlugins(home: string, extraSettingsFiles: string[] = []): InstalledPlugin[] {
  const cacheDir = path.join(claudeConfigDir(home), 'plugins', 'cache')
  const settingsFiles = [path.join(claudeConfigDir(home), 'settings.json'), ...extraSettingsFiles]
  const key = [home, ...extraSettingsFiles].join('\n')
  const fingerprint = pluginFingerprint(cacheDir, settingsFiles)
  const cached = pluginCache.get(key)
  if (cached?.fingerprint === fingerprint) return cached.plugins
  const enabled = enabledMap(settingsFiles)
  const configs = pluginConfigsMap(settingsFiles)
  const plugins: InstalledPlugin[] = []
  for (const marketplace of listDirs(cacheDir)) {
    for (const pluginDir of listDirs(path.join(cacheDir, marketplace))) {
      const plugin = resolvePlugin(home, cacheDir, marketplace, pluginDir, enabled, configs)
      if (plugin) plugins.push(plugin)
    }
  }
  pluginCache.set(key, { fingerprint, plugins })
  return plugins
}

/** The plugin's effective enablement per Claude's precedence: a managed
 * enabledPlugins entry force-enables or blocks, then the user's setting, then the
 * manifest's defaultEnabled, which defaults to true ("starts in an enabled state
 * when the user has not set one"). */
function pluginEnabled(qualified: string, pluginDir: string, enabled: Record<string, boolean>, manifest: Record<string, unknown>): boolean {
  const managedEntry = readManagedSettings().enabledPlugins
  if (managedEntry !== null && typeof managedEntry === 'object') {
    const managedState = (managedEntry as Record<string, unknown>)[qualified] ?? (managedEntry as Record<string, unknown>)[pluginDir]
    if (typeof managedState === 'boolean') return managedState
  }
  const userState = enabled[qualified] ?? enabled[pluginDir]
  if (typeof userState === 'boolean') return userState
  return manifest.defaultEnabled !== false
}

/** Resolve one cached plugin directory into an enabled InstalledPlugin, or null to skip
 * it: turned off by managed/user settings or defaultEnabled, or no version yet. */
function resolvePlugin(home: string, cacheDir: string, marketplace: string, pluginDir: string, enabled: Record<string, boolean>, configs: Record<string, Record<string, string>>): InstalledPlugin | null {
  const qualified = `${pluginDir}@${marketplace}`
  const version = newestVersion(listDirs(path.join(cacheDir, marketplace, pluginDir)))
  if (!version) return null
  const root = path.join(cacheDir, marketplace, pluginDir, version)
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'))
  if (!pluginEnabled(qualified, pluginDir, enabled, manifest)) return null
  const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : pluginDir
  // Claude: "{id} is the plugin identifier with characters outside a-z, A-Z, 0-9,
  // _, and - replaced by -", one dash per character, underscores kept.
  const id = qualified.replace(/[^A-Za-z0-9_-]/g, '-')
  const userConfig = configs[qualified] ?? configs[pluginDir] ?? configs[name]
  return { name, root, dataDir: path.join(claudeConfigDir(home), 'plugins', 'data', id), manifest, ...(userConfig ? { userConfig } : {}) }
}

/** The two plugin path variables, textually substituted into plugin-shipped
 * config (hook commands, MCP server definitions, command bodies). A caller
 * substituting into text that is still raw JSON must pass an escapeValue that
 * JSON-escapes: a Windows root (C:\Users\...) inserted verbatim injects invalid
 * escape sequences and the subsequent parse throws. */
/** A plugin component path, resolved inside the plugin root. Claude "rejects a component
 * path that resolves outside the plugin root, such as `../shared-utils`", so an escaping
 * entry yields undefined and its caller skips that component. The check is lexical, which
 * is the rule as documented: a plugin's own root may itself be a symlink (link mode). */
export function pluginComponentPath(plugin: Pick<InstalledPlugin, 'name' | 'root'>, declared: string): string | undefined {
  const resolved = path.resolve(plugin.root, declared)
  const inside = path.relative(plugin.root, resolved)
  if (inside !== '' && (inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside))) {
    console.warn(`pi-code-plugins: plugin ${plugin.name} declares the component path "${declared}", which resolves outside its root; ignoring it`)
    return undefined
  }
  return resolved
}

export function substitutePluginVars(value: string, plugin: InstalledPlugin, escapeValue: (substituted: string) => string = (substituted) => substituted): string {
  return value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', escapeValue(plugin.root))
    .replaceAll('${CLAUDE_PLUGIN_DATA}', escapeValue(plugin.dataDir))
    .replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => escapeValue(plugin.userConfig?.[key] ?? ''))
}
