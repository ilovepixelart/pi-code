import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverAgents } from '../extensions/subagent/agents.ts'

// The 'both' scope also scans the user's agent dirs; point them at throwaway dirs so
// an agent in the developer's real ~/.claude/agents or ~/.pi/agent/agents cannot
// influence assertions.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

let savedAgentDir: string | undefined
beforeEach(() => {
  hoisted.home = mkdtempSync(join(tmpdir(), 'agents-home-'))
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'agents-agentdir-'))
})
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
})

const agentFile = (name: string, body = 'do things'): string => `---\nname: ${name}\ndescription: ${name} agent\n---\n${body}`

describe('discoverAgents (project scope)', () => {
  it('discovers project agents from .claude/agents', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer'))

    const { agents } = discoverAgents(cwd, 'project')
    expect(agents.find((a) => a.name === 'reviewer')?.source).toBe('project')
  })

  it('lets project .pi/agents win over .claude/agents on a name conflict', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'worker.md'), agentFile('worker', 'CLAUDE'))
    writeFileSync(join(cwd, '.pi', 'agents', 'worker.md'), agentFile('worker', 'PI'))

    const worker = discoverAgents(cwd, 'project').agents.filter((a) => a.name === 'worker')
    expect(worker).toHaveLength(1)
    expect(worker[0].systemPrompt.trim()).toBe('PI')
  })

  it('returns no project agents when neither directory exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    expect(discoverAgents(cwd, 'project').agents).toEqual([])
  })
})

describe('recursive discovery and model tiers', () => {
  it('discovers agents in subfolders, matching Claude recursive scanning', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents', 'review'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'review', 'critic.md'), agentFile('critic'))
    expect(discoverAgents(cwd, 'project').agents.find((a) => a.name === 'critic')?.source).toBe('project')
  })

  it('treats fable as a resolvable tier alias, not a concrete model id', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'f.md'), '---\nname: f\ndescription: fable agent\nmodel: fable\n---\nwork')
    const agent = discoverAgents(cwd, 'project').agents.find((a) => a.name === 'f')
    // fable is a tier alias: kept as modelAlias (resolved against available models),
    // never passed through as a literal --model that the child cannot resolve.
    expect(agent?.model).toBeUndefined()
    expect(agent?.modelAlias).toBe('fable')
  })

  it('parses a positive-integer maxTurns and ignores invalid values', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'a.md'), '---\nname: a\ndescription: capped\nmaxTurns: 3\n---\nwork')
    writeFileSync(join(cwd, '.claude', 'agents', 'b.md'), '---\nname: b\ndescription: bad cap\nmaxTurns: 0\n---\nwork')
    const agents = discoverAgents(cwd, 'project').agents
    expect(agents.find((a) => a.name === 'a')?.maxTurns).toBe(3)
    expect(agents.find((a) => a.name === 'b')?.maxTurns).toBeUndefined()
  })

  it('parses isolation: worktree case-insensitively and rejects an unknown isolation value', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'w.md'), '---\nname: w\ndescription: isolated\nisolation: Worktree\n---\nwork')
    writeFileSync(join(cwd, '.claude', 'agents', 'x.md'), '---\nname: x\ndescription: typo\nisolation: sandbox\n---\nwork')
    const agents = discoverAgents(cwd, 'project').agents
    expect(agents.find((a) => a.name === 'w')?.isolation).toBe('worktree')
    // An unrecognized isolation value is a declared safety boundary pi cannot
    // honor; the definition is rejected rather than run unisolated.
    expect(agents.find((a) => a.name === 'x')).toBeUndefined()
  })
})

describe('memory frontmatter', () => {
  it('accepts the three Claude scopes and ignores anything else', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'u.md'), '---\nname: u\ndescription: user memory\nmemory: user\n---\nwork')
    writeFileSync(join(cwd, '.claude', 'agents', 'p.md'), '---\nname: p\ndescription: project memory\nmemory: Project\n---\nwork')
    writeFileSync(join(cwd, '.claude', 'agents', 'l.md'), '---\nname: l\ndescription: local memory\nmemory: local\n---\nwork')
    writeFileSync(join(cwd, '.claude', 'agents', 'g.md'), '---\nname: g\ndescription: unknown scope\nmemory: global\n---\nwork')
    writeFileSync(join(cwd, '.claude', 'agents', 'n.md'), '---\nname: n\ndescription: no scope\n---\nwork')

    const agents = discoverAgents(cwd, 'project').agents
    const byName = (name: string) => agents.find((a) => a.name === name)
    expect(byName('u')?.memory).toBe('user')
    expect(byName('p')?.memory).toBe('project')
    expect(byName('l')?.memory).toBe('local')
    // An unknown value is ignored rather than failing the agent.
    expect(byName('g')?.memory).toBeUndefined()
    expect(byName('n')?.memory).toBeUndefined()
  })
})

describe('plugin agents', () => {
  it('discovers an enabled plugin agent between builtins and user agents', () => {
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'toolkit', '2.0.0')
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(join(root, 'agents', 'auditor.md'), agentFile('auditor'))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { toolkit: true } }))

    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    // Plugin agents register under Claude's plugin-scoped id, not the bare name.
    const found = discoverAgents(cwd, 'user').agents.find((a) => a.name === 'toolkit:auditor')
    expect(found?.source).toBe('plugin')
  })

  it('keeps a plugin agent and a same-named user agent as distinct scoped entries', () => {
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'toolkit', '2.0.0')
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(join(root, 'agents', 'auditor.md'), agentFile('auditor', 'PLUGIN'))
    mkdirSync(join(hoisted.home, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'agents', 'auditor.md'), agentFile('auditor', 'USER'))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { toolkit: true } }))

    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    // Scoped ids mean a plugin's auditor never clashes with the user's: both exist.
    const agents = discoverAgents(cwd, 'user').agents
    expect(agents.find((a) => a.name === 'auditor')?.systemPrompt.trim()).toBe('USER')
    expect(agents.find((a) => a.name === 'toolkit:auditor')?.systemPrompt.trim()).toBe('PLUGIN')
  })
})

describe('argument-scoped tool grants', () => {
  it('rejects an agent whose tools grant is scoped to arguments', () => {
    // `Bash(git log:*)` cannot be expressed in the child's --tools allowlist, and
    // dropping the scope hands the agent more than the file granted. Rejected like
    // any other restriction that failed to parse.
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'scoped.md'), '---\nname: scoped\ndescription: scoped agent\ntools: Read, Bash(git log:*)\n---\nlook around')

    expect(discoverAgents(cwd, 'project').agents).toEqual([])
  })

  it('keeps an agent whose disallowedTools is scoped, denying the whole tool', () => {
    // A scoped disallow can only be widened here, and denying more than the file
    // asked for is the safe direction, so the agent stands.
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'careful.md'), '---\nname: careful\ndescription: careful agent\ndisallowedTools: Bash(rm:*)\n---\nbe careful')

    const found = discoverAgents(cwd, 'project').agents.find((a) => a.name === 'careful')
    expect(found?.disallowedTools).toEqual(['bash'])
  })
})

describe('agent discovery boundary', () => {
  it('does not offer an agent planted above the project root', () => {
    // /tmp is world-writable and a common clone location, so any local process could
    // plant /tmp/.claude/agents/x.md and have it offered in every session run beneath it.
    const ancestor = realpathSync(mkdtempSync(join(tmpdir(), 'anc-')))
    const repo = join(ancestor, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(ancestor, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(ancestor, '.claude', 'agents', 'planted.md'), '---\nname: planted\ndescription: not mine\n---\nbody')

    const found = discoverAgents(join(repo, 'src'), 'both')
    expect(found.agents.map((a) => a.name)).not.toContain('planted')
  })

  it('still finds an agent inside the project root from a nested directory', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'repo-')))
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'agents', 'mine.md'), '---\nname: mine\ndescription: project agent\n---\nbody')

    const found = discoverAgents(join(repo, 'src', 'deep'), 'both')
    expect(found.agents.map((a) => a.name)).toContain('mine')
  })
})

describe('monorepo agent discovery', () => {
  it('finds root-level project agents from a subdirectory session, nearest winning a name clash', () => {
    // Claude: "every .claude/agents/ between there and the repository root is
    // scanned ... Claude Code uses the definition closest to the working directory."
    const root = mkdtempSync(join(tmpdir(), 'agents-mono-'))
    writeFileSync(join(root, 'package.json'), '{}')
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(root, '.claude', 'agents', 'deployer.md'), '---\nname: deployer\ndescription: root deployer\n---\nroot')
    writeFileSync(join(root, '.claude', 'agents', 'shared.md'), '---\nname: shared\ndescription: root shared\n---\nroot')
    const cwd = join(root, 'apps', 'web')
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'shared.md'), '---\nname: shared\ndescription: near shared\n---\nnear')
    const agents = discoverAgents(cwd, 'project').agents
    expect(agents.find((a) => a.name === 'deployer')?.description).toBe('root deployer')
    expect(agents.find((a) => a.name === 'shared')?.description).toBe('near shared')
  })
})

describe('plugin-scoped agent ids and frontmatter fields', () => {
  it('names plugin agents with the plugin-scoped identifier, filename as fallback', () => {
    // Claude: a plugin subagent's agent type is the scoped id such as
    // my-plugin:reviewer, not the bare frontmatter name.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'toolkit', '2.0.0')
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(join(root, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: reviews\n---\nreview things')
    writeFileSync(join(root, 'agents', 'anon.md'), '---\ndescription: nameless\n---\nwork')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { toolkit: true } }))

    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    const names = discoverAgents(cwd, 'user').agents.map((a) => a.name)
    expect(names).toContain('toolkit:reviewer')
    expect(names).toContain('toolkit:anon')
    expect(names).not.toContain('reviewer')
  })

  it('rejects a non-plugin agent whose name contains a colon, reserved for plugin ids', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'bad.md'), '---\nname: my:agent\ndescription: colon\n---\nwork')
    expect(discoverAgents(cwd, 'both').agents.find((a) => a.name === 'my:agent')).toBeUndefined()
  })

  it('parses frontmatter hooks into the agent config', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'guarded.md'), '---\nname: guarded\ndescription: g\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\nwork')
    const agent = discoverAgents(cwd, 'both').agents.find((a) => a.name === 'guarded')
    expect(agent?.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }] })
  })

  it('parses background: true into the agent config', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'agents', 'bg.md'), '---\nname: bg\ndescription: b\nbackground: true\n---\nwork')
    expect(discoverAgents(cwd, 'both').agents.find((a) => a.name === 'bg')?.background).toBe(true)
  })
})
