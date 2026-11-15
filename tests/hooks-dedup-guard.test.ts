import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import hooksExtension from '../extensions/hooks/index.ts'
import { setCliSettingsReader } from '../extensions/internal/cli-settings.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'

// No spawn double: the guard is a real process exiting 2, declared blocking in one settings
// source and `async` in the project's settings.json, as a repository would to disarm it.
const hoisted = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>

const GUARD = `node -e "process.stderr.write('GUARD-BLOCK');process.exit(2)"`
const guardHooks = (fields: Record<string, unknown> = {}) => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: GUARD, ...fields }] }] } })

describe('a guard hook copied as async into project settings', () => {
  const tempDirs: string[] = []
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, configDir: process.env.CLAUDE_CONFIG_DIR }
  const restore = (key: 'PI_CODING_AGENT_DIR' | 'CLAUDE_CONFIG_DIR', value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeEach(() => {
    hoisted.home = tempDir('dedup-home-')
    process.env.PI_CODING_AGENT_DIR = tempDir('dedup-agent-')
    delete process.env.CLAUDE_CONFIG_DIR
    setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
  })

  afterEach(() => {
    restore('PI_CODING_AGENT_DIR', saved.agentDir)
    restore('CLAUDE_CONFIG_DIR', saved.configDir)
    setManagedSettingsPath(undefined)
    setCliSettingsReader(undefined)
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A Bash tool call in a trusted project whose settings.json holds the async copy. */
  const bashCall = async (): Promise<unknown> => {
    const cwd = tempDir('dedup-proj-')
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(guardHooks({ async: true })))
    const handlers = new Map<string, Handler>()
    hooksExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn), events: { on: () => {}, emit: () => {} }, sendMessage: () => {}, registerCommand: () => {} } as never)
    const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: () => {}, confirm: async () => true }, sessionManager: { getSessionId: () => 's', getSessionFile: () => undefined } }
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx)
    return handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'echo hi' }, toolCallId: 't1' }, ctx)
  }

  it('should block the call when the blocking guard is in managed settings', async () => {
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify(guardHooks()))

    expect(await bashCall()).toEqual({ block: true, reason: 'GUARD-BLOCK' })
  })

  it('should block the call when the blocking guard is in the --settings file', async () => {
    const settingsFile = join(tempDir('dedup-flag-'), 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(guardHooks()))
    setCliSettingsReader(() => ({ settingsFile, sources: new Set(['user', 'project', 'local'] as const), forwardArgs: [], errors: [] }))

    expect(await bashCall()).toEqual({ block: true, reason: 'GUARD-BLOCK' })
  })

  it('should not block the call when the blocking guard is in user settings', async () => {
    // Claude Code 2.1.325: project settings outrank user settings, so the async copy runs.
    mkdirSync(join(hoisted.home, '.claude'))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify(guardHooks()))

    expect(await bashCall()).toBeUndefined()
  })
})
