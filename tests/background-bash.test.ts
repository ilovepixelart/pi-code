import * as fs from 'node:fs'
import * as os from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import backgroundBashExtension, { backgroundAllowed, foregroundLimitMs, startsWithSleep } from '../extensions/background-bash.ts'
import { allShells, commandPreview, forgetShell, MAX_FINISHED_SHELLS, registerShell, resetShells, settleShell, shellCompletionText, shellOutputDir, shellsStatusText, stopAllShells, stopShell } from '../extensions/internal/background-shells.ts'

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
}

const setup = (options: { hasUI?: boolean; prompted?: boolean } = {}): Harness => {
  const tools = new Map<string, { name: string; execute: Execute; description: string; parameters: { properties: Record<string, unknown> }; promptGuidelines?: string[] }>()
  const handlers = new Map<string, Handler[]>()
  const sent: Sent[] = []
  const pi = {
    registerTool: (tool: { name: string; execute: Execute; description: string; parameters: { properties: Record<string, unknown> } }) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent['message'], opts: Sent['options']) => sent.push({ message, options: opts }),
  }
  backgroundBashExtension(pi as never)
  const ctx = {
    cwd: os.tmpdir(),
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
    const base = { id: 'b1', command: 'npm   run\n dev', outputFile: '/tmp/b1.output' }
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
  it('extends the built-in schema and prompt with background guidance', () => {
    const h = setup()
    const bash = h.tool('bash')
    expect(Object.keys(bash.parameters.properties)).toEqual(['command', 'timeout', 'run_in_background'])
    expect(bash.description).toContain('run_in_background')
    expect(bash.promptGuidelines?.join('\n')).toContain('task_stop')
  })

  it('returns a quick command in the foreground, untracked', async () => {
    const h = setup()
    const result = await h.bash('t1', { command: 'echo hello' })
    expect(textOf(result).trim()).toBe('hello')
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

  it('runs as pi bash does with background tasks disabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
    process.env.BASH_DEFAULT_TIMEOUT_MS = '50'
    const h = setup()
    const result = await h.bash('t1', { command: 'sleep 0.2; echo done', run_in_background: true })
    expect(textOf(result).trim()).toBe('done')
    expect(allShells()).toHaveLength(0)
  })

  it('runs as pi bash does in a session without a UI', async () => {
    const h = setup({ hasUI: false })
    const result = await h.bash('t1', { command: 'echo headless', run_in_background: true })
    expect(textOf(result).trim()).toBe('headless')
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

  it('stops every background command when pi quits', async () => {
    const h = setup()
    await h.bash('t1', { command: 'sleep 10', run_in_background: true })
    h.emit('session_shutdown', { reason: 'quit' })
    await until(() => allShells()[0]?.state === 'killed')
    expect(h.sent).toHaveLength(0)
  })
})

describe('task_stop tool', () => {
  it('stops a running background command without a notice', async () => {
    const h = setup()
    const id = idOf(await h.bash('t1', { command: 'sleep 10', run_in_background: true }))
    expect(textOf(await h.stop('t2', { task_id: id }))).toBe(`Stopped background command ${id}.`)
    await until(() => allShells()[0]?.finishedAt !== undefined)
    expect(allShells()[0]?.state).toBe('killed')
    expect(h.sent).toHaveLength(0)
    expect(textOf(await h.stop('t3', { task_id: id }))).toContain('is not running')
  })

  it('rejects an unknown id', async () => {
    const h = setup()
    await expect(h.stop('t1', { task_id: 'b12345678' })).rejects.toThrow('No background command with ID b12345678')
  })
})
