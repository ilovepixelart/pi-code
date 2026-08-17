import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { installedPlugins, substitutePluginVars } from '../extensions/internal/plugins.ts'

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
