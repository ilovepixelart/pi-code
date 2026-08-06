import type { EventEmitter as Emitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import hooksExtension, { type HookRunner, interpretHookResult, loadHooks, matchingCommands, runHookCommand, runPreToolUse } from '../extensions/hooks.ts'

/**
 * Hook commands must never reach a real shell from this suite, so `spawn` is
 * replaced by a scripted fake child process. `os.homedir()` is redirected at a
 * temp dir so the extension reads throwaway settings instead of the developer's.
 */
interface Behavior {
  stdout?: string[]
  stderr?: string[]
  code?: number | null
  error?: Error
  stdinError?: Error
  hang?: boolean
}

interface SpawnRecord {
  file: string
  args: string[]
  options: unknown
  command: string
  stdin: string
  killSignals: string[]
}

const hoisted = vi.hoisted(() => ({
  home: '',
  calls: [] as SpawnRecord[],
  behaviors: new Map<string, Behavior>(),
  live: [] as Array<{ emit: (name: string, arg?: unknown) => boolean }>,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    spawn: (file: string, args: string[], options: unknown) => {
      const command = args[1] ?? ''
      const behavior = hoisted.behaviors.get(command) ?? {}
      const record: SpawnRecord = { file, args, options, command, stdin: '', killSignals: [] }
      hoisted.calls.push(record)

      const child = new EventEmitter() as Emitter & Record<string, unknown>
      // Real streams, so setEncoding decodes multi-byte characters split across chunks
      // exactly as it does in production.
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      const stdin = new EventEmitter() as Emitter & Record<string, unknown>
      stdin.end = (data: string) => {
        record.stdin = data
        if (behavior.stdinError) stdin.emit('error', behavior.stdinError)
      }
      child.stdin = stdin
      child.kill = (signal: string) => {
        record.killSignals.push(signal)
        return true
      }
      hoisted.live.push(child)

      // Microtask (not a timer) so scripted output still flows under fake timers. A real
      // child ends its streams before close, which is when a decoder flushes its tail.
      queueMicrotask(() => {
        const out = child.stdout as PassThrough
        const err = child.stderr as PassThrough
        for (const chunk of behavior.stdout ?? []) out.write(chunk)
        for (const chunk of behavior.stderr ?? []) err.write(chunk)
        if (behavior.error) return void child.emit('error', behavior.error)
        if (behavior.hang) return

        let ended = 0
        const onEnd = () => {
          if (++ended === 2) child.emit('close', behavior.code === undefined ? 0 : behavior.code)
        }
        out.on('end', onEnd)
        err.on('end', onEnd)
        out.end()
        err.end()
      })
      return child
    },
  }
})

const script = (command: string, behavior: Behavior): void => {
  hoisted.behaviors.set(command, behavior)
}

const commandsRun = (): string[] => hoisted.calls.map((call) => call.command)

const recordFor = (command: string): SpawnRecord => {
  const record = hoisted.calls.find((call) => call.command === command)
  if (!record) throw new Error(`no spawn recorded for ${command}`)
  return record
}

const tempDirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Write a `.claude/<name>` settings file under `root` and return its directory. */
const writeSettings = (root: string, name: string, hooks: unknown): void => {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', name), JSON.stringify({ hooks }))
}

beforeEach(() => {
  hoisted.calls.length = 0
  hoisted.live.length = 0
  hoisted.behaviors.clear()
  hoisted.home = tempDir('hooks-home-')
})

afterEach(() => {
  // Release any child scripted to hang so its pending promise never leaks into the next test.
  for (const child of hoisted.live.splice(0)) child.emit('close', 0)
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Handler = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>

/** Register the extension against a stub API and expose its three lifecycle handlers. */
const setupExtension = () => {
  const handlers = new Map<string, Handler>()
  const busHandlers = new Map<string, (data: unknown) => void>()
  hooksExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    events: { on: (channel: string, fn: (data: unknown) => void) => busHandlers.set(channel, fn), emit: () => {} },
  } as never)
  const handler = (name: string): Handler => {
    const found = handlers.get(name)
    if (!found) throw new Error(`hooks extension did not register ${name}`)
    return found
  }
  const notes: Array<{ msg: string; level: string }> = []
  const defaultCtx = { ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) } }
  return {
    registered: [...handlers.keys()],
    notes,
    sessionStart: (reason: string, ctx: Record<string, unknown>) => handler('session_start')({ reason }, ctx),
    toolCall: (toolName: string, input: unknown, toolCallId = 't1') => handler('tool_call')({ toolName, input, toolCallId }),
    toolEnd: (toolName: string, isError = false, end: { toolCallId?: string; result?: unknown } = {}) => handler('tool_execution_end')({ toolName, isError, toolCallId: end.toolCallId ?? 't1', result: end.result }),
    input: (text: string, source = 'interactive') => handler('input')({ text, source }, defaultCtx),
    agentEnd: () => handler('agent_end')({ messages: [] }),
    beforeCompact: (reason: string) => handler('session_before_compact')({ reason }),
    shutdown: (reason: string) => handler('session_shutdown')({ reason }),
    emitMcpTools: (entries: unknown) => busHandlers.get('pi-code:mcp-tools')?.(entries),
  }
}

describe('runHookCommand process wiring', () => {
  it('runs the command through /bin/sh by absolute path, streams piped and detached into its own group', async () => {
    await runHookCommand('guard.sh', {}, 5000)
    const record = recordFor('guard.sh')
    expect(record.file).toBe('/bin/sh')
    expect(record.args).toEqual(['-c', 'guard.sh'])
    // `detached` is what makes the shell a process-group leader, so a timeout can kill
    // the grandchildren a compound command forks.
    expect(record.options).toEqual({ stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: process.env })
  })

  it('writes the payload to stdin as JSON', async () => {
    await runHookCommand('cat', { tool_name: 'bash', tool_input: { command: 'ls' } }, 5000)
    expect(JSON.parse(recordFor('cat').stdin)).toEqual({ tool_name: 'bash', tool_input: { command: 'ls' } })
  })

  it('concatenates multiple stdout and stderr chunks in arrival order', async () => {
    script('chatty', { stdout: ['one', 'two'], stderr: ['err1', 'err2'], code: 0 })
    expect(await runHookCommand('chatty', {}, 5000)).toEqual({ code: 0, stdout: 'onetwo', stderr: 'err1err2', timedOut: false })
  })

  it('reports the exit code the process closed with', async () => {
    script('fail', { stderr: ['boom'], code: 2 })
    expect(await runHookCommand('fail', {}, 5000)).toEqual({ code: 2, stdout: '', stderr: 'boom', timedOut: false })
  })

  it('reports a signal-killed close (null exit code) as exit code 0', async () => {
    script('killed', { code: null })
    expect(await runHookCommand('killed', {}, 5000)).toEqual({ code: 0, stdout: '', stderr: '', timedOut: false })
  })

  it('stops accumulating stdout past the cap', async () => {
    const huge = 'x'.repeat(600_000)
    script('flood', { stdout: [huge, huge, huge], code: 0 })

    const result = await runHookCommand('flood', {}, 5000)
    // 1.8MB written; the cap stops accumulation after the chunk that crosses it.
    expect(result.stdout.length).toBeLessThan(1_800_000)
  })

  it('resolves as a clean run when the process fails to spawn', async () => {
    script('missing', { error: new Error('spawn /bin/sh ENOENT') })
    expect(await runHookCommand('missing', {}, 5000)).toEqual({ code: 0, stdout: '', stderr: '', timedOut: false })
  })

  it('keeps output already received when the process then errors', async () => {
    script('half', { stdout: ['partial'], error: new Error('EIO') })
    expect(await runHookCommand('half', {}, 5000)).toEqual({ code: 0, stdout: 'partial', stderr: '', timedOut: false })
  })

  it('swallows an EPIPE from a hook that exits without reading stdin', async () => {
    script('exit2', { stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), stderr: ['denied'], code: 2 })
    expect(await runHookCommand('exit2', {}, 5000)).toEqual({ code: 2, stdout: '', stderr: 'denied', timedOut: false })
  })
})

describe('runHookCommand timeout', () => {
  it('does not kill the child before the timeout elapses', async () => {
    vi.useFakeTimers()
    script('slow', { hang: true })
    void runHookCommand('slow', {}, 1000)
    await vi.advanceTimersByTimeAsync(999)
    expect(recordFor('slow').killSignals).toEqual([])
  })

  it('kills the child with SIGKILL once the timeout elapses', async () => {
    vi.useFakeTimers()
    script('slow', { hang: true })
    void runHookCommand('slow', {}, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(recordFor('slow').killSignals).toEqual(['SIGKILL'])
  })

  it('cancels the kill timer once the process closes on its own', async () => {
    vi.useFakeTimers()
    script('quick', { code: 0 })
    expect(await runHookCommand('quick', {}, 1000)).toEqual({ code: 0, stdout: '', stderr: '', timedOut: false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordFor('quick').killSignals).toEqual([])
  })
})

describe('hook timeout configuration', () => {
  const runnerRecording = (seen: number[]): HookRunner => {
    return async (_command, _payload, ms) => {
      seen.push(ms)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
  }

  it('defaults to 60 seconds when the hook declares no timeout', async () => {
    const seen: number[] = []
    await runPreToolUse({ PreToolUse: [{ hooks: [{ command: 'a' }] }] }, 'bash', {}, runnerRecording(seen))
    expect(seen).toEqual([60_000])
  })

  it('converts a declared timeout from seconds to milliseconds', async () => {
    const seen: number[] = []
    await runPreToolUse({ PreToolUse: [{ hooks: [{ command: 'a', timeout: 5 }] }] }, 'bash', {}, runnerRecording(seen))
    expect(seen).toEqual([5000])
  })

  it.each([0, -5, Number.NaN])('falls back to the default for a non-positive timeout (%s)', async (timeout) => {
    // A 0ms timer fires before the hook can run, and a timed-out PreToolUse hook fails
    // closed, so honoring `timeout: 0` would permanently block every matched tool.
    const seen: number[] = []
    await runPreToolUse({ PreToolUse: [{ hooks: [{ command: 'a', timeout }] }] }, 'bash', {}, runnerRecording(seen))
    expect(seen).toEqual([60_000])
  })

  it('clamps a timeout above the 32-bit timer limit', async () => {
    // Node clamps setTimeout delays past 2^31-1 ms to 1ms, which would kill the hook
    // instantly and fail closed, the same bricked-tool outcome as timeout: 0.
    const seen: number[] = []
    await runPreToolUse({ PreToolUse: [{ hooks: [{ command: 'a', timeout: 3_000_000_000 }] }] }, 'bash', {}, runnerRecording(seen))
    expect(seen).toEqual([2_147_483_000])
  })
})

describe('non-command hook types', () => {
  it('runs only command hooks and skips prompt/agent typed entries', async () => {
    // Claude settings may carry prompt or agent hooks with no command field; running
    // one through sh -c undefined would throw out of the tool_call handler.
    const seen: string[] = []
    const runner: HookRunner = async (command) => {
      seen.push(command)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const config = {
      PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'judge this' } as never, { command: 'real-hook' }, { type: 'command', command: 'typed-hook' }] }],
    }
    const decision = await runPreToolUse(config, 'bash', {}, runner)
    expect(decision).toEqual({ block: false })
    expect(seen).toEqual(['real-hook', 'typed-hook'])
  })
})

describe('interpretHookResult defaults and precedence', () => {
  it('falls back to "Blocked by hook" when exit 2 leaves stderr empty', () => {
    expect(interpretHookResult(2, '', '   \n  ')).toEqual({ block: true, reason: 'Blocked by hook' })
  })

  it('trims surrounding whitespace off the stderr reason', () => {
    expect(interpretHookResult(2, '', '  no force push \n')).toEqual({ block: true, reason: 'no force push' })
  })

  it('blocks on exit 2 even when stdout says the tool is allowed', () => {
    const allow = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } })
    expect(interpretHookResult(2, allow, 'still denied')).toEqual({ block: true, reason: 'still denied' })
  })

  it('falls back to "Blocked by hook" when a deny decision omits its reason', () => {
    const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(interpretHookResult(0, out, '')).toEqual({ block: true, reason: 'Blocked by hook' })
  })

  it('falls back to "Blocked by hook" when a legacy block decision omits its reason', () => {
    expect(interpretHookResult(0, JSON.stringify({ decision: 'block' }), '')).toEqual({ block: true, reason: 'Blocked by hook' })
  })

  it('allows an explicit permissionDecision of allow', () => {
    const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'fine' } })
    expect(interpretHookResult(0, out, '')).toEqual({ block: false })
  })

  it('allows a legacy decision of approve', () => {
    expect(interpretHookResult(0, JSON.stringify({ decision: 'approve', reason: 'fine' }), '')).toEqual({ block: false })
  })

  it('allows a non-zero exit that is not 2, since only 2 blocks', () => {
    expect(interpretHookResult(1, '', 'script crashed')).toEqual({ block: false })
  })

  it('allows when stdout is not valid JSON', () => {
    expect(interpretHookResult(0, 'not json at all {', '')).toEqual({ block: false })
  })

  it('allows when stdout is JSON null rather than an object', () => {
    expect(interpretHookResult(0, 'null', '')).toEqual({ block: false })
  })
})

describe('runPreToolUse hook sequencing', () => {
  it('returns the first blocking verdict and skips the remaining hooks', async () => {
    const run: string[] = []
    const runner: HookRunner = async (command) => {
      run.push(command)
      return command === 'second' ? { code: 2, stdout: '', stderr: 'denied by second', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const config = { PreToolUse: [{ hooks: [{ command: 'first' }, { command: 'second' }, { command: 'third' }] }] }
    expect(await runPreToolUse(config, 'bash', {}, runner)).toEqual({ block: true, reason: 'denied by second' })
    expect(run).toEqual(['first', 'second'])
  })

  it('allows the tool when every matching hook passes', async () => {
    const run: string[] = []
    const runner: HookRunner = async (command) => {
      run.push(command)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const config = { PreToolUse: [{ hooks: [{ command: 'first' }, { command: 'second' }] }] }
    expect(await runPreToolUse(config, 'bash', {}, runner)).toEqual({ block: false })
    expect(run).toEqual(['first', 'second'])
  })

  it('allows the tool when the config declares no PreToolUse hooks at all', async () => {
    const runner: HookRunner = async () => ({ code: 2, stdout: '', stderr: 'denied', timedOut: false })
    expect(await runPreToolUse({}, 'bash', {}, runner)).toEqual({ block: false })
  })
})

describe('matchingCommands edge shapes', () => {
  it('returns nothing when the event has no matcher list', () => {
    expect(matchingCommands(undefined, 'bash')).toEqual([])
  })

  it('returns nothing for a matching entry that declares no hooks', () => {
    expect(matchingCommands([{ matcher: 'Bash' } as never], 'bash')).toEqual([])
  })

  it('runs a handler defined identically in more than one settings file once', () => {
    // Claude: "If you define the same handler in more than one settings file, it runs once."
    const entries = [
      { matcher: 'Bash', hooks: [{ command: 'guard.sh' }] },
      { matcher: '*', hooks: [{ command: 'guard.sh' }, { command: 'other.sh' }] },
    ]
    expect(matchingCommands(entries, 'bash')).toEqual([{ command: 'guard.sh' }, { command: 'other.sh' }])
  })

  it('falls back to case-insensitive literal equality when the matcher is an invalid regex', () => {
    const hook = { matcher: 'Bash(', hooks: [{ command: 'lit' }] }
    expect(matchingCommands([hook], 'bash(')).toEqual([{ command: 'lit' }])
    expect(matchingCommands([hook], 'bash')).toEqual([])
  })

  it('does not partial-match an exact-name matcher', () => {
    const hook = { matcher: 'Bash', hooks: [{ command: 'guard' }] }
    expect(matchingCommands([hook], 'bashful')).toEqual([])
    expect(matchingCommands([hook], 'rebash')).toEqual([])
  })

  it('collects hooks from every applying entry in declaration order', () => {
    const entries = [
      { matcher: '*', hooks: [{ command: 'all' }] },
      { matcher: 'Bash', hooks: [{ command: 'bash-only' }] },
      { matcher: 'Edit', hooks: [{ command: 'edit-only' }] },
    ]
    expect(matchingCommands(entries, 'bash')).toEqual([{ command: 'all' }, { command: 'bash-only' }])
  })
})

describe('loadHooks malformed config shapes', () => {
  it('ignores an event whose matchers are not an array', () => {
    const dir = tempDir('hooks-cfg-')
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: { matcher: 'Bash' }, PostToolUse: [{ hooks: [{ command: 'ok' }] }] } }))
    const config = loadHooks([file])
    expect(config.PreToolUse).toBeUndefined()
    expect(config.PostToolUse).toEqual([{ hooks: [{ command: 'ok' }] }])
  })

  it('yields an empty config for a settings file with no hooks key', () => {
    const dir = tempDir('hooks-cfg-')
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }))
    expect(loadHooks([file])).toEqual({})
  })

  it('keeps separate events separate while merging across files', () => {
    const dir = tempDir('hooks-cfg-')
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writeFileSync(a, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'p1' }] }] } }))
    writeFileSync(b, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'q1' }] }] } }))
    expect(loadHooks([a, b])).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'p1' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'q1' }] }],
    })
  })
})

describe('hooks extension registration', () => {
  it('subscribes to the lifecycle events it bridges', () => {
    expect(setupExtension().registered).toEqual(['session_start', 'tool_call', 'tool_execution_end', 'input', 'agent_end', 'session_before_compact', 'session_shutdown'])
  })
})

describe('hooks extension session_start', () => {
  const homeConfig = {
    SessionStart: [{ matcher: 'startup', hooks: [{ command: 'home-session' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'home-pre' }] }],
  }

  it('runs SessionStart hooks matching the session source with the source in the payload', async () => {
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    await setupExtension().sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    expect(commandsRun()).toEqual(['home-session'])
    expect(JSON.parse(recordFor('home-session').stdin)).toEqual({ hook_event_name: 'SessionStart', source: 'startup' })
  })

  it('does not run SessionStart hooks whose matcher misses the session source', async () => {
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    await setupExtension().sessionStart('resume', { cwd: tempDir('hooks-proj-') })
    expect(commandsRun()).toEqual([])
  })

  it('skips SessionStart hooks on a reload but still loads the config', async () => {
    writeSettings(hoisted.home, 'settings.json', { ...homeConfig, SessionStart: [{ matcher: 'reload', hooks: [{ command: 'home-session' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('reload', { cwd: tempDir('hooks-proj-') })
    expect(commandsRun()).toEqual([])
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-pre'])
  })

  it('fires SessionStart hooks on a fork with source fork, as Claude does', async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ matcher: 'fork', hooks: [{ command: 'home-session' }] }] })
    await setupExtension().sessionStart('fork', { cwd: tempDir('hooks-proj-') })
    expect(commandsRun()).toEqual(['home-session'])
    expect(JSON.parse(recordFor('home-session').stdin)).toEqual({ hook_event_name: 'SessionStart', source: 'fork' })
  })

  it("maps pi's new-session start onto Claude's clear source", async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ matcher: 'clear', hooks: [{ command: 'home-session' }] }] })
    await setupExtension().sessionStart('new', { cwd: tempDir('hooks-proj-') })
    expect(commandsRun()).toEqual(['home-session'])
    expect(JSON.parse(recordFor('home-session').stdin)).toEqual({ hook_event_name: 'SessionStart', source: 'clear' })
  })

  it('exposes CLAUDE_PROJECT_DIR to hook commands', async () => {
    // Claude's documented pattern is "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh".
    const project = tempDir('hooks-proj-')
    writeSettings(hoisted.home, 'settings.json', homeConfig)

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project })
    await ext.toolCall('bash', {})

    const options = recordFor('home-pre').options as { env?: Record<string, string> }
    expect(options.env?.CLAUDE_PROJECT_DIR).toBe(project)
    expect(options.env?.PATH).toBeDefined()
  })

  it('loads project settings after user settings when the project is trusted', async () => {
    const project = tempDir('hooks-proj-')
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    writeSettings(project, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'project-pre' }] }] })
    writeSettings(project, 'settings.local.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'local-pre' }] }] })

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project, isProjectTrusted: () => true, hasUI: true, ui: { confirm: async () => true } })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-session', 'home-pre', 'project-pre', 'local-pre'])
  })

  it('ignores project settings when the approval prompt is declined', async () => {
    const project = tempDir('hooks-proj-')
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    writeSettings(project, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'project-pre' }] }] })

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project, isProjectTrusted: () => true, hasUI: true, ui: { confirm: async () => false } })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-session', 'home-pre'])
  })

  it('ignores project settings when the project is untrusted', async () => {
    const project = tempDir('hooks-proj-')
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    writeSettings(project, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'project-pre' }] }] })

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project, isProjectTrusted: () => false })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-session', 'home-pre'])
  })

  it('treats a host without isProjectTrusted as untrusted', async () => {
    const project = tempDir('hooks-proj-')
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    writeSettings(project, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'project-pre' }] }] })

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-session', 'home-pre'])
  })

  it('replaces the previous config rather than accumulating on a second session_start', async () => {
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    const ext = setupExtension()
    const project = tempDir('hooks-proj-')
    await ext.sessionStart('startup', { cwd: project })
    await ext.sessionStart('startup', { cwd: project })
    hoisted.calls.length = 0
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-pre'])
  })

  it('runs every matching SessionStart hook concurrently', async () => {
    writeSettings(hoisted.home, 'settings.json', {
      SessionStart: [{ matcher: 'startup', hooks: [{ command: 'sess-a' }, { command: 'sess-b' }] }],
    })
    script('sess-a', { hang: true })
    script('sess-b', { hang: true })

    const pending = setupExtension().sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await Promise.resolve()
    expect(commandsRun()).toEqual(['sess-a', 'sess-b'])
    for (const child of hoisted.live) child.emit('close', 0)
    await expect(pending).resolves.toBeUndefined()
  })
})

describe('hooks extension tool_call', () => {
  const withPreHook = async (behavior: Behavior) => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] })
    script('guard', behavior)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('blocks the tool with the hook stderr as the reason when the hook exits 2', async () => {
    const ext = await withPreHook({ stderr: ['force push is not allowed'], code: 2 })
    expect(await ext.toolCall('bash', { command: 'git push -f' })).toEqual({ block: true, reason: 'force push is not allowed' })
  })

  it('blocks the tool with the deny reason from hookSpecificOutput', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'secrets file' } })], code: 0 })
    expect(await ext.toolCall('bash', { command: 'cat .env' })).toEqual({ block: true, reason: 'secrets file' })
  })

  it('returns undefined so the tool proceeds when the hook allows it', async () => {
    const ext = await withPreHook({ code: 0 })
    expect(await ext.toolCall('bash', { command: 'ls' })).toBeUndefined()
  })

  it('forwards the tool name and input to the hook payload', async () => {
    const ext = await withPreHook({ code: 0 })
    await ext.toolCall('bash', { command: 'ls -la' })
    expect(JSON.parse(recordFor('guard').stdin)).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'ls -la' } })
  })

  it('runs no hook and allows the tool before any session_start has loaded a config', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] })
    expect(await setupExtension().toolCall('bash', {})).toBeUndefined()
    expect(commandsRun()).toEqual([])
  })
})

describe('hooks extension tool_execution_end', () => {
  const withPostHooks = async (hooks: Array<{ command: string }>) => {
    writeSettings(hoisted.home, 'settings.json', { PostToolUse: [{ matcher: 'Bash', hooks }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('runs PostToolUse hooks with the tool name, input and response in the payload', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolCall('bash', { command: 'ls' })
    await ext.toolEnd('bash', false, { result: 'file.txt' })
    expect(commandsRun()).toEqual(['post'])
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'ls' }, tool_response: 'file.txt' })
  })

  it('pairs tool_input with the call it belongs to, not the latest call', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolCall('bash', { command: 'first' }, 'c1')
    await ext.toolCall('bash', { command: 'second' }, 'c2')
    await ext.toolEnd('bash', false, { toolCallId: 'c1', result: 'r1' })
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'first' }, tool_response: 'r1' })
  })

  it('omits tool_input when no matching tool_call was seen', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolEnd('bash', false, { toolCallId: 'never-called', result: 'r' })
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'bash', tool_response: 'r' })
  })

  it('skips PostToolUse hooks when the tool execution failed', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolEnd('bash', true)
    expect(commandsRun()).toEqual([])
  })

  it('skips PostToolUse hooks whose matcher misses the tool', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolEnd('edit')
    expect(commandsRun()).toEqual([])
  })

  it('does not block on a PostToolUse hook that exits 2', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    script('post', { stderr: ['angry'], code: 2 })
    await expect(ext.toolEnd('bash')).resolves.toBeUndefined()
  })

  it('starts every matching PostToolUse hook before waiting on any of them', async () => {
    const ext = await withPostHooks([{ command: 'post-a' }, { command: 'post-b' }])
    script('post-a', { hang: true })
    script('post-b', { hang: true })

    const pending = ext.toolEnd('bash')
    await Promise.resolve()
    expect(commandsRun()).toEqual(['post-a', 'post-b'])
    for (const child of hoisted.live) child.emit('close', 0)
    await expect(pending).resolves.toBeUndefined()
  })
})

describe('hooks extension UserPromptSubmit', () => {
  const withPromptHooks = async (hooks: Array<{ command: string }>) => {
    writeSettings(hoisted.home, 'settings.json', { UserPromptSubmit: [{ hooks }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('continues an ordinary prompt, passing it in the payload', async () => {
    const ext = await withPromptHooks([{ command: 'audit' }])
    expect(await ext.input('ship it')).toEqual({ action: 'continue' })
    expect(JSON.parse(recordFor('audit').stdin)).toEqual({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
  })

  it('does not run on extension-injected input', async () => {
    const ext = await withPromptHooks([{ command: 'audit' }])
    expect(await ext.input('injected', 'extension')).toEqual({ action: 'continue' })
    expect(commandsRun()).toEqual([])
  })

  it('injects a hook additionalContext ahead of the prompt via transform', async () => {
    const ext = await withPromptHooks([{ command: 'ctx' }])
    script('ctx', { stdout: [JSON.stringify({ hookSpecificOutput: { additionalContext: 'repo is frozen' } })] })
    expect(await ext.input('deploy')).toEqual({ action: 'transform', text: 'repo is frozen\n\ndeploy' })
  })

  it('injects plain stdout as context', async () => {
    const ext = await withPromptHooks([{ command: 'ctx' }])
    script('ctx', { stdout: ['remember the changelog'] })
    expect(await ext.input('deploy')).toEqual({ action: 'transform', text: 'remember the changelog\n\ndeploy' })
  })

  it('blocks a prompt a hook denies and surfaces the reason', async () => {
    const ext = await withPromptHooks([{ command: 'guard' }])
    script('guard', { stderr: ['no secrets in prompts'], code: 2 })
    expect(await ext.input('here is my api key')).toEqual({ action: 'handled' })
    expect(ext.notes.at(-1)).toEqual({ msg: 'no secrets in prompts', level: 'error' })
  })
})

describe('hooks extension notify-style events', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('runs Stop hooks on agent end', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'stopped' }] }] })
    await ext.agentEnd()
    expect(commandsRun()).toEqual(['stopped'])
    expect(JSON.parse(recordFor('stopped').stdin)).toEqual({ hook_event_name: 'Stop' })
  })

  it('runs PreCompact hooks matching the compaction trigger', async () => {
    const ext = await withHooks({ PreCompact: [{ matcher: 'manual', hooks: [{ command: 'pc' }] }] })
    await ext.beforeCompact('manual')
    expect(commandsRun()).toEqual(['pc'])
    expect(JSON.parse(recordFor('pc').stdin)).toEqual({ hook_event_name: 'PreCompact', trigger: 'manual' })
  })

  it('does not run PreCompact hooks whose matcher misses the trigger', async () => {
    const ext = await withHooks({ PreCompact: [{ matcher: 'manual', hooks: [{ command: 'pc' }] }] })
    await ext.beforeCompact('threshold')
    expect(commandsRun()).toEqual([])
  })

  it("maps pi's threshold/overflow compaction onto Claude's auto trigger", async () => {
    const ext = await withHooks({ PreCompact: [{ matcher: 'auto', hooks: [{ command: 'pc' }] }] })
    await ext.beforeCompact('threshold')
    expect(commandsRun()).toEqual(['pc'])
    expect(JSON.parse(recordFor('pc').stdin)).toEqual({ hook_event_name: 'PreCompact', trigger: 'auto' })
  })

  it("runs SessionEnd hooks with the Claude spelling of pi's shutdown reason", async () => {
    const ext = await withHooks({ SessionEnd: [{ matcher: 'prompt_input_exit', hooks: [{ command: 'bye' }] }] })
    await ext.shutdown('quit')
    expect(commandsRun()).toEqual(['bye'])
    expect(JSON.parse(recordFor('bye').stdin)).toEqual({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
  })

  it("still fires a SessionEnd matcher written against pi's raw reason", async () => {
    const ext = await withHooks({ SessionEnd: [{ matcher: 'quit', hooks: [{ command: 'bye' }] }] })
    await ext.shutdown('quit')
    expect(commandsRun()).toEqual(['bye'])
  })
})

describe('hooks MCP tool aliases', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it("fires a Claude mcp__ matcher against pi's server_tool name and reports the Claude name", async () => {
    const ext = await withHooks({ PreToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'guard' }] }] })
    ext.emitMcpTools([{ pi: 'github_create_issue', claude: 'mcp__github__create_issue' }])
    await ext.toolCall('github_create_issue', { title: 't' })
    expect(commandsRun()).toEqual(['guard'])
    expect(JSON.parse(recordFor('guard').stdin)).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__create_issue', tool_input: { title: 't' } })
  })

  it('does not fire the mcp__ matcher when no alias was published', async () => {
    const ext = await withHooks({ PreToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'guard' }] }] })
    await ext.toolCall('github_create_issue', {})
    expect(commandsRun()).toEqual([])
  })

  it('reports the Claude name in PostToolUse payloads for aliased tools', async () => {
    const ext = await withHooks({ PostToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'post' }] }] })
    ext.emitMcpTools([{ pi: 'github_create_issue', claude: 'mcp__github__create_issue' }])
    await ext.toolCall('github_create_issue', { title: 't' })
    await ext.toolEnd('github_create_issue', false, { result: 'ok' })
    expect(commandsRun()).toEqual(['post'])
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue', tool_input: { title: 't' }, tool_response: 'ok' })
  })

  it('ignores a malformed alias payload from the bus', async () => {
    const ext = await withHooks({ PreToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'guard' }] }] })
    ext.emitMcpTools([{ pi: 'github_create_issue' }])
    ext.emitMcpTools('junk')
    await ext.toolCall('github_create_issue', {})
    expect(commandsRun()).toEqual([])
  })
})
