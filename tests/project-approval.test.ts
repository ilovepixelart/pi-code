import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasTrustRequiringProjectResources } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { hasClaudeShapedConfig, isProjectApproved } from '../extensions/project-approval.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'pa-'))

const write = (cwd: string, rel: string, body = '{}') => {
  mkdirSync(join(cwd, rel, '..'), { recursive: true })
  writeFileSync(join(cwd, rel), body)
}

const deps = (over: Partial<Parameters<typeof isProjectApproved>[1]> = {}) => ({
  hasClaudeShaped: () => true,
  piWouldAsk: () => false,
  savedDecision: () => null,
  remember: () => {},
  ...over,
})

const ctx = (over: Partial<Parameters<typeof isProjectApproved>[0]> = {}) => ({
  cwd: '/repo',
  hasUI: true,
  isProjectTrusted: () => true,
  ui: { confirm: async () => true },
  ...over,
})

/**
 * The reason this module exists rather than a project_trust handler. pi's
 * resolveProjectTrusted returns true before emitting the event when it finds no
 * trust-requiring resources, so a handler never sees the case pi-code cares about.
 */
describe('pi does not consider claude-shaped config trust-requiring', () => {
  it('ignores .claude and .mcp.json, so pi trusts such a project without asking', () => {
    const cwd = tempDir()
    write(cwd, join('.claude', 'settings.json'))
    write(cwd, '.mcp.json')
    write(cwd, join('.claude', 'agents', 'evil.md'), '# agent')

    expect(hasTrustRequiringProjectResources(cwd)).toBe(false)
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it('does consider .pi/settings.json trust-requiring', () => {
    const cwd = tempDir()
    write(cwd, join('.pi', 'settings.json'))
    expect(hasTrustRequiringProjectResources(cwd)).toBe(true)
  })
})

describe('isProjectApproved', () => {
  it('asks for a claude-shaped project pi trusted without prompting', async () => {
    const confirm = vi.fn(async () => true)
    const remember = vi.fn()

    expect(await isProjectApproved(ctx({ ui: { confirm } }), deps({ remember }))).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(remember).toHaveBeenCalledWith('/repo', true)
  })

  it('refuses and remembers when the user declines', async () => {
    const remember = vi.fn()
    expect(await isProjectApproved(ctx({ ui: { confirm: async () => false } }), deps({ remember }))).toBe(false)
    expect(remember).toHaveBeenCalledWith('/repo', false)
  })

  it('never overrides pi having declined trust', async () => {
    expect(await isProjectApproved(ctx({ isProjectTrusted: () => false }), deps())).toBe(false)
    expect(await isProjectApproved(ctx({ isProjectTrusted: undefined }), deps())).toBe(false)
  })

  it('does not ask when the project ships nothing pi would miss', async () => {
    const confirm = vi.fn(async () => true)
    expect(await isProjectApproved(ctx({ ui: { confirm } }), deps({ hasClaudeShaped: () => false }))).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not ask again when pi already prompted for this project', async () => {
    const confirm = vi.fn(async () => true)
    expect(await isProjectApproved(ctx({ ui: { confirm } }), deps({ piWouldAsk: () => true }))).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('applies a stored decision instead of re-asking', async () => {
    const confirm = vi.fn(async () => true)
    expect(await isProjectApproved(ctx({ ui: { confirm } }), deps({ savedDecision: () => true }))).toBe(true)
    expect(await isProjectApproved(ctx({ ui: { confirm } }), deps({ savedDecision: () => false }))).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('refuses when there is no UI to ask with', async () => {
    // pi never consulted defaultProjectTrust here, so there is no preference to defer to.
    expect(await isProjectApproved(ctx({ hasUI: false }), deps())).toBe(false)
  })
})
