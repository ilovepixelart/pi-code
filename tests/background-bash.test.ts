import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { type CreateAgentSessionRuntimeFactory, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createBashToolDefinition, SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import backgroundBashExtension, { backgroundAllowed, foregroundLimitMs, startsWithSleep } from '../extensions/background-bash.ts'
import { allShells, commandPreview, forgetShell, MAX_FINISHED_SHELLS, markBackground, registerShell, resetShells, runningShells, setShellsListener, settleShell, shellCompletionText, shellOutputDir, shellsFooterText, shellsStatusText, stopAllShells, stopShell } from '../extensions/internal/background-shells.ts'
import { CLAUDE_TOOL_MAP, claudeToolName } from '../extensions/internal/claude-tool-names.ts'
import monitorExtension from '../extensions/monitor.ts'

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: { exit_code?: number } }
type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void, ctx?: unknown) => Promise<ToolResult>
type Handler = (event: Record<string, unknown>, ctx: unknown) => void
type Sent = { message: { customType: string; content: string }; options: { triggerTurn?: boolean } }

interface Harness {
  bash: Execute
  stop: Execute
  tool: (name: string) => { description: string; parameters: { properties: Record<string, unknown> }; promptGuidelines?: string[] }
  sent: Sent[]
  emit: (event: string, payload?: Record<string, unknown>) => void
  ctx: Record<string, unknown>
  footer: () => string | undefined
  active: () => string[]
}

const setup = (options: { hasUI?: boolean; prompted?: boolean; maxOutputBytes?: number; active?: string[] } = {}): Harness => {
  const tools = new Map<string, { name: string; execute: Execute; description: string; parameters: { properties: Record<string, unknown> }; promptGuidelines?: string[] }>()
  const handlers = new Map<string, Handler[]>()
  const sent: Sent[] = []
  let active = options.active ?? ['read', 'bash', 'task_stop']
  const pi = {
    registerTool: (tool: { name: string; execute: Execute; description: string; parameters: { properties: Record<string, unknown> } }) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent['message'], opts: Sent['options']) => sent.push({ message, options: opts }),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
  }
  backgroundBashExtension(pi as never, { maxOutputBytes: options.maxOutputBytes })
  const statuses = new Map<string, string | undefined>()
  const ctx = {
    cwd: os.tmpdir(),
    ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value), theme: { fg: (_color: string, value: string) => value } },
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => 'test-session',
      getSessionFile: () => undefined,
      getBranch: () => (options.prompted === false ? [] : [{ type: 'message' }]),
    },
  }
  const emit = (event: string, payload: Record<string, unknown> = {}): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx)
  }
  emit('session_start')
  const get = (name: string) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`${name} was not registered`)
    return tool
  }
  return {
    bash: (id, params, signal, onUpdate) => get('bash').execute(id, params, signal, onUpdate, ctx),
    stop: (id, params) => get('task_stop').execute(id, params, undefined, undefined, ctx),
    tool: get,
    sent,
    emit,
    ctx,
    footer: () => statuses.get('background-shells'),
    active: () => active,
  }
}

const textOf = (result: ToolResult): string => result.content.map((part) => part.text).join('')
const idOf = (result: ToolResult): string => {
  const match = /ID:? (b[0-9a-f]{8})/.exec(textOf(result))
  if (!match?.[1]) throw new Error(`no task id in: ${textOf(result)}`)
  return match[1]
}
const until = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// For the suites that run real commands. A stopped shell is killed asynchronously: wait
// for it, so no process outlives the file. A shell a test already stopped counts too: it
// has no stop handle left but its process is still on its way out.
const stopAndWait = async (): Promise<void> => {
  const live = allShells().filter((shell) => shell.finishedAt === undefined && (shell.stop !== undefined || shell.state === 'killed'))
  resetShells()
  await until(() => live.every((shell) => shell.finishedAt !== undefined))
}

beforeEach(() => resetShells())
afterEach(() => resetShells())

describe('foregroundLimitMs', () => {
  it('defaults to two minutes when no timeout is passed', () => {
    expect(foregroundLimitMs(undefined, {})).toBe(120_000)
  })

  it('takes BASH_DEFAULT_TIMEOUT_MS as the default', () => {
    expect(foregroundLimitMs(undefined, { BASH_DEFAULT_TIMEOUT_MS: '5000' })).toBe(5000)
  })

  it('ignores an unusable default', () => {
    for (const raw of ['', ' ', 'abc', '0', '-5']) expect(foregroundLimitMs(undefined, { BASH_DEFAULT_TIMEOUT_MS: raw })).toBe(120_000)
  })

  it('honours a requested timeout, given in seconds', () => {
    expect(foregroundLimitMs(30, {})).toBe(30_000)
  })

  it('caps a requested timeout at ten minutes', () => {
    expect(foregroundLimitMs(3600, {})).toBe(600_000)
  })

  it('caps at the larger of the default and BASH_MAX_TIMEOUT_MS', () => {
    expect(foregroundLimitMs(3600, { BASH_MAX_TIMEOUT_MS: '60000' })).toBe(120_000)
    expect(foregroundLimitMs(3600, { BASH_DEFAULT_TIMEOUT_MS: '900000', BASH_MAX_TIMEOUT_MS: '60000' })).toBe(900_000)
    expect(foregroundLimitMs(3600, { BASH_MAX_TIMEOUT_MS: '1800000' })).toBe(1_800_000)
  })
})

describe('startsWithSleep', () => {
  it.each([
    ['sleep 5', true],
    ['  sleep 5 && echo hi', true],
    ['sleep', true],
    ['sleepy 5', false],
    ['echo sleep 5', false],
    ['npm test', false],
  ])('%s -> %s', (command, expected) => {
    expect(startsWithSleep(command)).toBe(expected)
  })
})

describe('backgroundAllowed', () => {
  it('needs a UI and background tasks left enabled', () => {
    expect(backgroundAllowed({ hasUI: true }, {})).toBe(true)
    expect(backgroundAllowed({ hasUI: false }, {})).toBe(false)
    expect(backgroundAllowed({ hasUI: true }, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })).toBe(false)
    expect(backgroundAllowed({ hasUI: true }, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' })).toBe(true)
  })
})

describe('background shell registry', () => {
  const fakeShell = (id: string) => {
    const outputFile = `${shellOutputDir()}/${id}.output`
    fs.writeFileSync(outputFile, 'x')
    return registerShell({ id, command: `cmd ${id}`, outputFile, stop: () => {} })
  }

  it('settles a command as completed or failed by its exit code', () => {
    const ok = fakeShell('b00000001')
    const bad = fakeShell('b00000002')
    const unknown = fakeShell('b00000003')
    settleShell(ok, 0)
    settleShell(bad, 2)
    settleShell(unknown, undefined)
    expect([ok.state, bad.state, unknown.state]).toEqual(['completed', 'failed', 'failed'])
  })

  it('keeps a stopped command stopped when its exit arrives', () => {
    const shell = fakeShell('b00000004')
    expect(stopShell(' b00000004 ')).toBe('stopped')
    settleShell(shell, 143)
    expect(shell.state).toBe('killed')
    expect(stopShell('b00000004')).toBe('not-running')
    expect(stopShell('nope')).toBe('unknown')
  })

  it('evicts the earliest-finished commands beyond the cap', () => {
    const shells = Array.from({ length: MAX_FINISHED_SHELLS + 2 }, (_, i) => fakeShell(`b${String(i).padStart(8, '0')}`))
    for (const shell of shells) settleShell(shell, 0)
    const ids = allShells().map((shell) => shell.id)
    expect(ids).toHaveLength(MAX_FINISHED_SHELLS)
    expect(ids).not.toContain(shells[0]?.id)
    expect(ids).not.toContain(shells[1]?.id)
  })

  it('removes the output file of an evicted command, and no other', () => {
    const shells = Array.from({ length: MAX_FINISHED_SHELLS + 1 }, (_, i) => fakeShell(`b${String(i).padStart(8, '0')}`))
    for (const shell of shells) settleShell(shell, 0)
    expect(shells.map((shell) => fs.existsSync(shell.outputFile))).toEqual([false, ...shells.slice(1).map(() => true)])
  })

  it('forgets a foreground command and its output file', () => {
    const shell = fakeShell('b00000005')
    forgetShell(shell)
    expect(allShells()).toHaveLength(0)
    expect(fs.existsSync(shell.outputFile)).toBe(false)
  })

  it('recreates the output directory if it was removed', () => {
    const first = shellOutputDir()
    fs.rmSync(first, { recursive: true, force: true })
    const second = shellOutputDir()
    expect(fs.existsSync(second)).toBe(true)
  })

  it('stopAllShells stops running commands and removes the output directory', () => {
    let stopped = 0
    const dir = shellOutputDir()
    registerShell({ id: 'b00000006', command: 'a', outputFile: `${dir}/a`, stop: () => stopped++ })
    settleShell(registerShell({ id: 'b00000007', command: 'b', outputFile: `${dir}/b` }), 0)
    expect(stopAllShells()).toBe(1)
    expect(stopped).toBe(1)
    expect(fs.existsSync(dir)).toBe(false)
    expect(stopAllShells()).toBe(0)
  })

  it('formats a listing and completion notices', () => {
    expect(shellsStatusText([])).toBe('')
    const base = { id: 'b1', command: 'npm   run\n dev', outputFile: '/tmp/b1.output', background: true }
    expect(shellsStatusText([{ ...base, state: 'running' }])).toBe('b1 shell: running - npm run dev\n  output: /tmp/b1.output')
    expect(shellsStatusText([{ ...base, state: 'killed' }])).toContain('stopped')
    expect(shellsStatusText([{ ...base, state: 'failed', exitCode: 1 }])).toContain('failed (exit code 1)')
    expect(shellsStatusText([{ ...base, state: 'failed' }])).toContain('failed (exit code ?)')
    expect(shellCompletionText({ ...base, state: 'completed', exitCode: 0 })).toBe('Background command b1 ("npm run dev") completed (exit code 0). Output: /tmp/b1.output')
    expect(shellCompletionText({ ...base, state: 'failed', exitCode: 3 })).toContain('failed (exit code 3)')
    expect(shellCompletionText({ ...base, state: 'failed' })).toContain('failed (exit code ?)')
    expect(shellCompletionText({ ...base, state: 'killed' })).toContain('was stopped')
  })

  it('clips long commands in previews', () => {
    const preview = commandPreview(`echo ${'😀'.repeat(100)}`)
    expect(Array.from(preview)).toHaveLength(80)
    expect(preview.endsWith('…')).toBe(true)
  })
})

describe('bash tool', () => {
  afterEach(stopAndWait)

  it('extends the built-in schema and prompt with background guidance', () => {
    const h = setup()
    const bash = h.tool('bash')
    expect(Object.keys(bash.parameters.properties)).toEqual(['command', 'timeout', 'run_in_background'])
    expect(bash.description).toContain('run_in_background')
    expect(bash.promptGuidelines?.join('\n')).toContain('task_stop')
  })

  it.each([{ hasUI: true }, { hasUI: false }])('keeps what the built-in definition carries and the override does not replace (hasUI: $hasUI)', (options) => {
    const replaced = new Set(['description', 'promptGuidelines', 'parameters', 'execute'])
    const bash = setup(options).tool('bash') as unknown as Record<string, unknown>
    const kept = Object.entries(createBashToolDefinition(os.tmpdir())).filter(([key]) => !replaced.has(key))
    expect(kept.map(([key]) => key)).toEqual(expect.arrayContaining(['outputSchema', 'constrainedSampling', 'promptSnippet']))
    for (const [key, value] of kept) expect(JSON.stringify(bash[key]), key).toBe(JSON.stringify(value))
    for (const [key, value] of kept) expect(typeof bash[key], key).toBe(typeof value)
  })

  it('states the default timeout in force, not a fixed one', () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = '30000'
    const timeout = setup().tool('bash').parameters.properties.timeout as { description: string }
    expect(timeout.description).toContain('after 30 seconds')
    expect(timeout.description).not.toContain('120')
  })

  it('returns a quick command in the foreground, untracked', async () => {
    const h = setup()
    const result = await h.bash('t1', { command: 'echo hello' })
    // The shell's own stderr (a Git Bash startup warning) may precede the output.
    expect(textOf(result)).toContain('hello')
    expect(result.structuredContent?.exit_code).toBe(0)
    expect(allShells()).toHaveLength(0)
  })

  it('reports a failing foreground command as the built-in tool does', async () => {
    const h = setup()
    const result = await h.bash('t1', { command: 'echo nope; exit 3' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Command exited with code 3')
  })

  it('streams foreground output updates', async () => {
    const h = setup()
    const updates: unknown[] = []
    await h.bash('t1', { command: 'echo streamed' }, undefined, (update) => updates.push(update))
    expect(updates.length).toBeGreaterThan(0)
  })

  it('aborting a foreground command kills it', async () => {
    const h = setup()
    const controller = new AbortController()
    const running = h.bash('t1', { command: 'echo started; sleep 10; echo late' }, controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(running).rejects.toThrow('Command aborted')
    expect(allShells()).toHaveLength(0)
  })

  it('honours an already-aborted signal', async () => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(h.bash('t1', { command: 'echo never' }, controller.signal)).rejects.toThrow()
  })

  it.each(['echo quick', 'true'])('leaves no output file behind a call that never reached the background: %s', async (command) => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(h.bash('t1', { command }, controller.signal)).rejects.toThrow()
    await h.bash('t2', { command })
    // A stream still opening when its file was removed would create it now.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fs.readdirSync(shellOutputDir())).toEqual([])
  })

  it('starts a run_in_background command and notifies when it completes', async () => {
    const h = setup()
    const result = await h.bash('t1', { command: 'sleep 0.2; echo finished', run_in_background: true })
    const id = idOf(result)
    expect(textOf(result)).toContain('Command running in background with ID')
    const [shell] = allShells()
    expect(shell?.state).toBe('running')
    await until(() => h.sent.length > 0)
    expect(h.sent[0]?.message.customType).toBe('bash-background')
    expect(h.sent[0]?.message.content).toContain(`Background command ${id}`)
    expect(h.sent[0]?.message.content).toContain('completed (exit code 0)')
    expect(h.sent[0]?.options.triggerTurn).toBe(true)
    expect(fs.readFileSync(shell?.outputFile ?? '', 'utf8')).toContain('finished')
  })

  it('reports a failed background command', async () => {
    const h = setup()
    await h.bash('t1', { command: 'exit 4', run_in_background: true })
    await until(() => h.sent.length > 0)
    expect(h.sent[0]?.message.content).toContain('failed (exit code 4)')
  })

  it('moves a command that reaches its timeout to the background', async () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = '200'
    const h = setup()
    const updates: unknown[] = []
    const result = await h.bash('t1', { command: 'echo early; sleep 0.6; echo late' }, undefined, (update) => updates.push(update))
    expect(textOf(result)).toContain('did not complete within its 0.2s timeout and was moved to the background')
    const seen = updates.length
    await until(() => h.sent.length > 0)
    // The call has returned: no further updates reach it.
    expect(updates.length).toBe(seen)
    const output = fs.readFileSync(allShells()[0]?.outputFile ?? '', 'utf8')
    expect(output).toContain('early')
    expect(output).toContain('late')
  })

  it('keeps a backgrounded command alive when the tool call signal aborts', async () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = '100'
    const h = setup()
    const controller = new AbortController()
    await h.bash('t1', { command: 'echo a; sleep 0.4; echo b' }, controller.signal)
    controller.abort()
    await until(() => h.sent.length > 0)
    expect(h.sent[0]?.message.content).toContain('completed (exit code 0)')
  })

  it('uses a requested timeout as the foreground limit', async () => {
    const h = setup()
    const result = await h.bash('t1', { command: 'echo x; sleep 0.5', timeout: 0.1 })
    expect(textOf(result)).toContain('0.1s timeout')
  })

  it('stops, rather than backgrounds, a command that starts with sleep', async () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = '100'
    const h = setup()
    await expect(h.bash('t1', { command: 'sleep 5' })).rejects.toThrow('timed out after 0.1 seconds')
    expect(allShells()).toHaveLength(0)
  })

  it('backgrounds a sleep command when asked to', async () => {
    const h = setup()
    const result = await h.bash('t1', { command: 'sleep 0.1', run_in_background: true })
    expect(textOf(result)).toContain('running in background')
  })

  it('passes an invalid timeout to the built-in tool', async () => {
    const h = setup()
    await expect(h.bash('t1', { command: 'echo x', timeout: -1 })).rejects.toThrow('Invalid timeout')
  })

  describe.each([
    ['with background tasks disabled', { env: '1' }],
    ['in a session without a UI', { hasUI: false }],
  ])('%s', (_name, { env, hasUI }: { env?: string; hasUI?: boolean }) => {
    const off = (): Harness => {
      if (env) process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = env
      return setup({ hasUI })
    }

    it('does not offer run_in_background or mention background commands', () => {
      const bash = off().tool('bash')
      expect(Object.keys(bash.parameters.properties)).toEqual(['command', 'timeout'])
      expect(JSON.stringify([bash.description, bash.parameters, bash.promptGuidelines])).not.toMatch(/background|task_stop/)
      expect((bash.parameters.properties.timeout as { description: string }).description).toContain('stopped after 120 seconds')
    })

    it('rejects run_in_background instead of blocking on the command', async () => {
      const h = off()
      await expect(h.bash('t1', { command: 'sleep 2', run_in_background: true })).rejects.toThrow('Background commands are not available')
      expect(allShells()).toHaveLength(0)
    })

    it('stops a command at the default timeout', async () => {
      process.env.BASH_DEFAULT_TIMEOUT_MS = '100'
      const h = off()
      await expect(h.bash('t1', { command: 'echo early; sleep 2' })).rejects.toThrow('timed out after 0.1 seconds')
      expect(allShells()).toHaveLength(0)
    })

    it('caps a requested timeout', async () => {
      process.env.BASH_DEFAULT_TIMEOUT_MS = '100'
      process.env.BASH_MAX_TIMEOUT_MS = '200'
      const h = off()
      await expect(h.bash('t1', { command: 'echo early; sleep 2', timeout: 60 })).rejects.toThrow('timed out after 0.2 seconds')
    })

    it('runs a quick command', async () => {
      const result = await off().bash('t1', { command: 'echo quick' })
      expect(textOf(result)).toContain('quick')
      expect(result.structuredContent?.exit_code).toBe(0)
    })
  })

  it('records the notice without a turn before the session has had one', async () => {
    const h = setup({ prompted: false })
    await h.bash('t1', { command: 'echo hi', run_in_background: true })
    await until(() => h.sent.length > 0)
    expect(h.sent[0]?.options.triggerTurn).toBe(false)
  })

  it('holds a notice while no session is attached and delivers it to the next one', async () => {
    const h = setup()
    await h.bash('t1', { command: 'sleep 0.2', run_in_background: true })
    h.emit('session_shutdown', { reason: 'new' })
    await until(() => allShells()[0]?.state === 'completed')
    expect(h.sent).toHaveLength(0)
    const next = setup()
    expect(next.sent).toHaveLength(1)
  })

  it('starts turns once the session has been prompted', async () => {
    const h = setup({ prompted: false })
    h.emit('agent_start')
    await h.bash('t1', { command: 'echo hi', run_in_background: true })
    await until(() => h.sent.length > 0)
    expect(h.sent[0]?.options.triggerTurn).toBe(true)
  })

  describe('output', () => {
    const CAP = 4096
    // pi's built-in tool saves the full text of output it truncates to a file of its own.
    const builtinCopies = (): string[] => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('pi-bash-'))
    const sizeOf = (file: string | undefined): number => fs.statSync(file ?? '').size
    // Endless output at a rate that keeps the files small while the cap takes effect.
    const CHATTER = 'while true; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done'

    beforeEach(() => {
      for (const name of builtinCopies()) fs.rmSync(`${os.tmpdir()}/${name}`)
    })

    it('stops a background command whose output passes the cap, and says so', async () => {
      const h = setup({ maxOutputBytes: CAP })
      const id = idOf(await h.bash('t1', { command: CHATTER, run_in_background: true }))
      await until(() => h.sent.length > 0)
      expect(h.sent[0]?.message.content).toContain(`Background command ${id}`)
      expect(h.sent[0]?.message.content).toContain('was stopped: its output passed the 4.0KB limit')
      const [shell] = allShells()
      expect(shell?.state).toBe('killed')
      // Nothing is written past the chunk that crossed the cap; a pipe chunk is at most 64 KB.
      expect(sizeOf(shell?.outputFile)).toBeGreaterThan(CAP)
      expect(sizeOf(shell?.outputFile)).toBeLessThanOrEqual(CAP + 65536)
    })

    it('applies the cap once a command has moved to the background', async () => {
      process.env.BASH_DEFAULT_TIMEOUT_MS = '200'
      const h = setup({ maxOutputBytes: CAP })
      const result = await h.bash('t1', { command: CHATTER })
      expect(textOf(result)).toContain('moved to the background')
      await until(() => h.sent.length > 0)
      expect(h.sent[0]?.message.content).toContain('its output passed the 4.0KB limit')
      await until(() => builtinCopies().length === 0)
    })

    it('leaves a command under the cap alone', async () => {
      const h = setup({ maxOutputBytes: CAP })
      await h.bash('t1', { command: 'echo small', run_in_background: true })
      await until(() => h.sent.length > 0)
      expect(h.sent[0]?.message.content).toContain('completed (exit code 0)')
    })

    it('keeps one copy of a background command output', async () => {
      const h = setup()
      await h.bash('t1', { command: 'seq 1 20000', run_in_background: true })
      await until(() => h.sent.length > 0)
      expect(fs.readFileSync(allShells()[0]?.outputFile ?? '', 'utf8')).toContain('\n20000\n')
      expect(builtinCopies()).toEqual([])
    })

    it('removes the built-in copy of a command that moved to the background', async () => {
      process.env.BASH_DEFAULT_TIMEOUT_MS = '300'
      const h = setup()
      const result = await h.bash('t1', { command: 'seq 1 20000; sleep 0.6; seq 1 20000' })
      expect(textOf(result)).toContain('moved to the background')
      await until(() => h.sent.length > 0)
      await until(() => builtinCopies().length === 0)
      expect(sizeOf(allShells()[0]?.outputFile)).toBe(2 * 108894)
    })

    // Windows may keep listing a removed file until the stream writing it has closed.
    it.skipIf(process.platform === 'win32')('removes the built-in copy at quit, without waiting for the command to end', async () => {
      process.env.BASH_DEFAULT_TIMEOUT_MS = '300'
      const h = setup()
      const updates: unknown[] = []
      await h.bash('t1', { command: 'seq 1 20000; sleep 10' }, undefined, (update) => updates.push(update))
      expect(builtinCopies()).toHaveLength(1)
      h.emit('session_shutdown', { reason: 'quit' })
      expect(builtinCopies()).toEqual([])
    })

    it('keeps the built-in copy a foreground result points at', async () => {
      const h = setup()
      const result = await h.bash('t1', { command: 'seq 1 20000' })
      expect(builtinCopies()).toHaveLength(1)
      expect(textOf(result)).toContain(builtinCopies()[0])
    })
  })

  it('stops every background command when pi quits', async () => {
    const h = setup()
    await h.bash('t1', { command: 'sleep 10', run_in_background: true })
    h.emit('session_shutdown', { reason: 'quit' })
    await until(() => allShells()[0]?.state === 'killed')
    expect(h.sent).toHaveLength(0)
  })
})

describe('footer status', () => {
  afterEach(stopAndWait)

  it('words the count of running background commands', () => {
    expect(shellsFooterText(0)).toBeUndefined()
    expect(shellsFooterText(1)).toBe('⏵ 1 background shell')
    expect(shellsFooterText(3)).toBe('⏵ 3 background shells')
  })

  it('counts a background command while it runs and clears when it finishes', async () => {
    const h = setup()
    expect(h.footer()).toBeUndefined()
    await h.bash('t1', { command: 'sleep 0.3', run_in_background: true })
    expect(h.footer()).toBe('⏵ 1 background shell')
    await until(() => h.sent.length > 0)
    expect(h.footer()).toBeUndefined()
  })

  it('leaves a foreground command out until it moves to the background', async () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = '200'
    const h = setup()
    const seen: Array<string | undefined> = []
    setShellsListener(() => seen.push(shellsFooterText(runningShells())))
    const running = h.bash('t1', { command: 'echo a; sleep 0.5' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(allShells()).toHaveLength(0)
    // A leftover command from another test may settle meanwhile; only a count matters here.
    expect(seen.filter(Boolean)).toEqual([])
    await running
    expect(seen.filter(Boolean)).toEqual(['⏵ 1 background shell'])
    h.emit('session_start')
    expect(h.footer()).toBe('⏵ 1 background shell')
    await until(() => h.sent.length > 0)
  })

  it('updates when a command is stopped, and shows commands kept across a session switch', async () => {
    const h = setup()
    const id = idOf(await h.bash('t1', { command: 'sleep 10', run_in_background: true }))
    h.emit('session_shutdown', { reason: 'new' })
    const next = setup()
    expect(next.footer()).toBe('⏵ 1 background shell')
    await next.stop('t2', { task_id: id })
    expect(next.footer()).toBeUndefined()
  })

  it('survives a listener from a replaced session throwing', () => {
    setShellsListener(() => {
      throw new Error('stale session')
    })
    const shell = registerShell({ id: 'b0000000a', command: 'x', outputFile: `${shellOutputDir()}/x`, background: false })
    expect(() => markBackground(shell)).not.toThrow()
    setShellsListener(undefined)
  })

  it('skips the footer in a session without a UI', async () => {
    const h = setup({ hasUI: false })
    h.emit('session_start')
    expect(h.footer()).toBeUndefined()
  })
})

describe('task_stop tool', () => {
  afterEach(stopAndWait)

  it('stops a running background command without a notice', async () => {
    const h = setup()
    const id = idOf(await h.bash('t1', { command: 'sleep 10', run_in_background: true }))
    expect(textOf(await h.stop('t2', { task_id: id }))).toBe(`Stopped background command ${id}.`)
    await until(() => allShells()[0]?.finishedAt !== undefined)
    expect(allShells()[0]?.state).toBe('killed')
    expect(h.sent).toHaveLength(0)
    expect(textOf(await h.stop('t3', { task_id: id }))).toContain('is not running')
  })

  it("takes the id as shell_id, Claude's deprecated name for it", async () => {
    const h = setup()
    const id = idOf(await h.bash('t1', { command: 'sleep 10', run_in_background: true }))
    expect(textOf(await h.stop('t2', { shell_id: id }))).toBe(`Stopped background command ${id}.`)
    expect(Object.keys(h.tool('task_stop').parameters.properties)).toEqual(['task_id', 'shell_id'])
  })

  it('prefers task_id and rejects a call with neither', async () => {
    const h = setup()
    const id = idOf(await h.bash('t1', { command: 'sleep 10', run_in_background: true }))
    expect(textOf(await h.stop('t2', { task_id: id, shell_id: 'b00000000' }))).toBe(`Stopped background command ${id}.`)
    await expect(h.stop('t3', {})).rejects.toThrow('task_id is required')
  })

  it("answers to Claude's names for the tool", () => {
    for (const name of ['taskstop', 'killshell', 'killbash']) expect(CLAUDE_TOOL_MAP[name], name).toBe('task_stop')
    expect(claudeToolName('task_stop')).toBe('TaskStop')
  })

  it('rejects an unknown id', async () => {
    const h = setup()
    await expect(h.stop('t1', { task_id: 'b12345678' })).rejects.toThrow('No background command with ID b12345678')
  })

  it('stays in a session that starts without bash', () => {
    expect(setup({ active: ['read', 'task_stop', 'todo'] }).active()).toEqual(['read', 'task_stop', 'todo'])
  })
})

// Against a real pi session: which tools a session starts with is decided by pi from what
// is registered when, and a stubbed pi cannot say what that comes to.
describe('tool selection', () => {
  const SHELL_TOOLS = ['bash', 'monitor', 'task_stop']
  // Every pi mode binds something, and pi starts the session again after /reload only then.
  const BINDINGS = { shutdownHandler: () => {} }
  type SessionOptions = { tools?: string[]; noTools?: 'all' | 'builtin'; defaultTools?: string[] }

  afterEach(async () => {
    vi.unstubAllEnvs()
    await stopAndWait()
  })

  const start = async (options: SessionOptions = {}) => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bash-tools-cwd-')))
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-tools-agent-'))
    if (options.defaultTools) fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultTools: options.defaultTools }))
    // Where an extension finds the settings pi was started with.
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { noExtensions: true, extensionFactories: [(pi) => backgroundBashExtension(pi), (pi) => monitorExtension(pi)] } })
      return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: options.tools, noTools: options.noTools })), services, diagnostics: services.diagnostics }
    }
    const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) })
    await runtime.session.bindExtensions(BINDINGS)
    return runtime
  }
  type Runtime = Awaited<ReturnType<typeof start>>
  const shellTools = (runtime: Runtime): string[] => SHELL_TOOLS.filter((name) => runtime.session.getActiveToolNames().includes(name))
  /** The shell tools at the start of the session, after /reload and after /new. */
  const shellToolsAcross = async (runtime: Runtime): Promise<string[][]> => {
    const seen = [shellTools(runtime)]
    await runtime.session.reload()
    seen.push(shellTools(runtime))
    await runtime.newSession()
    await runtime.session.bindExtensions(BINDINGS)
    seen.push(shellTools(runtime))
    return seen
  }

  it('offers its bash, task_stop and monitor in a default session', async () => {
    const runtime = await start()
    try {
      expect(shellTools(runtime)).toEqual(SHELL_TOOLS)
      expect(runtime.session.getToolDefinition('bash')?.description).toContain('A command still running at its timeout is stopped.')
    } finally {
      await runtime.dispose()
    }
  })

  // Claude Code with Bash denied: no Bash, no Monitor, TaskStop stays.
  it.each<[string, SessionOptions]>([
    ['the defaultTools setting leaves bash out', { defaultTools: ['read'] }],
    ['built-in tools are off', { noTools: 'builtin' }],
    ['--tools removes bash', { tools: ['-bash'] }],
  ])('offers task_stop, and neither bash nor monitor, where %s', async (_name, options) => {
    const runtime = await start(options)
    try {
      expect(await shellToolsAcross(runtime)).toEqual([['task_stop'], ['task_stop'], ['task_stop']])
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps bash off across /reload once the session turned it off, and monitor with it', async () => {
    const runtime = await start()
    try {
      runtime.session.setActiveToolsByName(runtime.session.getActiveToolNames().filter((name) => name !== 'bash'))
      await runtime.session.reload()
      expect(shellTools(runtime)).toEqual(['task_stop'])
    } finally {
      await runtime.dispose()
    }
  })

  // Claude Code with `--tools "Monitor,Read"`: Monitor without Bash, and it runs.
  it('keeps a monitor that an allowlist names without bash, and it runs', async () => {
    const runtime = await start({ tools: ['read', 'monitor'] })
    try {
      expect(await shellToolsAcross(runtime)).toEqual([['monitor'], ['monitor'], ['monitor']])
      const ctx = { cwd: os.tmpdir(), hasUI: true, isProjectTrusted: () => false, sessionManager: { getSessionId: () => 'test-session', getSessionFile: () => undefined, getBranch: () => [] } }
      const result = (await runtime.session.getToolDefinition('monitor')?.execute('call-1', { description: 'the watch', command: 'echo hi' }, undefined, undefined, ctx as never)) as ToolResult
      expect(textOf(result)).toMatch(/ID: m[0-9a-f]{8}/)
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a monitor that the defaultTools setting names without bash', async () => {
    const runtime = await start({ defaultTools: ['read', 'monitor'] })
    try {
      expect(await shellToolsAcross(runtime)).toEqual([
        ['monitor', 'task_stop'],
        ['monitor', 'task_stop'],
        ['monitor', 'task_stop'],
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
