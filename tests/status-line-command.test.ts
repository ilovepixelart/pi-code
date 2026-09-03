import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import statusLine, { readStatusLineConfig } from '../extensions/status-line.ts'

const hoisted = vi.hoisted(() => ({ home: '', runs: [] as Array<{ command: string; payload: unknown }>, result: { code: 0, stdout: '', stderr: '', timedOut: false }, gate: undefined as Promise<void> | undefined, settingsChanged: undefined as (() => void) | undefined, fsReads: [] as string[], kills: [] as number[] }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

// Pass-through readFileSync that records every path, so tests can assert the
// settings chain is not re-read per refresh (deterministic, no wall-clock).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
    hoisted.fsReads.push(String(args[0]))
    return actual.readFileSync(...args)
  }
  return { ...actual, readFileSync: readFileSync as typeof actual.readFileSync }
})

// The watcher polls on a real interval; capturing its callback lets a test drive a
// settings change deterministically under fake timers.
vi.mock('../extensions/internal/settings-watch.js', () => ({
  watchSettingsFiles: (_files: string[], reload: () => void) => {
    hoisted.settingsChanged = reload
    return () => {
      hoisted.settingsChanged = undefined
    }
  },
}))

vi.mock('../extensions/hooks/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extensions/hooks/index.js')>()
  return {
    ...actual,
    runHookCommand: async (command: string, payload: unknown, _timeout?: number, options?: { onChild?: (kill: () => void) => void }) => {
      hoisted.runs.push({ command, payload })
      options?.onChild?.(() => hoisted.kills.push(hoisted.runs.length))
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
  hoisted.fsReads.length = 0
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
  it('arms the refresh interval when the setting is added mid-session', async () => {
    // Claude re-runs the script when the statusLine settings change mid-session. The
    // interval was armed once at session start, so adding or changing refreshInterval had
    // no effect until the next session.
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs).toHaveLength(1)

    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh', refreshInterval: 1 } })
    hoisted.settingsChanged?.()
    await vi.advanceTimersByTimeAsync(400)
    const afterReload = hoisted.runs.length
    await vi.advanceTimersByTimeAsync(1400)

    expect(hoisted.runs.length).toBeGreaterThan(afterReload)
  })

  it('runs the configured command with the session payload and shows every line it printed, padded', async () => {
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
    // Claude: "Your script can output multiple lines to create a richer display."
    // pi renders every extension status on one row and replaces newlines with spaces
    // (footer.js sanitizeStatusText), so the rows are joined rather than dropped.
    expect(status.at(-1)).toBe(' CTX 42% | $0.10 second row ')
  })

  it('drops a blank line rather than rendering a gap', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'first\n\n   \nlast\n', stderr: '', timedOut: false }
    const { handlers, status, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    expect(status.at(-1)).toBe('first last')
  })

  it('runs a changed command at once instead of waiting out the debounce', async () => {
    // Claude re-runs the script when the statusLine settings change. Making the user
    // wait 300ms to see whether the command they just edited works is the one case
    // where the debounce has nothing to batch.
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'first.sh' } })
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs).toHaveLength(1)

    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'second.sh' } })
    hoisted.settingsChanged?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(hoisted.runs).toHaveLength(2)
    expect(hoisted.runs[1].command).toBe('second.sh')
  })

  it('still debounces when the settings changed but the command did not', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh', padding: 2 } })
    hoisted.settingsChanged?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.runs).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs).toHaveLength(2)
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

  it('anchors workspace.project_dir at the repository, not the starting directory', async () => {
    // A script reading .workspace.project_dir to label the repo showed the
    // subdirectory the session happened to start in.
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, ctx } = setup(sub)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const workspace = (hoisted.runs[0].payload as { workspace: { current_dir: string; project_dir: string } }).workspace
    expect(workspace.current_dir).toBe(sub)
    expect(workspace.project_dir).toBe(repo)
  })

  it('reports whether the session is in a git worktree', async () => {
    const repo = tempDir()
    // A worktree carries a .git file pointing at the main checkout, not a directory.
    writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/feature\n')
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, ctx } = setup(repo)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    expect((hoisted.runs[0].payload as { workspace: { git_worktree: boolean } }).workspace.git_worktree).toBe(true)
  })

  it('reports the context window as zero-output and no usage before the first response', async () => {
    // Claude sends total_output_tokens 0 and current_usage null rather than omitting
    // them, so a script reading .context_window.current_usage gets null, not undefined.
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const window = (hoisted.runs[0].payload as { context_window: Record<string, unknown> }).context_window
    expect(window.total_output_tokens).toBe(0)
    expect(window.current_usage).toBeNull()
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

describe('statusLine rate limits', () => {
  it('surfaces the five-hour and seven-day windows from provider response headers', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    // The header timestamps must be in the future of the (frozen) clock, or the
    // expiry rule below would rightly drop them.
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.(
      {
        type: 'after_provider_response',
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '35.5',
          'anthropic-ratelimit-unified-5h-reset': '2026-08-16T12:00:00Z',
          'anthropic-ratelimit-unified-7d-utilization': '12',
          'anthropic-ratelimit-unified-7d-reset': '2026-08-22T00:00:00Z',
        },
      },
      ctx,
    )
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    // Claude documents resets_at as Unix epoch seconds, not the raw header string.
    expect(payload.rate_limits).toEqual({
      five_hour: { used_percentage: 35.5, resets_at: Date.parse('2026-08-16T12:00:00Z') / 1000 },
      seven_day: { used_percentage: 12, resets_at: Date.parse('2026-08-22T00:00:00Z') / 1000 },
    })
  })

  it('computes utilization from limit and remaining when no utilization header is sent', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    // Header casing varies by provider, and a null value must be tolerated, not crash.
    await handlers.get('after_provider_response')?.(
      {
        type: 'after_provider_response',
        status: 200,
        headers: {
          'Anthropic-RateLimit-Unified-5h-Limit': '1000',
          'Anthropic-RateLimit-Unified-5h-Remaining': '250',
          'anthropic-ratelimit-unified-7d-utilization': null,
        },
      },
      ctx,
    )
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.rate_limits).toEqual({ five_hour: { used_percentage: 75 } })
  })

  it('clamps an out-of-range utilization down to 100', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.({ type: 'after_provider_response', status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '150' } }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.rate_limits).toEqual({ five_hour: { used_percentage: 100 } })
  })

  it('clamps a computed utilization up to 0 when remaining exceeds the limit', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.(
      {
        type: 'after_provider_response',
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-limit': '1000', 'anthropic-ratelimit-unified-5h-remaining': '1500' },
      },
      ctx,
    )
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.rate_limits).toEqual({ five_hour: { used_percentage: 0 } })
  })

  it('omits rate_limits when the response carries no rate-limit headers', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.({ type: 'after_provider_response', status: 200, headers: {} }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.rate_limits).toBeUndefined()
  })

  it('warns once per session on a 429 with the retry-after delay', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    const notify = vi.fn()
    ctx.ui.notify = notify
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.({ type: 'after_provider_response', status: 429, headers: { 'retry-after': '30' } }, ctx)
    await handlers.get('after_provider_response')?.({ type: 'after_provider_response', status: 429, headers: {} }, ctx)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toBe('warning')
    expect(String(notify.mock.calls[0][0])).toContain('30')
  })
})

describe('statusLine instant refresh', () => {
  it('refreshes immediately when the model changes', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    const initial = hoisted.runs.length
    await handlers.get('model_select')?.({ type: 'model_select', model: { id: 'other' }, previousModel: undefined, source: 'set' }, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs.length).toBe(initial + 1)
  })

  it('refreshes immediately when the thinking level changes', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    const initial = hoisted.runs.length
    await handlers.get('thinking_level_select')?.({ type: 'thinking_level_select', level: 'low', previousLevel: 'high' }, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs.length).toBe(initial + 1)
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

describe('statusLine settings caching', () => {
  const styleOf = (run: { payload: unknown } | undefined) => (run?.payload as { output_style?: { name: string } } | undefined)?.output_style?.name
  const settingsReads = () => hoisted.fsReads.filter((p) => p.includes('settings')).length

  it('does not re-read the settings chain on interval refreshes', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh', refreshInterval: 1 }, outputStyle: 'Explanatory' })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs).toHaveLength(1)
    expect(styleOf(hoisted.runs[0])).toBe('Explanatory')

    // Three interval ticks, each debounced into a command run: the style name and
    // the resolved settings-file list come from the session cache, not the disk.
    const afterFirstRun = settingsReads()
    await vi.advanceTimersByTimeAsync(3400)
    expect(hoisted.runs.length).toBeGreaterThan(1)
    expect(settingsReads()).toBe(afterFirstRun)
    await handlers.get('session_shutdown')?.({}, ctx)
  })

  it('re-reads the active style at the next turn, not on refreshes between turns', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' }, outputStyle: 'Explanatory' })
    hoisted.result = { code: 0, stdout: 'seg', stderr: '', timedOut: false }
    const { handlers, busHandlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(styleOf(hoisted.runs.at(-1))).toBe('Explanatory')

    // /output-style persists straight to settings with no bus event, and the new
    // style applies from the next turn; a refresh between turns keeps the old name.
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' }, outputStyle: 'Terse' })
    busHandlers.get('pi-code:plan-mode')?.({ active: true })
    await vi.advanceTimersByTimeAsync(400)
    expect(styleOf(hoisted.runs.at(-1))).toBe('Explanatory')

    await handlers.get('turn_start')?.({}, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(styleOf(hoisted.runs.at(-1))).toBe('Terse')
  })
})

describe('statusLine payload and expiry conformance', () => {
  it('drops a rate-limit window whose resets_at has passed instead of leaving it stale', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T11:00:00Z'))
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.(
      {
        type: 'after_provider_response',
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '35.5',
          'anthropic-ratelimit-unified-5h-reset': '2026-08-16T12:00:00Z',
        },
      },
      ctx,
    )
    await vi.advanceTimersByTimeAsync(400)

    // Two hours later the window has reset; the next payload must not carry it.
    vi.setSystemTime(new Date('2026-08-16T13:00:00Z'))
    hoisted.runs.length = 0
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.rate_limits).toBeUndefined()
  })

  it('reports workspace.added_dirs as an empty array and maps pi effort levels onto the documented vocabulary', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    ;(ctx as { thinkingLevel: string }).thinkingLevel = 'minimal'
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect((payload.workspace as { added_dirs?: unknown }).added_dirs).toEqual([])
    // pi's 'minimal' is off-contract; Claude's vocabulary starts at 'low'.
    expect((payload.effort as { level: string }).level).toBe('low')
  })

  it('omits effort and reports thinking disabled when the level is off', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    ;(ctx as { thinkingLevel: string }).thinkingLevel = 'off'
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)

    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.effort).toBeUndefined()
    expect((payload.thinking as { enabled: boolean }).enabled).toBe(false)
  })
})

describe('statusLine cadence and managed config', () => {
  it('lets a managed statusLine win over the settings files', async () => {
    const { readStatusLineConfig } = await import('../extensions/status-line.ts')
    const dir = tempDir()
    const user = join(dir, 'settings.json')
    writeFileSync(user, JSON.stringify({ statusLine: { type: 'command', command: 'user.sh' } }))
    const config = readStatusLineConfig([user], { statusLine: { type: 'command', command: 'managed.sh' } })
    expect(config?.command).toBe('managed.sh')
  })

  it('refreshes after each assistant message, as Claude re-runs per message', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    hoisted.runs.length = 0

    await handlers.get('message_end')?.({ message: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }, ctx)
    await vi.advanceTimersByTimeAsync(400)

    expect(hoisted.runs.length).toBeGreaterThan(0)
  })

  it('re-runs on its own when a rate-limit window reaches its resets_at time', async () => {
    // Claude re-runs the script when "a rate-limit window in the data your script
    // last received reaches its resets_at time".
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    hoisted.result = { code: 0, stdout: 'x', stderr: '', timedOut: false }
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    await handlers.get('after_provider_response')?.({ type: 'after_provider_response', status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '90', 'anthropic-ratelimit-unified-5h-reset': '2026-08-16T00:10:00Z' } }, ctx)
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    hoisted.runs.length = 0

    // Cross the reset time with no other trigger: the expiry timer re-runs the
    // script and the expired window is gone from its payload.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
    expect(hoisted.runs.length).toBeGreaterThan(0)
    const payload = hoisted.runs.at(-1)?.payload as Record<string, unknown>
    expect(payload.rate_limits).toBeUndefined()
  })

  it('cancels the in-flight script when a new update triggers', async () => {
    const cwd = tempDir()
    writeSettings(hoisted.home, 'settings.json', { statusLine: { type: 'command', command: 'seg.sh' } })
    const { handlers, ctx } = setup(cwd)
    vi.useFakeTimers()
    let release!: () => void
    hoisted.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hoisted.kills.length = 0
    await handlers.get('session_start')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.runs.length).toBe(1)

    // A new trigger while the first run is still in flight cancels it.
    await handlers.get('turn_end')?.({}, ctx)
    await vi.advanceTimersByTimeAsync(400)
    expect(hoisted.kills.length).toBe(1)
    release()
    hoisted.gate = undefined
    await vi.advanceTimersByTimeAsync(400)
  })
})
