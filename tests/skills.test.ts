import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Point os.homedir() at a hermetic temp home so the extension-wiring test never reads the
// developer's real ~/.claude skills. The other suites pass home explicitly and are unaffected.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const { default: skillsExt, skillDirs, pluginSkills } = await import('../extensions/skills.ts')
const { sharedSlot } = await import('../extensions/internal/shared-slot.ts')

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

describe('skills trust gating', () => {
  it('omits the project skills directory until the project is approved', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    // A project skill's name and description reach the model's prompt, so an
    // unapproved repository must not contribute them.
    expect(skillDirs(cwd, home, false)).toEqual([join(home, '.claude', 'skills')])
  })
})

describe('skillDirs', () => {
  it('returns nothing when no .claude/skills directory exists', () => {
    expect(skillDirs(tempDir('cs-proj-'), tempDir('cs-home-'), true)).toEqual([])
  })

  it('returns the project skills directory when it exists', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    expect(skillDirs(cwd, home, true)).toEqual([join(cwd, '.claude', 'skills')])
  })

  it('lists user skills before project skills', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    expect(skillDirs(cwd, home, true)).toEqual([join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')])
  })

  it('ignores a .claude/skills path that is a file, not a directory', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'skills'), 'not a dir')
    expect(skillDirs(cwd, home, true)).toEqual([])
  })

  it('keeps an enabled plugin skills directory out of the loader scan', () => {
    // pi's loader would name the skill by its directory, dropping the plugin prefix, so
    // plugin skills are registered as /plugin:name commands instead of contributed here.
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    const root = join(home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, 'skills'), { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))

    expect(skillDirs(cwd, home, false)).toEqual([])
  })

  it('skips a plugin skills directory declared outside the plugin root', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    const root = join(home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, 'skills'), { recursive: true })
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    // A real directory outside the plugin: without the guard it would be scanned, since
    // the only other thing standing between a declared path and the loader is existence.
    const outside = join(home, 'outside-skills')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', skills: relative(root, outside) }))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))

    // The outside path is refused, and the plugin's own skills are not part of the loader
    // scan either: a declaration adds to the plugin's own scan (see pluginSkills).
    const dirs = skillDirs(cwd, home, false)
    expect(dirs).not.toContain(outside)
    expect(dirs).toEqual([])
  })

  it('adds a declared skills directory to the default scan rather than replacing it', () => {
    // Claude: "Adds to the default: `skills`. The default `skills/` directory is always
    // scanned, and directories listed in `skills` are loaded alongside it." Replacing it
    // silently dropped every skill in the conventional location.
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    const root = join(home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, 'skills', 'bundled-skill'), { recursive: true })
    mkdirSync(join(root, 'extra', 'extra-skill'), { recursive: true })
    writeFileSync(join(root, 'skills', 'bundled-skill', 'SKILL.md'), '---\nname: bundled-skill\ndescription: bundled\n---\nBundled')
    writeFileSync(join(root, 'extra', 'extra-skill', 'SKILL.md'), '---\nname: extra-skill\ndescription: extra\n---\nExtra')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', skills: 'extra' }))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))

    expect(skillDirs(cwd, home, false)).toEqual([])
    expect(pluginSkills(home).map((skill) => skill.name)).toEqual(['kit:extra-skill', 'kit:bundled-skill'])
  })

  it('finds project skills at the repository root from a subdirectory session', () => {
    const repo = tempDir('cs-repo-')
    const home = tempDir('cs-home-')
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true })
    const sub = join(repo, 'src')
    mkdirSync(sub)
    expect(skillDirs(sub, home, true)).toEqual([join(repo, '.claude', 'skills')])
  })
})

describe('extension wiring', () => {
  // A mocked homedir plus a fresh agent dir make the discovery hermetic: the trust store
  // and the home skills both live in temp dirs, never the developer's real config.
  let savedAgentDir: string | undefined
  beforeEach(() => {
    hoisted.home = tempDir('cs-home-')
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = tempDir('cs-agent-')
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  it('returns skillPaths from resources_discover when skills exist', async () => {
    const cwd = tempDir('cs-proj-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    const homeSkills = join(hoisted.home, '.claude', 'skills')
    mkdirSync(homeSkills, { recursive: true })

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    // A .claude/skills directory is itself claude-shaped config, so a project pi trusts
    // silently but has no stored decision for contributes nothing: only the hermetic home
    // skills survive, and never the project's, trusted or not.
    const trusted = (await handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd, isProjectTrusted: () => true })) as { skillPaths: string[] } | undefined
    expect(trusted).toEqual({ skillPaths: [homeSkills] })

    const untrusted = (await handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd, isProjectTrusted: () => false })) as { skillPaths: string[] } | undefined
    expect(untrusted).toEqual({ skillPaths: [homeSkills] })
  })

  it('registers an enabled plugin skill as a /plugin:name command and expands it', async () => {
    const cwd = tempDir('cs-proj-')
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, 'skills', 'deploy'), { recursive: true })
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))
    writeFileSync(join(root, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: deploys\nargument-hint: "[target]"\n---\nDeploy $ARGUMENTS now.')

    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<unknown> }>()
    const sent: string[] = []
    skillsExt({
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<unknown> }) => commands.set(name, options),
      registerTool: () => {},
      sendUserMessage: (text: string) => sent.push(text),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    } as never)
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd, sessionManager: { getBranch: () => [] } })

    expect([...commands.keys()]).toEqual(['kit:deploy'])
    expect(commands.get('kit:deploy')?.description).toContain('[target]')
    // The menu runs the command handler, not the input pipeline, so the handler has to
    // expand the skill itself. pi would otherwise deliver the raw "/kit:deploy" text.
    await commands.get('kit:deploy')?.handler('prod', { cwd, isIdle: () => true, isProjectTrusted: () => true, hasUI: false, waitForIdle: async () => {} })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('<skill name="kit:deploy"')
    expect(sent[0]).toContain('Deploy prod now.')
  })

  it('keeps one skill when two plugins register the same name', () => {
    const home = hoisted.home
    for (const market of ['market', 'other']) {
      const root = join(home, '.claude', 'plugins', 'cache', market, 'kit', '1.0.0')
      mkdirSync(join(root, 'skills', 'deploy'), { recursive: true })
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
      writeFileSync(join(root, 'skills', 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: from ${market}\n---\nFrom ${market}`)
    }
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))

    expect(pluginSkills(home).map((skill) => skill.name)).toEqual(['kit:deploy'])
  })

  it('reports a plugin skill name collision once per process', () => {
    const home = hoisted.home
    for (const market of ['market', 'other']) {
      const root = join(home, '.claude', 'plugins', 'cache', market, 'kit', '1.0.0')
      mkdirSync(join(root, 'skills', 'deploy'), { recursive: true })
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
      writeFileSync(join(root, 'skills', 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: from ${market}\n---\nFrom ${market}`)
    }
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Discovery reruns on every session start, input and tool call.
      pluginSkills(home)
      pluginSkills(home)
      expect(warn.mock.calls.filter(([message]) => String(message).includes('is hidden by'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not register a plugin skill over a command that already owns its name', async () => {
    const cwd = tempDir('cs-proj-')
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, 'skills', 'deploy'), { recursive: true })
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))
    writeFileSync(join(root, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: deploys\n---\nDeploy')

    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, unknown>()
    skillsExt({
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      getCommands: () => [{ name: 'kit:deploy', source: 'command' }],
      registerCommand: (name: string) => commands.set(name, true),
      registerTool: () => {},
    } as never)
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd, sessionManager: { getBranch: () => [] }, isProjectTrusted: () => true })

    expect(commands.has('kit:deploy')).toBe(false)
  })

  const pluginFixture = (body = '---\nname: deploy\ndescription: deploys\n---\nDeploy $ARGUMENTS', dir = 'deploy') => {
    const cwd = tempDir('cs-proj-')
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    const filePath = join(root, 'skills', dir, 'SKILL.md')
    const settingsPath = join(hoisted.home, '.claude', 'settings.json')
    mkdirSync(join(root, 'skills', dir), { recursive: true })
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { kit: true } }))
    writeFileSync(filePath, body)
    const ctx = { cwd, sessionManager: { getBranch: () => [] }, isProjectTrusted: () => true, isIdle: () => true, hasUI: false, waitForIdle: vi.fn(async () => {}), ui: { notify: vi.fn() } }
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    type Tool = {
      description: string
      prepareLoadout: () => { descriptions: { plugin_skill: string } }
      execute: (id: string, params: { command: string }, signal: undefined, update: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>
    }
    const tools = new Map<string, Tool>()
    const sendUserMessage = vi.fn()
    const emit = vi.fn()
    const exec = vi.fn(async () => ({ stdout: 'SPAN-OUT', stderr: '', code: 0 }))
    const piCommands: Array<{ name: string; source: string; sourceInfo: { path: string } }> = []
    skillsExt({
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
      getCommands: () => piCommands,
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options),
      registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
      sendUserMessage,
      exec,
      events: { emit },
    } as never)
    const start = (context = ctx) => handlers.get('session_start')?.({}, context)
    const invoke = (context = ctx, command = '/kit:deploy prod') => tools.get('plugin_skill')!.execute('call', { command }, undefined, undefined, context)
    const input = (text: string, context = ctx) => handlers.get('input')?.({ text, source: 'interactive' }, context) as Promise<{ action: string; text?: string } | undefined>
    return { ctx, root, filePath, settingsPath, handlers, commands, tools, sendUserMessage, emit, exec, piCommands, start, invoke, input }
  }

  it.each(['\n', '\t', ' '])('splits the name from the arguments on any whitespace (%j)', async (separator) => {
    const t = pluginFixture()
    await t.start()
    const result = await t.invoke(t.ctx, `/kit:deploy${separator}prod`)
    expect(result.content[0].text).toContain('Deploy prod')
    expect((await t.input(`/kit:deploy${separator}prod`))?.text).toContain('Deploy prod')
  })

  // Claude: "Plugin skills are not affected by skillOverrides. Manage those through
  // /plugin instead." A key written for a personal skill of the same bare name must not
  // reach a plugin's skill either.
  it.each([
    ['kit:deploy', 'off'],
    ['kit:deploy', 'user-invocable-only'],
    ['kit:deploy', 'name-only'],
    ['deploy', 'off'],
  ])('leaves a plugin skill untouched by skillOverrides %s: %s', async (key, state) => {
    const t = pluginFixture()
    writeFileSync(t.settingsPath, JSON.stringify({ enabledPlugins: { kit: true }, skillOverrides: { [key]: state } }))
    await t.start()
    expect(t.commands.has('kit:deploy')).toBe(true)
    expect(t.tools.get('plugin_skill')?.description).toContain('/kit:deploy - deploys')
    expect((await t.invoke()).content[0].text).toContain('Deploy prod')
    expect((await t.input('/kit:deploy prod'))?.text).toContain('Deploy prod')
    expect(t.ctx.ui.notify).not.toHaveBeenCalled()
  })

  it.each(['/kit:deploy prod', '/skill:kit:deploy prod'])('refuses typed %s for a plugin skill marked user-invocable: false', async (text) => {
    const t = pluginFixture('---\nname: deploy\ndescription: deploys\nuser-invocable: false\n---\nDeploy $ARGUMENTS !`git diff`')
    await t.start()
    expect(t.commands.has('kit:deploy')).toBe(false)
    expect(await t.input(text, { ...t.ctx, hasUI: true })).toEqual({ action: 'handled' })
    expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('user-invocable: false'), 'info')
    expect(t.exec).not.toHaveBeenCalled()
    // The model path is the one such a skill exists for.
    expect((await t.invoke()).content[0].text).toContain('Deploy prod')
  })

  // Claude names a plugin skill `plugin:<directory>` internally and shows the frontmatter
  // name; both spellings have to reach the same skill, listed once.
  it.each(['/kit:ship prod', '/skill:kit:ship prod'])('accepts the directory name as an alias in typed %s', async (text) => {
    const t = pluginFixture(undefined, 'ship')
    await t.start()
    expect([...t.commands.keys()]).toEqual(['kit:deploy'])
    const outcome = await t.input(text)
    expect(outcome?.text).toContain('<skill name="kit:deploy"')
    expect(outcome?.text).toContain('Deploy prod')
  })

  it('accepts the directory name as an alias in the plugin_skill tool without listing it', async () => {
    const t = pluginFixture(undefined, 'ship')
    await t.start()
    const tool = t.tools.get('plugin_skill')!
    expect(tool.description).toContain('/kit:deploy')
    expect(tool.description).not.toContain('/kit:ship')
    expect((await t.invoke(t.ctx, '/kit:ship prod')).content[0].text).toContain('<skill name="kit:deploy"')
  })

  it('prefers a frontmatter name over the directory alias of another skill', async () => {
    const t = pluginFixture('---\nname: release\ndescription: releases\n---\nRELEASE BODY')
    mkdirSync(join(t.root, 'skills', 'other'))
    writeFileSync(join(t.root, 'skills', 'other', 'SKILL.md'), '---\nname: deploy\ndescription: deploys\n---\nDEPLOY BODY')
    await t.start()
    expect((await t.input('/kit:deploy'))?.text).toContain('DEPLOY BODY')
    expect((await t.invoke(t.ctx, '/kit:deploy')).content[0].text).toContain('DEPLOY BODY')
    expect((await t.input('/kit:other'))?.text).toContain('DEPLOY BODY')
  })

  describe('the bare /skill:name form of a plugin skill', () => {
    // The notice is once per process; each test starts with nothing reported.
    beforeEach(() => sharedSlot<Set<string>>('warned-once').set(undefined))

    const secondPlugin = (name: string) => {
      const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', name, '1.0.0')
      mkdirSync(join(root, 'skills', 'deploy'), { recursive: true })
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }))
      writeFileSync(join(root, 'skills', 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: deploys\n---\nFROM ${name}`)
      writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true, [name]: true } }))
    }

    it('still resolves to the one plugin skill of that name, with one deprecation notice', async () => {
      const t = pluginFixture()
      await t.start()
      const ui = { ...t.ctx, hasUI: true }
      const first = await t.input('/skill:deploy prod', ui)
      expect(first?.text).toContain('<skill name="kit:deploy"')
      expect(first?.text).toContain('Deploy prod')
      expect((await t.input('/skill:deploy again', ui))?.text).toContain('Deploy again')
      expect(t.ctx.ui.notify).toHaveBeenCalledTimes(1)
      expect(t.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/\/skill:deploy is deprecated.*\/kit:deploy/), 'warning')
    })

    it('prints the deprecation to stderr when there is no UI', async () => {
      const t = pluginFixture()
      await t.start()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect((await t.input('/skill:deploy prod'))?.text).toContain('Deploy prod')
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Use /kit:deploy instead'))
      } finally {
        warn.mockRestore()
      }
    })

    it('does not warn for the qualified forms', async () => {
      const t = pluginFixture()
      await t.start()
      const ui = { ...t.ctx, hasUI: true }
      await t.input('/skill:kit:deploy prod', ui)
      await t.input('/kit:deploy prod', ui)
      expect(t.ctx.ui.notify).not.toHaveBeenCalled()
    })

    it('leaves a personal skill of that name in charge', async () => {
      const t = pluginFixture()
      mkdirSync(join(hoisted.home, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(hoisted.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: mine\n---\nPERSONAL BODY')
      await t.start()
      const outcome = await t.input('/skill:deploy prod', { ...t.ctx, hasUI: true })
      expect(outcome?.text).toContain('PERSONAL BODY')
      expect(outcome?.text).toContain('<skill name="deploy"')
      expect(t.ctx.ui.notify).not.toHaveBeenCalled()
    })

    it('leaves a skill pi loaded under that name to pi', async () => {
      const t = pluginFixture()
      t.piCommands.push({ name: 'skill:deploy', source: 'skill', sourceInfo: { path: join(tempDir('cs-pi-'), 'SKILL.md') } })
      await t.start()
      expect(await t.input('/skill:deploy prod', { ...t.ctx, hasUI: true })).toBeUndefined()
      expect(t.ctx.ui.notify).not.toHaveBeenCalled()
    })

    it('names the qualified skills instead of guessing when several plugins ship the name', async () => {
      const t = pluginFixture()
      secondPlugin('aaa')
      await t.start()
      expect(await t.input('/skill:deploy prod', { ...t.ctx, hasUI: true })).toEqual({ action: 'handled' })
      expect(t.ctx.ui.notify).toHaveBeenCalledTimes(1)
      const [message] = t.ctx.ui.notify.mock.calls[0]
      expect(message).toContain('/aaa:deploy')
      expect(message).toContain('/kit:deploy')
    })
  })

  it('rechecks disable-model-invocation on every model call', async () => {
    const t = pluginFixture()
    await t.start()
    writeFileSync(t.filePath, '---\nname: deploy\ndescription: deploys\ndisable-model-invocation: true\n---\nUser only')
    await expect(t.invoke()).rejects.toThrow('user-only')
  })

  it('uses the current tool context for file and plugin variable expansion', async () => {
    const t = pluginFixture('---\nname: deploy\ndescription: deploys\n---\n@config.txt\n${CLAUDE_PROJECT_DIR}\n${CLAUDE_PLUGIN_ROOT}\n$ARGUMENTS')
    const other = tempDir('cs-other-')
    writeFileSync(join(t.ctx.cwd, 'config.txt'), 'WRONG PROJECT')
    writeFileSync(join(other, 'config.txt'), 'CURRENT PROJECT')
    await t.start()
    const result = await t.invoke({ ...t.ctx, cwd: other }, 'kit:deploy prod')
    expect(result.content[0].text).toContain('CURRENT PROJECT')
    expect(result.content[0].text).not.toContain('WRONG PROJECT')
    expect(result.content[0].text).toContain(other)
    expect(result.content[0].text).toContain(t.root)
    expect(result.content[0].text).toContain('prod')
  })

  it('emits skill hooks and runs a model-invoked fork with the expanded prompt', async () => {
    const { setAgentRunner } = await import('../extensions/internal/agent-run.ts')
    const t = pluginFixture('---\nname: deploy\ndescription: deploys\ncontext: fork\nagent: reviewer\nhooks:\n  Stop: []\n---\nReview $ARGUMENTS')
    const runner = vi.fn(async () => 'FORK RESULT')
    setAgentRunner(runner)
    try {
      await t.start()
      const result = await t.invoke()
      expect(result.content[0].text).toContain('FORK RESULT')
      expect(runner).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Review prod', agent: 'reviewer' }))
      expect(t.emit).toHaveBeenCalledWith('pi-code:skill-hooks', expect.objectContaining({ skillName: 'kit:deploy' }))
      expect(t.sendUserMessage).not.toHaveBeenCalled()
    } finally {
      setAgentRunner(undefined)
    }
  })

  it('keeps model expansion from executing injected shell', async () => {
    const t = pluginFixture('---\nname: deploy\ndescription: deploys\n---\n!`git diff`')
    await t.start()
    await t.invoke()
    expect(t.exec).not.toHaveBeenCalled()
  })

  it('refreshes the listing across sessions without registering duplicate commands', async () => {
    const t = pluginFixture()
    await t.start()
    const tool = t.tools.get('plugin_skill')!
    expect(tool.prepareLoadout().descriptions.plugin_skill).toContain('/kit:deploy')
    writeFileSync(t.settingsPath, JSON.stringify({ enabledPlugins: { kit: false } }))
    await t.start()
    expect(tool.prepareLoadout().descriptions.plugin_skill).not.toContain('/kit:deploy')
    await expect(t.invoke()).rejects.toThrow('not available')
    writeFileSync(t.settingsPath, JSON.stringify({ enabledPlugins: { kit: true } }))
    await t.start()
    expect(tool.prepareLoadout().descriptions.plugin_skill).toContain('/kit:deploy')
    expect(t.commands.size).toBe(1)
  })

  it('lets a plugin command win a skill name collision before registering either extension', async () => {
    const t = pluginFixture()
    mkdirSync(join(t.root, 'commands'))
    writeFileSync(join(t.root, 'commands', 'deploy.md'), 'Run the command')
    await t.start()
    expect(pluginSkills(hoisted.home)).toEqual([])
    expect(t.commands.has('kit:deploy')).toBe(false)
  })
})

describe('Claude skill invocation expansion', () => {
  const setup = (cwd: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const api = {
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      exec: async () => ({ stdout: 'SPAN-OUT\n', stderr: '', code: 0 }),
    }
    skillsExt(api as never)
    return { input: (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, { cwd }) }
  }

  it('expands dynamic content and arguments in a SKILL.md body, as Claude documents', async () => {
    // Claude: a command file and a skill "work the same way": !`cmd` injection and
    // $ARGUMENTS apply to SKILL.md bodies too. pi's loader delivers the raw text,
    // so the docs' first-skill tutorial (built on !`git diff`) emitted literal text.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: greets\n---\nDiff: !`git diff HEAD`\nHello $ARGUMENTS')
    const { input } = setup(cwd)
    const result = (await input('/skill:greet world')) as { action: string; text: string }
    expect(result?.action).toBe('transform')
    expect(result.text).toContain('<skill name="greet"')
    expect(result.text).toContain('SPAN-OUT')
    expect(result.text).toContain('Hello world')
    expect(result.text).not.toContain('$ARGUMENTS')
  })

  it('aborts the invocation when an injected command fails, as a command does', async () => {
    // docs/commands.md: a failed !`cmd` span aborts the invocation and the model never sees
    // a half-expanded body. pi logs a throwing input handler and carries on with the raw
    // text, so an uncaught failure sent SKILL.md unexpanded.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: greets\n---\nDiff: !`git diff HEAD`\nHello $ARGUMENTS')
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: 'fatal: bad revision', code: 128 }) } as never)
    const notes: Array<{ message: string; level?: string }> = []
    const result = await handlers.get('input')?.({ text: '/skill:greet world', source: 'interactive' }, { cwd, isProjectTrusted: () => true, ui: { notify: (message: string, level?: string) => notes.push({ message, level }) } })

    expect(result).toEqual({ action: 'handled' })
    expect(notes).toHaveLength(1)
    expect(notes[0].level).toBe('error')
    expect(notes[0].message).toContain('git diff HEAD')
  })

  // pi loads its own skill directories ahead of the ones extensions add, first name wins
  // (pi dist/core/resource-loader, skills): the listing then shows pi's skill, and the
  // invocation must run that one, not the Claude skill of the same name.
  const withPiSkill = (cwd: string, piSkillFile: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    skillsExt({
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      getCommands: () => [{ name: 'skill:greet', source: 'skill', sourceInfo: { path: piSkillFile } }],
    } as never)
    return (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, { cwd })
  }

  it("leaves a skill pi resolved to its own file to pi's expansion", async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: claude\n---\nCLAUDE BODY $ARGUMENTS')
    const piSkill = join(tempDir('pi-skills-'), 'SKILL.md')
    writeFileSync(piSkill, '---\nname: greet\ndescription: pi\n---\nPI BODY')

    expect(await withPiSkill(cwd, piSkill)('/skill:greet world')).toBeUndefined()
  })

  it('expands the Claude skill when it is the one pi loaded', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    const claudeSkill = join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md')
    writeFileSync(claudeSkill, '---\nname: greet\ndescription: claude\n---\nCLAUDE BODY $ARGUMENTS')

    const result = (await withPiSkill(cwd, claudeSkill)('/skill:greet world')) as { action: string; text: string }
    expect(result.action).toBe('transform')
    expect(result.text).toContain('CLAUDE BODY world')
  })

  it('expands a skill whose directory is a symlink, as pi loads it', async () => {
    // `npx skills add` installs under .agents/skills and links into .claude/skills, and
    // dotfile managers link the whole tree. pi's loader follows the link and registers the
    // skill; the shim skipped it (a symlink is not a directory to Dirent), so the plain
    // body went out with $ARGUMENTS literal and every dynamic feature off.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const real = tempDir('cs-real-')
    writeFileSync(join(real, 'SKILL.md'), '---\nname: greet\ndescription: greets\n---\nHello $ARGUMENTS')
    mkdirSync(join(hoisted.home, '.claude', 'skills'), { recursive: true })
    symlinkSync(real, join(hoisted.home, '.claude', 'skills', 'greet'))
    const { input } = setup(cwd)
    const result = (await input('/skill:greet world')) as { action: string; text: string }
    expect(result?.action).toBe('transform')
    expect(result.text).toContain('Hello world')
    expect(result.text).not.toContain('$ARGUMENTS')
  })

  it('leaves a dangling skill link to pi, and a link to a plain file', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const skills = join(hoisted.home, '.claude', 'skills')
    mkdirSync(skills, { recursive: true })
    symlinkSync(join(hoisted.home, 'nowhere'), join(skills, 'dangling'))
    writeFileSync(join(hoisted.home, 'plain.md'), 'not a directory')
    symlinkSync(join(hoisted.home, 'plain.md'), join(skills, 'plain'))
    const { input } = setup(cwd)
    expect(await input('/skill:dangling x')).toBeUndefined()
    expect(await input('/skill:plain x')).toBeUndefined()
  })

  it('matches a skill by frontmatter name over its directory name, like pi does', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'some-dir'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'some-dir', 'SKILL.md'), '---\nname: fancy\ndescription: named\n---\nBody here')
    const { input } = setup(cwd)
    const result = (await input('/skill:fancy')) as { action: string; text: string }
    expect(result?.action).toBe('transform')
    expect(result.text).toContain('Body here')
  })

  it('passes through a /skill: invocation it does not own', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const { input } = setup(cwd)
    expect(await input('/skill:not-ours x')).toBeUndefined()
  })

  it('passes through ordinary input untouched', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const { input } = setup(cwd)
    expect(await input('just a prompt')).toBeUndefined()
  })
})

describe('Claude skill lookup edge cases', () => {
  it('passes a malformed-frontmatter skill through to pi instead of throwing', async () => {
    // parseCommandFile throws on broken YAML; the invocation must degrade to pi's
    // plain expansion (raw body, no dynamic features), never fail the input.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'rough'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'rough', 'SKILL.md'), '---\nname: [broken yaml\n---\nRough body')
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
    await expect(handlers.get('input')?.({ text: '/skill:rough', source: 'interactive' }, { cwd })).resolves.toBeUndefined()
  })
})

describe('skill frontmatter hooks publication', () => {
  const setupWithBus = (cwd: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const emitted: Array<{ channel: string; data: unknown }> = []
    const api = {
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
    }
    skillsExt(api as never)
    return { input: (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, { cwd }), emitted }
  }

  it('publishes frontmatter hooks on the shared bus when a skill is invoked', async () => {
    // Claude registers hooks from skill frontmatter when the skill is invoked and
    // keeps them for the rest of the session; the hooks extension owns the running,
    // so the skill side publishes them over the shared bus.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'secure-ops'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'secure-ops', 'SKILL.md'), '---\nname: secure-ops\ndescription: guarded\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./scripts/check.sh\n---\nBody')
    const { input, emitted } = setupWithBus(cwd)
    await input('/skill:secure-ops')

    expect(emitted).toContainEqual({
      channel: 'pi-code:skill-hooks',
      data: { skillName: 'secure-ops', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh' }] }] } },
    })
  })

  it('publishes nothing for a skill without frontmatter hooks', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'plain'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: p\n---\nBody')
    const { input, emitted } = setupWithBus(cwd)
    await input('/skill:plain')

    expect(emitted).toEqual([])
  })
})

describe('context: fork and skillOverrides', () => {
  it('runs a context: fork skill through the subagent seam and returns its result', async () => {
    // Claude: "Add context: fork ... The skill content becomes the prompt that
    // drives the subagent"; `agent` picks the subagent type.
    const { setAgentRunner } = await import('../extensions/internal/agent-run.ts')
    const requests: unknown[] = []
    setAgentRunner(async (request) => {
      requests.push(request)
      return 'FORK RESULT'
    })
    try {
      const cwd = tempDir('cs-proj-')
      hoisted.home = tempDir('cs-home-')
      mkdirSync(join(hoisted.home, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(hoisted.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\ncontext: fork\nagent: reviewer\n---\nDeploy $ARGUMENTS now.')
      const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
      skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
      const result = (await handlers.get('input')?.({ text: '/skill:deploy prod', source: 'interactive' }, { cwd })) as { action: string; text?: string }

      expect(result.action).toBe('transform')
      expect(result.text).toContain('FORK RESULT')
      const request = requests[0] as { prompt: string; agent?: string }
      expect(request.prompt).toContain('Deploy prod now.')
      expect(request.agent).toBe('reviewer')
    } finally {
      setAgentRunner(undefined)
    }
  })

  describe('a forked skill in an interactive session', () => {
    // Claude: "The forked subagent runs in the background: you keep working while it runs,
    // and its result arrives in your conversation when it completes. Set background: false
    // in the frontmatter to instead wait for the result in the turn that invoked the skill."
    const forkSetup = async (frontmatterExtra = '') => {
      const { setAgentRunner } = await import('../extensions/internal/agent-run.ts')
      // Every fork is resolved at the end: one left pending stays "running" in the module
      // and would make the next test's invocation wait behind it.
      const finishers: Array<(text: string) => void> = []
      const requests: unknown[] = []
      setAgentRunner((request) => {
        requests.push(request)
        return new Promise<string>((resolve) => {
          finishers.push(resolve)
        })
      })
      const cwd = tempDir('cs-proj-')
      hoisted.home = tempDir('cs-home-')
      mkdirSync(join(hoisted.home, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(hoisted.home, '.claude', 'skills', 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: d\ncontext: fork\n${frontmatterExtra}---\nDeploy $ARGUMENTS now.`)
      // One skills instance per session, as pi re-runs the factory on each replacement and
      // makes the old instance's sendMessage throw once it is invalidated.
      const session = () => {
        const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
        const sent: Array<{ message: { content?: string }; options: unknown }> = []
        let sendThrows = false
        skillsExt({
          on: (name: string, fn: never) => handlers.set(name, fn),
          exec: async () => ({ stdout: '', stderr: '', code: 0 }),
          registerCommand: () => {},
          registerTool: () => {},
          sendMessage: (message: { content?: string }, options: unknown) => {
            if (sendThrows) throw new Error('This extension ctx is stale after session replacement or reload')
            sent.push({ message, options })
          },
        } as never)
        // A session in use has had turns; prompted false models one that has not had any yet.
        const start = async (prompted = true) => handlers.get('session_start')?.({ reason: 'startup' }, { sessionManager: { getBranch: () => (prompted ? [{ type: 'message' }] : []) }, cwd })
        const shutdown = async (reason: string) => {
          await handlers.get('session_shutdown')?.({ reason }, { cwd })
          sendThrows = true
        }
        return { handlers, sent, start, shutdown, stale: () => (sendThrows = true) }
      }
      const first = session()
      await first.start()
      const notes: string[] = []
      const invoke = () => first.handlers.get('input')?.({ text: '/skill:deploy prod', source: 'interactive' }, { cwd, hasUI: true, ui: { notify: (m: string) => notes.push(m) } }) as Promise<{ action: string; text?: string }>
      const done = async () => {
        for (const finish of finishers) finish('released')
        await new Promise((resolve) => setImmediate(resolve))
        setAgentRunner(undefined)
      }
      return { invoke, finish: (text: string) => finishers.at(-1)?.(text), sent: first.sent, notes, requests, staleSession: first.stale, first, session, done }
    }
    const settled = () => new Promise((resolve) => setImmediate(resolve))

    it('runs in the background and delivers the result to the conversation when it completes', async () => {
      const t = await forkSetup()
      try {
        const result = await t.invoke()
        expect(result.action).toBe('handled')
        expect(t.sent).toEqual([])
        expect(t.notes.join(' ')).toContain('deploy')

        t.finish('FORK RESULT')
        await settled()
        expect(t.sent).toHaveLength(1)
        expect(t.sent[0].message.content).toContain('FORK RESULT')
        expect(t.sent[0].options).toEqual({ triggerTurn: true })
      } finally {
        await t.done()
      }
    })

    // pi 1.1.0 sends a turn an extension starts before the session's first prompt without a
    // system prompt, and the session keeps going without one; the result is recorded for
    // the next prompt instead.
    it('records the result without starting a turn in a session that has had no turn yet', async () => {
      const t = await forkSetup()
      try {
        await t.first.shutdown('new')
        const second = t.session()
        await second.start(false)
        await t.invoke()
        t.finish('FORK RESULT')
        await settled()
        expect(second.sent).toHaveLength(1)
        expect(second.sent[0].options).toEqual({ triggerTurn: false })
      } finally {
        await t.done()
      }
    })

    it('waits in the invoking turn when the skill sets background: false', async () => {
      const t = await forkSetup('background: false\n')
      try {
        const pending = t.invoke()
        await settled()
        t.finish('FORK RESULT')
        const result = await pending
        expect(result.action).toBe('transform')
        expect(result.text).toContain('FORK RESULT')
        expect(t.sent).toEqual([])
      } finally {
        await t.done()
      }
    })

    it('waits when CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is 1', async () => {
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
      const t = await forkSetup()
      try {
        const pending = t.invoke()
        await settled()
        t.finish('FORK RESULT')
        expect((await pending).action).toBe('transform')
      } finally {
        await t.done()
        delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
      }
    })

    it('waits for a second invocation while an earlier one of the same skill is still running', async () => {
      const t = await forkSetup()
      try {
        expect((await t.invoke()).action).toBe('handled')
        const second = t.invoke()
        await settled()
        t.finish('SECOND RESULT')
        expect((await second).action).toBe('transform')
      } finally {
        await t.done()
      }
    })

    it('keeps a delivery that throws from escaping as an unhandled rejection', async () => {
      // The background promise has no awaiter, and sendMessage on an invalidated pi throws:
      // an escaping rejection there is an unhandledRejection, and pi exits on one.
      const t = await forkSetup()
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        await t.invoke()
        t.staleSession()
        t.finish('LATE RESULT')
        await settled()
        await settled()
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
        await t.done()
      }
    })

    it.each(['new', 'resume', 'fork', 'reload'])('delivers a fork finishing after a %s switch to the current session, once', async (reason) => {
      const t = await forkSetup()
      try {
        await t.invoke()
        await t.first.shutdown(reason)
        const next = t.session()
        await next.start()

        t.finish('LATE RESULT')
        await settled()

        expect(next.sent).toHaveLength(1)
        expect(next.sent[0].message.content).toContain('LATE RESULT')
        expect(next.sent[0].options).toEqual({ triggerTurn: true })
        expect(t.first.sent).toEqual([])
      } finally {
        await t.done()
      }
    })

    it('holds a fork finishing between sessions and delivers it once at the next session_start', async () => {
      const t = await forkSetup()
      try {
        await t.invoke()
        await t.first.shutdown('new')
        t.finish('LATE RESULT')
        await settled()

        const next = t.session()
        await next.start()
        await next.shutdown('new')
        const after = t.session()
        await after.start()

        expect(next.sent.map((s) => s.message.content)).toEqual([expect.stringContaining('LATE RESULT')])
        expect(after.sent).toEqual([])
      } finally {
        await t.done()
      }
    })
  })

  it('refuses a skill set to off in skillOverrides', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'quiet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'quiet', 'SKILL.md'), '---\nname: quiet\ndescription: q\n---\nBody')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { quiet: 'off' } }))
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const notes: string[] = []
    skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
    const result = (await handlers.get('input')?.({ text: '/skill:quiet', source: 'interactive' }, { cwd, hasUI: true, ui: { notify: (m: string) => notes.push(m) } })) as { action: string } | undefined

    expect(result?.action).toBe('handled')
    expect(notes.some((n) => n.includes('skillOverrides'))).toBe(true)
  })

  it('skips the enterprise skills directory when CLAUDE_CODE_DISABLE_POLICY_SKILLS is set', () => {
    // Claude: "Set to 1 to skip loading skills from the system-wide managed skills
    // directory. Useful for container or CI sessions that should not load
    // operator-provisioned skills." The enterprise dir beside managed-settings.json is
    // that directory here; personal and project skills are untouched.
    return (async () => {
      const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')
      const managedDir = tempDir('cs-managed-')
      setManagedSettingsPath(join(managedDir, 'managed-settings.json'))
      process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1'
      try {
        const cwd = tempDir('cs-proj-')
        const home = tempDir('cs-home-')
        mkdirSync(join(managedDir, '.claude', 'skills', 'deploy'), { recursive: true })
        writeFileSync(join(managedDir, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: e\n---\nENTERPRISE BODY')
        mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

        const dirs = skillDirs(cwd, home, true)
        expect(dirs).toEqual([join(home, '.claude', 'skills')])
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS
        setManagedSettingsPath(undefined)
      }
    })()
  })

  it('discovers enterprise skills beside the managed settings file, winning a name clash', async () => {
    const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')
    const managedDir = tempDir('cs-managed-')
    setManagedSettingsPath(join(managedDir, 'managed-settings.json'))
    try {
      const cwd = tempDir('cs-proj-')
      hoisted.home = tempDir('cs-home-')
      mkdirSync(join(managedDir, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(managedDir, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: e\n---\nENTERPRISE BODY')
      mkdirSync(join(hoisted.home, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(hoisted.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: p\n---\nPERSONAL BODY')

      const dirs = skillDirs(cwd, hoisted.home, true)
      expect(dirs[0]).toBe(join(managedDir, '.claude', 'skills'))

      // The observable outcome, not the directory ordering: invoking the clashing
      // name expands the enterprise body. Directory order alone would still pass
      // if resolution flipped to last-match; the expansion cannot.
      const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
      skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
      const result = (await handlers.get('input')?.({ text: '/skill:deploy', source: 'interactive' }, { cwd })) as { action: string; text: string }
      expect(result?.action).toBe('transform')
      expect(result.text).toContain('ENTERPRISE BODY')
      expect(result.text).not.toContain('PERSONAL BODY')
    } finally {
      setManagedSettingsPath(undefined)
    }
  })
})
