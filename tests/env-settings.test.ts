import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import envSettingsExtension, { applyEnvSettings, envFromSettings, mergeEnvScopes } from '../extensions/env-settings.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'

const hoisted = vi.hoisted(() => ({ home: '', approved: false }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

// The project scope stays approval-gated (a project env var can redirect a provider),
// so approval is stubbed to a per-test flag rather than exercising the trust store here.
vi.mock('../extensions/internal/project-approval.js', () => ({
  isProjectApprovedSilently: () => hoisted.approved,
}))

describe('envFromSettings', () => {
  it('extracts string env values from a settings object', () => {
    expect(envFromSettings({ env: { A: 'x', B: 'y' } })).toEqual({ A: 'x', B: 'y' })
  })

  it('coerces numbers and booleans to strings', () => {
    expect(envFromSettings({ env: { N: 3, T: true, F: false } })).toEqual({ N: '3', T: 'true', F: 'false' })
  })

  it('skips non-scalar values (object, array, null)', () => {
    expect(envFromSettings({ env: { O: {}, A: [], Z: null, S: 'keep' } })).toEqual({ S: 'keep' })
  })

  it('returns an empty object when there is no env object', () => {
    expect(envFromSettings({})).toEqual({})
    expect(envFromSettings(null)).toEqual({})
    expect(envFromSettings({ env: 'nope' })).toEqual({})
  })
})

describe('mergeEnvScopes', () => {
  it('merges per key with precedence managed > user > project without wiping other scopes', () => {
    const merged = mergeEnvScopes({ A: 'm', C: 'mc' }, { A: 'u', B: 'ub' }, { A: 'p', D: 'pd' })
    expect(merged).toEqual({ A: 'm', B: 'ub', C: 'mc', D: 'pd' })
  })
})

describe('applyEnvSettings', () => {
  it('sets new keys and records them as owned', () => {
    const env: NodeJS.ProcessEnv = {}
    const owned = new Set<string>()
    applyEnvSettings({ A: '1' }, env, owned)
    expect(env.A).toBe('1')
    expect(owned.has('A')).toBe(true)
  })

  it('never overwrites a variable already in the real environment it did not set', () => {
    const env: NodeJS.ProcessEnv = { A: 'shell' }
    const owned = new Set<string>()
    applyEnvSettings({ A: 'settings' }, env, owned)
    expect(env.A).toBe('shell')
    expect(owned.has('A')).toBe(false)
  })

  it('updates a key it owns on a later refresh', () => {
    const env: NodeJS.ProcessEnv = {}
    const owned = new Set<string>()
    applyEnvSettings({ A: '1' }, env, owned)
    applyEnvSettings({ A: '2' }, env, owned)
    expect(env.A).toBe('2')
  })

  it('unsets a key it owns once a later apply no longer defines it', () => {
    // Cross-project leak guard: a key an approved project set must not persist into a
    // later apply (session or project) that does not define it.
    const env: NodeJS.ProcessEnv = {}
    const owned = new Set<string>()
    applyEnvSettings({ A: '1' }, env, owned)
    applyEnvSettings({}, env, owned)
    expect('A' in env).toBe(false)
    expect(owned.has('A')).toBe(false)
  })

  it('leaves a key it never owned (a shell export) untouched on unset', () => {
    // The unset guard only removes keys this module set, never a shell export it skipped.
    const env: NodeJS.ProcessEnv = { A: 'shell' }
    const owned = new Set<string>()
    applyEnvSettings({ A: 'settings' }, env, owned) // skipped: shell outranks
    applyEnvSettings({}, env, owned)
    expect(env.A).toBe('shell')
  })

  it('lets a managed key overwrite a shell export, but a user key does not', () => {
    // Managed policy outranks even an ambient shell export; user/project do not.
    const managedEnv: NodeJS.ProcessEnv = { A: 'shell' }
    const managedOwned = new Set<string>()
    applyEnvSettings({ A: 'managed' }, managedEnv, managedOwned, new Set(['A']))
    expect(managedEnv.A).toBe('managed')
    expect(managedOwned.has('A')).toBe(true)

    const userEnvVar: NodeJS.ProcessEnv = { A: 'shell' }
    const userOwned = new Set<string>()
    applyEnvSettings({ A: 'user' }, userEnvVar, userOwned, new Set())
    expect(userEnvVar.A).toBe('shell')
    expect(userOwned.has('A')).toBe(false)
  })
})

describe('env-settings extension', () => {
  const tempDirs: string[] = []
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }
  const usedKeys = new Set<string>()
  const setReal = (key: string, value: string): void => {
    usedKeys.add(key)
    process.env[key] = value
  }
  const writeSettings = (dir: string, name: string, env: unknown): void => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', name), JSON.stringify({ env }))
  }
  const track = (...keys: string[]): void => {
    for (const key of keys) usedKeys.add(key)
  }

  type Handler = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>
  const setup = (): { handlers: Map<string, Handler> } => {
    const handlers = new Map<string, Handler>()
    envSettingsExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never)
    return { handlers }
  }

  beforeEach(() => {
    hoisted.home = tempDir('env-home-')
    hoisted.approved = false
    setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
  })

  afterEach(() => {
    for (const key of usedKeys) delete process.env[key]
    usedKeys.clear()
    setManagedSettingsPath(undefined)
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('applies user and managed env at factory time, but not project env', async () => {
    track('ENVTEST_USER', 'ENVTEST_MANAGED', 'ENVTEST_PROJECT')
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_USER: 'uv' })
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ env: { ENVTEST_MANAGED: 'mv' } }))

    setup()
    expect(process.env.ENVTEST_USER).toBe('uv')
    expect(process.env.ENVTEST_MANAGED).toBe('mv')
    // Project scope needs the session ctx for approval, so it is untouched at factory time.
    expect(process.env.ENVTEST_PROJECT).toBeUndefined()
  })

  it('adds approved project env at session_start', async () => {
    track('ENVTEST_PROJECT')
    const project = tempDir('env-proj-')
    writeSettings(project, 'settings.json', { ENVTEST_PROJECT: 'pv' })
    hoisted.approved = true

    const { handlers } = setup()
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: project, isProjectTrusted: () => true })
    expect(process.env.ENVTEST_PROJECT).toBe('pv')
  })

  it('merges settings.local.json over settings.json within the approved project scope', async () => {
    track('ENVTEST_PROJECT')
    const project = tempDir('env-proj-')
    writeSettings(project, 'settings.json', { ENVTEST_PROJECT: 'base' })
    writeSettings(project, 'settings.local.json', { ENVTEST_PROJECT: 'local' })
    hoisted.approved = true

    const { handlers } = setup()
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: project, isProjectTrusted: () => true })
    expect(process.env.ENVTEST_PROJECT).toBe('local')
  })

  it('ignores project env when the project is not approved', async () => {
    track('ENVTEST_PROJECT')
    const project = tempDir('env-proj-')
    writeSettings(project, 'settings.json', { ENVTEST_PROJECT: 'pv' })
    hoisted.approved = false

    const { handlers } = setup()
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: project, isProjectTrusted: () => true })
    expect(process.env.ENVTEST_PROJECT).toBeUndefined()
  })

  it('does not overwrite a variable already in the real environment', async () => {
    setReal('ENVTEST_REAL', 'from-shell')
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_REAL: 'from-settings' })

    setup()
    expect(process.env.ENVTEST_REAL).toBe('from-shell')
  })

  it('applies managed over user per key at factory time', async () => {
    track('ENVTEST_SHARED', 'ENVTEST_USER_ONLY')
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_SHARED: 'user', ENVTEST_USER_ONLY: 'u' })
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ env: { ENVTEST_SHARED: 'managed' } }))

    setup()
    expect(process.env.ENVTEST_SHARED).toBe('managed')
    expect(process.env.ENVTEST_USER_ONLY).toBe('u')
  })

  it('unsets an approved project key once a later session no longer defines it', async () => {
    track('ENVTEST_PROJECT')
    const project = tempDir('env-proj-')
    writeSettings(project, 'settings.json', { ENVTEST_PROJECT: 'pv' })
    hoisted.approved = true

    const { handlers } = setup()
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: project, isProjectTrusted: () => true })
    expect(process.env.ENVTEST_PROJECT).toBe('pv')

    // A later session on a project that does not define the key must unset it, so an
    // approved project's env cannot leak into a later one within the same process.
    const other = tempDir('env-proj-')
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: other, isProjectTrusted: () => true })
    expect(process.env.ENVTEST_PROJECT).toBeUndefined()
  })

  it('lets managed env override a preexisting shell export, but user env does not', async () => {
    track('ENVTEST_MANAGED_OVR', 'ENVTEST_USER_OVR')
    setReal('ENVTEST_MANAGED_OVR', 'from-shell')
    setReal('ENVTEST_USER_OVR', 'from-shell')
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ env: { ENVTEST_MANAGED_OVR: 'from-managed' } }))
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_USER_OVR: 'from-user' })

    setup()
    expect(process.env.ENVTEST_MANAGED_OVR).toBe('from-managed') // managed outranks the shell
    expect(process.env.ENVTEST_USER_OVR).toBe('from-shell') // user does not
  })

  it('does not throw and applies nothing when the user settings.json is invalid JSON', () => {
    track('ENVTEST_BROKEN')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), '{ not json')

    // readSettingsFile swallows the parse error, so the factory apply is a no-op rather
    // than throwing during extension load, and nothing from the unreadable scope lands.
    expect(() => setup()).not.toThrow()
    expect('ENVTEST_BROKEN' in process.env).toBe(false)
  })
})
