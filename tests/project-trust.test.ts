import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decideTrust, hasClaudeShapedConfig } from '../extensions/project-trust.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'pt-'))

/** pi's own trust check and trust store, stubbed so the decision logic is what is under test. */
const deps = (over: Partial<Parameters<typeof decideTrust>[3]> = {}) => ({
  hasClaudeShaped: () => true,
  piWouldAsk: () => false,
  savedDecision: () => null,
  ...over,
})

const confirmYes = async () => true
const confirmNo = async () => false
const neverAsk = async () => {
  throw new Error('should not have prompted')
}

describe('hasClaudeShapedConfig', () => {
  it.each([
    ['.mcp.json', true],
    [join('.claude', 'settings.json'), true],
    [join('.claude', 'agents'), true],
    [join('.pi', 'mcp.json'), true],
  ])('detects %s', (entry, expected) => {
    const cwd = tempDir()
    mkdirSync(join(cwd, entry, '..'), { recursive: true })
    writeFileSync(join(cwd, entry), '{}')
    expect(hasClaudeShapedConfig(cwd)).toBe(expected)
  })

  it('is false for a repository with no agent configuration', () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'README.md'), 'nothing to see')
    expect(hasClaudeShapedConfig(cwd)).toBe(false)
  })
})

describe('decideTrust', () => {
  it('prompts and remembers approval for a claude-shaped project pi would not ask about', async () => {
    expect(await decideTrust('/repo', true, confirmYes, deps())).toEqual({ trusted: 'yes', remember: true })
  })

  it('remembers a refusal too, so the repo is not re-asked every session', async () => {
    expect(await decideTrust('/repo', true, confirmNo, deps())).toEqual({ trusted: 'no', remember: true })
  })

  it('stays out of the way when the project ships no agent configuration', async () => {
    expect(await decideTrust('/repo', true, neverAsk, deps({ hasClaudeShaped: () => false }))).toEqual({ trusted: 'undecided' })
  })

  it('stays out of the way when pi already prompts for this project', async () => {
    // Double-prompting would train the user to click through both.
    expect(await decideTrust('/repo', true, neverAsk, deps({ piWouldAsk: () => true }))).toEqual({ trusted: 'undecided' })
  })

  it('defers to a stored decision rather than asking again', async () => {
    expect(await decideTrust('/repo', true, neverAsk, deps({ savedDecision: () => true }))).toEqual({ trusted: 'undecided' })
    expect(await decideTrust('/repo', true, neverAsk, deps({ savedDecision: () => false }))).toEqual({ trusted: 'undecided' })
  })

  it('does not force a decision when there is no UI to ask with', async () => {
    // Returning "no" here would override a remembered yes, since handlers run before trust.json.
    expect(await decideTrust('/repo', false, neverAsk, deps())).toEqual({ trusted: 'undecided' })
  })
})
