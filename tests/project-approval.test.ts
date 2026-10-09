import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasTrustRequiringProjectResources } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookFiles } from '../extensions/hooks/index.ts'
import { floorNotice } from '../extensions/internal/pi-floor.ts'
import { approvalRecheck, hasClaudeShapedConfig, isProjectApproved, isProjectApprovedSilently } from '../extensions/internal/project-approval.ts'
import { projectConfigPaths } from '../extensions/mcp/index.ts'

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
  it('does not stop the walk at a package.json, which a repository chooses where to put', () => {
    // Only .git ends the walk now. A package.json between cwd and the config that
    // gates it used to hide that config, and a repository decides where its
    // package.json files sit.
    const parent = tempDir()
    mkdirSync(join(parent, '.claude'), { recursive: true })
    writeFileSync(join(parent, '.claude', 'settings.json'), '{}')
    const cwd = join(parent, 'pkg', 'src')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(parent, 'pkg', 'package.json'), '{}')

    expect(hasClaudeShapedConfig(cwd, join(parent, 'nowhere'))).toBe(true)
  })

  it('stops the walk at the home directory, so user config is never read as a project to gate', () => {
    // ~/.claude/settings.json is the user's own file. A directory under home that is
    // not in a repository must not walk up into it and report a project to approve.
    const home = tempDir()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{}')
    const cwd = join(home, 'notes')
    mkdirSync(cwd)

    expect(hasClaudeShapedConfig(cwd, home)).toBe(false)
  })

  it('still finds project config below home', () => {
    const home = tempDir()
    const cwd = join(home, 'repo', 'src')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(home, 'repo', '.claude'), { recursive: true })
    writeFileSync(join(home, 'repo', '.claude', 'settings.json'), '{}')

    expect(hasClaudeShapedConfig(cwd, home)).toBe(true)
  })

  it('ignores .claude and .mcp.json, so pi trusts such a project without asking', () => {
    const cwd = tempDir()
    write(cwd, join('.claude', 'settings.json'))
    write(cwd, '.mcp.json')
    write(cwd, join('.claude', 'agents', 'evil.md'), '# agent')

    expect(hasTrustRequiringProjectResources(cwd)).toBe(false)
    expect(hasClaudeShapedConfig(cwd)).toBe(true)
  })

  it('counts a .claude/CLAUDE.md as project config', () => {
    // Its body is injected verbatim into the prompt, and context-imports gates it on
    // approval, so a repository whose only Claude config is that file must be asked
    // about rather than silently approved.
    const cwd = tempDir()
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'CLAUDE.md'), '# project rules')
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

describe('hasClaudeShapedConfig covers the settings a worktree pointer relocates', () => {
  // Not on Windows: there settings.local.json stays in the working directory (one of
  // Claude's placement exceptions), so nothing is relocated and the walk covers it.
  it.skipIf(process.platform === 'win32')('counts the settings.local.json the chain reads from the main checkout', () => {
    // settings.local.json is read from the main checkout, which a worktree's .git file
    // names. An archive can carry both ends of that pointer, so its payload directory
    // became the "main checkout" while the walk from cwd saw nothing claude-shaped: the
    // payload's hooks and env loaded with no approval dialog.
    const tree = tempDir()
    const payload = join(tree, 'payload')
    mkdirSync(join(payload, '.git', 'worktrees', 'x'), { recursive: true })
    writeFileSync(join(tree, '.git'), 'gitdir: payload/.git/worktrees/x\n')
    writeFileSync(join(payload, '.git', 'worktrees', 'x', 'gitdir'), '../../../../.git\n')
    write(payload, '.claude/settings.local.json', '{"hooks":{}}')

    expect(hasClaudeShapedConfig(tree, join(tree, 'nowhere'))).toBe(true)
  })
})

describe('approvalRecheck', () => {
  it('withdraws approval once a project nobody was asked about turns claude-shaped mid-session', () => {
    // A repository with nothing claude-shaped reads as approved without a question. Config
    // that appears later (a branch checkout, an unpacked archive) must not inherit that
    // answer: a settings watcher reloading with it ran the repository's hooks unasked.
    let shaped = false
    const recheck = approvalRecheck(ctx(), deps({ hasClaudeShaped: () => shaped }))
    expect(recheck()).toBe(true)
    shaped = true
    expect(recheck()).toBe(false)
  })

  it('keeps a project approved when its decision was recorded', () => {
    expect(approvalRecheck(ctx(), deps({ savedDecision: () => true }))()).toBe(true)
  })

  it('reads the session ctx once, since a poll outlives it and every getter then throws', () => {
    let replaced = false
    const live = {
      get cwd() {
        if (replaced) throw new Error('This extension ctx is stale')
        return '/repo'
      },
      isProjectTrusted: () => {
        if (replaced) throw new Error('This extension ctx is stale')
        return true
      },
    }
    const recheck = approvalRecheck(live, deps({ savedDecision: () => true }))
    replaced = true
    expect(recheck()).toBe(true)
  })

  it('never approves what pi itself declined to trust', () => {
    expect(approvalRecheck(ctx({ isProjectTrusted: () => false }), deps({ savedDecision: () => true }))()).toBe(false)
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

describe('a pi without the isProjectTrusted callback', () => {
  // pi before 0.79.1 omits ctx.isProjectTrusted. Every such pi is below PI_FLOOR, so the
  // version-floor extension's one session-start notice covers it; approval itself just
  // fails closed, with no prompt and no notice of its own on every gated surface.
  it('reads every project as unapproved on both paths, without prompting or notifying', async () => {
    // A fresh module: nothing an earlier test ran can have used up a once-per-process notice.
    vi.resetModules()
    const { isProjectApproved, isProjectApprovedSilently } = await import('../extensions/internal/project-approval.ts')
    const notify = vi.fn()
    const confirm = vi.fn(async () => true)
    const stale = ctx({ isProjectTrusted: undefined, ui: { confirm, notify } })

    expect(await isProjectApproved(stale, deps())).toBe(false)
    expect(isProjectApprovedSilently(stale, deps())).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('is a pi the version-floor notice warns about', () => {
    expect(floorNotice('0.79.0')).toBeDefined()
  })

  it('reads as unapproved without a ui', () => {
    expect(isProjectApprovedSilently({ cwd: '/repo' }, deps())).toBe(false)
  })

  it('stays silent and behaves exactly as before when the runtime provides isProjectTrusted', async () => {
    const notify = vi.fn()
    // Trusted, claude-shaped, no stored decision: still prompts and approves as today.
    expect(await isProjectApproved(ctx({ ui: { confirm: async () => true, notify } }), deps())).toBe(true)
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

describe('hasClaudeShapedConfig exempts the configuration home', () => {
  // Claude applies the configuration home's .claude/settings.local.json without the
  // trust step. That home is the home directory, or the directory whose `.claude`
  // subdirectory is CLAUDE_CONFIG_DIR, unless that directory sits in a repository whose
  // root takes the local settings instead.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not gate the home directory own settings.local.json', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    const home = tempDir()
    write(home, join('.claude', 'settings.local.json'))

    expect(hasClaudeShapedConfig(home, home)).toBe(false)
  })

  it('does not gate the settings.local.json beside a CLAUDE_CONFIG_DIR named .claude', () => {
    const configHome = tempDir()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(configHome, '.claude'))
    write(configHome, join('.claude', 'settings.local.json'))

    expect(hasClaudeShapedConfig(configHome, join(configHome, 'nowhere'))).toBe(false)
  })

  it('gates it when CLAUDE_CONFIG_DIR is not the folder .claude subdirectory', () => {
    const folder = tempDir()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(folder, 'cfg'))
    write(folder, join('.claude', 'settings.local.json'))

    expect(hasClaudeShapedConfig(folder, join(folder, 'nowhere'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('gates it when the configuration home sits in a repository whose root takes the local settings', () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const configHome = join(repo, 'dotfiles')
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(configHome, '.claude'))
    write(configHome, join('.claude', 'settings.local.json'))

    expect(hasClaudeShapedConfig(configHome, join(repo, 'nowhere'))).toBe(true)
  })

  it('still gates an unrelated folder settings.local.json', () => {
    const configHome = tempDir()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(configHome, '.claude'))
    const project = tempDir()
    write(project, join('.claude', 'settings.local.json'))

    expect(hasClaudeShapedConfig(project, join(project, 'nowhere'))).toBe(true)
  })
})
