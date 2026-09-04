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
  it('merges per key with the documented precedence managed > project > user, without wiping other scopes', () => {
    // Claude: "env values follow settings precedence" - managed > local > shared
    // project > user (local overlays project inside projectEnv before this merge).
    const merged = mergeEnvScopes({ A: 'm', C: 'mc' }, { A: 'u', B: 'ub', E: 'ue' }, { A: 'p', D: 'pd', E: 'pe' })
    expect(merged).toEqual({ A: 'm', B: 'ub', C: 'mc', D: 'pd', E: 'pe' })
  })
})

describe('applyEnvSettings', () => {
  it('sets new keys and records them as owned', () => {
    const env: NodeJS.ProcessEnv = {}
    const owned = new Map<string, string | undefined>()
    applyEnvSettings({ A: '1' }, env, owned)
    expect(env.A).toBe('1')
    expect(owned.has('A')).toBe(true)
  })

  it('replaces a shell-inherited value, as Claude documents, and restores it when the key is dropped', () => {
    // Claude: "When the same variable is set in both your shell and a settings file
    // env block, the settings file value applies. Claude Code writes each env entry
    // into the process environment, replacing the value inherited from the shell."
    const env: NodeJS.ProcessEnv = { A: 'shell' }
    const owned = new Map<string, string | undefined>()
    applyEnvSettings({ A: 'settings' }, env, owned)
    expect(env.A).toBe('settings')
    applyEnvSettings({}, env, owned)
    expect(env.A).toBe('shell')
  })

  it('honors the documented empty-string override of an export that cannot be unset', () => {
    // Claude: 'set it to an empty string in the env block: "CLAUDE_CODE_USE_VERTEX": ""'.
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_USE_VERTEX: '1' }
    const owned = new Map<string, string | undefined>()
    applyEnvSettings({ CLAUDE_CODE_USE_VERTEX: '' }, env, owned)
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe('')
  })

  it('updates a key it owns on a later refresh without forgetting the original', () => {
    const env: NodeJS.ProcessEnv = { A: 'shell' }
    const owned = new Map<string, string | undefined>()
    applyEnvSettings({ A: '1' }, env, owned)
    applyEnvSettings({ A: '2' }, env, owned)
    expect(env.A).toBe('2')
    applyEnvSettings({}, env, owned)
    expect(env.A).toBe('shell')
  })

  it('unsets a key it owns once a later apply no longer defines it', () => {
    // Cross-project leak guard: a key an approved project set must not persist into a
    // later apply (session or project) that does not define it.
    const env: NodeJS.ProcessEnv = {}
    const owned = new Map<string, string | undefined>()
    applyEnvSettings({ A: '1' }, env, owned)
    applyEnvSettings({}, env, owned)
    expect('A' in env).toBe(false)
    expect(owned.has('A')).toBe(false)
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

  it('strips a repo-hostile key from a trusted project env before it reaches the process', async () => {
    // sanitizeProjectEnv is unit-tested; this pins that session_start actually routes a
    // project's env through it. Without the wiring a trusted repository's settings.json
    // could point CLAUDE_CONFIG_DIR (and HOME, XDG_*) wherever it likes.
    const project = tempDir('env-proj-')
    mkdirSync(join(project, '.git'))
    writeSettings(project, 'settings.json', { CLAUDE_CONFIG_DIR: '/evil', ENVTEST_OK: 'fine' })
    track('ENVTEST_OK')
    hoisted.approved = true
    const { handlers } = setup()
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: project, isProjectTrusted: () => true })
    expect(process.env.ENVTEST_OK).toBe('fine')
    expect(process.env.CLAUDE_CONFIG_DIR).not.toBe('/evil')
  })

  it('applies an env edit to the running session when the settings file is saved', async () => {
    // Claude: "Claude Code watches your settings files and reloads them when they change,
    // so it applies most edits to the running session without a restart". `env` is not on
    // the restart-only list (model, effortLevel/modelSettings, outputStyle), so an edit
    // has to reach process.env without a new session.
    track('ENVTEST_LIVE')
    process.env.PI_CODE_SETTINGS_WATCH_INTERVAL_MS = '25'
    usedKeys.add('PI_CODE_SETTINGS_WATCH_INTERVAL_MS')
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_LIVE: 'before' })

    const { handlers } = setup()
    await handlers.get('session_start')?.({}, { cwd: tempDir('env-proj-') })
    expect(process.env.ENVTEST_LIVE).toBe('before')

    writeSettings(hoisted.home, 'settings.json', { ENVTEST_LIVE: 'after' })
    await vi.waitFor(() => {
      expect(process.env.ENVTEST_LIVE).toBe('after')
    }, 5000)
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

  it('ignores a parent directory settings.json, like every other settings consumer', async () => {
    // Claude reads the shared settings.json from the session's own directory: "to use a
    // file committed at the repository root, start Claude Code there". Walking up meant a
    // subdirectory session inherited env the rest of pi-code would not read.
    track('ENVTEST_ANCESTOR')
    const repo = tempDir('env-repo-')
    mkdirSync(join(repo, '.git'))
    writeSettings(repo, 'settings.json', { ENVTEST_ANCESTOR: 'from-root' })
    const sub = join(repo, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    hoisted.approved = true

    const { handlers } = setup()
    await handlers.get('session_start')?.({ reason: 'startup' }, { cwd: sub, isProjectTrusted: () => true })

    expect(process.env.ENVTEST_ANCESTOR).toBeUndefined()
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

  it('replaces a shell export with the settings value, as Claude documents', async () => {
    // Claude: "the settings file value applies ... replacing the value inherited
    // from the shell".
    setReal('ENVTEST_REAL', 'from-shell')
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_REAL: 'from-settings' })

    setup()
    expect(process.env.ENVTEST_REAL).toBe('from-settings')
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

  it('lets every settings scope override a preexisting shell export', async () => {
    track('ENVTEST_MANAGED_OVR', 'ENVTEST_USER_OVR')
    setReal('ENVTEST_MANAGED_OVR', 'from-shell')
    setReal('ENVTEST_USER_OVR', 'from-shell')
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ env: { ENVTEST_MANAGED_OVR: 'from-managed' } }))
    writeSettings(hoisted.home, 'settings.json', { ENVTEST_USER_OVR: 'from-user' })

    setup()
    expect(process.env.ENVTEST_MANAGED_OVR).toBe('from-managed')
    expect(process.env.ENVTEST_USER_OVR).toBe('from-user')
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

describe('sanitizeProjectEnv', () => {
  it('drops the repo-hostile keys a checked-out repository must not control, warning each', async () => {
    // Claude: "Project and local settings can't set variables that a checked-out
    // repository shouldn't control ... Claude Code drops each one and logs a warning."
    const { sanitizeProjectEnv } = await import('../extensions/env-settings.ts')
    const warned: string[] = []
    const hostile = {
      CLAUDE_CONFIG_DIR: '/evil',
      CLAUDE_CODE_TMPDIR: '/evil',
      HOME: '/evil',
      TMPDIR: '/evil',
      TMP: '/evil',
      TEMP: '/evil',
      XDG_CONFIG_HOME: '/evil',
      XDG_DATA_HOME: '/evil',
      OTEL_LOG_RAW_API_BODIES: '1',
      ENABLE_BETA_TRACING_DETAILED: '1',
      BETA_TRACING_ENDPOINT: 'https://exfil',
      CLAUDE_CODE_PROCESS_WRAPPER: '/evil',
      CLAUDE_CODE_SYNC_SKILLS: '1',
      CLAUDE_CODE_SYNC_PLUGINS: '1',
      CLAUDE_CODE_PLUGIN_CACHE_DIR: '/evil',
      CLAUDE_CODE_PLUGIN_SEED_DIR: '/evil',
      PI_CODING_AGENT_DIR: '/evil',
      API_TIMEOUT_MS: '5000',
    }
    const kept = sanitizeProjectEnv(hostile, (key: string) => warned.push(key))
    expect(kept).toEqual({ API_TIMEOUT_MS: '5000' })
    expect(warned).toHaveLength(17)
    expect(warned).toContain('CLAUDE_CONFIG_DIR')
    expect(warned).toContain('XDG_DATA_HOME')
  })

  it('keeps ordinary keys untouched (the guard must not block normal work)', async () => {
    const { sanitizeProjectEnv } = await import('../extensions/env-settings.ts')
    expect(sanitizeProjectEnv({ ANTHROPIC_BASE_URL: 'https://proxy', DEBUG: '1' }, () => {})).toEqual({ ANTHROPIC_BASE_URL: 'https://proxy', DEBUG: '1' })
  })
})
