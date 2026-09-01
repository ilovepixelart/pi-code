import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Point os.homedir() at a hermetic temp home so the extension-wiring test never reads the
// developer's real ~/.claude skills. The other suites pass home explicitly and are unaffected.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const { default: skillsExt, skillDirs } = await import('../extensions/skills.ts')

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

  it('includes an enabled plugin skills directory', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    const root = join(home, '.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
    mkdirSync(join(root, 'skills'), { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { kit: true } }))

    expect(skillDirs(cwd, home, false)).toEqual([join(root, 'skills')])
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
