import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasTrustRequiringProjectResources } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { hookFiles } from '../extensions/hooks.ts'
import { hasClaudeShapedConfig, isProjectApproved, isProjectApprovedSilently } from '../extensions/internal/project-approval.ts'
import { projectConfigPaths } from '../extensions/mcp.ts'

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

describe('isProjectApprovedSilently', () => {
  it('refuses when pi never trusted the project', () => {
    expect(isProjectApprovedSilently(ctx({ isProjectTrusted: () => false }), deps())).toBe(false)
  })

  it('approves a trusted project with no claude-shaped config', () => {
    expect(isProjectApprovedSilently(ctx(), deps({ hasClaudeShaped: () => false }))).toBe(true)
  })

  it('approves when pi itself prompted for this project', () => {
    expect(isProjectApprovedSilently(ctx(), deps({ piWouldAsk: () => true }))).toBe(true)
  })

  it('honors a stored decision and reads undecided as unapproved, never prompting', () => {
    expect(isProjectApprovedSilently(ctx(), deps({ savedDecision: () => true }))).toBe(true)
    expect(isProjectApprovedSilently(ctx(), deps({ savedDecision: () => false }))).toBe(false)
    // The prompting variant would ask here; the silent one must not.
    expect(isProjectApprovedSilently(ctx(), deps({ savedDecision: () => null }))).toBe(false)
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

describe('the trust trigger stays in sync with what the trust-gated extensions consume', () => {
  // The approval prompt only fires when hasClaudeShapedConfig sees project config. If a new
  // project source is added to an extension but not to that list, a repository shipping only
  // the new source would be trusted without a prompt, which is the auto-trust bug PR #12 fixed.
  // These derive the expected project sources from the extensions themselves so the list cannot
  // silently drift.

  it.each(projectConfigPaths('/x').map((abs) => abs.slice('/x/'.length)))('treats a project with only %s as claude-shaped (mcp project config runs commands on connect)', (rel) => {
    const cwd = tempDir()
    mkdirSync(join(cwd, rel, '..'), { recursive: true })
    writeFileSync(join(cwd, rel), '{}')
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it.each(
    hookFiles('/x', '/h', true)
      .filter((abs) => abs.startsWith('/x/'))
      .map((abs) => abs.slice('/x/'.length)),
  )('treats a project with only %s as claude-shaped (hooks run arbitrary shell)', (rel) => {
    const cwd = tempDir()
    mkdirSync(join(cwd, rel, '..'), { recursive: true })
    writeFileSync(join(cwd, rel), '{}')
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it('treats a project with only a .claude/output-styles directory as claude-shaped (style bodies are injected verbatim)', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it.each([join('.claude', 'agents'), join('.pi', 'agents')])('treats a project with only a %s directory as claude-shaped (project agents ship their own prompt and tools)', (dir) => {
    const cwd = tempDir()
    mkdirSync(join(cwd, dir), { recursive: true })
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it('treats a project with only a .claude/rules directory as claude-shaped (rule filenames and scopes are surfaced in the system prompt)', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude', 'rules'), { recursive: true })
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it('treats a project with only CLAUDE.local.md as claude-shaped (its body is injected into the system prompt)', () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'notes')
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })
})

describe('runtime version guard for a missing isProjectTrusted callback', () => {
  // pi >= 0.79.1 hands extensions ctx.isProjectTrusted; older runtimes omit it, so the
  // trust guard reads every project as untrusted and each project-scoped surface fails
  // closed with nothing said. The module turns that silence into one warning, once. Each
  // case loads a fresh module so the once-per-process guard starts un-fired.
  const RUNTIME_TOO_OLD = 'pi-code requires pi >= 0.79.1 for project configuration; project-scoped .claude config stays disabled on this pi version'

  const freshApproval = async () => {
    vi.resetModules()
    return import('../extensions/internal/project-approval.ts')
  }

  it('fails closed and warns once, never repeating the notice on later calls', async () => {
    const { isProjectApproved, isProjectApprovedSilently } = await freshApproval()
    const notify = vi.fn()
    const stale = ctx({ isProjectTrusted: undefined, ui: { confirm: async () => true, notify } })

    expect(await isProjectApproved(stale, deps())).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(RUNTIME_TOO_OLD, 'warning')

    // A second call, through either path, must not warn again.
    expect(await isProjectApproved(stale, deps())).toBe(false)
    expect(isProjectApprovedSilently(stale, deps())).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('warns from the silent path too: a missing capability is not an approval prompt', async () => {
    const { isProjectApprovedSilently } = await freshApproval()
    const notify = vi.fn()
    expect(isProjectApprovedSilently(ctx({ isProjectTrusted: undefined, ui: { confirm: async () => true, notify } }), deps())).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(RUNTIME_TOO_OLD, 'warning')
  })

  it('stays silent and behaves exactly as before when the runtime provides isProjectTrusted', async () => {
    const { isProjectApproved } = await freshApproval()
    const notify = vi.fn()
    // Trusted, claude-shaped, no stored decision: still prompts and approves as today.
    expect(await isProjectApproved(ctx({ ui: { confirm: async () => true, notify } }), deps())).toBe(true)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not throw on a headless runtime that is too old and has no ui to warn through', async () => {
    const { isProjectApprovedSilently } = await freshApproval()
    expect(() => isProjectApprovedSilently({ cwd: '/repo' }, deps())).not.toThrow()
  })

  it('does not warn when a modern runtime reports the project untrusted', async () => {
    const { isProjectApprovedSilently } = await freshApproval()
    const notify = vi.fn()
    // The guard keys on the capability being absent, not on the trust answer: a runtime
    // that supplies isProjectTrusted and returns false is simply untrusted, not too old,
    // so it fails closed without the RUNTIME_TOO_OLD notice.
    expect(isProjectApprovedSilently(ctx({ isProjectTrusted: () => false, ui: { confirm: async () => true, notify } }), deps())).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('hasClaudeShapedConfig walks to the repository root', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'shaped-'))

  it('sees config at the repo root when started in a subdirectory', () => {
    // Agent discovery already walks up, so a cwd-only check approved a project
    // whose .claude/agents at the root was about to be loaded.
    const root = tmp()
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
    const sub = join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })

    expect(hasClaudeShapedConfig(sub)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('stops at the repository root rather than inheriting a parent', () => {
    const outer = tmp()
    mkdirSync(join(outer, '.claude', 'agents'), { recursive: true })
    const inner = join(outer, 'nested')
    mkdirSync(join(inner, '.git'), { recursive: true })

    expect(hasClaudeShapedConfig(inner)).toBe(false)
    rmSync(outer, { recursive: true, force: true })
  })
})
