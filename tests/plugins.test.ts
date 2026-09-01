import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// Counts file reads so the cache tests can assert a repeat call re-reads nothing.
// The builtin namespace is not spyable, so the module is wrapped instead, like os.
const fsHoisted = vi.hoisted(() => ({ reads: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    fsHoisted.reads++
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync }
})

import { installedPlugins, resetInstalledPluginsCache, substitutePluginVars } from '../extensions/internal/plugins.ts'

describe('substitutePluginVars user_config', () => {
  const plugin = { name: 'p', root: '/r', dataDir: '/d', manifest: {}, userConfig: { token: 'secret-x', region: 'eu' } }

  it('substitutes ${user_config.KEY} alongside the plugin path vars', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} config syntax under test
    expect(substitutePluginVars('${CLAUDE_PLUGIN_ROOT}/bin --token ${user_config.token} --region ${user_config.region}', plugin as never)).toBe('/r/bin --token secret-x --region eu')
  })

  it('replaces an unknown user_config key with an empty string', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} config syntax under test
    expect(substitutePluginVars('x=${user_config.missing}', plugin as never)).toBe('x=')
  })
})

const home = (): string => mkdtempSync(join(tmpdir(), 'plugins-home-'))

/** Lay down one cached plugin version with a manifest. */
const install = (root: string, marketplace: string, plugin: string, version: string, manifest?: Record<string, unknown>): string => {
  const dir = join(root, '.claude', 'plugins', 'cache', marketplace, plugin, version)
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: plugin, ...manifest }))
  return dir
}

const enable = (root: string, entries: Record<string, boolean>): void => {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: entries }))
}

describe('installedPlugins', () => {
  it('loads an enabled cached plugin with its root and data dir', () => {
    const h = home()
    const dir = install(h, 'community', 'formatter', '1.2.0')
    enable(h, { formatter: true })

    const plugins = installedPlugins(h, [])
    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('formatter')
    expect(plugins[0].root).toBe(dir)
    expect(plugins[0].dataDir).toBe(join(h, '.claude', 'plugins', 'data', 'formatter-community'))
  })

  it('keeps underscores and hyphens in the data-dir id, folding only characters outside a-zA-Z0-9_-', () => {
    // plugins-reference: "{id} is the plugin identifier with characters outside a-z,
    // A-Z, 0-9, _, and - replaced by -".
    const h = home()
    install(h, 'my-market', 'my_plugin', '1.0.0')
    enable(h, { 'my_plugin@my-market': true })

    const plugins = installedPlugins(h, [])
    expect(plugins[0].dataDir).toBe(join(h, '.claude', 'plugins', 'data', 'my_plugin-my-market'))
  })

  it('skips plugins that are not enabled or explicitly disabled', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    install(h, 'community', 'linter', '1.0.0')
    enable(h, { linter: false })

    expect(installedPlugins(h, [])).toEqual([])
  })

  it('honors marketplace-qualified enablement and picks the newest version', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.9.0')
    const newest = install(h, 'community', 'formatter', '1.10.0')
    enable(h, { 'formatter@community': true })

    const plugins = installedPlugins(h, [])
    expect(plugins).toHaveLength(1)
    expect(plugins[0].root).toBe(newest)
  })

  it('attaches userConfig from pluginConfigs in settings', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    mkdirSync(join(h, '.claude'), { recursive: true })
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { formatter: true }, pluginConfigs: { formatter: { options: { api_token: 'tok-1' } } } }))
    expect(installedPlugins(h)[0].userConfig).toEqual({ api_token: 'tok-1' })
  })

  it('lets a later user settings file toggle a plugin off, project files never counted', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })
    const later = mkdtempSync(join(tmpdir(), 'plugins-user-'))
    writeFileSync(join(later, 'settings.json'), JSON.stringify({ enabledPlugins: { formatter: false } }))

    // An additional user-controlled source can flip it; the default (no extra
    // sources) is user settings alone, and no surface passes a project file.
    expect(installedPlugins(h, [join(later, 'settings.json')])).toEqual([])
    expect(installedPlugins(h)).toHaveLength(1)
  })
})

describe('installedPlugins cache', () => {
  it('serves a repeat call without re-reading settings or manifests', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })
    const first = installedPlugins(h)
    expect(first).toHaveLength(1)

    const mark = fsHoisted.reads
    expect(installedPlugins(h)).toEqual(first)
    // The walk is memoized; a repeat call revalidates with stats, not file reads.
    expect(fsHoisted.reads).toBe(mark)
  })

  it('re-reads after resetInstalledPluginsCache', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })
    installedPlugins(h)

    resetInstalledPluginsCache()
    const mark = fsHoisted.reads
    expect(installedPlugins(h)).toHaveLength(1)
    expect(fsHoisted.reads).toBeGreaterThan(mark)
  })

  it('sees a settings edit on the next call', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })
    expect(installedPlugins(h)).toHaveLength(1)

    enable(h, { formatter: false })
    expect(installedPlugins(h)).toEqual([])
  })

  it('sees a plugin installed under an existing marketplace on the next call', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true, linter: true })
    expect(installedPlugins(h)).toHaveLength(1)

    install(h, 'community', 'linter', '1.0.0')
    expect(
      installedPlugins(h)
        .map((p) => p.name)
        .sort(),
    ).toEqual(['formatter', 'linter'])
  })

  it('sees an in-place edit of the resolved manifest on the next call', () => {
    const h = home()
    const dir = install(h, 'community', 'formatter', '1.0.0', { displayName: 'Original' })
    enable(h, { formatter: true })
    expect(installedPlugins(h)[0].manifest.displayName).toBe('Original')

    // Rewrite plugin.json in place: no cache-tree directory entry changes, so only a
    // fingerprint that stats the manifest itself can notice. Pin a distinct mtime so
    // the stat token differs even for a same-instant rewrite.
    const manifest = join(dir, '.claude-plugin', 'plugin.json')
    writeFileSync(manifest, JSON.stringify({ name: 'formatter', displayName: 'Edited' }))
    const future = new Date(Date.now() + 5000)
    utimesSync(manifest, future, future)

    expect(installedPlugins(h)[0].manifest.displayName).toBe('Edited')
  })
})
