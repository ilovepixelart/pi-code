import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
