import type { EventEmitter as Emitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import contextImports from '../extensions/context-imports.ts'
import hooksExtension, { type HookRunner, interpretHookResult, isBackgroundHook, loadHooks, matchingCommands, runHookCommand, runPreToolUse, runPromptHook, runUserPromptSubmit, sessionEndTimeoutMs, timeoutMs } from '../extensions/hooks/index.ts'
import { setManagedSettingsPath } from '../extensions/internal/managed-settings.ts'
import { setMcpToolCaller } from '../extensions/internal/mcp-call.ts'
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
  /** A pid for the fake child; far above any real pid so a group kill can only fail. */
  pid?: number
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
      if (behavior.pid !== undefined) child.pid = behavior.pid
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
  // Hermetic managed settings: session_start reads disableAllHooks from the managed
  // path, which must never resolve to this machine's real policy file.
  setManagedSettingsPath(join(hoisted.home, 'managed-settings.json'))
})

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  setManagedSettingsPath(undefined)

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
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  hooksExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    events: { on: (channel: string, fn: (data: unknown) => void) => busHandlers.set(channel, fn), emit: () => {} },
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    registerCommand: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
  } as never)
  const handler = (name: string): Handler => {
    const found = handlers.get(name)
    if (!found) throw new Error(`hooks extension did not register ${name}`)
    return found
  }
  const notes: Array<{ msg: string; level: string }> = []
  const defaultCtx = {
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
    // Without this capability the first sessionStart in the file emits the
    // once-per-module runtime-too-old warning into whichever test happens to run
    // first, making every notes[N] index order-dependent under shuffle.
    isProjectTrusted: () => false,
    cwd: '/proj',
    thinkingLevel: 'high',
    sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/tmp/sess-1.jsonl' },
  }
  return {
    registered: [...handlers.keys()],
    commands: [...commands.keys()],
    runCommand: (name: string, args = '') => {
      const spec = commands.get(name)
      if (!spec) throw new Error(`hooks extension did not register /${name}`)
      return spec.handler(args, defaultCtx)
    },
    notes,
    sent,
    sessionStart: (reason: string, ctx: Record<string, unknown>) => handler('session_start')({ reason }, { ...defaultCtx, ...ctx }),
    toolCall: (toolName: string, input: unknown, toolCallId = 't1', ctxOverride: Record<string, unknown> = {}) => handler('tool_call')({ toolName, input, toolCallId }, { ...defaultCtx, ...ctxOverride }),
    toolResult: (toolName: string, opts: { input?: unknown; content?: unknown[]; details?: unknown; isError?: boolean } = {}) =>
      handler('tool_result')({ type: 'tool_result', toolCallId: 't1', toolName, input: opts.input ?? {}, content: opts.content ?? [], details: opts.details, isError: opts.isError ?? false }, defaultCtx),
    userBash: (command: string, ctxOverride: Record<string, unknown> = {}) => handler('user_bash')({ type: 'user_bash', command, excludeFromContext: false, cwd: '/proj' }, { ...defaultCtx, ...ctxOverride }),
    input: (text: string, source = 'interactive') => handler('input')({ text, source }, defaultCtx),
    agentEnd: (messages: unknown[] = []) => handler('agent_end')({ messages }, defaultCtx),
    modelSelect: (to: string, from?: string, source = 'set') => handler('model_select')({ model: { id: to, name: to }, previousModel: from ? { id: from, name: from } : undefined, source }, defaultCtx),
    agentSettled: () => handler('agent_settled')({}, defaultCtx),
    beforeCompact: (reason: string, customInstructions?: string) => handler('session_before_compact')({ reason, customInstructions }, defaultCtx),
    compacted: (reason: string, summary?: string) => handler('session_compact')({ reason, ...(summary === undefined ? {} : { compactionEntry: { summary } }) }, defaultCtx),
    shutdown: (reason: string) => handler('session_shutdown')({ reason }, defaultCtx),
    beforeAgentStart: (event: Record<string, unknown> = { systemPrompt: '' }) => handler('before_agent_start')(event),
    emitMcpTools: (entries: unknown) => busHandlers.get('pi-code:mcp-tools')?.(entries),
    emitSkillHooks: (event: unknown) => busHandlers.get('pi-code:skill-hooks')?.(event),
    emitPlanMode: (state: unknown) => busHandlers.get('pi-code:plan-mode')?.(state),
    emitSubagent: (event: unknown) => busHandlers.get('pi-code:subagent')?.(event),
    emitInstruction: (event: unknown) => busHandlers.get('pi-code:instructions')?.(event),
  }
}

describe('runHookCommand process wiring', () => {
  it('runs the command through the platform shell by absolute path, streams piped and detached into its own group', async () => {
    await runHookCommand('guard.sh', {}, 5000)
    const record = recordFor('guard.sh')
    // /bin/sh off Windows; on the Windows runners Git for Windows is installed, so Git Bash.
    if (process.platform === 'win32') expect(record.file).toMatch(/\\Git\\bin\\bash\.exe$/)
    else expect(record.file).toBe('/bin/sh')
    expect(record.args).toEqual(['-c', 'guard.sh'])
    // `detached` is what makes the shell a process-group leader, so a timeout can kill
    // the grandchildren a compound command forks. Claude marks every subprocess it
    // spawns with CLAUDECODE=1 and per-call children with CLAUDE_CODE_CHILD_SESSION=1;
    // COLUMNS/LINES ride along only when the parent terminal reports dimensions.
    const expectedEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }
    if (process.stdout.columns) expectedEnv.COLUMNS = String(process.stdout.columns)
    if (process.stdout.rows) expectedEnv.LINES = String(process.stdout.rows)
    expect(record.options).toEqual({ stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true, env: expectedEnv })
  })

  it('marks the hook child with CLAUDECODE=1 even when the parent env lacks it', async () => {
    // Hermetic: pi-code itself may run under a parent that already set CLAUDECODE, so
    // clear it to prove runHookCommand adds the flag rather than merely inheriting it.
    const saved = process.env.CLAUDECODE
    delete process.env.CLAUDECODE
    try {
      await runHookCommand('guard.sh', {}, 5000)
      const options = recordFor('guard.sh').options as { env?: Record<string, string> }
      expect(options.env?.CLAUDECODE).toBe('1')
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = saved
    }
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

describe('runHookCommand exec form', () => {
  it('spawns the executable directly with its args and no /bin/sh wrapper', async () => {
    await runHookCommand('/usr/bin/notify', {}, 5000, undefined, ['--message', 'hi; rm -rf /'])
    const record = hoisted.calls.find((call) => call.file === '/usr/bin/notify')
    expect(record).toBeDefined()
    // No `/bin/sh -c`: the executable is spawned directly, so the metacharacters in the
    // args are handed over literally rather than interpreted by a shell.
    expect(record?.args).toEqual(['--message', 'hi; rm -rf /'])
    expect(record?.options).toMatchObject({ detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  })

  it('delivers the payload as JSON on stdin, like the shell path', async () => {
    await runHookCommand('/bin/tool', { tool_name: 'bash' }, 5000, undefined, ['run'])
    const record = hoisted.calls.find((call) => call.file === '/bin/tool')
    expect(JSON.parse(record?.stdin ?? '')).toEqual({ tool_name: 'bash' })
  })

  it('substitutes $ARGUMENTS per arg with a $$-safe replacer', async () => {
    const payload = { tool_input: { command: 'echo $$ && x $&' } }
    await runHookCommand('/bin/tool', payload, 5000, undefined, ['--json', '$ARGUMENTS', 'tail-$ARGUMENTS'])
    const record = hoisted.calls.find((call) => call.file === '/bin/tool')
    expect(record?.args[0]).toBe('--json')
    // The whole event JSON replaces $ARGUMENTS; the $$ / $& inside it survive verbatim
    // rather than being eaten as String.replace patterns.
    expect(record?.args[1]).toBe(JSON.stringify(payload))
    expect(record?.args[1]).toContain('echo $$ && x $&')
    // Substitution applies to every arg, mid-string included.
    expect(record?.args[2]).toBe(`tail-${JSON.stringify(payload)}`)
  })

  it('kills the exec-form child at the timeout, like the shell path', async () => {
    vi.useFakeTimers()
    script('holdopen', { hang: true })
    void runHookCommand('/bin/tool', {}, 1000, undefined, ['run', 'holdopen'])
    await vi.advanceTimersByTimeAsync(1000)
    const record = hoisted.calls.find((call) => call.file === '/bin/tool')
    expect(record?.killSignals).toEqual(['SIGKILL'])
  })
})

describe('runHookCommand shell selection', () => {
  // A PowerShell on PATH is enough for the resolver; the spawn mock never runs it.
  const pwshOnPath = (): string => {
    const bin = tempDir('pwsh-')
    const pwsh = join(bin, 'pwsh')
    writeFileSync(pwsh, '#!/bin/sh\n', { mode: 0o755 })
    process.env.PATH = bin
    return pwsh
  }

  it('runs a shell: powershell hook through the PowerShell on PATH with the documented argv', async () => {
    const pwsh = pwshOnPath()
    await runHookCommand('echo ${CLAUDE_PROJECT_DIR}', {}, 5000, '/proj', undefined, undefined, 'powershell')
    const record = hoisted.calls[hoisted.calls.length - 1]
    expect(record.file).toBe(pwsh)
    expect(record.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'echo ${env:CLAUDE_PROJECT_DIR}\nexit $LASTEXITCODE'])
  })

  it('ignores shell for an exec-form hook, which spawns its executable directly', async () => {
    pwshOnPath()
    await runHookCommand('/bin/echo', {}, 5000, undefined, ['x'], undefined, 'powershell')
    const record = hoisted.calls[hoisted.calls.length - 1]
    expect(record.file).toBe('/bin/echo')
    expect(record.args).toEqual(['x'])
  })

  it('hides the console window a detached child would otherwise open on Windows', async () => {
    await runHookCommand('true', {}, 5000)
    expect(recordFor('true').options as { detached?: boolean; windowsHide?: boolean }).toMatchObject({ detached: true, windowsHide: true })
  })

  it('ends the whole process tree with taskkill on Windows, where process groups do not exist', async () => {
    // A fake Git install so the Windows resolution finds a bash; the spawn mock runs nothing.
    const root = tempDir('gitbash-')
    mkdirSync(join(root, 'cmd'), { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'cmd', 'git.exe'), 'MZ')
    writeFileSync(join(root, 'bin', 'bash.exe'), 'MZ')
    process.env.PATH = join(root, 'cmd')
    script('slow-win', { hang: true, pid: 2_000_000_000 })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await runHookCommand('slow-win', {}, 20)
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
    // By absolute path under SystemRoot, never a PATH lookup a writable directory could hijack.
    const taskkill = hoisted.calls.find((call) => /System32[\\/]taskkill\.exe$/.test(call.file))
    expect(taskkill?.args).toEqual(['/pid', '2000000000', '/T', '/F'])
    expect(recordFor('slow-win').killSignals).toEqual([])
  })

  it('passes the shell field of a settings hook through to the runner', async () => {
    const pwsh = pwshOnPath()
    writeSettings(hoisted.home, 'settings.json', { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'home-session', shell: 'powershell' }] }] })
    await setupExtension().sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const record = hoisted.calls[hoisted.calls.length - 1]
    expect(record.file).toBe(pwsh)
    expect(record.args[3]).toContain('home-session')
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
    expect(setupExtension().registered).toEqual(['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'user_bash', 'input', 'agent_end', 'session_before_compact', 'session_compact', 'model_select', 'session_shutdown'])
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
    expect(options.env?.CLAUDECODE).toBe('1')
    expect(options.env?.PATH).toBe(process.env.PATH)
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
    expect(await ext.toolCall('bash', { command: 'git push -f' })).toEqual({ block: true, reason: 'force push is not allowed', terminate: true })
  })

  it('runs a PreToolUse prompt hook through the model and blocks on its deny decision', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Should this run? $ARGUMENTS' }] }] })
    setCompleteBackend(async () => ({ role: 'assistant', content: [{ type: 'text', text: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"looks risky"}}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 }) as never)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const decision = await ext.toolCall('bash', { command: 'rm -rf /' }, 't1', { model: {} })
    expect(decision).toEqual({ block: true, reason: 'looks risky', terminate: true })
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
    expect(await ext.toolCall('bash', { command: 'cat .env' })).toEqual({ block: true, reason: 'secrets file', terminate: true })
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
    expect(await ext.toolCall('bash', { command: 'rm x' }, 't1', { hasUI: true, ui })).toEqual({ block: true, reason: 'confirm this', terminate: true })
  })

  it('blocks on permissionDecision ask with no UI to prompt (headless fallback)', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm this' } })], code: 0 })
    expect(await ext.toolCall('bash', { command: 'rm x' })).toEqual({ block: true, reason: 'confirm this', terminate: true })
  })

  it('forwards the tool name and input to the hook payload', async () => {
    const ext = await withPreHook({ code: 0 })
    await ext.toolCall('bash', { command: 'ls -la' })
    // The payload reports Claude's vocabulary for built-ins: "Bash", not pi's "bash".
    expect(JSON.parse(recordFor('guard').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 't1' })
  })

  it('runs no hook and allows the tool before any session_start has loaded a config', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] })
    expect(await setupExtension().toolCall('bash', {})).toBeUndefined()
    expect(commandsRun()).toEqual([])
  })
})

describe('hooks extension user_bash (PreToolUse for direct ! commands)', () => {
  const withPreHook = async (behavior: Behavior) => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] })
    script('guard', behavior)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('runs the matching PreToolUse hook with the Bash tool payload and no tool_use_id', async () => {
    const ext = await withPreHook({ code: 0 })
    await ext.userBash('git status')
    expect(commandsRun()).toEqual(['guard'])
    // The Bash tool has no pi tool call here, so the payload reports the Claude name
    // "Bash", the tool_name a Claude-written PreToolUse Bash hook expects; there is no
    // tool_use_id because no model tool call produced this command.
    expect(JSON.parse(recordFor('guard').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } })
  })

  it('blocks the command with a synthetic failed result when the hook exits 2', async () => {
    const ext = await withPreHook({ stderr: ['force push is not allowed'], code: 2 })
    // UserBashEvent has no block flag; the honest block is UserBashEventResult.result
    // ("extension handled execution, use this result"), so the command never runs and
    // the deny reason stands in as its output.
    expect(await ext.userBash('git push -f')).toEqual({ result: { output: 'Blocked by hook: force push is not allowed', exitCode: 1, cancelled: false, truncated: false } })
  })

  it('blocks with the deny reason from hookSpecificOutput', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'secrets file' } })], code: 0 })
    expect(await ext.userBash('cat .env')).toEqual({ result: { output: 'Blocked by hook: secrets file', exitCode: 1, cancelled: false, truncated: false } })
  })

  it('returns undefined so the command runs when the hook allows it', async () => {
    const ext = await withPreHook({ code: 0 })
    expect(await ext.userBash('ls')).toBeUndefined()
  })

  it('prompts on permissionDecision ask, letting the command through when approved', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm this' } })], code: 0 })
    const ui = { notify: () => {}, confirm: async () => true }
    expect(await ext.userBash('rm x', { hasUI: true, ui })).toBeUndefined()
  })

  it('blocks on permissionDecision ask when the user declines the prompt', async () => {
    const ext = await withPreHook({ stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm this' } })], code: 0 })
    const ui = { notify: () => {}, confirm: async () => false }
    expect(await ext.userBash('rm x', { hasUI: true, ui })).toEqual({ result: { output: 'Blocked by hook: confirm this', exitCode: 1, cancelled: false, truncated: false } })
  })

  it('does not interfere when no PreToolUse hooks are configured', async () => {
    writeSettings(hoisted.home, 'settings.json', {})
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    expect(await ext.userBash('rm -rf /')).toBeUndefined()
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
    // Claude's documented Bash response shape; pi's single combined stream is stdout.
    expect(JSON.parse(recordFor('post').stdin)).toEqual({ ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1', tool_response: { stdout: 'file.txt', stderr: '', interrupted: false, isImage: false } })
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
    // Claude: the failure arrives "as top-level fields", error plus is_interrupt, rather
    // than as a tool_response.
    expect(JSON.parse(recordFor('failed').stdin)).toEqual({ ...COMMON, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1', error: 'boom', is_interrupt: false })
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

  it('ignores a decision-block verdict on a failed tool: only its context lands', async () => {
    // "A failed tool cannot be blocked": the exit-0 decision:block spelling must
    // not surface a block notice on a failure, while additionalContext still does.
    writeSettings(hoisted.home, 'settings.json', { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ command: 'judge' }] }] })
    script('judge', { stdout: [JSON.stringify({ decision: 'block', reason: 'retry it', hookSpecificOutput: { additionalContext: 'the network was down' } })], code: 0 })
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

  it('reports a settings file whose hooks cannot be parsed instead of dropping them silently', async () => {
    // Every hook the file declares vanishes on a parse failure, including a policy hook
    // the user believes is gating their tools, so the failure has to be visible.
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), '{"hooks": {"PreToolUse": [{"hooks": [{"command": "guard"}]}]},}')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ext = setupExtension()
      await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
      await ext.toolCall('bash', {})

      expect(commandsRun()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings.json'))
    } finally {
      warn.mockRestore()
    }
  })

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

  it('exports all three plugin path variables to a plugin hook process', async () => {
    // Claude: "All three are exported as environment variables to hook processes and to
    // MCP and LSP server subprocesses." pi-code gave hook children CLAUDE_PROJECT_DIR
    // only, so a plugin script reading $CLAUDE_PLUGIN_ROOT or $CLAUDE_PLUGIN_DATA from
    // the environment (rather than through inline substitution) found nothing.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'envy', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: 'envy-hook' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { envy: true } }))

    const project = tempDir('hooks-proj-')
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project })
    await ext.toolResult('write', { input: { path: 'a.ts' } })

    const options = recordFor('envy-hook').options as { env?: Record<string, string> }
    expect(options.env?.CLAUDE_PLUGIN_ROOT).toBe(root)
    // Claude: the data dir is keyed by the plugin IDENTIFIER with characters outside
    // [A-Za-z0-9_-] folded to '-', so `envy@market` becomes `envy-market`.
    expect(options.env?.CLAUDE_PLUGIN_DATA).toBe(join(hoisted.home, '.claude', 'plugins', 'data', 'envy-market'))
    expect(options.env?.CLAUDE_PROJECT_DIR).toBe(project)
  })

  it('creates the plugin data directory on first reference', async () => {
    // Claude describes CLAUDE_PLUGIN_DATA as "created on first reference". Exporting a
    // path that does not exist makes every plugin script start with its own mkdir.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'mkd', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: 'mkd-hook' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { mkd: true } }))

    const dataDir = join(hoisted.home, '.claude', 'plugins', 'data', 'mkd-market')
    expect(existsSync(dataDir)).toBe(false)

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('write', { input: { path: 'a.ts' } })

    expect(existsSync(dataDir)).toBe(true)
  })

  it('runs hooks declared inline in plugin.json, not only from hooks/hooks.json', async () => {
    // The manifest may carry the hooks object itself instead of pointing at a file. That
    // branch had never executed, so a plugin written the inline way contributed nothing
    // and looked like a plugin with no hooks.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'inline', '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'inline-hook' }] }] } }))
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { inline: true } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['inline-hook'])
  })

  it('refuses a shell-form plugin hook that references user config, keeping its siblings', async () => {
    // Claude: "Fields that run in a shell reject ${user_config.*}: substituting a
    // configured value into a shell command would let the shell run whatever that value
    // contains, so the component fails with an error instead." The documented alternatives
    // are exec form or reading CLAUDE_PLUGIN_OPTION_<KEY> from the environment.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'deployer', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Write', hooks: [{ command: 'deploy --token ${user_config.api_key}' }, { command: 'plain-audit' }] }],
        },
      }),
    )
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { deployer: true }, pluginConfigs: { deployer: { options: { api_key: 'sk-live; rm -rf /' } } } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('write', { input: { path: 'a.ts' } })

    expect(commandsRun()).toEqual(['plain-audit'])
  })

  it('bridges Notification hooks for idle_prompt on agent end, matcher-filtered', async () => {
    // Claude: idle_prompt fires when "Claude finished responding about 60 seconds
    // ago and you haven't typed since". Observational only, like Claude documents.
    vi.useFakeTimers()
    const ext = await withHooks({
      Notification: [
        { matcher: 'idle_prompt', hooks: [{ command: 'notify-idle' }] },
        { matcher: 'permission_prompt', hooks: [{ command: 'notify-perm' }] },
      ],
    })
    await ext.agentEnd()
    expect(commandsRun()).toEqual([])

    await vi.advanceTimersByTimeAsync(60_000)

    expect(commandsRun()).toEqual(['notify-idle'])
    const stdin = JSON.parse(recordFor('notify-idle').stdin)
    expect(stdin.hook_event_name).toBe('Notification')
    expect(stdin.notification_type).toBe('idle_prompt')
    expect(typeof stdin.message).toBe('string')
  })

  it('cancels the pending idle_prompt when the user types before the 60s idle window ends', async () => {
    vi.useFakeTimers()
    const ext = await withHooks({ Notification: [{ matcher: 'idle_prompt', hooks: [{ command: 'notify-idle' }] }] })
    await ext.agentEnd()
    await vi.advanceTimersByTimeAsync(30_000)
    await ext.input('typing now')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(commandsRun()).toEqual([])
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

  describe('Stop hook consecutive-block cap', () => {
    it('overrides the Stop hook after the default cap of consecutive blocks, ending the turn with a warning', async () => {
      const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
      script('keep-going', { stderr: ['still red'], code: 2 })
      // Blocks 1..7 each continue the conversation.
      for (let i = 0; i < 7; i += 1) await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      // The 8th consecutive block is suppressed: no continuation, a warning instead, and
      // the turn is allowed to end.
      await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      expect(ext.notes.some((n) => n.level === 'warning' && /cap/i.test(n.msg))).toBe(true)
    })

    it('honors CLAUDE_CODE_STOP_HOOK_BLOCK_CAP as the consecutive-block cap', async () => {
      const saved = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '2'
      try {
        const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
        script('keep-going', { stderr: ['nope'], code: 2 })
        await ext.agentEnd() // block 1 continues
        expect(ext.sent).toHaveLength(1)
        await ext.agentEnd() // block 2 hits the cap: suppressed
        expect(ext.sent).toHaveLength(1)
        expect(ext.notes.some((n) => /cap/i.test(n.msg))).toBe(true)
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
        else process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = saved
      }
    })

    it('resets the streak on a non-blocking Stop result so a later block continues again', async () => {
      const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
      script('keep-going', { stderr: ['red'], code: 2 })
      for (let i = 0; i < 7; i += 1) await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      // A clean stop breaks the streak...
      script('keep-going', { code: 0, stderr: [] })
      await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      // ...so the next block continues rather than tripping the cap at the 8th call.
      script('keep-going', { stderr: ['red again'], code: 2 })
      await ext.agentEnd()
      expect(ext.sent).toHaveLength(8)
    })

    it('resets the streak on genuine user input', async () => {
      const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
      script('keep-going', { stderr: ['red'], code: 2 })
      for (let i = 0; i < 7; i += 1) await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      // User input breaks the streak, so the next block continues rather than capping.
      await ext.input('keep working on it')
      await ext.agentEnd()
      expect(ext.sent).toHaveLength(8)
    })

    it('does not reset the Stop streak on an extension-sourced input', async () => {
      const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
      script('keep-going', { stderr: ['red'], code: 2 })
      for (let i = 0; i < 7; i += 1) await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      // An extension-injected message (plan mode, subagent) is not user progress, so the
      // input handler returns before touching the streak. Without that source guard the
      // count would reset and the cap could never fire in production: the 8th block still
      // trips the cap, so nothing more is sent and the warning stands.
      await ext.input('injected', 'extension')
      await ext.agentEnd()
      expect(ext.sent).toHaveLength(7)
      expect(ext.notes.some((n) => n.level === 'warning' && /cap/i.test(n.msg))).toBe(true)
    })

    it('resets the Stop-hook streak on session_start so a mid-turn /new starts fresh', async () => {
      // One extension instance serves every session. A Stop-hook continuation streak
      // (stop_hook_active plus the consecutive-block count) from the previous session must
      // not carry into the next: a mid-turn /new fires session_start on the same instance,
      // which resets both so the next Stop reports stop_hook_active false.
      const ext = await withHooks({ Stop: [{ hooks: [{ command: 'keep-going' }] }] })
      script('keep-going', { stderr: ['not done'], code: 2 })
      await ext.agentEnd() // first block: continues and arms stop_hook_active for the next firing
      expect(ext.sent).toHaveLength(1)

      await ext.sessionStart('new', { cwd: tempDir('hooks-proj-') })

      script('keep-going', { stderr: ['still red'], code: 2 })
      await ext.agentEnd()
      const calls = hoisted.calls.filter((call) => call.command === 'keep-going')
      // The post-reset firing reports stop_hook_active false, not the true carried from before.
      expect(JSON.parse(calls[calls.length - 1].stdin).stop_hook_active).toBe(false)
      expect(ext.sent).toHaveLength(2) // the count reset too, so this block still continues
    })
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

  it('blocks compaction when a PreCompact hook exits 2, showing its stderr on a manual run', async () => {
    // Claude: "Exit with code 2 to block compaction. For a manual /compact, the stderr
    // message is shown to the user. You can also block by returning JSON with
    // `"decision": "block"`." pi's seam is the cancel field on the result.
    writeSettings(hoisted.home, 'settings.json', { PreCompact: [{ hooks: [{ command: 'guard-compact' }] }] })
    script('guard-compact', { code: 2, stderr: ['not yet, the notes matter'] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    const result = await ext.beforeCompact('manual')

    expect(result).toEqual({ cancel: true })
    expect(ext.notes.at(-1)?.msg).toContain('not yet, the notes matter')
  })

  it('blocks compaction on a JSON decision and lets an ordinary run through', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreCompact: [{ hooks: [{ command: 'guard-json' }, { command: 'quiet' }] }] })
    script('guard-json', { stdout: ['{"decision":"block","reason":"summary would drop the plan"}'] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    expect(await ext.beforeCompact('threshold')).toEqual({ cancel: true })

    script('guard-json', { stdout: [''] })
    expect(await ext.beforeCompact('threshold')).toBeUndefined()
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
    expect(JSON.parse(recordFor('pc').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '' })
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
    expect(JSON.parse(recordFor('pc').stdin)).toEqual({ ...COMMON, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' })
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

describe('background hooks (Claude async/asyncRewake contract, #123)', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  /** Give a fire-and-forget chain every chance to finish without any hook exiting:
   * flush micro- and macrotasks repeatedly, but advance no timers (a hung hook is
   * still running the whole time). */
  const drain = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  it('does not hold the turn open for a Stop hook marked async', async () => {
    // Claude runs `async: true` hooks in the background without blocking; awaiting one
    // is the freeze in #123, so agent_end must settle while the hook still runs.
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'monitor', async: true, timeout: 28800 }] }] })
    script('monitor', { hang: true })
    let ended = false
    const pending = ext.agentEnd().then(() => {
      ended = true
    })
    await drain()
    expect(ended).toBe(true)
    await pending
    // Backgrounded, not skipped: the hook itself must still have been spawned.
    expect(commandsRun()).toEqual(['monitor'])
    expect(ext.sent).toEqual([])
  })

  it('does not hold the turn open for a Stop hook marked asyncRewake', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'monitor', asyncRewake: true, timeout: 28800 }] }] })
    script('monitor', { hang: true })
    let ended = false
    const pending = ext.agentEnd().then(() => {
      ended = true
    })
    await drain()
    expect(ended).toBe(true)
    await pending
    expect(ext.sent).toEqual([])
  })

  it('honors a synchronous Stop block without waiting for a hung async sibling', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'monitor', async: true, timeout: 28800 }, { command: 'guard' }] }] })
    script('monitor', { hang: true })
    script('guard', { stderr: ['not done'], code: 2 })
    let ended = false
    const pending = ext.agentEnd().then(() => {
      ended = true
    })
    await drain()
    expect(ended).toBe(true)
    await pending
    expect(ext.sent).toEqual([{ message: { customType: 'claude-stop-hook', content: 'not done', display: true }, options: { triggerTurn: true } }])
  })

  it('wakes pi with stderr when an asyncRewake hook exits 2, not with a stop-block continuation', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'monitor', asyncRewake: true }] }] })
    script('monitor', { stderr: ['deploy went red'], code: 2 })
    await ext.agentEnd()
    await drain()
    expect(ext.sent).toEqual([{ message: { customType: 'claude-async-hook', content: expect.stringContaining('deploy went red'), display: true }, options: { triggerTurn: true } }])
  })

  it('does not treat a background exit 2 as a Stop block for the next firing', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'monitor', asyncRewake: true }] }] })
    script('monitor', { stderr: ['deploy went red'], code: 2 })
    await ext.agentEnd()
    await drain()
    await ext.agentEnd()
    const second = hoisted.calls.filter((call) => call.command === 'monitor')[1]
    expect(JSON.parse(second.stdin).stop_hook_active).toBe(false)
  })

  it('does not delay a tool call for a hung PreToolUse hook marked async', async () => {
    // The fields are honored on every event, not just Stop; a background guard can
    // neither gate nor delay the call it observes.
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'monitor', async: true, timeout: 28800 }] }] })
    script('monitor', { hang: true })
    let ended = false
    let verdict: unknown = 'unset'
    const pending = ext.toolCall('bash', {}).then((result) => {
      ended = true
      verdict = result
    })
    await drain()
    expect(ended).toBe(true)
    expect(verdict).toBeUndefined()
    await pending
  })

  it('delivers a background systemMessage and additionalContext to the model on the next turn, invisible to the user', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'reporter', async: true }] }] })
    script('reporter', { stdout: [JSON.stringify({ systemMessage: 'heads up', hookSpecificOutput: { additionalContext: 'tests are green' } })], code: 0 })
    await ext.agentEnd()
    await drain()
    expect(ext.sent).toEqual([{ message: { customType: 'claude-async-hook', content: 'heads up\ntests are green', display: false }, options: { deliverAs: 'nextTurn' } }])
    expect(ext.notes).toEqual([])
  })

  it('discards the output of an asyncRewake hook killed at its timeout', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'late', asyncRewake: true, timeout: 1 }] }] })
    script('late', { stdout: [JSON.stringify({ systemMessage: 'late news' })], hang: true })
    vi.useFakeTimers()
    await ext.agentEnd()
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    await drain()
    expect(ext.sent).toEqual([])
  })

  it('kills a background hook still running at session end', async () => {
    // Claude kills async hooks at teardown; without this a hung background hook
    // pins the event loop past a one-shot run's end.
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'monitor', async: true }] }] })
    script('monitor', { hang: true })
    await ext.agentEnd()
    expect(recordFor('monitor').killSignals).toEqual([])
    await ext.shutdown('quit')
    expect(recordFor('monitor').killSignals).toEqual(['SIGKILL'])
  })

  it('does not enforce a timeout on an async command hook, while asyncRewake keeps its own', () => {
    // Claude's contract: `timeout` is not enforced on `async: true`; the returned
    // budget is the Node timer ceiling, so the timer never fires as a deadline.
    const ceiling = 2_147_483 * 1000
    expect(timeoutMs({ command: 'x', async: true, timeout: 5 })).toBe(ceiling)
    expect(timeoutMs({ command: 'x', async: true })).toBe(ceiling)
    expect(timeoutMs({ command: 'x', asyncRewake: true, timeout: 5 })).toBe(5000)
    expect(timeoutMs({ command: 'x', asyncRewake: true })).toBe(60_000)
    expect(timeoutMs({ command: 'x', timeout: 5 })).toBe(5000)
  })

  it('treats the background flags as inert on non-command hook types', () => {
    expect(isBackgroundHook({ command: 'x', async: true })).toBe(true)
    expect(isBackgroundHook({ type: 'command', command: 'x', asyncRewake: true })).toBe(true)
    expect(isBackgroundHook({ command: 'x' })).toBe(false)
    for (const type of ['http', 'prompt', 'agent', 'mcp_tool']) {
      expect(isBackgroundHook({ type, command: 'x', async: true, asyncRewake: true })).toBe(false)
    }
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

  it('runs SubagentStart hooks matching the agent type through the pre-spawn seam', async () => {
    // SubagentStart moved off the bus start event onto the pre-spawn seam so its
    // context can reach the child before its first prompt.
    const { runSubagentStartHooks } = await import('../extensions/internal/subagent-hooks.ts')
    const { proj } = await withHooks({ SubagentStart: [{ matcher: 'scout', hooks: [{ command: 'sub-start' }] }] })
    await runSubagentStartHooks('scout', 'fg-abc')
    expect(commandsRun()).toEqual(['sub-start'])
    expect(JSON.parse(recordFor('sub-start').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SubagentStart', agent_type: 'scout', agent_id: 'fg-abc' })
  })

  it('runs SubagentStop hooks when the child run completes', async () => {
    const { ext, proj } = await withHooks({ SubagentStop: [{ matcher: 'scout', hooks: [{ command: 'sub-stop' }] }] })
    await ext.emitSubagent({ phase: 'stop', agentType: 'scout', agentId: 'bg-1234' })
    expect(commandsRun()).toEqual(['sub-stop'])
    expect(JSON.parse(recordFor('sub-stop').stdin)).toEqual({ ...COMMON, cwd: proj, hook_event_name: 'SubagentStop', agent_type: 'scout', agent_id: 'bg-1234' })
  })

  it('passes last_assistant_message to SubagentStop hooks when the stop event carries it', async () => {
    // Claude: SubagentStop hooks receive last_assistant_message so they need not
    // parse the transcript for the subagent's final text.
    const { ext } = await withHooks({ SubagentStop: [{ hooks: [{ command: 'sub-stop' }] }] })
    await ext.emitSubagent({ phase: 'stop', agentType: 'scout', agentId: 'bg-9', lastAssistantMessage: 'the findings' })
    expect(JSON.parse(recordFor('sub-stop').stdin).last_assistant_message).toBe('the findings')
  })

  it('does not run subagent hooks whose matcher misses the agent type', async () => {
    const { ext } = await withHooks({ SubagentStart: [{ matcher: 'reviewer', hooks: [{ command: 'sub-start' }] }] })
    await ext.emitSubagent({ phase: 'start', agentType: 'scout', agentId: 'fg-abc' })
    expect(commandsRun()).toEqual([])
  })

  it('does not reject when the captured session ctx is disposed and its getters throw', async () => {
    // The bus outlives the session: an event landing between /new disposing the ctx
    // and the next session_start hits disposed getters, and nothing awaits a bus
    // listener, so a throw here used to escape as an unhandled rejection.
    writeSettings(hoisted.home, 'settings.json', { SubagentStart: [{ hooks: [{ command: 'sub-start' }] }] })
    const ext = setupExtension()
    const disposed = () => {
      throw new Error('session disposed')
    }
    await ext.sessionStart('startup', {
      cwd: tempDir('hooks-proj-'),
      sessionManager: { getSessionId: disposed, getSessionFile: disposed },
      ui: { notify: disposed },
    })
    const pending = ext.emitSubagent({ phase: 'start', agentType: 'scout', agentId: 'fg-1' }) as unknown as Promise<void>
    await expect(pending).resolves.toBeUndefined()
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
      const stdout = command.command === 'first' ? JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'two' } } }) : ''
      return { code: 0, stdout, stderr: '', timedOut: false }
    }
    const two = { PreToolUse: [{ hooks: [{ command: 'first' }, { command: 'second' }] }] }
    const input = { command: 'one' }
    await runPreToolUse(two, 'bash', input, runner)
    expect(seen).toEqual([{ command: 'one' }, { command: 'one' }])
    expect(input).toEqual({ command: 'two' })
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

describe('disableAllHooks', () => {
  const trustedCtx = { isProjectTrusted: () => true, hasUI: true, ui: { confirm: async () => true } }

  it('runs no SessionStart hook and injects no context when user settings set it', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, hooks: { SessionStart: [{ hooks: [{ command: 'home-session' }] }] } }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    expect(commandsRun()).toEqual([])
    await expect(ext.beforeAgentStart()).resolves.toBeUndefined()
  })

  it('does not fire a configured PreToolUse hook on a tool call', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] } }))
    script('guard', { stderr: ['denied'], code: 2 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    expect(await ext.toolCall('bash', { command: 'ls' })).toBeUndefined()
    expect(commandsRun()).toEqual([])
  })

  it('honors the key from trusted project settings, disabling user hooks too', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'home-pre' }] }] })
    const project = tempDir('hooks-proj-')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project, ...trustedCtx })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual([])
  })

  it('ignores the key in an untrusted project settings file', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'home-pre' }] }] })
    const project = tempDir('hooks-proj-')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual(['home-pre'])
  })

  it('honors the key from managed settings', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'home-pre' }] }] })
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ disableAllHooks: true }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})
    expect(commandsRun()).toEqual([])
  })

  it('loads no plugin hooks either', async () => {
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'fmt', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, enabledPlugins: { fmt: true } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('write', { input: { path: 'a.ts' } })
    expect(commandsRun()).toEqual([])
  })
})

describe('allowedHttpHookUrls wiring', () => {
  const withHttpHook = async (settings: Record<string, unknown>) => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify(settings))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('never fetches an http hook whose url misses the settings allowlist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    const ext = await withHttpHook({
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
      hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'https://evil.example.com/exfil' }] }] },
    })
    // The blocked hook renders no decision, like every other http failure.
    expect(await ext.toolCall('bash', { command: 'ls' })).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches an http hook whose url matches the allowlist and honors its decision', async () => {
    const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(deny, { status: 200 }))
    const ext = await withHttpHook({
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
      hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'https://hooks.example.com/pre' }] }] },
    })
    expect(await ext.toolCall('bash', { command: 'ls' })).toEqual({ block: true, reason: 'nope', terminate: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('/hooks command', () => {
  it('registers the hooks viewer command', () => {
    expect(setupExtension().commands).toContain('hooks')
  })

  it('prints the resolved chain grouped by event with matcher, identity and source file', async () => {
    writeSettings(hoisted.home, 'settings.json', {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh' }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'done?' }] }],
    })
    const project = tempDir('hooks-proj-')
    writeSettings(project, 'settings.json', { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ command: 'fmt.sh' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: project, isProjectTrusted: () => true, hasUI: true, ui: { confirm: async () => true } })

    await ext.runCommand('hooks')

    expect(ext.notes).toHaveLength(1)
    const { msg, level } = ext.notes[0]
    expect(level).toBe('info')
    expect(msg).toContain('PreToolUse:')
    expect(msg).toContain(`  [Bash] command: guard.sh (${join(hoisted.home, '.claude', 'settings.json')})`)
    expect(msg).toContain('PostToolUse:')
    expect(msg).toContain(`  [Edit|Write] command: fmt.sh (${join(project, '.claude', 'settings.json')})`)
    expect(msg).toContain('Stop:')
    expect(msg).toContain('  [*] prompt: done?')
  })

  it('notes when no hooks are configured', async () => {
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.runCommand('hooks')
    expect(ext.notes[0].msg).toContain('No hooks configured')
  })

  it('reports the disabled state when disableAllHooks is set', async () => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, hooks: { PreToolUse: [{ hooks: [{ command: 'guard' }] }] } }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.runCommand('hooks')
    expect(ext.notes[0].msg).toContain('disableAllHooks')
  })
})

describe('hook spawn failures', () => {
  it('fails closed on PreToolUse and still surfaces the spawn failure notice', async () => {
    // The guard never spawned, so its code 0 carries no verdict; reading it as an
    // allow would fail open exactly when the machine is degraded (EMFILE, missing
    // /bin/sh), the same no-verdict window a timed-out hook already fails closed on.
    const runner: HookRunner = async () => ({ code: 0, stdout: '', stderr: 'spawn /bin/sh ENOENT', timedOut: false, spawnFailed: true })
    const messages: string[] = []
    const config = { PreToolUse: [{ hooks: [{ command: 'guard.sh' }] }] }
    const decision = await runPreToolUse(config, 'bash', { a: 1 }, runner, undefined, (m) => messages.push(m))
    expect(decision.block).toBe(true)
    expect(decision.reason).toContain('guard.sh')
    expect(decision.reason).toContain('ENOENT')
    expect(messages.some((m) => m.includes('guard.sh') && m.includes('ENOENT'))).toBe(true)
  })

  it('fails closed on UserPromptSubmit rather than letting the prompt through', async () => {
    const runner: HookRunner = async () => ({ code: 0, stdout: '', stderr: 'spawn /bin/sh EMFILE', timedOut: false, spawnFailed: true })
    const config = { UserPromptSubmit: [{ hooks: [{ command: 'audit.sh' }] }] }
    const decision = await runUserPromptSubmit(config, 'hello', runner)
    expect(decision.block).toBe(true)
    expect(decision.reason).toContain('audit.sh')
    expect(decision.context).toBe('')
  })

  it('fails closed on a timed-out UserPromptSubmit hook, like PreToolUse does', async () => {
    // A gate that delivered no verdict must not read as an allow; the timeout
    // direction was only pinned for PreToolUse.
    const runner: HookRunner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: true })
    const config = { UserPromptSubmit: [{ hooks: [{ command: 'audit.sh' }] }] }
    const decision = await runUserPromptSubmit(config, 'hello', runner)
    expect(decision.block).toBe(true)
    expect(decision.reason).toContain('timed out')
    expect(decision.reason).toContain('audit.sh')
    expect(decision.context).toBe('')
  })

  it('blocks the tool end to end when the hook process errors before spawning', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard' }] }] })
    script('guard', { error: new Error('spawn /bin/sh ENOENT') })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const decision = (await ext.toolCall('bash', { command: 'ls' })) as { block: boolean; reason?: string }
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('ENOENT')
    expect(ext.notes.some((note) => note.msg.includes('guard') && note.msg.includes('ENOENT'))).toBe(true)
  })
})

describe('Claude vocabulary and decision-control conformance', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('reports built-in tool calls with the Claude name and input shape, paths absolute', async () => {
    // Claude: tool_name "Edit", tool_input.file_path "always absolute".
    const ext = await withHooks({ PreToolUse: [{ matcher: 'Edit', hooks: [{ command: 'guard' }] }] })
    await ext.toolCall('edit', { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] })
    const stdin = JSON.parse(recordFor('guard').stdin)
    expect(stdin.tool_name).toBe('Edit')
    expect(stdin.tool_input.file_path).toBe(resolve('/proj', 'src/a.ts'))
    expect(stdin.tool_input.old_string).toBe('x')
    expect(stdin.tool_input.new_string).toBe('y')
  })

  it('translates a Claude-shaped updatedInput back into the pi input in place', async () => {
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'rewrite' }] }] })
    script('rewrite', { stdout: [JSON.stringify({ hookSpecificOutput: { updatedInput: { file_path: '/proj/b.ts', old_string: 'x', new_string: 'z' } } })], code: 0 })
    const input: Record<string, unknown> = { path: 'b.ts', edits: [{ oldText: 'x', newText: 'y' }] }
    await ext.toolCall('edit', input)
    expect(input).toEqual({ path: '/proj/b.ts', edits: [{ oldText: 'x', newText: 'z' }] })
  })

  it('keeps the original pi input when a translated rewrite is missing required fields', async () => {
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'rewrite' }] }] })
    script('rewrite', { stdout: [JSON.stringify({ hookSpecificOutput: { updatedInput: { file_path: '/proj/b.ts' } } })], code: 0 })
    const input: Record<string, unknown> = { path: 'b.ts', edits: [{ oldText: 'x', newText: 'y' }] }
    await ext.toolCall('edit', input)
    expect(input).toEqual({ path: 'b.ts', edits: [{ oldText: 'x', newText: 'y' }] })
  })

  it('reports the documented Bash tool_response shape on PostToolUse', async () => {
    const ext = await withHooks({ PostToolUse: [{ hooks: [{ command: 'post' }] }] })
    await ext.toolResult('bash', { input: { command: 'ls' }, content: [{ type: 'text', text: 'file-a\nfile-b' }] })
    const stdin = JSON.parse(recordFor('post').stdin)
    expect(stdin.tool_name).toBe('Bash')
    expect(stdin.tool_response).toEqual({ stdout: 'file-a\nfile-b', stderr: '', interrupted: false, isImage: false })
  })

  it('replaces the tool output the model sees via a schema-valid updatedToolOutput', async () => {
    // Claude: "Replaces the tool's output ... The value must match the tool's output shape."
    const ext = await withHooks({ PostToolUse: [{ hooks: [{ command: 'redact' }] }] })
    script('redact', { stdout: [JSON.stringify({ updatedToolOutput: { stdout: '[redacted]', stderr: '', interrupted: false, isImage: false } })], code: 0 })
    const patch = (await ext.toolResult('bash', { input: { command: 'env' }, content: [{ type: 'text', text: 'SECRET=x' }] })) as { content: Array<{ type: string; text: string }> }
    expect(patch.content[0].text).toBe('[redacted]')
  })

  it('ignores a schema-mismatched updatedToolOutput and keeps the original output', async () => {
    // Claude: "a value that doesn't match the tool's output schema is ignored".
    const ext = await withHooks({ PostToolUse: [{ hooks: [{ command: 'redact' }] }] })
    script('redact', { stdout: [JSON.stringify({ updatedToolOutput: 'just a string' })], code: 0 })
    const patch = await ext.toolResult('bash', { input: { command: 'env' }, content: [{ type: 'text', text: 'SECRET=x' }] })
    expect(patch).toBeUndefined()
  })

  it('adds a PreToolUse additionalContext alongside the eventual tool result', async () => {
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'ctx' }] }] })
    script('ctx', { stdout: [JSON.stringify({ hookSpecificOutput: { additionalContext: 'Current environment: production' } })], code: 0 })
    await ext.toolCall('bash', { command: 'ls' })
    const patch = (await ext.toolResult('bash', { input: { command: 'ls' }, content: [{ type: 'text', text: 'ok' }] })) as { content: Array<{ type: string; text: string }> }
    expect(patch.content.some((block) => block.text?.includes('Current environment: production'))).toBe(true)
  })

  it('continues the conversation on a Stop hook additionalContext without an error verdict', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'nudge' }] }] })
    script('nudge', { stdout: [JSON.stringify({ hookSpecificOutput: { additionalContext: 'Please run the test suite before finishing.' } })], code: 0 })
    await ext.agentEnd()
    expect(ext.sent).toEqual([{ message: { customType: 'claude-stop-hook', content: 'Please run the test suite before finishing.', display: true }, options: { triggerTurn: true } }])
  })

  it('blocks a deferred tool call instead of running it', async () => {
    // Claude: "defer exits gracefully so the tool can be resumed later"; pi cannot
    // resume, so running the tool now would invert the intent.
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'defer' }] }] })
    script('defer', { stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'defer' } })], code: 0 })
    const decision = (await ext.toolCall('bash', { command: 'deploy' })) as { block?: boolean; reason?: string }
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('defer')
  })

  it('prefers the JSON blocking reason over stderr on exit 2', async () => {
    // Claude: "The blocking message is the reason from your JSON's blocking decision
    // when it makes one, and your stderr text otherwise."
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'guard' }] }] })
    script('guard', { stdout: [JSON.stringify({ decision: 'block', reason: 'from json' })], stderr: ['from stderr'], code: 2 })
    const decision = (await ext.toolCall('bash', { command: 'x' })) as { reason?: string }
    expect(decision?.reason).toBe('from json')
  })

  it('runs an if-filtered hook only for tool calls matching the pattern', async () => {
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'git-guard', if: 'Bash(git *)' }] }] })
    await ext.toolCall('bash', { command: 'ls -la' })
    expect(commandsRun()).toEqual([])
    await ext.toolCall('bash', { command: 'git push' })
    expect(commandsRun()).toEqual(['git-guard'])
  })

  it('never runs an if-carrying hook on a non-tool event', async () => {
    // Claude: "On other events, a hook with `if` set never runs."
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'stopper', if: 'Bash(git *)' }] }] })
    await ext.agentEnd()
    expect(commandsRun()).toEqual([])
  })

  it('ignores a stray matcher on an event without matcher support', async () => {
    // Claude: "If you add a matcher field to an event without matcher support, it
    // is silently ignored."
    const ext = await withHooks({ Stop: [{ matcher: 'SomethingElse', hooks: [{ command: 'stopped' }] }] })
    await ext.agentEnd()
    expect(commandsRun()).toEqual(['stopped'])
  })
})

describe('prompt-style decisions on Stop and PostToolUse', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('blocks the stop when a hook answers with a permissionDecision deny', async () => {
    // A type: "prompt"/"agent" hook's reply arrives as stdout in this shape.
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'gate' }] }] })
    script('gate', { stdout: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'tests are red' } })], code: 0 })
    await ext.agentEnd()
    expect(ext.sent).toEqual([{ message: { customType: 'claude-stop-hook', content: 'tests are red', display: true }, options: { triggerTurn: true } }])
  })

  it('blocks the stop on the documented prompt-hook ok:false schema', async () => {
    // Claude: prompt hooks respond {"ok": false, "reason": ...}; on Stop the reason
    // is fed back and the turn continues.
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'gate' }] }] })
    script('gate', { stdout: [JSON.stringify({ ok: false, reason: 'not done yet' })], code: 0 })
    await ext.agentEnd()
    expect(ext.sent).toEqual([{ message: { customType: 'claude-stop-hook', content: 'not done yet', display: true }, options: { triggerTurn: true } }])
  })

  it('feeds an ok:false PostToolUse verdict back as feedback next to the result', async () => {
    const ext = await withHooks({ PostToolUse: [{ hooks: [{ command: 'review' }] }] })
    script('review', { stdout: [JSON.stringify({ ok: false, reason: 'lint failed' })], code: 0 })
    const patch = (await ext.toolResult('bash', { input: { command: 'x' }, content: [{ type: 'text', text: 'out' }] })) as { content: Array<{ text?: string }> }
    expect(patch.content.some((block) => block.text?.includes('lint failed'))).toBe(true)
  })
})

describe('hooks polish: interrupts, timeout defaults, prompt-hook contract', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('does not run Stop hooks when the turn ended on a user interrupt', async () => {
    // Claude: Stop "does not run if the stoppage occurred due to a user interrupt";
    // pi marks the aborted turn's final assistant message stopReason "aborted".
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'stopper' }] }] })
    await ext.agentEnd([{ role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' }])
    expect(commandsRun()).toEqual([])
  })

  it('still runs Stop hooks for a normally completed turn', async () => {
    const ext = await withHooks({ Stop: [{ hooks: [{ command: 'stopper' }] }] })
    await ext.agentEnd([{ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }])
    expect(commandsRun()).toEqual(['stopper'])
  })

  it('gives prompt hooks the documented 30s default and keeps command hooks at the noted 60s', () => {
    // Claude defaults: 30 for prompt, 60 for agent; the 60s command default is
    // pi-code's documented fail-closed divergence from Claude's 600.
    expect(timeoutMs({ command: 'x', type: 'prompt' })).toBe(30_000)
    expect(timeoutMs({ command: 'x', type: 'agent' })).toBe(60_000)
    expect(timeoutMs({ command: 'x' })).toBe(60_000)
  })

  it('caps SessionEnd hooks at the documented 1.5s budget, raised by a declared timeout up to 60s', () => {
    // Claude: "SessionEnd hooks share a 1.5-second budget; if your settings set a
    // longer per-hook timeout, Claude Code raises the budget to match, up to 60s."
    expect(sessionEndTimeoutMs({ command: 'x' })).toBe(1500)
    expect(sessionEndTimeoutMs({ command: 'x', timeout: 10 })).toBe(10_000)
    expect(sessionEndTimeoutMs({ command: 'x', timeout: 300 })).toBe(60_000)
  })

  it('appends the input JSON to a prompt hook that has no $ARGUMENTS placeholder', async () => {
    // Claude: "If $ARGUMENTS is not present, input JSON is appended to the prompt."
    let seenPrompt = ''
    setCompleteBackend((async (_model: unknown, context: { messages: Array<{ content: string }> }) => {
      seenPrompt = context.messages[0]?.content ?? ''
      return { role: 'assistant', content: [{ type: 'text', text: '{}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 }
    }) as never)
    const result = await runPromptHook({ command: '', type: 'prompt', prompt: 'Should this stop?' }, { hook_event_name: 'Stop' }, { id: 'session-model' } as never, 5000)
    expect(result.code).toBe(0)
    expect(seenPrompt).toContain('Should this stop?')
    expect(seenPrompt).toContain('"hook_event_name":"Stop"')
  })
})

describe('hooks extension PostModelSwitch', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('runs PostModelSwitch hooks after a model change, matched against the new model', async () => {
    // Claude runs PostModelSwitch after the session's model changes; the matcher
    // compares against the canonical name of the model switched to.
    const ext = await withHooks({
      PostModelSwitch: [
        { matcher: '.*opus.*', hooks: [{ command: 'on-opus' }] },
        { matcher: '.*haiku.*', hooks: [{ command: 'on-haiku' }] },
      ],
    })
    await ext.modelSelect('claude-opus-5', 'claude-sonnet-5', 'set')

    expect(commandsRun()).toEqual(['on-opus'])
    const stdin = JSON.parse(recordFor('on-opus').stdin)
    expect(stdin).toMatchObject({ hook_event_name: 'PostModelSwitch', from_model: 'claude-sonnet-5', to_model: 'claude-opus-5', source: 'command' })
  })

  it("maps pi's model_select sources onto Claude's vocabulary", async () => {
    const ext = await withHooks({ PostModelSwitch: [{ hooks: [{ command: 'switched' }] }] })
    await ext.modelSelect('claude-opus-5', 'claude-sonnet-5', 'restore')

    // pi's restore (model restored on resume) is Claude's "resume".
    expect(JSON.parse(recordFor('switched').stdin).source).toBe('resume')
  })
})

describe('hooks extension SessionStart compact source', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('fires SessionStart with source compact after a compaction, alongside PostCompact', async () => {
    // Claude fires SessionStart with source "compact" when a session continues
    // after compaction, in addition to the PostCompact event itself.
    const ext = await withHooks({
      SessionStart: [{ matcher: 'compact', hooks: [{ command: 'fresh-context' }] }],
      PostCompact: [{ hooks: [{ command: 'post-compact' }] }],
    })
    await ext.compacted('manual')

    expect(commandsRun().sort()).toEqual(['fresh-context', 'post-compact'])
    expect(JSON.parse(recordFor('fresh-context').stdin)).toMatchObject({ hook_event_name: 'SessionStart', source: 'compact' })
  })

  it('does not fire compact-matched SessionStart hooks on a startup begin', async () => {
    const ext = await withHooks({ SessionStart: [{ matcher: 'compact', hooks: [{ command: 'fresh-context' }] }] })
    await ext.agentEnd()
    expect(commandsRun()).toEqual([])
    void ext
  })
})

describe('hooks extension dedup scope', () => {
  it('keeps a plugin copy of a settings-file handler separate, running both', async () => {
    // Claude: "If you define the same handler in more than one settings file, it
    // runs once. A plugin's or skill's copy of the same handler stays separate."
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'fmt', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: 'shared-format.sh' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { fmt: true }, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ command: 'shared-format.sh' }] }] } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolResult('write', { input: { path: 'a.ts' } })

    expect(commandsRun()).toEqual(['shared-format.sh', 'shared-format.sh'])
  })
})

describe('hooks from managed policy settings', () => {
  it('runs hooks declared in managed settings', async () => {
    // Claude's hook locations include managed policy settings.
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-guard' }] }] } }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['managed-guard'])
  })

  it('keeps managed hooks running when settings-level disableAllHooks is set', async () => {
    // Claude: disableAllHooks in user/project/local settings cannot disable hooks
    // an administrator configured through managed policy settings.
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-guard' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'user-guard' }] }] } }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['managed-guard'])
  })

  it('turns managed hooks off only via managed-level disableAllHooks', async () => {
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ disableAllHooks: true, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-guard' }] }] } }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual([])
  })
})

describe('hooks from skill frontmatter', () => {
  const invokeSkill = (ext: ReturnType<typeof setupExtension>, hooks: unknown, skillName = 'secure-ops') => {
    ext.emitSkillHooks({ skillName, hooks })
  }

  it('registers skill hooks at invocation and keeps them for the rest of the session', async () => {
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    invokeSkill(ext, { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'skill-guard' }] }] })
    await ext.toolCall('bash', {})
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['skill-guard', 'skill-guard'])
  })

  it('removes a once hook after its first successful run', async () => {
    // Claude: once removes the hook after its first successful run; honored only
    // for skill-frontmatter hooks.
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    invokeSkill(ext, { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'skill-once', once: true }] }] })
    await ext.toolCall('bash', {})
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['skill-once'])
  })

  it('keeps a once hook in place after a failing run', async () => {
    // Claude: a run that fails, blocks with exit code 2, or times out leaves the
    // hook in place, so it runs again on the next matching event.
    script('skill-once', { code: 1 })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    invokeSkill(ext, { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'skill-once', once: true }] }] })
    await ext.toolCall('bash', {})
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['skill-once', 'skill-once'])
  })

  it('ignores once on a settings-file hook', async () => {
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'settings-once', once: true }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['settings-once', 'settings-once'])
  })
})

describe('hooks compact and timing fields', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('passes custom_instructions from a manual /compact to PreCompact hooks', async () => {
    const ext = await withHooks({ PreCompact: [{ hooks: [{ command: 'pre-compact' }] }] })
    await ext.beforeCompact('manual', 'keep the failing test list')

    expect(JSON.parse(recordFor('pre-compact').stdin)).toMatchObject({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'keep the failing test list' })
  })

  it('sends empty custom_instructions on an automatic compaction', async () => {
    const ext = await withHooks({ PreCompact: [{ hooks: [{ command: 'pre-compact' }] }] })
    await ext.beforeCompact('threshold')

    expect(JSON.parse(recordFor('pre-compact').stdin).custom_instructions).toBe('')
  })

  it('passes the compaction summary to PostCompact hooks as compact_summary', async () => {
    const ext = await withHooks({ PostCompact: [{ hooks: [{ command: 'post-compact' }] }] })
    await ext.compacted('auto', 'what happened so far')

    expect(JSON.parse(recordFor('post-compact').stdin)).toMatchObject({ hook_event_name: 'PostCompact', compact_summary: 'what happened so far' })
  })

  it('reports the tool execution time as duration_ms on PostToolUse', async () => {
    vi.useFakeTimers()
    const ext = await withHooks({ PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'post-timing' }] }] })
    await ext.toolCall('bash', { command: 'sleep 2' })
    await vi.advanceTimersByTimeAsync(1234)
    await ext.toolResult('bash', { input: { command: 'sleep 2' } })
    await vi.runAllTimersAsync()

    expect(JSON.parse(recordFor('post-timing').stdin).duration_ms).toBe(1234)
  })
})

describe('hooks suppressOriginalPrompt', () => {
  const withHooks = async (config: Record<string, unknown>) => {
    writeSettings(hoisted.home, 'settings.json', config)
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  it('honors continue:false over a Stop hook decision, showing its stopReason', async () => {
    // Claude: continue "takes precedence over any event-specific decision fields", and
    // stopReason is the "message shown to the user when continue is false". A hook that
    // sets both was continuing the turn on the strength of the field it overrides.
    writeSettings(hoisted.home, 'settings.json', { Stop: [{ hooks: [{ command: 'halt' }] }] })
    script('halt', { stdout: ['{"decision":"block","reason":"keep going","continue":false,"stopReason":"budget spent"}'] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    await ext.agentEnd([{ role: 'assistant', content: 'done' }])

    expect(ext.sent).toEqual([])
    expect(ext.notes.at(-1)?.msg).toContain('budget spent')
  })

  it('reports effort in Claude vocabulary, omitting it when thinking is off', async () => {
    // Claude's effort levels are low, medium, high, xhigh and max. pi adds minimal and
    // off, which a hook keying on the documented set cannot read.
    const ext = await withHooks({ PreToolUse: [{ hooks: [{ command: 'effort-probe' }] }] })

    await ext.toolCall('bash', { command: 'x' }, 't1', { thinkingLevel: 'minimal' })
    expect(JSON.parse(recordFor('effort-probe').stdin).effort).toEqual({ level: 'low' })

    hoisted.calls.length = 0
    await ext.toolCall('bash', { command: 'x' }, 't1', { thinkingLevel: 'off' })
    expect(JSON.parse(recordFor('effort-probe').stdin).effort).toBeUndefined()
  })

  it('keeps the prompt when a non-blocking hook sets suppressOriginalPrompt', async () => {
    // Claude scopes the field to a block: "If true when decision is block, omits the
    // original prompt text from the block message shown to the user", and separately
    // "UserPromptSubmit: can't replace the prompt; it only injects additionalContext
    // alongside it". Treating it as a replacement dropped what the user actually typed.
    script('suppress', { stdout: ['{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CTX","suppressOriginalPrompt":true}}'], code: 0 })
    const ext = await withHooks({ UserPromptSubmit: [{ hooks: [{ command: 'suppress' }] }] })

    const result = (await ext.input('the original prompt')) as { action: string; text?: string }
    expect(result.action).toBe('transform')
    expect(result.text).toBe('CTX\n\nthe original prompt')
  })

  it('never echoes the prompt in a block message, which is what the field asks for', async () => {
    script('deny', { stdout: ['{"decision":"block","reason":"no secrets in prompts","hookSpecificOutput":{"suppressOriginalPrompt":true}}'], code: 0 })
    const ext = await withHooks({ UserPromptSubmit: [{ hooks: [{ command: 'deny' }] }] })

    expect(await ext.input('my api key is sk-live-123')).toEqual({ action: 'handled' })
    expect(ext.notes.at(-1)?.msg).toBe('no secrets in prompts')
    expect(ext.notes.at(-1)?.msg).not.toContain('sk-live-123')
  })

  it('keeps the prompt when no hook suppresses it', async () => {
    script('ctx', { stdout: ['{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CTX"}}'], code: 0 })
    const ext = await withHooks({ UserPromptSubmit: [{ hooks: [{ command: 'ctx' }] }] })

    const result = (await ext.input('keep me')) as { action: string; text?: string }
    expect(result.text).toBe('CTX\n\nkeep me')
  })
})

describe('hook error notices', () => {
  it('surfaces a hook error notice for malformed JSON output instead of using it as context', async () => {
    // Claude: when {..}-shaped stdout cannot be parsed, the transcript shows a
    // hook error notice and the text is not added as context.
    script('bad-json', { stdout: ['{"decision": nope}'], code: 0 })
    writeSettings(hoisted.home, 'settings.json', { UserPromptSubmit: [{ hooks: [{ command: 'bad-json' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    const result = (await ext.input('hello')) as { action: string; text?: string }
    expect(result.action).toBe('continue')
    expect(ext.notes.some((note) => note.msg.includes('hook error'))).toBe(true)
  })
})

describe('hooks SubagentStart context seam', () => {
  it('serves SubagentStart hooks through the pre-spawn runner, returning their context', async () => {
    // Claude: SubagentStart hooks inject additionalContext into the subagent
    // before its first prompt, so they must run before the child spawns; the
    // subagent extension calls this seam pre-spawn.
    const { runSubagentStartHooks } = await import('../extensions/internal/subagent-hooks.ts')
    script('sub-start', { stdout: ['{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"security rules"}}'], code: 0 })
    writeSettings(hoisted.home, 'settings.json', { SubagentStart: [{ matcher: 'scout', hooks: [{ command: 'sub-start' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    const contexts = await runSubagentStartHooks('scout', 'fg-1')
    expect(commandsRun()).toEqual(['sub-start'])
    expect(contexts).toEqual(['security rules'])
    expect(JSON.parse(recordFor('sub-start').stdin)).toMatchObject({ hook_event_name: 'SubagentStart', agent_type: 'scout', agent_id: 'fg-1' })
  })

  it('no longer double-runs SubagentStart from the bus start event', async () => {
    writeSettings(hoisted.home, 'settings.json', { SubagentStart: [{ hooks: [{ command: 'sub-start' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    await ext.emitSubagent({ phase: 'start', agentType: 'scout', agentId: 'fg-1' })
    expect(commandsRun()).toEqual([])
  })
})

describe('hooks from agent frontmatter in the child', () => {
  const withAgentHooks = async (hooks: unknown) => {
    process.env.PI_CODE_SUBAGENT = '1'
    process.env.PI_CODE_AGENT_HOOKS = JSON.stringify({ agent: 'scout', id: 'fg-9', hooks })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    return ext
  }

  afterEach(() => {
    delete process.env.PI_CODE_SUBAGENT
    delete process.env.PI_CODE_AGENT_HOOKS
  })

  it('runs agent-frontmatter hooks inside the subagent child', async () => {
    const ext = await withAgentHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'agent-guard' }] }] })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['agent-guard'])
  })

  it('fires the converted Stop hook as SubagentStop when the child finishes', async () => {
    // Claude converts a Stop hook in agent frontmatter to SubagentStop, the event
    // fired when the subagent completes; in the child that is its own agent end.
    const ext = await withAgentHooks({ SubagentStop: [{ hooks: [{ command: 'agent-done' }] }] })
    await ext.agentEnd()

    expect(commandsRun()).toEqual(['agent-done'])
    expect(JSON.parse(recordFor('agent-done').stdin)).toMatchObject({ hook_event_name: 'SubagentStop', agent_type: 'scout', agent_id: 'fg-9' })
  })
})

describe('allowManagedHooksOnly', () => {
  it('runs only managed hooks when the managed policy sets allowManagedHooksOnly', async () => {
    // Claude: "Your user, project, local, and plugin hooks are blocked."
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-only' }] }] } }))
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'user-blocked' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['managed-only'])
  })

  it('exempts hooks from a plugin the managed policy force-enables', async () => {
    // Claude: "Your user, project, local, and plugin hooks are blocked. Hooks from
    // plugins force-enabled in managed settings `enabledPlugins` are exempt."
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'guard', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard-hook' }] }] } }))
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true, enabledPlugins: { guard: true }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-only' }] }] } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun().sort()).toEqual(['guard-hook', 'managed-only'])
  })

  it('lets a settings-level disableAllHooks still silence a force-enabled plugin', async () => {
    // The exemption is from allowManagedHooksOnly, not from the user's escape hatch. A
    // settings-file disableAllHooks turns off every non-managed hook, and a plugin hook
    // is non-managed however it came to be enabled; only managed policy hooks survive it.
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'noisy', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'noisy-hook' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }))
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true, enabledPlugins: { noisy: true }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-only' }] }] } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['managed-only'])
  })

  it('still blocks a plugin the managed policy does not force-enable', async () => {
    const root = join(hoisted.home, '.claude', 'plugins', 'cache', 'market', 'other', '1.0.0')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'other-hook' }] }] } }))
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { other: true } }))
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'managed-only' }] }] } }))

    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual(['managed-only'])
  })

  it('blocks skill-frontmatter hooks too under allowManagedHooksOnly', async () => {
    writeFileSync(join(hoisted.home, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true }))
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    ext.emitSkillHooks({ skillName: 's', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'skill-blocked' }] }] } })
    await ext.toolCall('bash', {})

    expect(commandsRun()).toEqual([])
  })
})

describe('settings watching', () => {
  it('picks up a settings edit mid-session without a restart', async () => {
    // Claude: "Direct edits to hooks in settings files are normally picked up
    // automatically by the file watcher."
    process.env.PI_CODE_SETTINGS_WATCH_INTERVAL_MS = '25'
    try {
      writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'before-edit' }] }] })
      const ext = setupExtension()
      await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

      writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'after-edit' }] }] })
      await vi.waitFor(
        async () => {
          hoisted.calls.length = 0
          await ext.toolCall('bash', {})
          expect(commandsRun()).toEqual(['after-edit'])
        },
        { timeout: 3000, interval: 100 },
      )
    } finally {
      delete process.env.PI_CODE_SETTINGS_WATCH_INTERVAL_MS
    }
  })
})

describe('mcp_tool hook dispatch', () => {
  afterEach(() => setMcpToolCaller(undefined))

  it('routes a configured mcp_tool hook through the dispatcher to the caller seam', async () => {
    // The type === 'mcp_tool' dispatch arm had no end-to-end path: config ->
    // matcher -> boundRunner -> runMcpToolHook -> the seam, with the tool's
    // verdict feeding the decision like any command hook's stdout.
    const calls: Array<[string, string, Record<string, unknown>]> = []
    setMcpToolCaller(async (server, tool, input) => {
      calls.push([server, tool, input])
      return { text: JSON.stringify({ decision: 'block', reason: 'mcp guard says no' }), isError: false }
    })
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'guard-srv', tool: 'vet', input: { command: '${tool_input.command}' } }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    const decision = (await ext.toolCall('bash', { command: 'rm -rf /' })) as { block: boolean; reason?: string }

    expect(calls).toEqual([['guard-srv', 'vet', { command: 'rm -rf /' }]])
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('mcp guard says no')
  })

  it('lets the tool proceed when the mcp_tool hook returns no verdict', async () => {
    setMcpToolCaller(async () => ({ text: 'all fine', isError: false }))
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'guard-srv', tool: 'vet' }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })

    expect(await ext.toolCall('bash', { command: 'ls' })).toBeUndefined()
  })
})

describe('prompt hook model override', () => {
  afterEach(() => setCompleteBackend(null))

  const answer = { role: 'assistant', content: [{ type: 'text', text: '{"hookSpecificOutput":{"permissionDecision":"allow"}}' }], api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 }

  const runWith = async (override: string | undefined, available: Array<{ id: string; name?: string }>) => {
    const seen: string[] = []
    setCompleteBackend(async (model) => {
      seen.push((model as { id: string }).id)
      return answer as never
    })
    writeSettings(hoisted.home, 'settings.json', { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'ok? $ARGUMENTS', ...(override === undefined ? {} : { model: override }) }] }] })
    const ext = setupExtension()
    await ext.sessionStart('startup', { cwd: tempDir('hooks-proj-') })
    await ext.toolCall('bash', { command: 'ls' }, 't1', { model: { id: 'session-model' }, modelRegistry: { getAvailable: () => available } })
    return seen
  }

  it('resolves an exact model id from the registry', async () => {
    expect(await runWith('guard-9', [{ id: 'big-1' }, { id: 'guard-9' }])).toEqual(['guard-9'])
  })

  it('falls back to a substring match on id or display name', async () => {
    expect(await runWith('haiku', [{ id: 'big-1' }, { id: 'small-haiku-2', name: 'Small Haiku' }])).toEqual(['small-haiku-2'])
  })

  it('uses the session model when the override matches nothing or is absent', async () => {
    expect(await runWith('nope', [{ id: 'big-1' }])).toEqual(['session-model'])
    expect(await runWith(undefined, [{ id: 'big-1' }])).toEqual(['session-model'])
  })
})
