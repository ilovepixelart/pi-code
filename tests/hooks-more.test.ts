import type { EventEmitter as Emitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import contextImports from '../extensions/context-imports.ts'
import hooksExtension, { type HookRunner, interpretHookResult, loadHooks, matchingCommands, runHookCommand, runPreToolUse, runUserPromptSubmit } from '../extensions/hooks.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import { setCompleteBackend } from '../extensions/internal/model-complete.ts'

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

let savedAgentDir: string | undefined
beforeEach(() => {
  // getAgentDir() lives in the SDK, so mocking node:os here does not reach it: without
  // this the suite writes trust decisions into the developer's real ~/.pi/agent.
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'agentdir-'))

  hoisted.calls.length = 0
  hoisted.live.length = 0
  hoisted.behaviors.clear()
  hoisted.home = tempDir('hooks-home-')
})

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir

  // Release any child scripted to hang so its pending promise never leaks into the next test.
  for (const child of hoisted.live.splice(0)) child.emit('close', 0)
  vi.useRealTimers()
  vi.restoreAllMocks()
  setCompleteBackend(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Handler = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>

/** The common Claude payload fields every hook receives, as produced by defaultCtx. */
const COMMON = { session_id: 'sess-1', transcript_path: '/tmp/sess-1.jsonl', cwd: '/proj', effort: { level: 'high' }, permission_mode: 'default' }

/** Register the extension against a stub API and expose its three lifecycle handlers. */
const setupExtension = () => {
  const handlers = new Map<string, Handler>()
  const busHandlers = new Map<string, (data: unknown) => void>()
  const sent: Array<{ message: unknown; options: unknown }> = []
  hooksExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    events: { on: (channel: string, fn: (data: unknown) => void) => busHandlers.set(channel, fn), emit: () => {} },
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  } as never)
  const handler = (name: string): Handler => {
    const found = handlers.get(name)
    if (!found) throw new Error(`hooks extension did not register ${name}`)
    return found
  }
  const notes: Array<{ msg: string; level: string }> = []
  const defaultCtx = {
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
    cwd: '/proj',
    thinkingLevel: 'high',
    sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/tmp/sess-1.jsonl' },
  }
  return {
    registered: [...handlers.keys()],
    notes,
    sent,
    sessionStart: (reason: string, ctx: Record<string, unknown>) => handler('session_start')({ reason }, { ...defaultCtx, ...ctx }),
    toolCall: (toolName: string, input: unknown, toolCallId = 't1', ctxOverride: Record<string, unknown> = {}) => handler('tool_call')({ toolName, input, toolCallId }, { ...defaultCtx, ...ctxOverride }),
    toolResult: (toolName: string, opts: { input?: unknown; content?: unknown[]; details?: unknown; isError?: boolean } = {}) =>
      handler('tool_result')({ type: 'tool_result', toolCallId: 't1', toolName, input: opts.input ?? {}, content: opts.content ?? [], details: opts.details, isError: opts.isError ?? false }, defaultCtx),
    input: (text: string, source = 'interactive') => handler('input')({ text, source }, defaultCtx),
    agentEnd: (messages: unknown[] = []) => handler('agent_end')({ messages }, defaultCtx),
    beforeCompact: (reason: string) => handler('session_before_compact')({ reason }, defaultCtx),
    compacted: (reason: string) => handler('session_compact')({ reason }, defaultCtx),
    shutdown: (reason: string) => handler('session_shutdown')({ reason }, defaultCtx),
    beforeAgentStart: (event: Record<string, unknown> = { systemPrompt: '' }) => handler('before_agent_start')(event),
    emitMcpTools: (entries: unknown) => busHandlers.get('pi-code:mcp-tools')?.(entries),
    emitPlanMode: (state: unknown) => busHandlers.get('pi-code:plan-mode')?.(state),
    emitSubagent: (event: unknown) => busHandlers.get('pi-code:subagent')?.(event),
    emitInstruction: (event: unknown) => busHandlers.get('pi-code:instructions')?.(event),
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

  it('marks a run whose process fails to spawn instead of reporting a clean allow', async () => {
    script('missing', { error: new Error('spawn /bin/sh ENOENT') })
    expect(await runHookCommand('missing', {}, 5000)).toEqual({ code: 0, stdout: '', stderr: 'spawn /bin/sh ENOENT', timedOut: false, spawnFailed: true })
  })

  it('keeps output already received when the process then errors', async () => {
    script('half', { stdout: ['partial'], error: new Error('EIO') })
    expect(await runHookCommand('half', {}, 5000)).toEqual({ code: 0, stdout: 'partial', stderr: 'EIO', timedOut: false, spawnFailed: true })
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
  it('runs command, prompt, and agent hooks but skips entries missing their required fields', async () => {
    // prompt and agent hooks run with their prompt mirrored into `command`; an agent
    // hook with no prompt, or an mcp_tool hook missing its tool, is dropped.
    const seen: string[] = []
    const runner: HookRunner = async (command) => {
      seen.push(command.command)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const config = {
      PreToolUse: [
        {
          hooks: [{ type: 'prompt', prompt: 'judge this' } as never, { command: 'real-hook' }, { type: 'agent', prompt: 'verify this' } as never, { type: 'agent' } as never, { type: 'mcp_tool', server: 'x' } as never, { type: 'command', command: 'typed-hook' }],
        },
      ],
    }
    const decision = await runPreToolUse(config, 'bash', {}, runner)
    expect(decision).toEqual({ block: false })
    // 'verify this' is the agent hook's mirrored identity; the promptless agent and
    // the fieldless mcp_tool hooks are absent.
    expect(seen).toEqual(['judge this', 'real-hook', 'verify this', 'typed-hook'])
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
  it('returns the first blocking verdict; every hook still runs (parallel launch)', async () => {
    const run: string[] = []
    const runner: HookRunner = async (command) => {
      run.push(command.command)
      return command.command === 'second' ? { code: 2, stdout: '', stderr: 'denied by second', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const config = { PreToolUse: [{ hooks: [{ command: 'first' }, { command: 'second' }, { command: 'third' }] }] }
    expect(await runPreToolUse(config, 'bash', {}, runner)).toEqual({ block: true, reason: 'denied by second' })
    expect(run).toEqual(['first', 'second', 'third'])
  })

  it('allows the tool when every matching hook passes', async () => {
    const run: string[] = []
    const runner: HookRunner = async (command) => {
      run.push(command.command)
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

describe('runPreToolUse updatedInput', () => {
  const config = { PreToolUse: [{ hooks: [{ command: 'rewrite' }] }] }

  it('replaces the entire tool input in place before the tool runs', async () => {
    const input = { command: 'rm -rf /', timeout: 5 }
    const runner: HookRunner = async () => ({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'echo safe' } } }), stderr: '', timedOut: false })
    expect(await runPreToolUse(config, 'bash', input, runner)).toEqual({ block: false })
    // Claude documents updatedInput as replacing the whole tool_input: timeout is dropped.
    expect(input).toEqual({ command: 'echo safe' })
  })

  it('applies updatedInput even when the same hook denies', async () => {
    const input = { command: 'x' }
    const runner: HookRunner = async () => ({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no', updatedInput: { command: 'y' } } }), stderr: '', timedOut: false })
    expect(await runPreToolUse(config, 'bash', input, runner)).toEqual({ block: true, reason: 'no' })
    expect(input).toEqual({ command: 'y' })
  })

  it('ignores a non-object updatedInput', async () => {
    const input = { command: 'x' }
    const runner: HookRunner = async () => ({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: 'junk' } }), stderr: '', timedOut: false })
    await runPreToolUse(config, 'bash', input, runner)
    expect(input).toEqual({ command: 'x' })
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

describe('malformed hook config', () => {
  it('skips an entry whose hooks is not a list, keeping the rest of the event usable', () => {
    const dir = tempDir('hooks-cfg-')
    const file = join(dir, 'settings.json')
    // A plausible hand-edit: one entry as an object instead of a one-element list.
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: { type: 'command', command: 'bad' } },
            { matcher: 'Edit', hooks: [{ command: 'good' }] },
          ],
        },
      }),
    )

    const config = loadHooks([file])
    expect(config.PreToolUse).toHaveLength(1)
    // The whole session used to fail every tool call on this; now it costs one entry.
    expect(() => matchingCommands(config.PreToolUse, 'bash')).not.toThrow()
    expect(matchingCommands(config.PreToolUse, 'edit')).toEqual([{ command: 'good' }])
  })

  it('survives a settings file that is bare null, or a non-string matcher', () => {
    const dir = tempDir('hooks-cfg-')
    const nullFile = join(dir, 'null.json')
    writeFileSync(nullFile, 'null')
    expect(loadHooks([nullFile])).toEqual({})

    const badMatcher = join(dir, 'matcher.json')
    writeFileSync(badMatcher, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 42, hooks: [{ command: 'x' }] }] } }))
    expect(loadHooks([badMatcher]).PreToolUse ?? []).toEqual([])
  })
})

describe('hooks extension registration', () => {
  it('subscribes to the lifecycle events it bridges', () => {
    expect(setupExtension().registered).toEqual(['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'input', 'agent_end', 'session_before_compact', 'session_compact', 'session_shutdown'])
  })
})

describe('hooks extension session_start', () => {
  const homeConfig = {
    SessionStart: [{ matcher: 'startup', hooks: [{ command: 'home-session' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'home-pre' }] }],
  }

  it('runs SessionStart hooks matching the session source with the source in the payload', async () => {
    writeSettings(hoisted.home, 'settings.json', homeConfig)
    const proj = tempDir('hooks-proj-')
    await setupExtension().sessionStart('startup', { cwd: proj })
    expect(commandsRun()).toEqual(['home-session'])
    expect(JSON.parse(recordFor('home-session').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' })
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
    const proj = tempDir('hooks-proj-')
    await setupExtension().sessionStart('fork', { cwd: proj })
    expect(commandsRun()).toEqual(['home-session'])
    expect(JSON.parse(recordFor('home-session').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SessionStart', source: 'fork' })
  })

  it('injects SessionStart hook stdout as context on the next agent start, once', async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ hooks: [{ command: 'ctx-hook' }] }] })
    script('ctx-hook', { stdout: ['Remember the deploy freeze'], code: 0 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await expect(ext.beforeAgentStart()).resolves.toEqual({
      message: { customType: 'claude-hook-context', content: 'Remember the deploy freeze', display: false },
    })
    await expect(ext.beforeAgentStart()).resolves.toBeUndefined()
  })

  it('prefers hookSpecificOutput.additionalContext over raw stdout and joins multiple hooks', async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ hooks: [{ command: 'json-ctx' }, { command: 'plain-ctx' }] }] })
    script('json-ctx', { stdout: [JSON.stringify({ hookSpecificOutput: { additionalContext: 'from-json' } })], code: 0 })
    script('plain-ctx', { stdout: ['from-stdout'], code: 0 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await expect(ext.beforeAgentStart()).resolves.toEqual({
      message: { customType: 'claude-hook-context', content: 'from-json\nfrom-stdout', display: false },
    })
  })

  it('injects nothing when SessionStart hooks produce no context', async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ hooks: [{ command: 'silent' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await expect(ext.beforeAgentStart()).resolves.toBeUndefined()
  })

  it("maps pi's new-session start onto Claude's clear source", async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ matcher: 'clear', hooks: [{ command: 'home-session' }] }] })
    const proj = tempDir('hooks-proj-')
    await setupExtension().sessionStart('new', { cwd: proj })
    expect(commandsRun()).toEqual(['home-session'])
    expect(JSON.parse(recordFor('home-session').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SessionStart', source: 'clear' })
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

  it('runs a PreToolUse prompt hook through the model and blocks on its deny decision', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Should this run? $ARGUMENTS' }] }] })
    setCompleteBackend(async () => ({ role: 'assistant', content: [{ type: 'text', text: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"looks risky"}}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 }) as never)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const decision = await ext.toolCall('bash', { command: 'rm -rf /' }, 't1', { model: {} })
    expect(decision).toEqual({ block: true, reason: 'looks risky' })
  })

  it('lets the tool through when a prompt hook allows and there is no command hook to run', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'ok? $ARGUMENTS' }] }] })
    setCompleteBackend(async () => ({ role: 'assistant', content: [{ type: 'text', text: '{"hookSpecificOutput":{"permissionDecision":"allow"}}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 }) as never)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    expect(await ext.toolCall('bash', { command: 'ls' }, 't1', { model: {} })).toBeUndefined()
    expect(commandsRun()).toEqual([]) // the prompt hook did not shell out
  })

  it('blocks the tool with the deny reason from hookSpecificOutput', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'secrets file' } })], code: 0 })
    expect(await ext.toolCall('bash', { command: 'cat .env' })).toEqual({ block: true, reason: 'secrets file' })
  })

  it('returns undefined so the tool proceeds when the hook allows it', async () => {
    const ext = await withPreHook({ code: 0 })
    expect(await ext.toolCall('bash', { command: 'ls' })).toBeUndefined()
  })

  it('prompts the user on permissionDecision ask, letting the call through when approved', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm this' } })], code: 0 })
    const ui = { notify: () => {}, confirm: async () => true }
    expect(await ext.toolCall('bash', { command: 'rm x' }, 't1', { hasUI: true, ui })).toBeUndefined()
  })

  it('blocks on permissionDecision ask when the user declines the prompt', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm this' } })], code: 0 })
    const ui = { notify: () => {}, confirm: async () => false }
    expect(await ext.toolCall('bash', { command: 'rm x' }, 't1', { hasUI: true, ui })).toEqual({ block: true, reason: 'confirm this' })
  })

  it('blocks on permissionDecision ask with no UI to prompt (headless fallback)', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm this' } })], code: 0 })
    expect(await ext.toolCall('bash', { command: 'rm x' })).toEqual({ block: true, reason: 'confirm this' })
  })

  it('forwards the tool name and input to the hook payload', async () => {
    const ext = await withPreHook({ code: 0 })
    await ext.toolCall('bash', { command: 'ls -la' })
    expect(JSON.parse(recordFor('guard').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'ls -la' }, tool_use_id: 't1' })
  })

  it('runs no hook and allows the tool before any session_start has loaded a config', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] })
    expect(await setupExtension().toolCall('bash', {})).toBeUndefined()
    expect(commandsRun()).toEqual([])
  })
})

describe('hooks extension tool_result (PostToolUse)', () => {
  const withPostHooks = async (hooks: Array<{ command: string }>) => {
    writeSettings(hoisted.home, 'settings.json', { PostToolUse: [{ matcher: 'Bash', hooks }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }
  const okText = [{ type: 'text', text: 'file.txt' }]

  it('runs PostToolUse hooks with the tool name, input and response in the payload', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolResult('bash', { input: { command: 'ls' }, content: okText })
    expect(commandsRun()).toEqual(['post'])
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'ls' }, tool_use_id: 't1', tool_response: { content: okText, isError: false } })
  })

  it('returns no patch when every hook stays silent', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await expect(ext.toolResult('bash', { content: okText })).resolves.toBeUndefined()
  })

  it('appends an exit-2 hook stderr to the tool result as feedback', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    script('post', { stderr: ['angry'], code: 2 })
    await expect(ext.toolResult('bash', { content: okText })).resolves.toEqual({
      content: [...okText, { type: 'text', text: 'PostToolUse hook: angry' }],
    })
  })

  it('appends a decision-block reason and additionalContext to the tool result', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    script('post', { stdout: [JSON.stringify({ decision: 'block', reason: 'lint failed', hookSpecificOutput: { additionalContext: 'run npm lint' } })], code: 0 })
    await expect(ext.toolResult('bash', { content: okText })).resolves.toEqual({
      content: [...okText, { type: 'text', text: 'PostToolUse hook: lint failed' }, { type: 'text', text: 'run npm lint' }],
    })
  })

  it('skips PostToolUse hooks when the tool execution failed', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolResult('bash', { isError: true })
    expect(commandsRun()).toEqual([])
  })

  it('runs PostToolUseFailure hooks on a failed execution with the failure in the payload', async () => {
    writeSettings(hoisted.home, 'settings.json', { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ command: 'failed' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('bash', { input: { command: 'x' }, content: [{ type: 'text', text: 'boom' }], isError: true })
    expect(commandsRun()).toEqual(['failed'])
    expect(JSON.parse(recordFor('failed').stdin)).toEqual({ ...COMMON, hook_event_name: 'PostToolUseFailure', tool_name: 'bash', tool_input: { command: 'x' }, tool_use_id: 't1', tool_response: { content: [{ type: 'text', text: 'boom' }], isError: true } })
  })

  it('does not run PostToolUseFailure hooks on a successful execution', async () => {
    writeSettings(hoisted.home, 'settings.json', { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ command: 'failed' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('bash', { content: okText })
    expect(commandsRun()).toEqual([])
  })

  it('appends a PostToolUseFailure hook additionalContext to the failed result for the model', async () => {
    // Claude shows the failure hook's output to the model even though the tool failed.
    writeSettings(hoisted.home, 'settings.json', { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ command: 'diag' }] }] })
    script('diag', { stdout: [JSON.stringify({ hookSpecificOutput: { additionalContext: 'the network was down' } })], code: 0 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const patched = (await ext.toolResult('bash', { input: { command: 'x' }, content: [{ type: 'text', text: 'boom' }], isError: true })) as { content: Array<{ text: string }> } | undefined
    expect(patched?.content.map((c) => c.text)).toEqual(['boom', 'the network was down'])
  })

  it('appends a PostToolUseFailure hook stderr (exit 2) to the failed result', async () => {
    writeSettings(hoisted.home, 'settings.json', { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ command: 'diag' }] }] })
    script('diag', { stderr: ['check your credentials'], code: 2 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const patched = (await ext.toolResult('bash', { content: [{ type: 'text', text: 'boom' }], isError: true })) as { content: Array<{ text: string }> } | undefined
    expect(patched?.content.at(-1)?.text).toBe('PostToolUseFailure hook: check your credentials')
  })

  it('skips PostToolUse hooks whose matcher misses the tool', async () => {
    const ext = await withPostHooks([{ command: 'post' }])
    await ext.toolResult('edit')
    expect(commandsRun()).toEqual([])
  })

  it('starts every matching PostToolUse hook before waiting on any of them', async () => {
    const ext = await withPostHooks([{ command: 'post-a' }, { command: 'post-b' }])
    script('post-a', { hang: true })
    script('post-b', { hang: true })

    const pending = ext.toolResult('bash')
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
    expect(JSON.parse(recordFor('audit').stdin)).toEqual({ ...COMMON, hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
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

  it('runs an enabled plugin hook with its plugin root substituted', async () => {
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'fmt', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { fmt: true } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('write', { input: { path: 'a.ts' } })

    expect(commandsRun()).toEqual([`${root}/scripts/format.sh`])
  })

  it('bridges Notification hooks for idle_prompt on agent end, matcher-filtered', async () => {
    // The one notification pi can honestly source today: the agent finished and
    // is waiting for input. Observational only, like Claude documents.
    const ext = await withHooks({
      Notification: [
        { matcher: 'idle_prompt', hooks: [{ command: 'notify-idle' }] },
        { matcher: 'permission_prompt', hooks: [{ command: 'notify-perm' }] },
      ],
    })
    await ext.agentEnd()

    expect(commandsRun()).toEqual(['notify-idle'])
    const stdin = JSON.parse(recordFor('notify-idle').stdin)
    expect(stdin.hook_event_name).toBe('Notification')
    expect(stdin.notification_type).toBe('idle_prompt')
    expect(typeof stdin.message).toBe('string')
  })

  it('runs Stop hooks on agent end with stop_hook_active false', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'stopped' }] }] })
    await ext.agentEnd()
    expect(commandsRun()).toEqual(['stopped'])
    expect(JSON.parse(recordFor('stopped').stdin)).toEqual({ ...COMMON, hook_event_name: 'Stop', stop_hook_active: false })
    expect(ext.sent).toEqual([])
  })

  it('includes the final assistant text as last_assistant_message on Stop', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'stopped' }] }] })
    await ext.agentEnd([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
    ])
    expect(JSON.parse(recordFor('stopped').stdin).last_assistant_message).toBe('all done')
  })

  it('continues the conversation when a Stop hook blocks, with the reason', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
    script('keep-going', { stdout: [JSON.stringify({ decision: 'block', reason: 'tests are still red' })], code: 0 })
    await ext.agentEnd()
    expect(ext.sent).toEqual([{ message: { customType: 'claude-stop-hook', content: 'tests are still red', display: true }, options: { triggerTurn: true } }])
  })

  it('reports stop_hook_active true while continuing from a stop hook, then resets', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
    script('keep-going', { stderr: ['not done'], code: 2 })
    await ext.agentEnd()
    expect(ext.sent).toHaveLength(1)

    script('keep-going', { code: 0, stderr: [] })
    await ext.agentEnd()
    const second = hoisted.calls.filter((call) => call.command === 'keep-going')[1]
    expect(JSON.parse(second.stdin)).toEqual({ ...COMMON, hook_event_name: 'Stop', stop_hook_active: true })
    expect(ext.sent).toHaveLength(1)

    await ext.agentEnd()
    const third = hoisted.calls.filter((call) => call.command === 'keep-going')[2]
    expect(JSON.parse(third.stdin)).toEqual({ ...COMMON, hook_event_name: 'Stop', stop_hook_active: false })
  })

  it('surfaces a systemMessage from any hook as a user warning', async () => {
    const warn = JSON.stringify({ systemMessage: 'heads up' })
    const ext = await withHooks({
      PreToolUse: [{ hooks: [{ command: 'pre' }] }],
      PostToolUse: [{ hooks: [{ command: 'post' }] }],
      UserPromptSubmit: [{ hooks: [{ command: 'prompt' }] }],
      Stop: [{ hooks: [{ command: 'stop' }] }],
      PreCompact: [{ hooks: [{ command: 'compact' }] }],
    })
    for (const name of ['pre', 'post', 'prompt', 'stop', 'compact']) script(name, { stdout: [warn], code: 0 })

    await ext.toolCall('bash', {})
    await ext.toolResult('bash')
    await ext.input('hello')
    await ext.agentEnd()
    await ext.beforeCompact('manual')
    expect(ext.notes).toEqual(Array(5).fill({ msg: 'heads up', level: 'warning' }))
  })

  it('surfaces a SessionStart systemMessage without treating it as context', async () => {
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ hooks: [{ command: 'greet' }] }] })
    script('greet', { stdout: [JSON.stringify({ systemMessage: 'welcome' })], code: 0 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    expect(ext.notes).toEqual([{ msg: 'welcome', level: 'warning' }])
    await expect(ext.beforeAgentStart()).resolves.toBeUndefined()
  })

  it('does not treat a timed-out Stop hook as a block', async () => {
    const ext = await withHooks({ Stop: [{ matcher: undefined, hooks: [{ command: 'hung', timeout: 1 }] }] })
    script('hung', { hang: true })
    vi.useFakeTimers()
    const pending = ext.agentEnd()
    await vi.advanceTimersByTimeAsync(1500)
    await pending
    expect(ext.sent).toEqual([])
  })

  it('runs PreCompact hooks matching the compaction trigger', async () => {
    const ext = await withHooks({ PreCompact: [{ matcher: 'manual', hooks: [{ command: 'pc' }] }] })
    await ext.beforeCompact('manual')
    expect(commandsRun()).toEqual(['pc'])
    expect(JSON.parse(recordFor('pc').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreCompact', trigger: 'manual' })
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
    expect(JSON.parse(recordFor('pc').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreCompact', trigger: 'auto' })
  })

  it('runs PostCompact hooks after compaction with the Claude trigger', async () => {
    const ext = await withHooks({ PostCompact: [{ matcher: 'auto', hooks: [{ command: 'pc-post' }] }] })
    await ext.compacted('threshold')
    expect(commandsRun()).toEqual(['pc-post'])
    expect(JSON.parse(recordFor('pc-post').stdin)).toEqual({ ...COMMON, hook_event_name: 'PostCompact', trigger: 'auto' })
  })

  it('does not run PostCompact hooks whose matcher misses the trigger', async () => {
    const ext = await withHooks({ PostCompact: [{ matcher: 'manual', hooks: [{ command: 'pc-post' }] }] })
    await ext.compacted('overflow')
    expect(commandsRun()).toEqual([])
  })

  it("runs SessionEnd hooks with the Claude spelling of pi's shutdown reason", async () => {
    const ext = await withHooks({ SessionEnd: [{ matcher: 'prompt_input_exit', hooks: [{ command: 'bye' }] }] })
    await ext.shutdown('quit')
    expect(commandsRun()).toEqual(['bye'])
    expect(JSON.parse(recordFor('bye').stdin)).toEqual({ ...COMMON, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
  })

  it("still fires a SessionEnd matcher written against pi's raw reason", async () => {
    const ext = await withHooks({ SessionEnd: [{ matcher: 'quit', hooks: [{ command: 'bye' }] }] })
    await ext.shutdown('quit')
    expect(commandsRun()).toEqual(['bye'])
  })
})

describe('hooks subagent lifecycle', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    const proj = tempDir('hooks-proj-')
    await ext.sessionStart('startup', { cwd: proj })
    return { ext, proj }
  }

  it('runs SubagentStart hooks matching the agent type', async () => {
    const { ext, proj } = await withHooks({ SubagentStart: [{ matcher: 'scout', hooks: [{ command: 'sub-start' }] }] })
    await ext.emitSubagent({ phase: 'start', agentType: 'scout', agentId: 'fg-abc' })
    expect(commandsRun()).toEqual(['sub-start'])
    expect(JSON.parse(recordFor('sub-start').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SubagentStart', agent_type: 'scout', agent_id: 'fg-abc' })
  })

  it('runs SubagentStop hooks when the child run completes', async () => {
    const { ext, proj } = await withHooks({ SubagentStop: [{ matcher: 'scout', hooks: [{ command: 'sub-stop' }] }] })
    await ext.emitSubagent({ phase: 'stop', agentType: 'scout', agentId: 'bg-1234' })
    expect(commandsRun()).toEqual(['sub-stop'])
    expect(JSON.parse(recordFor('sub-stop').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SubagentStop', agent_type: 'scout', agent_id: 'bg-1234' })
  })

  it('does not run subagent hooks whose matcher misses the agent type', async () => {
    const { ext } = await withHooks({ SubagentStart: [{ matcher: 'reviewer', hooks: [{ command: 'sub-start' }] }] })
    await ext.emitSubagent({ phase: 'start', agentType: 'scout', agentId: 'fg-abc' })
    expect(commandsRun()).toEqual([])
  })
})

describe('hooks InstructionsLoaded', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    const proj = tempDir('hooks-proj-')
    await ext.sessionStart('startup', { cwd: proj })
    return { ext, proj }
  }

  const startEvent = (proj: string, files: Array<{ path: string; content: string }>) => ({ systemPrompt: '', systemPromptOptions: { cwd: proj, contextFiles: files } })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('bridges a session_start event from the bus with the common payload fields', async () => {
    const { ext, proj } = await withHooks({ InstructionsLoaded: [{ matcher: 'session_start', hooks: [{ command: 'il' }] }] })
    const projectFile = join(proj, 'CLAUDE.md')

    await ext.emitInstruction({ file_path: projectFile, memory_type: 'Project', load_reason: 'session_start' })

    expect(commandsRun()).toEqual(['il'])
    expect(JSON.parse(recordFor('il').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'InstructionsLoaded', file_path: projectFile, memory_type: 'Project', load_reason: 'session_start' })
  })

  it('does not announce raw contextFiles itself: exclusion-aware session_start events ride the bus', async () => {
    // claudeMdExcludes lives in context-imports; announcing contextFiles here
    // used to fire for files the exclusion had removed from the prompt.
    const { ext, proj } = await withHooks({ InstructionsLoaded: [{ matcher: 'session_start', hooks: [{ command: 'il' }] }] })

    await ext.beforeAgentStart(startEvent(proj, [{ path: join(proj, 'CLAUDE.md'), content: 'x' }]))

    expect(commandsRun()).toEqual([])
  })

  it('is not told an excluded context file loaded (context-imports integration over the bus)', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(
      join(hoisted.home, '.claude', 'settings.json'),
      JSON.stringify({
        claudeMdExcludes: ['**/vendor/CLAUDE.md'],
        hooks: { InstructionsLoaded: [{ matcher: 'session_start', hooks: [{ command: 'il' }] }] },
      }),
    )
    setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
    try {
      const ext = setupExtension()
      const proj = tempDir('hooks-proj-')
      mkdirSync(join(proj, 'vendor'))
      await ext.sessionStart('startup', { cwd: proj })

      // context-imports on the same bus: its synchronous emits reach the
      // listener hooks registered, regardless of extension order.
      const ciHandlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
      contextImports({
        on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => ciHandlers.set(name, fn),
        events: {
          emit: (channel: string, data: unknown) => {
            if (channel === 'pi-code:instructions') ext.emitInstruction(data)
          },
          on: () => () => {},
        },
      } as never)
      const contextFiles = [
        { path: join(proj, 'CLAUDE.md'), content: 'KEEP' },
        { path: join(proj, 'vendor', 'CLAUDE.md'), content: 'EXCLUDED' },
      ]
      await ciHandlers.get('before_agent_start')?.({ systemPrompt: 'BASE', systemPromptOptions: { cwd: proj, contextFiles } }, {})
      await flush()

      expect(commandsRun()).toEqual(['il'])
      expect(JSON.parse(recordFor('il').stdin).file_path).toBe(join(proj, 'CLAUDE.md'))
    } finally {
      setManagedSettingsPath(undefined)
    }
  })

  it('runs no hook when the matcher misses the load reason', async () => {
    const { ext, proj } = await withHooks({ InstructionsLoaded: [{ matcher: 'path_glob_match', hooks: [{ command: 'lazy' }] }] })

    await ext.emitInstruction({ file_path: join(proj, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' })

    expect(commandsRun()).toEqual([])
  })

  it('bridges a lazy path_glob_match event from the bus with its globs and trigger', async () => {
    const { ext, proj } = await withHooks({ InstructionsLoaded: [{ matcher: 'path_glob_match', hooks: [{ command: 'lazy' }] }] })
    const rule = join(proj, '.claude', 'rules', 'sql.md')

    await ext.emitInstruction({ file_path: rule, memory_type: 'Project', load_reason: 'path_glob_match', globs: ['db/**'], trigger_file_path: join(proj, 'db', 'schema.sql') })

    expect(commandsRun()).toEqual(['lazy'])
    expect(JSON.parse(recordFor('lazy').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'InstructionsLoaded', file_path: rule, memory_type: 'Project', load_reason: 'path_glob_match', globs: ['db/**'], trigger_file_path: join(proj, 'db', 'schema.sql') })
  })

  it('bridges an include event and honors a pipe-list matcher across reasons', async () => {
    const { ext, proj } = await withHooks({ InstructionsLoaded: [{ matcher: 'path_glob_match|include', hooks: [{ command: 'lazy' }] }] })

    await ext.emitInstruction({ file_path: join(proj, 'style.md'), memory_type: 'Project', load_reason: 'include', parent_file_path: join(proj, 'CLAUDE.md') })
    expect(commandsRun()).toEqual(['lazy'])
    expect(JSON.parse(recordFor('lazy').stdin).parent_file_path).toBe(join(proj, 'CLAUDE.md'))

    await ext.emitInstruction({ file_path: join(proj, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' })
    expect(commandsRun()).toEqual(['lazy'])
  })

  it('is observational: exit codes, block decisions and systemMessage output are all ignored', async () => {
    const { ext, proj } = await withHooks({ InstructionsLoaded: [{ hooks: [{ command: 'il' }] }] })
    script('il', { stdout: [JSON.stringify({ systemMessage: 'warn', decision: 'block', continue: false })], stderr: ['angry'], code: 2 })

    await ext.emitInstruction({ file_path: join(proj, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' })
    await flush()

    expect(commandsRun()).toEqual(['il'])
    expect(ext.notes).toEqual([])
    expect(ext.sent).toEqual([])
  })

  it('ignores malformed bus payloads and events arriving before session_start', async () => {
    const valid = { file_path: '/x/CLAUDE.md', memory_type: 'Project', load_reason: 'path_glob_match' }
    writeSettings(hoisted.home, 'settings.json', { InstructionsLoaded: [{ hooks: [{ command: 'lazy' }] }] })
    const fresh = setupExtension()
    await fresh.emitInstruction(valid)
    expect(commandsRun()).toEqual([])

    await fresh.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await fresh.emitInstruction({ file_path: '/x/CLAUDE.md', load_reason: 'path_glob_match' })
    await fresh.emitInstruction('junk')
    expect(commandsRun()).toEqual([])

    await fresh.emitInstruction(valid)
    expect(commandsRun()).toEqual(['lazy'])
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
    expect(JSON.parse(recordFor('guard').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'mcp__github__create_issue', tool_input: { title: 't' }, tool_use_id: 't1' })
  })

  it('does not fire the mcp__ matcher when no alias was published', async () => {
    const ext = await withHooks({ PreToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'guard' }] }] })
    await ext.toolCall('github_create_issue', {})
    expect(commandsRun()).toEqual([])
  })

  it('reports the Claude name in PostToolUse payloads for aliased tools', async () => {
    const ext = await withHooks({ PostToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'post' }] }] })
    ext.emitMcpTools([{ pi: 'github_create_issue', claude: 'mcp__github__create_issue' }])
    await ext.toolResult('github_create_issue', { input: { title: 't' }, content: [{ type: 'text', text: 'ok' }] })
    expect(commandsRun()).toEqual(['post'])
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue', tool_input: { title: 't' }, tool_use_id: 't1', tool_response: { content: [{ type: 'text', text: 'ok' }], isError: false } })
  })

  it('reports permission_mode plan while plan mode is active', async () => {
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'guard' }] }] })
    ext.emitPlanMode({ active: true })
    await ext.toolCall('read', { path: 'a' })
    expect(JSON.parse(recordFor('guard').stdin).permission_mode).toBe('plan')
    hoisted.calls.length = 0
    ext.emitPlanMode({ active: false })
    await ext.toolCall('read', { path: 'a' })
    expect(JSON.parse(recordFor('guard').stdin).permission_mode).toBe('default')
  })

  it('ignores a malformed plan-mode payload from the bus', async () => {
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'guard' }] }] })
    ext.emitPlanMode({ active: 'yes' })
    await ext.toolCall('read', { path: 'a' })
    expect(JSON.parse(recordFor('guard').stdin).permission_mode).toBe('default')
  })

  it('ignores a malformed alias payload from the bus', async () => {
    const ext = await withHooks({ PreToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ command: 'guard' }] }] })
    ext.emitMcpTools([{ pi: 'github_create_issue' }])
    ext.emitMcpTools('junk')
    await ext.toolCall('github_create_issue', {})
    expect(commandsRun()).toEqual([])
  })
})

describe('hook execution parallelism', () => {
  it('launches every matching PreToolUse hook before any completes', async () => {
    // Claude runs matching hooks in parallel; serial execution paid each hook's
    // latency in sequence on every tool call.
    const launched: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner: HookRunner = async (command) => {
      launched.push(command.command)
      await gate
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const two = { PreToolUse: [{ hooks: [{ command: 'slow' }, { command: 'also-slow' }] }] }
    const pending = runPreToolUse(two, 'bash', { a: 1 }, runner)
    expect(launched).toEqual(['slow', 'also-slow'])
    release()
    expect(await pending).toEqual({ block: false })
  })

  it('every parallel hook sees the original tool input; updatedInput still lands', async () => {
    const seen: unknown[] = []
    const runner: HookRunner = async (command, payload) => {
      seen.push(structuredClone((payload as { tool_input: unknown }).tool_input))
      const stdout = command.command === 'first' ? JSON.stringify({ hookSpecificOutput: { updatedInput: { a: 2 } } }) : ''
      return { code: 0, stdout, stderr: '', timedOut: false }
    }
    const two = { PreToolUse: [{ hooks: [{ command: 'first' }, { command: 'second' }] }] }
    const input = { a: 1 }
    await runPreToolUse(two, 'bash', input, runner)
    expect(seen).toEqual([{ a: 1 }, { a: 1 }])
    expect(input).toEqual({ a: 2 })
  })

  it('launches every matching UserPromptSubmit hook before any completes', async () => {
    const launched: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner: HookRunner = async (command) => {
      launched.push(command.command)
      await gate
      return { code: 0, stdout: 'ctx', stderr: '', timedOut: false }
    }
    const two = { UserPromptSubmit: [{ hooks: [{ command: 'one' }, { command: 'two' }] }] }
    const pending = runUserPromptSubmit(two, 'hello', runner)
    expect(launched).toEqual(['one', 'two'])
    release()
    expect((await pending).context).toBe('ctx\nctx')
  })
})

describe('hook spawn failures', () => {
  it('surfaces a spawn failure through the system message sink and proceeds', async () => {
    // Claude shows a hook error notice and the action proceeds; a silent code-0
    // meant a deny-list guard that never ran read as a clean allow.
    const runner: HookRunner = async () => ({ code: 0, stdout: '', stderr: 'spawn /bin/sh ENOENT', timedOut: false, spawnFailed: true })
    const messages: string[] = []
    const config = { PreToolUse: [{ hooks: [{ command: 'guard.sh' }] }] }
    const decision = await runPreToolUse(config, 'bash', { a: 1 }, runner, undefined, (m) => messages.push(m))
    expect(decision).toEqual({ block: false })
    expect(messages.some((m) => m.includes('guard.sh') && m.includes('ENOENT'))).toBe(true)
  })
})
