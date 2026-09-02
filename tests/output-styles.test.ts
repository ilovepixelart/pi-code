import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import outputStyles, { applyStyle, BUILTIN_STYLES_DIR, CODING_BASE_MARKER, loadStyles, parseStyle, pluginStyleDirs, readActiveStyleName, styleDirs, styleForName } from '../extensions/output-styles.ts'

// The extension reads user-scope styles and settings from the home directory; point it
// at a throwaway dir so the developer's real ~/.claude cannot influence assertions.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'os-'))

describe('parseStyle', () => {
  it('reads name and description from frontmatter and trims the body', () => {
    const md = '---\nname: Explanatory\ndescription: Teach while you work\n---\nExplain your reasoning.\n'
    expect(parseStyle(md, 'fallback')).toEqual({ name: 'Explanatory', description: 'Teach while you work', body: 'Explain your reasoning.', keepCodingInstructions: false, forceForPlugin: false })
  })

  it('falls back to the filename when name is absent and keeps the whole body', () => {
    expect(parseStyle('Just a persona.', 'concise')).toEqual({ name: 'concise', description: '', body: 'Just a persona.', keepCodingInstructions: false, forceForPlugin: false })
  })

  it('reads keep-coding-instructions true from frontmatter', () => {
    const md = '---\nname: Diagrams\nkeep-coding-instructions: true\n---\nLead with a diagram.\n'
    expect(parseStyle(md, 'fallback').keepCodingInstructions).toBe(true)
  })

  it('parses CRLF frontmatter (Windows-authored files)', () => {
    const md = '---\r\nname: Terse\r\ndescription: Few words\r\n---\r\nBe terse.\r\n'
    expect(parseStyle(md, 'fallback')).toEqual({ name: 'Terse', description: 'Few words', body: 'Be terse.', keepCodingInstructions: false, forceForPlugin: false })
  })
})

describe('applyStyle', () => {
  const prompt = `You are a coding agent.\nGuidelines here.\n${CODING_BASE_MARKER}\n\n<project_context>CLAUDE.md content</project_context>\n\nCurrent working directory: /p\n\n## Global Rules\nrules here`
  const style = { name: 'Writer', description: '', body: 'You are a writing assistant.', keepCodingInstructions: false, forceForPlugin: false }

  it('replaces the coding instructions and keeps everything after the marker', () => {
    const applied = applyStyle(prompt, style)
    expect(applied).not.toContain('You are a coding agent.')
    expect(applied).toContain('## Output Style: Writer')
    expect(applied).toContain('You are a writing assistant.')
    expect(applied).toContain('<project_context>CLAUDE.md content</project_context>')
    expect(applied).toContain('## Global Rules')
  })

  it('appends instead when the style keeps the coding instructions', () => {
    const applied = applyStyle(prompt, { ...style, keepCodingInstructions: true, forceForPlugin: false })
    expect(applied).toContain('You are a coding agent.')
    expect(applied.endsWith('## Output Style: Writer\n\nYou are a writing assistant.')).toBe(true)
  })

  it('falls back to appending when the marker is absent', () => {
    const applied = applyStyle('A custom SYSTEM.md prompt.', style)
    expect(applied).toContain('A custom SYSTEM.md prompt.')
    expect(applied).toContain('## Output Style: Writer')
  })

  it('matches the marker in the installed pi build', () => {
    // Canary: pi rewording its prompt tail silently degrades replace to append; this
    // test turns that into a visible failure at the next pi bump.
    const source = readFileSync(join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'system-prompt.js'), 'utf-8')
    expect(source).toContain(CODING_BASE_MARKER)
  })
})

describe('styleDirs', () => {
  it('returns the project output-styles directory only when trusted', () => {
    const cwd = tempDir()
    const home = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    expect(styleDirs(cwd, home, true)).toEqual([join(cwd, '.claude', 'output-styles')])
    expect(styleDirs(cwd, home, false)).toEqual([])
  })

  it('finds project styles at the repository root from a subdirectory session', () => {
    const repo = tempDir()
    const home = tempDir()
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, '.claude', 'output-styles'), { recursive: true })
    const sub = join(repo, 'src')
    mkdirSync(sub)
    expect(styleDirs(sub, home, true)).toEqual([join(repo, '.claude', 'output-styles')])
  })
})

describe('pluginStyleDirs', () => {
  // Lay down one enabled cached plugin with an optional manifest, as installedPlugins reads it.
  const installPlugin = (home: string, name: string, manifest: Record<string, unknown> = {}): string => {
    const root = join(home, '.claude', 'plugins', 'cache', 'market', name, '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest }))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [name]: true } }))
    return root
  }

  it('defaults to the plugin output-styles/ directory', () => {
    const home = tempDir()
    const root = installPlugin(home, 'styler')
    expect(pluginStyleDirs(home)).toEqual([join(root, 'output-styles')])
  })

  it('honors a manifest outputStyles override, replacing the default scan', () => {
    const home = tempDir()
    const root = installPlugin(home, 'styler', { outputStyles: ['./styles/', './extras/'] })
    expect(pluginStyleDirs(home)).toEqual([join(root, 'styles'), join(root, 'extras')])
  })

  it('returns nothing when no plugins are enabled', () => {
    expect(pluginStyleDirs(tempDir())).toEqual([])
  })
})

describe('loadStyles', () => {
  it('loads styles and lets a project style override a user style of the same name', () => {
    const userDir = tempDir()
    const projectDir = tempDir()
    writeFileSync(join(userDir, 'a.md'), '---\nname: shared\n---\nUSER')
    writeFileSync(join(projectDir, 'a.md'), '---\nname: shared\n---\nPROJECT')
    writeFileSync(join(projectDir, 'b.md'), '---\nname: extra\n---\nOTHER')

    const styles = loadStyles([userDir, projectDir])
    expect(styles.find((s) => s.name === 'shared')?.body).toBe('PROJECT')
    expect(styles.map((s) => s.name).sort()).toEqual(['extra', 'shared'])
  })

  it('skips a directory named like a style file instead of failing the session', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'not-a-file.md'))
    writeFileSync(join(dir, 'real.md'), '---\nname: Real\n---\nBODY')

    expect(loadStyles([dir]).map((s) => s.name)).toEqual(['Real'])
  })
})

describe('builtin styles', () => {
  it('ships Explanatory, Learning and Proactive as lowest-precedence styles', () => {
    const styles = loadStyles([BUILTIN_STYLES_DIR])
    const names = styles.map((style) => style.name).sort()
    // Claude's built-ins include Concise (v2.1.237+).
    expect(names).toEqual(['Concise', 'Explanatory', 'Learning', 'Proactive'])
    // Claude's built-ins are coding styles: they keep the software engineering instructions.
    expect(styles.every((style) => style.keepCodingInstructions)).toBe(true)
  })

  it('lets a user style of the same name override a builtin', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'explanatory.md'), '---\nname: Explanatory\ndescription: mine\n---\nCustom body.')
    const styles = loadStyles([BUILTIN_STYLES_DIR, dir])
    const explanatory = styles.find((style) => style.name === 'Explanatory')
    expect(explanatory?.description).toBe('mine')
  })
})

describe('readActiveStyleName', () => {
  it('returns the outputStyle from the last file that sets it', () => {
    const dir = tempDir()
    const user = join(dir, 'user.json')
    const local = join(dir, 'local.json')
    writeFileSync(user, JSON.stringify({ outputStyle: 'Explanatory' }))
    writeFileSync(local, JSON.stringify({ outputStyle: 'Concise' }))
    expect(readActiveStyleName([user, join(dir, 'absent.json'), local])).toBe('Concise')
  })

  it('returns undefined when no file sets outputStyle', () => {
    const dir = tempDir()
    const file = join(dir, 's.json')
    writeFileSync(file, JSON.stringify({ other: true }))
    expect(readActiveStyleName([file])).toBeUndefined()
  })
})

describe('styleForName', () => {
  const styles = [
    { name: 'a', description: '', body: 'A', keepCodingInstructions: false, forceForPlugin: false },
    { name: 'b', description: '', body: 'B', keepCodingInstructions: false, forceForPlugin: false },
  ]

  it('finds the matching style, or nothing for an unknown/undefined name', () => {
    expect(styleForName(styles, 'b')?.body).toBe('B')
    expect(styleForName(styles, 'z')).toBeUndefined()
    expect(styleForName(styles, undefined)).toBeUndefined()
  })
})

describe('extension wiring', () => {
  // Isolate pi's trust store so isProjectApproved never reads or writes the
  // developer's real ~/.pi/agent decisions.
  let savedAgentDir: string | undefined
  beforeEach(() => {
    hoisted.home = tempDir()
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'os-agent-'))
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  const projectWithStyle = (name: string, body: string): string => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'output-styles', 'style.md'), `---\nname: ${name}\n---\n${body}`)
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ outputStyle: name }))
    return cwd
  }

  it('reports non-interactive mode and an empty style list from the picker', async () => {
    const cwd = tempDir()
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    const notes: string[] = []
    outputStyles({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
    } as never)
    const base = { cwd, isProjectTrusted: () => true, ui: { notify: (m: string) => notes.push(m), confirm: async () => true, select: async () => undefined } }
    await handlers.get('session_start')?.({}, { ...base, hasUI: true })

    await commands.get('output-style')?.handler('', { ...base, hasUI: false })
    expect(notes.some((n) => n.includes('requires interactive mode'))).toBe(true)
  })

  it('refuses to overwrite a settings file it cannot parse', async () => {
    // settings.local.json also carries permissions, hooks and env. Starting from an empty
    // object on a parse failure replaced all of that with the style choice alone.
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    const invalid = '{"permissions":{"allow":["Bash(npm test)"]},}'
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), invalid)
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    const notes: Array<{ text: string; level: string }> = []
    outputStyles({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
    } as never)
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify: (text: string, level: string) => notes.push({ text, level }), confirm: async () => true, select: async () => undefined },
    }
    await handlers.get('session_start')?.({}, ctx)

    await commands.get('output-style')?.handler('proactive', ctx)

    expect(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8')).toBe(invalid)
    expect(notes.at(-1)?.level).toBe('error')
    expect(notes.at(-1)?.text).toContain('not valid JSON')
  })

  it('sets a style directly when /output-style is given a name', async () => {
    const cwd = projectWithStyle('Explain', 'Explain everything.')
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    const notes: string[] = []
    outputStyles({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
    } as never)
    const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: (m: string) => notes.push(m), confirm: async () => true, select: async () => undefined } }
    await handlers.get('session_start')?.({}, ctx)

    await commands.get('output-style')?.handler('proactive', ctx)
    const saved = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'))
    expect(saved.outputStyle).toBe('Proactive')

    await commands.get('output-style')?.handler('no-such-style', ctx)
    expect(notes.some((n) => n.includes('Unknown output style: no-such-style'))).toBe(true)
  })

  it('completes /output-style names by prefix, returning every style for an empty prefix', async () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'output-styles', 'a.md'), '---\nname: QqzAlpha\ndescription: First\n---\nbody')
    writeFileSync(join(cwd, '.claude', 'output-styles', 'b.md'), '---\nname: QqzBeta\n---\nbody')
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { getArgumentCompletions?: (prefix: string) => Promise<{ value: string; label: string; description?: string }[] | null> | { value: string; label: string; description?: string }[] | null }>()
    outputStyles({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, opts: { getArgumentCompletions?: (prefix: string) => unknown }) => commands.set(name, opts as never),
    } as never)
    const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: () => {}, confirm: async () => true, select: async () => undefined } }
    await handlers.get('session_start')?.({}, ctx)
    const complete = commands.get('output-style')?.getArgumentCompletions
    if (!complete) throw new Error('output-style registered no getArgumentCompletions')

    // Prefix match is case-insensitive; the Qqz prefix cannot collide with builtins.
    expect((await complete('Qqz'))?.map((item) => item.value).sort()).toEqual(['QqzAlpha', 'QqzBeta'])
    expect((await complete('qqza'))?.map((item) => item.value)).toEqual(['QqzAlpha'])
    // The completion carries the style description when one exists.
    expect((await complete('QqzAlpha'))?.[0]).toEqual({ value: 'QqzAlpha', label: 'QqzAlpha', description: 'First' })

    // An empty prefix offers every discovered style, builtins included.
    const expectedAll = loadStyles([BUILTIN_STYLES_DIR, join(cwd, '.claude', 'output-styles')]).map((style) => style.name)
    expect((await complete(''))?.map((item) => item.value).sort()).toEqual([...expectedAll].sort())
  })

  it('appends the active style body and the command persists a new choice', async () => {
    const cwd = projectWithStyle('Explain', 'Explain everything.')

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    const notes: string[] = []
    outputStyles({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts),
    } as never)

    const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: (m: string) => notes.push(m), confirm: async () => true, select: async () => 'Explain' } }
    await handlers.get('session_start')?.({}, ctx)
    const result = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(result.systemPrompt).toContain('## Output Style: Explain')
    expect(result.systemPrompt).toContain('Explain everything.')

    await commands.get('output-style')?.handler('', ctx)
    const saved = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'))
    expect(saved.outputStyle).toBe('Explain')
  })

  const wireSession = async (ctx: Record<string, unknown>): Promise<unknown> => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    outputStyles({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn), registerCommand: () => {} } as never)
    await handlers.get('session_start')?.({}, ctx)
    return handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})
  }

  it('loads and applies an output style shipped by an enabled plugin', async () => {
    // Enabled plugin ships a style; the user selects it. hoisted.home is the mocked ~.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'styler', '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'styler' }))
    mkdirSync(join(root, 'output-styles'), { recursive: true })
    writeFileSync(join(root, 'output-styles', 'zen.md'), '---\nname: Zen\n---\nBe calm and terse.')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { styler: true }, outputStyle: 'Zen' }))

    const result = (await wireSession({ cwd: tempDir(), hasUI: true, isProjectTrusted: () => true, ui: { notify: () => {} } })) as { systemPrompt: string }
    expect(result.systemPrompt).toContain('## Output Style: Zen')
    expect(result.systemPrompt).toContain('Be calm and terse.')
  })

  it('does not load a project style when the project is untrusted', async () => {
    const cwd = projectWithStyle('Evil', 'Injected instructions.')
    const result = await wireSession({ cwd, hasUI: true, isProjectTrusted: () => false, ui: { notify: () => {} } })
    expect(result).toBeUndefined()
  })

  it('does not load a project style when pi trusted silently and there is no UI to ask', async () => {
    // pi's own trust check ignores .claude-only repos, so isProjectTrusted() is true
    // for a clone nobody approved; the approval layer must still refuse without a UI.
    const cwd = projectWithStyle('Evil', 'Injected instructions.')
    const result = await wireSession({ cwd, hasUI: false, isProjectTrusted: () => true, ui: { notify: () => {} } })
    expect(result).toBeUndefined()
  })

  it('does not load a project style when the approval prompt is declined', async () => {
    const cwd = projectWithStyle('Evil', 'Injected instructions.')
    const result = await wireSession({ cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: () => {}, confirm: async () => false } })
    expect(result).toBeUndefined()
  })
})

describe('force-for-plugin and managed outputStyle', () => {
  it('parses force-for-plugin frontmatter', () => {
    const style = parseStyle('---\nname: Corp\ndescription: c\nforce-for-plugin: true\n---\nBody', 'x')
    expect(style.forceForPlugin).toBe(true)
  })

  it('applies the first loaded forced plugin style over the outputStyle setting', async () => {
    // Claude: "apply this style automatically whenever the plugin is enabled...
    // Overrides the user's outputStyle setting. If multiple enabled plugins set
    // this, Claude Code uses the first one loaded."
    const { forcedPluginStyle } = await import('../extensions/output-styles.ts')
    const styles = [parseStyle('---\nname: Normal\ndescription: n\n---\nBody', 'n'), parseStyle('---\nname: First\ndescription: f\nforce-for-plugin: true\n---\nBody', 'f'), parseStyle('---\nname: Second\ndescription: s\nforce-for-plugin: true\n---\nBody', 's')]
    expect(forcedPluginStyle(styles)?.name).toBe('First')
  })

  it('lets a managed-settings outputStyle win over every settings file', () => {
    const dir = tempDir()
    const user = join(dir, 'user.json')
    writeFileSync(user, JSON.stringify({ outputStyle: 'Explanatory' }))
    expect(readActiveStyleName([user], { outputStyle: 'Learning' })).toBe('Learning')
  })
})
