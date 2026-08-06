import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import statusLine, { readStatusLineConfig } from '../extensions/status-line.ts'

const hoisted = vi.hoisted(() => ({ home: '', runs: [] as Array<{ command: string; payload: unknown }>, result: { code: 0, stdout: '', stderr: '', timedOut: false } }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

vi.mock('../extensions/hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extensions/hooks.js')>()
  return {
    ...actual,
    runHookCommand: async (command: string, payload: unknown) => {
      hoisted.runs.push({ command, payload })
      return hoisted.result
    },
  }
})

const tempDirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-'))
  tempDirs.push(dir)
  return dir
}

const writeSettings = (root: string, name: string, settings: Record<string, unknown>): void => {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', name), JSON.stringify(settings))
}

beforeEach(() => {
  hoisted.home = tempDir()
  hoisted.runs.length = 0
  hoisted.result = { code: 0, stdout: '', stderr: '', timedOut: false }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readStatusLineConfig', () => {
  it('reads the command with padding and refreshInterval, last file winning', () => {
    const a = join(tempDir(), 'a.json')
    const b = join(tempDir(), 'b.json')
    writeFileSync(a, JSON.stringify({ statusLine: { type: 'command', command: 'first.sh' } }))
    writeFileSync(b, JSON.stringify({ statusLine: { type: 'command', command: 'second.sh', padding: 2, refreshInterval: 5 } }))
    expect(readStatusLineConfig([a, b])).toEqual({ command: 'second.sh', padding: 2, refreshInterval: 5 })
  })

  it('ignores malformed entries, sub-minimum intervals, and missing files', () => {
    const a = join(tempDir(), 'a.json')
    writeFileSync(a, JSON.stringify({ statusLine: { type: 'command', command: 'x.sh', refreshInterval: 0 } }))
    expect(readStatusLineConfig([a, join(tempDir(), 'absent.json')])).toEqual({ command: 'x.sh', padding: 0, refreshInterval: undefined })
    const bad = join(tempDir(), 'bad.json')
    writeFileSync(bad, JSON.stringify({ statusLine: { type: 'command' } }))
    expect(readStatusLineConfig([bad])).toBeUndefined()
  })
})

type Handler = (event: Record<string, unknown>, ctx?: unknown) => Promise<void>

const setup = (cwd: string) => {
  const handlers = new Map<string, Handler>()
  const busHandlers = new Map<string, (data: unknown) => void>()
  statusLine({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    events: { on: (channel: string, fn: (data: unknown) => void) => busHandlers.set(channel, fn), emit: () => {} },
  } as never)
  const status: Array<string | undefined> = []
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    thinkingLevel: 'high',
    model: { id: 'gpt-oss:20b' },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 131072, percent: 0.8 }),
    ui: { theme: { fg: (_c: string, t: string) => t }, setStatus: (_k: string, text: string | undefined) => status.push(text), notify: () => {}, confirm: async () => true },
    sessionManager: { getBranch: () => [], getSessionId: () => 'sess-9', getSessionFile: () => '/tmp/sess-9.jsonl' },
  }
  return { handlers, busHandlers, status, ctx }
}

describe('statusLine command contract', () => {
  it('runs the configured command with the session payload and shows its first line, padded', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh', padding: 1 } })
    hoisted.result = { code: 0, stdout: 'CTX 42% | $0.10\nsecond row\n', stderr: '', timedOut: false }
    const { handlers, status, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    expect(hoisted.runs).toHaveLength(1)
    expect(hoisted.runs[0].command).toBe('seg.sh')
    const payload = hoisted.runs[0].payload as Record<string, unknown>
    expect(payload.session_id).toBe('sess-9')
    expect(payload.cwd).toBe(cwd)
    expect((payload.model as { id: string }).id).toBe('gpt-oss:20b')
    expect((payload.context_window as { used_percentage: number }).used_percentage).toBe(0.8)
    expect(status.at(-1)).toBe(' CTX 42% | $0.10 ')
  })

  it('keeps the built-in segment when the command prints nothing', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 1, stdout: '', stderr: 'boom', timedOut: false }
    const { handlers, status, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(status.some((s) => s?.includes('ready'))).toBe(true)
  })

  it('ignores a project-defined command when the project is not approved', async () => {
    const cwd = tempDir()
    writeSettings(cwd, 'settings.json', { statusLine: { type: 'command', command: 'evil.sh' } })
    const { handlers, ctx } = setup(cwd)
    const untrusted = { ...ctx, isProjectTrusted: () => false }
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, untrusted)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs).toHaveLength(0)
  })

  it('re-runs on the refreshInterval timer', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh', refreshInterval: 2 } })
    hoisted.result = { code: 0, stdout: 'tick', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    const initial = hoisted.runs.length
    await vi.advanceTimersByTimeAsync(4500)
    expect(hoisted.runs.length).toBeGreaterThan(initial)
    await handlers.get('session_shutdown')?.({}, ctx)
  })

  it('re-runs when the plan-mode state changes on the bus', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, busHandlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    const initial = hoisted.runs.length
    busHandlers.get('pi-code:plan-mode')?.({ active: true })
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs.length).toBe(initial + 1)
  })
})
