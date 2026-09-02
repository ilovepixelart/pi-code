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
    } finally {
      setManagedSettingsPath(undefined)
    }
  })
})
