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

import * as fs from 'node:fs'
import * as path from 'node:path'

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

/** Version directories sort numerically segment-wise, so 1.10.0 beats 1.9.0. */
function newestVersion(versions: string[]): string | undefined {
  return [...versions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
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

/**
 * Enabled plugins from the cache. Enablement is decided by the user's own
 * settings only: plugins install to the user's machine and carry code (hook
 * scripts, MCP server commands), so a checked-out repo must not be able to flip
 * which of them run. `extraSettingsFiles`, when given, are additional
 * user-controlled settings sources, not project files.
 */
export function installedPlugins(home: string, extraSettingsFiles: string[] = []): InstalledPlugin[] {
  const cacheDir = path.join(home, '.claude', 'plugins', 'cache')
  const settingsFiles = [path.join(home, '.claude', 'settings.json'), ...extraSettingsFiles]
  const enabled = enabledMap(settingsFiles)
  const configs = pluginConfigsMap(settingsFiles)
  const plugins: InstalledPlugin[] = []
  for (const marketplace of listDirs(cacheDir)) {
    for (const pluginDir of listDirs(path.join(cacheDir, marketplace))) {
      const plugin = resolvePlugin(home, cacheDir, marketplace, pluginDir, enabled, configs)
      if (plugin) plugins.push(plugin)
    }
  }
  return plugins
}

/** Resolve one cached plugin directory into an enabled InstalledPlugin, or null to skip
 * it: not turned on in settings, or no version directory on disk yet. */
function resolvePlugin(home: string, cacheDir: string, marketplace: string, pluginDir: string, enabled: Record<string, boolean>, configs: Record<string, Record<string, string>>): InstalledPlugin | null {
  const qualified = `${pluginDir}@${marketplace}`
  const state = enabled[qualified] ?? enabled[pluginDir]
  if (state !== true) return null
  const version = newestVersion(listDirs(path.join(cacheDir, marketplace, pluginDir)))
  if (!version) return null
  const root = path.join(cacheDir, marketplace, pluginDir, version)
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'))
  const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : pluginDir
  const id = qualified.replace(/[^A-Za-z0-9]+/g, '-')
  const userConfig = configs[qualified] ?? configs[pluginDir] ?? configs[name]
  return { name, root, dataDir: path.join(home, '.claude', 'plugins', 'data', id), manifest, ...(userConfig ? { userConfig } : {}) }
}

/** The two plugin path variables, textually substituted into plugin-shipped
 * config (hook commands, MCP server definitions, command bodies). */
export function substitutePluginVars(value: string, plugin: InstalledPlugin): string {
  return value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.root)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', plugin.dataDir)
    .replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => plugin.userConfig?.[key] ?? '')
}
