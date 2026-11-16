import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultResourceLoader, loadSkills, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const { default: skillsExt, pluginSkills } = await import('../extensions/skills.ts')
const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')

const writeSkill = (dir: string, name: string, body = 'Local body $ARGUMENTS'): string => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, `---\nname: ${name}\ndescription: Synthetic test skill\n---\n${body}`)
  return file
}

describe('local Claude skill discovery', () => {
  let cwd: string
  let agentDir: string
  let personal: string

  beforeEach(() => {
    hoisted.home = mkdtempSync(join(tmpdir(), 'skill-discovery-'))
    cwd = join(hoisted.home, 'project')
    agentDir = join(hoisted.home, '.pi', 'agent')
    personal = join(hoisted.home, '.claude', 'skills')
    mkdirSync(join(cwd, '.git'), { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    // SDK dependencies are externalized: mocking node:os alone does not isolate them.
    vi.stubEnv('HOME', hoisted.home)
    vi.stubEnv('USERPROFILE', hoisted.home)
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
    setManagedSettingsPath(join(hoisted.home, 'policy', 'managed-settings.json'))
  })
  afterEach(() => setManagedSettingsPath(undefined))

  const wire = (getCommands: () => Array<{ name: string; source: string; sourceInfo: { path: string } }> = () => []) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>()
    const exec = vi.fn(async () => ({ stdout: 'EXECUTED', stderr: '', code: 0 }))
    skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec, getCommands } as never)
    const context = (trusted: boolean) => ({ cwd, isProjectTrusted: () => trusted })
    return {
      discover: async (reason = 'startup', trusted = true) => (await handlers.get('resources_discover')?.({ reason }, context(trusted))) as { skillPaths: string[] } | undefined,
      input: async (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, context(true)),
      exec,
    }
  }
  const native = (skillPaths: string[]) => loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false })

  it('excludes the personal cache while preserving local, nested and similarly named directories', async () => {
    const direct = writeSkill(join(personal, 'local'), 'local')
    const nested = writeSkill(join(personal, 'group', 'nested'), 'nested')
    const similar = writeSkill(join(personal, 'synced-other'), 'synced-other')
    writeSkill(join(personal, 'synced', 'bucket', 'remote'), 'remote')
    const result = await wire().discover()
    expect([...(result?.skillPaths ?? [])].sort()).toEqual([direct, nested, similar].sort())
    expect(
      native(result?.skillPaths ?? [])
        .skills.map((skill) => skill.name)
        .sort(),
    ).toEqual(['local', 'nested', 'synced-other'])
  })

  it('contributes nothing for empty directories or a cache-only installation', async () => {
    mkdirSync(personal, { recursive: true })
    const fixture = wire()
    expect(await fixture.discover()).toBeUndefined()
    writeSkill(join(personal, 'synced', 'bucket', 'remote'), 'remote')
    expect(await fixture.discover('reload')).toBeUndefined()
  })

  // Claude Code skips the cache by its directory name only, so a personal link into it
  // is an ordinary personal skill there and takes precedence over a project skill.
  it('loads a personal link into the cache as a personal skill, ahead of a project skill', async () => {
    const cached = join(personal, 'synced', 'bucket', 'greet')
    writeSkill(cached, 'greet', 'LINKED $ARGUMENTS')
    symlinkSync(cached, join(personal, 'alias'), 'junction')
    const project = writeSkill(join(cwd, '.claude', 'skills', 'greet'), 'greet', 'PROJECT $ARGUMENTS')
    new ProjectTrustStore(agentDir).set(cwd, true)
    const fixture = wire()
    const result = await fixture.discover()
    const linked = join(personal, 'alias', 'SKILL.md')
    expect(result?.skillPaths).toEqual([linked, project])
    expect(native(result?.skillPaths ?? []).skills[0]?.filePath).toBe(linked)
    expect(await fixture.input('/skill:greet world')).toMatchObject({ action: 'transform', text: expect.stringContaining('LINKED world') })
  })

  it('leaves cached skill invocations to pi without running injected commands', async () => {
    const cached = join(personal, 'synced', 'bucket', 'greet')
    writeSkill(cached, 'greet', 'CACHE !`echo forbidden`')
    const fixture = wire()
    expect(await fixture.discover()).toBeUndefined()
    expect(await fixture.input('/skill:greet')).toBeUndefined()
    expect(fixture.exec).not.toHaveBeenCalled()
  })

  it('loads a cache file linked into an ordinary skill directory', async () => {
    const cached = writeSkill(join(personal, 'synced', 'bucket', 'remote'), 'remote')
    const alias = join(personal, 'alias')
    mkdirSync(alias)
    symlinkSync(cached, join(alias, 'SKILL.md'), 'file')
    expect((await wire().discover())?.skillPaths).toEqual([join(alias, 'SKILL.md')])
  })

  it('excludes the lexical cache subtree even when a nested cache entry links outside it', async () => {
    const external = join(hoisted.home, 'external')
    writeSkill(external, 'remote')
    mkdirSync(join(personal, 'synced', 'bucket'), { recursive: true })
    symlinkSync(external, join(personal, 'synced', 'bucket', 'remote'), 'junction')
    expect(await wire().discover()).toBeUndefined()
  })

  it('preserves ordinary skill links and skips broken links', async () => {
    const external = join(hoisted.home, 'external')
    writeSkill(external, 'linked')
    mkdirSync(personal, { recursive: true })
    symlinkSync(external, join(personal, 'linked'), 'junction')
    symlinkSync(join(hoisted.home, 'missing'), join(personal, 'broken'), 'junction')
    const fixture = wire()
    const result = await fixture.discover()
    expect(native(result?.skillPaths ?? []).skills.map((skill) => skill.name)).toEqual(['linked'])
    expect(await fixture.input('/skill:linked world')).toMatchObject({ action: 'transform', text: expect.stringContaining('Local body world') })
  })

  it.each(['custom', 'linked-home', 'linked-custom'])('excludes the cache with a %s configuration directory', async (layout) => {
    const config = join(hoisted.home, 'config-store')
    writeSkill(join(config, 'skills', 'local'), 'local')
    writeSkill(join(config, 'skills', 'synced', 'bucket', 'remote'), 'remote')
    if (layout === 'custom') vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    else {
      const link = join(hoisted.home, layout === 'linked-home' ? '.claude' : 'config-link')
      symlinkSync(config, link, 'junction')
      if (layout === 'linked-custom') vi.stubEnv('CLAUDE_CONFIG_DIR', link)
    }
    const result = await wire().discover()
    expect(native(result?.skillPaths ?? []).skills.map((skill) => skill.name)).toEqual(['local'])
  })

  it('keeps project directories named synced behind the existing approval check', async () => {
    writeSkill(join(personal, 'synced', 'bucket', 'remote'), 'remote')
    const project = writeSkill(join(cwd, '.claude', 'skills', 'synced'), 'synced')
    const fixture = wire()
    expect(await fixture.discover()).toBeUndefined()
    new ProjectTrustStore(agentDir).set(cwd, true)
    expect(await fixture.discover('reload', false)).toBeUndefined()
    expect((await fixture.discover('reload'))?.skillPaths).toEqual([project])
    expect(await fixture.input('/skill:synced world')).toMatchObject({ action: 'transform', text: expect.stringContaining('Local body world') })
  })

  it.each(['.gitignore', '.ignore', '.fdignore'])('preserves %s, root markdown files and SKILL.md recursion stops', async (ignoreFile) => {
    const parent = writeSkill(join(personal, 'parent'), 'parent')
    writeSkill(join(personal, 'parent', 'child'), 'child')
    writeSkill(join(personal, 'ignored'), 'ignored')
    writeFileSync(join(personal, ignoreFile), 'ignored/\n')
    const markdown = join(personal, 'legacy.md')
    writeFileSync(markdown, '---\nname: legacy\ndescription: Synthetic legacy skill\n---\nLegacy body')
    const result = await wire().discover()
    expect([...(result?.skillPaths ?? [])].sort()).toEqual([parent, markdown].sort())
    expect(
      native(result?.skillPaths ?? [])
        .skills.map((skill) => skill.name)
        .sort(),
    ).toEqual(['legacy', 'parent'])
  })

  it('preserves native diagnostics without duplicating warnings for valid skills', async () => {
    const invalid = writeSkill(join(personal, 'invalid'), 'invalid')
    writeFileSync(invalid, '---\nname: invalid\n---\nNo description')
    const warned = writeSkill(join(personal, 'warned'), 'Bad_Name')
    const cachedInvalid = writeSkill(join(personal, 'synced', 'bucket', 'invalid'), 'invalid')
    writeFileSync(cachedInvalid, '---\nname: invalid\n---\nNo description')
    const result = await wire().discover()
    expect([...(result?.skillPaths ?? [])].sort()).toEqual([invalid, warned].sort())
    const loaded = native(result?.skillPaths ?? [])
    expect(loaded.diagnostics).toEqual(native([warned, invalid]).diagnostics)
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ path: invalid, message: expect.stringMatching(/description/i) }))
  })

  it('preserves enterprise, personal and project precedence without early name deduplication', async () => {
    const enterprise = writeSkill(join(hoisted.home, 'policy', '.claude', 'skills', 'synced'), 'greet', 'ENTERPRISE $ARGUMENTS')
    const local = writeSkill(join(personal, 'greet'), 'greet', 'PERSONAL $ARGUMENTS')
    const project = writeSkill(join(cwd, '.claude', 'skills', 'greet'), 'greet', 'PROJECT $ARGUMENTS')
    new ProjectTrustStore(agentDir).set(cwd, true)
    const fixture = wire()
    const result = await fixture.discover()
    expect(result?.skillPaths).toEqual([enterprise, local, project])
    expect(native(result?.skillPaths ?? []).skills[0]?.filePath).toBe(enterprise)
    expect(await fixture.input('/skill:greet world')).toMatchObject({ action: 'transform', text: expect.stringContaining('ENTERPRISE world') })
  })

  it('keeps a plugin skill named synced in the independent plugin flow', async () => {
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))
    writeSkill(join(root, 'skills', 'synced'), 'synced')
    expect(pluginSkills(hoisted.home).map((skill) => skill.name)).toEqual(['kit:synced'])
    expect(await wire().input('/kit:synced world')).toMatchObject({ action: 'transform', text: expect.stringContaining('Local body world') })
  })

  it('supports explicit pi settings imports and reload without taking over their expansion', async () => {
    const cached = writeSkill(join(personal, 'synced', 'bucket', 'greet'), 'greet', 'CACHE !`echo forbidden`')
    writeSkill(join(personal, 'greet'), 'greet', 'LOCAL $ARGUMENTS')
    const plugin = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))
    writeSkill(join(plugin, 'skills', 'greet'), 'greet', 'PLUGIN !`echo forbidden`')
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ skills: [cached] }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    const fixture = wire(() => loader.getSkills().skills.map((skill) => ({ name: `skill:${skill.name}`, source: 'skill', sourceInfo: skill.sourceInfo })))
    const refresh = async (reason: string) => {
      await loader.reload()
      const metadata = { source: 'local', scope: 'user', origin: 'top-level', baseDir: hoisted.home } as const
      loader.extendResources({ skillPaths: ((await fixture.discover(reason))?.skillPaths ?? []).map((file) => ({ path: file, metadata })) })
      return loader.getSkills().skills
    }
    expect((await refresh('startup')).map((skill) => skill.filePath)).toEqual([cached])
    expect(await fixture.input('/skill:greet prod')).toBeUndefined()
    expect(fixture.exec).not.toHaveBeenCalled()
    const local = join(personal, 'greet', 'SKILL.md')
    const localBody = '---\nname: renamed-local\ndescription: Synthetic local skill\n---\nLocal body'
    writeFileSync(local, localBody)
    const withPluginFallback = await refresh('reload')
    expect(withPluginFallback.find((skill) => skill.name === 'greet')?.filePath).toBe(cached)
    expect(await fixture.input('/skill:greet prod')).toBeUndefined()
    expect(fixture.exec).not.toHaveBeenCalled()
    const added = writeSkill(join(personal, 'added'), 'added')
    expect((await refresh('reload')).map((skill) => skill.filePath).sort()).toEqual([cached, local, added].sort())
  })
})
