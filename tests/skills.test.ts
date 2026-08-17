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
