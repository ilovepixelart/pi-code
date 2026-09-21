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

import { installedPlugins, pluginComponentPath, resetInstalledPluginsCache, substitutePluginVars } from '../extensions/internal/plugins.ts'

describe('substitutePluginVars user_config', () => {
  const plugin = { name: 'p', root: '/r', dataDir: '/d', manifest: {}, userConfig: { token: 'secret-x', region: 'eu' } }

  it('substitutes ${user_config.KEY} alongside the plugin path vars', () => {
    expect(substitutePluginVars('${CLAUDE_PLUGIN_ROOT}/bin --token ${user_config.token} --region ${user_config.region}', plugin as never)).toBe('/r/bin --token secret-x --region eu')
  })

  it('replaces an unknown user_config key with an empty string', () => {
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

describe('pluginComponentPath', () => {
  // Claude: a plugin's component path "rejects a component path that resolves outside the
  // plugin root, such as ../shared-utils".
  const root = join(tmpdir(), 'plugins', 'p')
  const plugin = { name: 'p', root, dataDir: join(tmpdir(), 'd'), manifest: {} }

  it('resolves a declared path inside the plugin root', () => {
    expect(pluginComponentPath(plugin, 'skills')).toBe(join(root, 'skills'))
    expect(pluginComponentPath(plugin, 'nested/dir')).toBe(join(root, 'nested', 'dir'))
    expect(pluginComponentPath(plugin, './commands')).toBe(join(root, 'commands'))
  })

  it('rejects a declared path that escapes the plugin root', () => {
    expect(pluginComponentPath(plugin, '../shared-utils')).toBeUndefined()
    expect(pluginComponentPath(plugin, 'skills/../../elsewhere')).toBeUndefined()
    expect(pluginComponentPath(plugin, join(tmpdir(), 'elsewhere'))).toBeUndefined()
  })
})

describe('substitutePluginVars escaping', () => {
  it('escapes a backslash-bearing plugin root so the hooks JSON still parses', () => {
    // The real case is a Windows root such as C:\Users\me\1.0.0\uv: substituted verbatim
    // into raw JSON it injects invalid escape sequences, the parse throws, and every hook
    // the plugin declared silently vanishes. The caller passes a JSON escaper for exactly
    // this, and the rule is testable on any platform, unlike a directory whose name
    // contains a backslash, which Windows cannot create.
    const jsonEscape = (value: string): string => JSON.stringify(value).slice(1, -1)
    const root = String.raw`C:\Users\me\1.0.0\uv`
    const raw = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh' }] }] } })

    const substituted = substitutePluginVars(raw, { name: 'fmt', root, dataDir: '/d', manifest: {} }, jsonEscape)

    const parsed = JSON.parse(substituted) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } }
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(`${root}/scripts/format.sh`)
  })
})

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

  it('skips an explicitly disabled plugin while a no-entry install stays enabled by default', () => {
    // Claude: defaultEnabled defaults to true, so an installed plugin with no
    // enabledPlugins entry runs; an explicit false turns it off.
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    install(h, 'community', 'linter', '1.0.0')
    enable(h, { linter: false })

    expect(installedPlugins(h, []).map((p) => p.name)).toEqual(['formatter'])
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

  it('sees a same-size settings rewrite within one timestamp tick', () => {
    // The mtime:size token cannot distinguish these two writes; only content
    // can. Same defect class as the settings-watch flake fixed in #170.
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    mkdirSync(join(h, '.claude'), { recursive: true })
    const settings = join(h, '.claude', 'settings.json')
    const on = '{"enabledPlugins":{"formatter":true }}'
    const off = '{"enabledPlugins":{"formatter":false}}'
    expect(on.length).toBe(off.length)
    const frozen = new Date('2026-01-02T03:04:05Z')
    writeFileSync(settings, on)
    utimesSync(settings, frozen, frozen)
    expect(installedPlugins(h, []).map((p) => p.name)).toEqual(['formatter'])

    writeFileSync(settings, off)
    utimesSync(settings, frozen, frozen)
    expect(installedPlugins(h, [])).toEqual([])
  })

  it('ranks a release above its own prerelease, per semver', () => {
    // The update-then-grace layout can hold 1.0.0-beta beside 1.0.0; a plain
    // string sort ranks the prerelease higher and serves stale plugin code.
    const h = home()
    install(h, 'community', 'formatter', '1.0.0-beta')
    const release = install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })

    expect(installedPlugins(h, [])[0].root).toBe(release)
  })

  it('compares numerically across a stray v prefix', () => {
    const h = home()
    install(h, 'community', 'formatter', 'v2.0.0')
    const newest = install(h, 'community', 'formatter', '10.0.0')
    enable(h, { formatter: true })

    expect(installedPlugins(h, [])[0].root).toBe(newest)
  })

  it('attaches userConfig from pluginConfigs in settings', () => {
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    mkdirSync(join(h, '.claude'), { recursive: true })
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { formatter: true }, pluginConfigs: { formatter: { options: { api_token: 'tok-1' } } } }))
    expect(installedPlugins(h)[0].userConfig).toEqual({ api_token: 'tok-1' })
  })

  it('coerces number and boolean option values to strings and drops the rest', () => {
    // ${user_config.KEY} substitutes into command strings, so scalars must
    // arrive as text and structured values must not arrive at all.
    const h = home()
    install(h, 'community', 'formatter', '1.0.0')
    mkdirSync(join(h, '.claude'), { recursive: true })
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { formatter: true }, pluginConfigs: { formatter: { options: { retries: 3, verbose: true, name: 'x', nested: { no: 1 }, list: [1] } } } }))
    expect(installedPlugins(h)[0].userConfig).toEqual({ retries: '3', verbose: 'true', name: 'x' })
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

/** Claude's record of what is installed: per plugin id, the installs and where each lives. */
const writeInstallIndex = (root: string, plugins: Record<string, unknown>, version = 2): void => {
  const dir = join(root, '.claude', 'plugins')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ version, plugins }))
}

const orphan = (versionDir: string): void => writeFileSync(join(versionDir, '.orphaned_at'), '1789000000000')

const rootsOf = (root: string): string[] => installedPlugins(root).map((plugin) => plugin.root)

describe('which version directory of a plugin loads', () => {
  // Claude's cache keeps old versions for a grace period and names some by commit sha. The
  // walk read "the newest" from the names alone, so `2fe0f0266557` (a sha, parsed as the
  // number 2) beat `1.2.49`, and a version Claude had already orphaned could beat the live one.
  it('takes the directory Claude recorded, not a higher-sorting sha directory', () => {
    const h = home()
    const live = install(h, 'official', 'azure', '1.2.49')
    install(h, 'official', 'azure', '2fe0f0266557')
    enable(h, { 'azure@official': true })
    writeInstallIndex(h, { 'azure@official': [{ scope: 'user', installPath: live, version: '1.2.49' }] })

    expect(rootsOf(h)).toEqual([live])
  })

  it('prefers the user-scope install over a project one listed before it', () => {
    // Enablement here is the user's own; a project or local install is another project's copy.
    const h = home()
    const projectCopy = install(h, 'official', 'review', 'unknown')
    const userCopy = install(h, 'official', 'review', 'c447c3207a42')
    enable(h, { 'review@official': true })
    writeInstallIndex(h, {
      'review@official': [
        { scope: 'project', projectPath: '/somewhere/else', installPath: projectCopy, version: 'unknown' },
        { scope: 'user', installPath: userCopy, version: 'c447c3207a42' },
      ],
    })

    expect(rootsOf(h)).toEqual([userCopy])
  })

  it('reads the older index layout, one install object per plugin', () => {
    const h = home()
    const live = install(h, 'official', 'azure', '1.2.49')
    install(h, 'official', 'azure', '2fe0f0266557')
    enable(h, { 'azure@official': true })
    writeInstallIndex(h, { 'azure@official': { version: '1.2.49', installPath: live } }, 1)

    expect(rootsOf(h)).toEqual([live])
  })

  it('skips a version Claude marked orphaned when there is no index entry', () => {
    const h = home()
    const older = install(h, 'community', 'formatter', '1.0.0')
    orphan(install(h, 'community', 'formatter', '2.0.0'))
    enable(h, { formatter: true })

    expect(rootsOf(h)).toEqual([older])
  })

  it('loads nothing for a plugin whose every version is orphaned', () => {
    const h = home()
    orphan(install(h, 'community', 'formatter', '1.0.0'))
    enable(h, { formatter: true })

    expect(rootsOf(h)).toEqual([])
  })

  it('falls back to the newest live version when the recorded directory is gone', () => {
    const h = home()
    const gone = join(h, '.claude', 'plugins', 'cache', 'community', 'formatter', '9.9.9')
    const live = install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })
    writeInstallIndex(h, { 'formatter@community': [{ scope: 'user', installPath: gone }] })

    expect(rootsOf(h)).toEqual([live])
  })

  it('ignores a recorded path that is not a version directory of that plugin', () => {
    // The index is a file in the user's config, but a path pointing at another plugin's tree
    // or outside the cache would make one plugin load another's code.
    const h = home()
    const live = install(h, 'community', 'formatter', '1.0.0')
    // A version name the plugin also has, so only the path itself says it belongs elsewhere.
    const other = install(h, 'community', 'linter', '1.0.0')
    enable(h, { formatter: true, linter: false })
    writeInstallIndex(h, { 'formatter@community': [{ scope: 'user', installPath: other }] })

    expect(rootsOf(h)).toEqual([live])
  })

  it('does not load the dot-directory Claude leaves while it clones a marketplace', () => {
    const h = home()
    mkdirSync(join(h, '.claude', 'plugins', 'cache', 'temp_git_1789929883961_186qjw', '.git', 'refs'), { recursive: true })
    install(h, 'community', 'formatter', '1.0.0')
    enable(h, { formatter: true })

    expect(installedPlugins(h).map((plugin) => plugin.name)).toEqual(['formatter'])
  })

  it('notices an edit of the index on the next call', () => {
    const h = home()
    const first = install(h, 'official', 'azure', '1.2.47')
    const second = install(h, 'official', 'azure', '1.2.49')
    enable(h, { 'azure@official': true })
    writeInstallIndex(h, { 'azure@official': [{ scope: 'user', installPath: first }] })
    expect(rootsOf(h)).toEqual([first])

    writeInstallIndex(h, { 'azure@official': [{ scope: 'user', installPath: second }] })
    expect(rootsOf(h)).toEqual([second])
  })
})

describe('installedPlugins manifest failures', () => {
  it('reports a plugin manifest it cannot parse instead of dropping the plugin', () => {
    // Without the manifest the plugin has no components at all: no commands, agents,
    // skills, hooks or MCP servers, and nothing says why it stopped working.
    const home = mkdtempSync(join(tmpdir(), 'plug-home-'))
    const root = join(home, '.claude', 'plugins', 'cache', 'market', 'broken', '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name": "broken",}')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { broken: true } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      resetInstalledPluginsCache()
      installedPlugins(home)

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin.json'))
    } finally {
      warn.mockRestore()
    }
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
    // The walk is memoized. Revalidation re-reads only the small settings file and Claude's
    // install index (content-hashed so a same-size rewrite is seen); the expensive part,
    // re-parsing every manifest in the tree, must not happen.
    expect(fsHoisted.reads).toBe(mark + 2)
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

describe('plugin default enablement and managed control', () => {
  it('enables an installed plugin with no enabledPlugins entry, per defaultEnabled defaulting to true', () => {
    const h = home()
    install(h, 'community', 'fresh', '1.0.0')

    expect(installedPlugins(h, []).some((p) => p.name === 'fresh')).toBe(true)
  })

  it('keeps a defaultEnabled: false plugin off until the user opts in', () => {
    const h = home()
    const dir = install(h, 'community', 'optin', '1.0.0')
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'optin', defaultEnabled: false }))

    expect(installedPlugins(h, []).some((p) => p.name === 'optin')).toBe(false)
    enable(h, { optin: true })
    resetInstalledPluginsCache()
    expect(installedPlugins(h, []).some((p) => p.name === 'optin')).toBe(true)
  })

  it('lets managed enabledPlugins force-enable and block over the user setting', async () => {
    const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')
    const h = home()
    setManagedSettingsPath(join(h, 'managed-settings.json'))
    try {
      install(h, 'community', 'forced', '1.0.0')
      install(h, 'community', 'blocked', '1.0.0')
      enable(h, { forced: false, blocked: true })
      writeFileSync(join(h, 'managed-settings.json'), JSON.stringify({ enabledPlugins: { forced: true, blocked: false } }))

      const names = installedPlugins(h, []).map((p) => p.name)
      expect(names).toContain('forced')
      expect(names).not.toContain('blocked')
    } finally {
      setManagedSettingsPath(undefined)
    }
  })
})
