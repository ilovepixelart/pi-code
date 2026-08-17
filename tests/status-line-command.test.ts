import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import statusLine, { readStatusLineConfig } from '../extensions/status-line.ts'

const hoisted = vi.hoisted(() => ({ home: '', runs: [] as Array<{ command: string; payload: unknown }>, result: { code: 0, stdout: '', stderr: '', timedOut: false }, gate: undefined as Promise<void> | undefined }))

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
      // A test can hold the first run open to exercise in-flight queueing.
      if (hoisted.gate) {
        const gate = hoisted.gate
        hoisted.gate = undefined
        await gate
      }
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
  hoisted.gate = undefined
  // Hermetic managed settings: the disableAllHooks read must never resolve to this
  // machine's real policy file.
  setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
})

afterEach(() => {
  setManagedSettingsPath(undefined)
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
    model: { id: 'gpt-oss:20b', name: 'GPT-OSS 20B' },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 131072, percent: 0.8 }),
    ui: { theme: { fg: (_c: string, t: string) => t }, setStatus: (_k: string, text: string | undefined) => status.push(text), notify: () => {}, confirm: async () => true },
    sessionManager: { getBranch: () => [], getSessionId: () => 'sess-9', getSessionFile: () => '/tmp/sess-9.jsonl', getSessionName: () => 'my-session' },
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
    // Claude's documented payload carries both; published statusline scripts read
    // .model.display_name and rendered the literal string "null" without it.
    expect((payload.model as { display_name: string }).display_name).toBe('GPT-OSS 20B')
    expect((payload.context_window as { used_percentage: number }).used_percentage).toBe(0.8)
    expect(status.at(-1)).toBe(' CTX 42% | $0.10 ')
  })

  it('carries the documented payload fields: version, event name, durations and counters', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('tool_result')?.({ toolName: 'write', isError: false, input: { path: 'a.ts', content: 'one\ntwo\nthree' } }, ctx)
    await handlers.get('tool_result')?.({ toolName: 'edit', isError: false, input: { path: 'a.ts', edits: [{ oldText: 'one\ntwo', newText: 'uno' }] } }, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.hook_event_name).toBe('Status')
    expect(typeof payload.version).toBe('string')
    expect((payload.version as string).length).toBeGreaterThan(0)
    expect(payload.session_name).toBe('my-session')
    const cost = payload.cost as Record<string, number>
    expect(cost.total_duration_ms).toBeGreaterThanOrEqual(0)
    expect(cost.total_lines_added).toBe(4)
    expect(cost.total_lines_removed).toBe(2)
    expect((payload.context_window as { remaining_percentage: number }).remaining_percentage).toBe(99.2)
    expect(payload.exceeds_200k_tokens).toBe(false)
    expect((payload.thinking as { enabled: boolean }).enabled).toBe(true)
  })

  it('measures API duration and the token breakdown from provider and message events', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    // One provider round-trip of 50ms, then a message with a usage breakdown.
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request', payload: {} }, ctx)
    await vi.advanceTimersByTimeAsync(50)
    await handlers.get('after_provider_response')?.({ type: 'after_provider_response', status: 200, headers: {} }, ctx)
    await handlers.get('message_end')?.({ type: 'message_end', message: { usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 128 } } }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect((payload.cost as Record<string, number>).total_api_duration_ms).toBeGreaterThanOrEqual(50)
    const cw = payload.context_window as Record<string, unknown>
    expect(cw.current_usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 })
    expect(cw.total_output_tokens).toBe(20)
  })

  it('flags exceeds_200k_tokens from the combined usage total', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('message_end')?.({ type: 'message_end', message: { usage: { input: 150000, output: 30000, cacheRead: 40000, cacheWrite: 0, totalTokens: 220000 } } }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.exceeds_200k_tokens).toBe(true)
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

describe('statusLine concurrency and compaction', () => {
  it('queues one rerun while a command is in flight instead of overlapping', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    let release: (() => void) | undefined
    hoisted.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { handlers, ctx } = setup(cwd)

    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    // Two more triggers arrive while the first run is still held open.
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('agent_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs).toHaveLength(1)

    release?.()
    await vi.advanceTimersByTimeAsync(400)
    // The two triggers collapse into a single queued rerun, not one run each.
    expect(hoisted.runs).toHaveLength(2)
  })

  it('refreshes after compaction and stops the timer at shutdown', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh', refreshInterval: 1 } })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const beforeCompact = hoisted.runs.length
    await handlers.get('session_compact')?.({ reason: 'manual' }, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs.length).toBe(beforeCompact + 1)

    await handlers.get('session_shutdown')?.({}, ctx)
    const afterShutdown = hoisted.runs.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(hoisted.runs.length).toBe(afterShutdown)
  })
})

describe('statusLine disableAllHooks', () => {
  it('does not run the configured command and keeps the built-in segment', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { disableAllHooks: true, statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, status, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    expect(hoisted.runs).toHaveLength(0)
    expect(status.some((s) => s?.includes('ready'))).toBe(true)
  })

  it('ignores a disableAllHooks in an unapproved project settings file', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    writeSettings(cwd, 'settings.json', { disableAllHooks: true })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    const untrusted = { ...ctx, isProjectTrusted: () => false }
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, untrusted)
    await vi.advanceTimersByTimeAsync(400)

    expect(hoisted.runs).toHaveLength(1)
  })

  it('honors a managed-settings disableAllHooks', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ disableAllHooks: true }))
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    expect(hoisted.runs).toHaveLength(0)
  })
})

describe('statusLine model payload', () => {
  it('falls back to the model id when pi reports no display name', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'ok', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, { ...ctx, model: { id: 'bare-id' } })
    await vi.advanceTimersByTimeAsync(400)

    expect((hoisted.runs[0].payload as { model: { display_name: string } }).model.display_name).toBe('bare-id')
  })
})
