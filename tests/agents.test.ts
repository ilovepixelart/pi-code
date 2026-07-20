import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { discoverAgents } from '../extensions/subagent/agents.ts'

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
