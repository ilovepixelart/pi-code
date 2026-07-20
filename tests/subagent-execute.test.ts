import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import subagentExtension from '../extensions/subagent/index.ts'

const spawnMock = vi.hoisted(() => vi.fn())
const discoverAgentsMock = vi.hoisted(() => vi.fn())
const startBackgroundRunMock = vi.hoisted(() => vi.fn((_agent: string, _task: string, _invocation: { command: string; args: string[]; cwd: string }, _onComplete: (run: unknown) => void): string => 'bg-deadbeef'))
const backgroundStatusTextMock = vi.hoisted(() => vi.fn(() => 'No background runs in this session.'))

vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), spawn: spawnMock }))
vi.mock('../extensions/subagent/agents.js', () => ({ discoverAgents: discoverAgentsMock }))
vi.mock('../extensions/subagent/background.js', () => ({
  backgroundStatusText: backgroundStatusTextMock,
  startBackgroundRun: startBackgroundRunMock,
}))

// ---------------------------------------------------------------------------
// Fake child process. No test in this file may start a real process: `spawn` is
// mocked module-wide and every child is this in-memory EventEmitter.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

/** What the fake child does once the implementation has attached its listeners. */
interface Script {
  /** Raw stdout chunks, emitted in order. Chunk boundaries need not align with lines. */
  stdout?: string[]
  stderr?: string[]
  /** Exit code handed to the 'close' event. */
  exitCode?: number | null
  /** Emit 'error' instead of 'close'. */
  fail?: boolean
  /** Milliseconds to wait before driving the child, for ordering across parallel spawns. */
  delay?: number
}

interface SpawnCall {
  command: string
  args: string[]
  options: { cwd?: string; shell?: boolean }
  /** Content of the --append-system-prompt file as it existed at spawn time, if any. */
  promptFile: { path: string; content: string } | null
}

let spawnCalls: SpawnCall[] = []
let spawnedChildren: FakeChild[] = []
let scripts: Map<string, Script>

/** Registers what the child spawned for `task` should do. */
const script = (task: string, s: Script) => scripts.set(`Task: ${task}`, s)

const drive = (child: FakeChild, s: Script) => {
  for (const chunk of s.stdout ?? []) child.stdout.emit('data', Buffer.from(chunk))
  for (const chunk of s.stderr ?? []) child.stderr.emit('data', Buffer.from(chunk))
  if (s.fail) child.emit('error', new Error('spawn ENOENT'))
  else child.emit('close', s.exitCode === undefined ? 0 : s.exitCode)
}

/** The pi arguments the implementation builds, isolated from the runtime-dependent prefix. */
const piArgs = (call: SpawnCall): string[] => call.args.slice(call.args.indexOf('--mode'))

// ---------------------------------------------------------------------------
// JSONL event builders: the wire format runSingleAgent parses off stdout.
// ---------------------------------------------------------------------------

interface UsageWire {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total: number }
  totalTokens?: number
}

const assistantMessage = (over: { text?: string; usage?: UsageWire; model?: string; stopReason?: string; errorMessage?: string } = {}) => ({
  role: 'assistant',
  content: over.text === undefined ? [] : [{ type: 'text', text: over.text }],
  usage: over.usage,
  model: over.model,
  stopReason: over.stopReason,
  errorMessage: over.errorMessage,
})

const line = (event: unknown) => `${JSON.stringify(event)}\n`
const messageEnd = (message: unknown) => line({ type: 'message_end', message })
const say = (text: string) => messageEnd(assistantMessage({ text }))

// ---------------------------------------------------------------------------
// Tool + context harness
// ---------------------------------------------------------------------------

type ToolResult = AgentToolResult<{ mode: string; agentScope: string; projectAgentsDir: string | null; results: ResultShape[] }> & { isError?: boolean }

interface ResultShape {
  agent: string
  agentSource: string
  task: string
  exitCode: number
  messages: unknown[]
  stderr: string
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number }
  model?: string
  stopReason?: string
  errorMessage?: string
  step?: number
}

type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: ToolResult) => void, ctx?: unknown) => Promise<ToolResult>

const sendMessageMock = vi.fn()

const getExecute = (): Execute => {
  let execute: Execute | undefined
  subagentExtension({
    registerTool: (t: { name: string; execute: Execute }) => {
      if (t.name === 'subagent') execute = t.execute
    },
    sendMessage: sendMessageMock,
  } as never)
  if (!execute) throw new Error('subagent tool was not registered')
  return execute
}

const agentConfig = (over: Partial<{ name: string; systemPrompt: string; source: string; model: string; tools: string[] }> = {}) => ({
  name: 'scout',
  description: 'a scout',
  systemPrompt: '',
  source: 'user',
  filePath: '/agents/scout.md',
  ...over,
})

const trustedCtx = { cwd: '/repo', hasUI: false, isProjectTrusted: () => true, ui: { confirm: vi.fn(async () => true) } }

const text = (result: ToolResult): string => {
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error(`expected a text content part, got ${first?.type}`)
  return first.text
}

const results = (result: ToolResult): ResultShape[] => {
  if (!result.details) throw new Error('expected details on the tool result')
  return result.details.results
}

let execute: Execute

beforeEach(() => {
  spawnCalls = []
  spawnedChildren = []
  scripts = new Map()
  spawnMock.mockReset()
  spawnMock.mockImplementation((command: string, args: string[], options: { cwd?: string }) => {
    const promptIndex = args.indexOf('--append-system-prompt')
    const promptPath = promptIndex === -1 ? null : args[promptIndex + 1]
    spawnCalls.push({
      command,
      args,
      options,
      promptFile: promptPath ? { path: promptPath, content: fs.readFileSync(promptPath, 'utf-8') } : null,
    })
    const child = new FakeChild()
    spawnedChildren.push(child)
    const s = scripts.get(args[args.length - 1]) ?? {}
    setTimeout(() => drive(child, s), s.delay ?? 0)
    return child
  })
  startBackgroundRunMock.mockClear()
  startBackgroundRunMock.mockReturnValue('bg-deadbeef')
  backgroundStatusTextMock.mockClear()
  sendMessageMock.mockClear()
  trustedCtx.ui.confirm.mockClear()
  discoverAgentsMock.mockReturnValue({ agents: [agentConfig()], projectAgentsDir: null })
  execute = getExecute()
})

// ---------------------------------------------------------------------------

describe('execute dispatch', () => {
  it('returns the background status listing and runs nothing when status is set', async () => {
    backgroundStatusTextMock.mockReturnValue('bg-1 scout: running - audit')
    const result = await execute('c1', { status: true, agent: 'scout', task: 'ignored' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('bg-1 scout: running - audit')
    expect(result.details).toMatchObject({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [] })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a call with no mode and names every discovered agent with its source', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig(), agentConfig({ name: 'repo', source: 'project' })], projectAgentsDir: '/repo/.pi/agents' })

    const result = await execute('c1', {}, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Invalid parameters. Provide exactly one mode.\nAvailable agents: scout (user), repo (project)')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a call that supplies two modes at once', async () => {
    const params = { chain: [{ agent: 'scout', task: 'a' }], tasks: [{ agent: 'scout', task: 'b' }] }
    const result = await execute('c1', params, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Invalid parameters. Provide exactly one mode.\nAvailable agents: scout (user)')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reports none as the available list when discovery found no agents', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [], projectAgentsDir: null })
    const result = await execute('c1', { agent: 'scout' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Invalid parameters. Provide exactly one mode.\nAvailable agents: none')
  })

  it('passes the requested agent scope to discovery and echoes it back in the details', async () => {
    const result = await execute('c1', { status: true, agentScope: 'both' }, undefined, undefined, trustedCtx)

    expect(discoverAgentsMock).toHaveBeenCalledWith('/repo', 'both')
    expect(result.details).toMatchObject({ agentScope: 'both' })
  })
})

describe('project agent gate', () => {
  const projectAgents = { agents: [agentConfig({ name: 'repo', source: 'project' })], projectAgentsDir: '/repo/.pi/agents' }

  it('refuses an untrusted project agent when there is no UI', async () => {
    discoverAgentsMock.mockReturnValue(projectAgents)
    const ctx = { ...trustedCtx, hasUI: false, isProjectTrusted: () => false }

    const result = await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, ctx)

    expect(text(result)).toBe('Project-local agents (repo) require a trusted project; refusing in non-interactive mode.')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('treats a context without isProjectTrusted as untrusted', async () => {
    discoverAgentsMock.mockReturnValue(projectAgents)
    const ctx = { cwd: '/repo', hasUI: false, ui: { confirm: vi.fn() } }

    const result = await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, ctx)

    expect(text(result)).toBe('Project-local agents (repo) require a trusted project; refusing in non-interactive mode.')
    expect(ctx.ui.confirm).not.toHaveBeenCalled()
  })

  it('labels the refusal with the chain mode and every requested project agent', async () => {
    discoverAgentsMock.mockReturnValue({
      agents: [agentConfig({ name: 'repo', source: 'project' }), agentConfig({ name: 'lint', source: 'project' })],
      projectAgentsDir: '/repo/.pi/agents',
    })
    const ctx = { ...trustedCtx, isProjectTrusted: () => false }

    const result = await execute(
      'c1',
      {
        chain: [
          { agent: 'repo', task: 'a' },
          { agent: 'lint', task: 'b' },
        ],
      },
      undefined,
      undefined,
      ctx,
    )

    expect(text(result)).toBe('Project-local agents (repo, lint) require a trusted project; refusing in non-interactive mode.')
    expect(result.details).toMatchObject({ mode: 'chain', results: [] })
  })

  it('asks the user before running an untrusted project agent interactively', async () => {
    discoverAgentsMock.mockReturnValue(projectAgents)
    const confirm = vi.fn(async () => true)
    const ctx = { ...trustedCtx, hasUI: true, isProjectTrusted: () => false, ui: { confirm } }
    script('t', { stdout: [say('done')] })

    const result = await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, ctx)

    expect(confirm).toHaveBeenCalledWith('Run project-local agents?', 'Agents: repo\nSource: /repo/.pi/agents\n\nProject agents are repo-controlled. Only continue for trusted repositories.')
    expect(text(result)).toBe('done')
  })

  it('reports an unknown project agents directory in the confirmation prompt', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ name: 'repo', source: 'project' })], projectAgentsDir: null })
    const confirm = vi.fn(async () => false)
    const ctx = { ...trustedCtx, hasUI: true, isProjectTrusted: () => false, ui: { confirm } }

    await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, ctx)

    expect(confirm).toHaveBeenCalledWith('Run project-local agents?', 'Agents: repo\nSource: (unknown)\n\nProject agents are repo-controlled. Only continue for trusted repositories.')
  })

  it('cancels without spawning when the user declines the confirmation', async () => {
    discoverAgentsMock.mockReturnValue(projectAgents)
    const ctx = { ...trustedCtx, hasUI: true, isProjectTrusted: () => false, ui: { confirm: vi.fn(async () => false) } }

    const result = await execute('c1', { tasks: [{ agent: 'repo', task: 't' }] }, undefined, undefined, ctx)

    expect(text(result)).toBe('Canceled: project-local agents not approved.')
    expect(result.details).toMatchObject({ mode: 'parallel', results: [] })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('runs a user-scoped agent without consulting the UI', async () => {
    const confirm = vi.fn(async () => true)
    const ctx = { ...trustedCtx, hasUI: true, isProjectTrusted: () => false, ui: { confirm } }
    script('t', { stdout: [say('ok')] })

    const result = await execute('c1', { agent: 'scout', task: 't' }, undefined, undefined, ctx)

    expect(confirm).not.toHaveBeenCalled()
    expect(text(result)).toBe('ok')
  })
})

describe('background mode', () => {
  it('refuses a background run that is not single mode', async () => {
    const result = await execute('c1', { background: true, chain: [{ agent: 'scout', task: 't' }] }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('background: true requires single mode (agent + task).')
    expect(startBackgroundRunMock).not.toHaveBeenCalled()
  })

  it('refuses a background run for an agent that does not exist', async () => {
    const result = await execute('c1', { background: true, agent: 'ghost', task: 't' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Unknown agent: "ghost". Available agents: "scout".')
    expect(startBackgroundRunMock).not.toHaveBeenCalled()
  })

  it('starts the run with the agent invocation and reports the returned run id', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ model: 'sonnet', tools: ['read', 'bash'] })], projectAgentsDir: null })
    startBackgroundRunMock.mockReturnValue('bg-1a2b3c4d')

    const result = await execute('c1', { background: true, agent: 'scout', task: 'audit', cwd: '/other' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Started background run bg-1a2b3c4d (scout). A notification will arrive on completion; check progress with {status: true}.')
    expect(startBackgroundRunMock.mock.calls[0][0]).toBe('scout')
    expect(startBackgroundRunMock.mock.calls[0][1]).toBe('audit')
    const invocation = startBackgroundRunMock.mock.calls[0][2]
    expect(invocation.args.slice(invocation.args.indexOf('--mode'))).toEqual(['--mode', 'json', '-p', '--no-session', '--model', 'sonnet', '--tools', 'read,bash', 'Task: audit'])
    expect(invocation.cwd).toBe('/other')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('defaults the background working directory to the context cwd', async () => {
    await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)

    expect(startBackgroundRunMock.mock.calls[0][2].cwd).toBe('/repo')
  })

  it('deletes the temporary system prompt file once the background run completes', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'You audit.' })], projectAgentsDir: null })

    await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)

    const invocation = startBackgroundRunMock.mock.calls[0][2]
    const promptPath = invocation.args[invocation.args.indexOf('--append-system-prompt') + 1]
    expect(fs.readFileSync(promptPath, 'utf-8')).toBe('You audit.')

    const onComplete = startBackgroundRunMock.mock.calls[0][3]
    onComplete({ id: 'bg-1a2b3c4d', agent: 'scout', state: 'done', turns: 3, output: 'all clear' })

    expect(fs.existsSync(promptPath)).toBe(false)
  })

  it('notifies the parent agent with the run outcome when the background run completes', async () => {
    await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)
    const onComplete = startBackgroundRunMock.mock.calls[0][3]

    onComplete({ id: 'bg-1a2b3c4d', agent: 'scout', state: 'done', turns: 3, output: 'all clear' })

    expect(sendMessageMock).toHaveBeenCalledWith({ customType: 'subagent-background', content: 'Background subagent run bg-1a2b3c4d (scout) done after 3 turns.\n\nall clear', display: true }, { triggerTurn: true })
  })

  it('substitutes a no-output marker when the background run produced nothing', async () => {
    await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)
    const onComplete = startBackgroundRunMock.mock.calls[0][3]

    onComplete({ id: 'bg-9', agent: 'scout', state: 'failed', turns: 0, output: '' })

    expect(sendMessageMock.mock.calls[0][0].content).toBe('Background subagent run bg-9 (scout) failed after 0 turns.\n\n(no output)')
  })
})

describe('runSingleAgent process handling', () => {
  it('reports an unknown agent without spawning anything', async () => {
    const result = await execute('c1', { agent: 'ghost', task: 'find it' }, undefined, undefined, trustedCtx)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Agent failed: Unknown agent: "ghost". Available agents: "scout".')
    expect(results(result)[0]).toMatchObject({ agent: 'ghost', agentSource: 'unknown', task: 'find it', exitCode: 1, messages: [], step: undefined })
  })

  it('builds the pi arguments from the agent model, tools and task', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ model: 'opus', tools: ['read', 'grep'] })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0])).toEqual(['--mode', 'json', '-p', '--no-session', '--model', 'opus', '--tools', 'read,grep', 'Task: inspect'])
    expect(spawnCalls[0].options.shell).toBe(false)
  })

  it('omits the model and tools flags when the agent declares neither', async () => {
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0])).toEqual(['--mode', 'json', '-p', '--no-session', 'Task: inspect'])
  })

  it('writes the agent system prompt to a temp file, passes it, and removes it afterwards', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ name: 'my agent/1', systemPrompt: 'Be terse.' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'my agent/1', task: 'inspect' }, undefined, undefined, trustedCtx)

    const call = spawnCalls[0]
    expect(piArgs(call).slice(0, 5)).toEqual(['--mode', 'json', '-p', '--no-session', '--append-system-prompt'])
    expect(call.promptFile?.content).toBe('Be terse.')
    // Unsafe characters in the agent name are replaced before it reaches the filesystem.
    expect(call.promptFile?.path.endsWith('/prompt-my_agent_1.md')).toBe(true)
    expect(fs.existsSync(call.promptFile?.path as string)).toBe(false)
  })

  it('runs the child in the caller-supplied working directory, falling back to the context cwd', async () => {
    script('a', { stdout: [say('x')] })
    script('b', { stdout: [say('y')] })

    await execute('c1', { agent: 'scout', task: 'a', cwd: '/elsewhere' }, undefined, undefined, trustedCtx)
    await execute('c2', { agent: 'scout', task: 'b' }, undefined, undefined, trustedCtx)

    expect(spawnCalls[0].options.cwd).toBe('/elsewhere')
    expect(spawnCalls[1].options.cwd).toBe('/repo')
  })

  it('parses a JSONL event that arrives split across two stdout chunks', async () => {
    const whole = say('reassembled')
    script('inspect', { stdout: [whole.slice(0, 20), whole.slice(20)] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('reassembled')
    expect(results(result)[0].messages).toHaveLength(1)
  })

  it('parses a final JSONL event that never received a trailing newline', async () => {
    script('inspect', { stdout: [say('flushed').trimEnd()] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('flushed')
  })

  it('skips malformed and blank JSONL lines without losing the surrounding events', async () => {
    script('inspect', { stdout: [`${say('first')}not json at all\n\n   \n${say('second')}`] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('second')
    expect(results(result)[0].messages).toHaveLength(2)
  })

  it('ignores JSONL events of unrelated types', async () => {
    script('inspect', { stdout: [line({ type: 'message_start', message: assistantMessage({ text: 'ignored' }) }), line({ type: 'message_end' }), say('kept')] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('kept')
    expect(results(result)[0].messages).toHaveLength(1)
  })

  it('records tool result messages without counting them as turns', async () => {
    script('inspect', { stdout: [say('done'), line({ type: 'tool_result_end', message: { role: 'toolResult', content: [] } })] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].messages).toHaveLength(2)
    expect(results(result)[0].usage.turns).toBe(1)
  })

  it('sums usage across assistant turns but takes the latest context size', async () => {
    script('inspect', {
      stdout: [messageEnd(assistantMessage({ text: 'one', usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, cost: { total: 0.5 }, totalTokens: 200 } })), messageEnd(assistantMessage({ text: 'two', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 7, cost: { total: 0.25 }, totalTokens: 300 } }))],
    })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].usage).toEqual({ input: 15, output: 5, cacheRead: 100, cacheWrite: 7, cost: 0.75, contextTokens: 300, turns: 2 })
  })

  it('counts an assistant turn that carries no usage block at all', async () => {
    script('inspect', { stdout: [say('one'), say('two')] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 })
  })

  it('adopts the model reported by the child when the agent config declares none', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'a', model: 'first-model' })), messageEnd(assistantMessage({ text: 'b', model: 'second-model' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].model).toBe('first-model')
  })

  it('keeps the configured model over the one the child reports', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ model: 'opus' })], projectAgentsDir: null })
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'a', model: 'reported' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].model).toBe('opus')
  })

  it('collects stderr chunks onto the result', async () => {
    script('inspect', { stdout: [say('ok')], stderr: ['warn: ', 'deprecated flag'] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].stderr).toBe('warn: deprecated flag')
  })

  it('treats a spawn error as exit code 1', async () => {
    script('inspect', { fail: true })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].exitCode).toBe(1)
    expect(text(result)).toBe('Agent failed: (no output)')
  })

  it('maps a null exit code to zero', async () => {
    script('inspect', { stdout: [say('ok')], exitCode: null })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(results(result)[0].exitCode).toBe(0)
    expect(text(result)).toBe('ok')
  })

  it('streams a running placeholder before any assistant text arrives', async () => {
    const updates: string[] = []
    script('inspect', { stdout: [messageEnd(assistantMessage({})), say('final')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, (partial) => updates.push(text(partial)), trustedCtx)

    expect(updates).toEqual(['(running...)', 'final'])
  })

  it('terminates the child and rejects when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    script('inspect', { stdout: [say('too late')] })

    await expect(execute('c1', { agent: 'scout', task: 'inspect' }, controller.signal, undefined, trustedCtx)).rejects.toThrow('Subagent was aborted')
    expect(spawnedChildren[0].kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('terminates the child when the signal aborts mid-run', async () => {
    const controller = new AbortController()
    script('inspect', { stdout: [say('too late')], delay: 20 })

    const pending = execute('c1', { agent: 'scout', task: 'inspect' }, controller.signal, undefined, trustedCtx)
    controller.abort()

    await expect(pending).rejects.toThrow('Subagent was aborted')
    expect(spawnedChildren[0].kill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('single mode', () => {
  it('returns the final assistant text on success', async () => {
    script('inspect', { stdout: [say('first answer'), say('final answer')] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('final answer')
    expect(result.isError).toBeUndefined()
    expect(results(result)[0]).toMatchObject({ agent: 'scout', agentSource: 'user', task: 'inspect', exitCode: 0 })
  })

  it('reports no output when the child exits cleanly with no assistant text', async () => {
    script('inspect', {})

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('(no output)')
    expect(result.isError).toBeUndefined()
  })

  it('names the stop reason in the failure text when one is reported', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'partial', stopReason: 'error', errorMessage: 'model overloaded' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent error: model overloaded')
    expect(result.isError).toBe(true)
  })

  it('fails an aborted run even though the child exited cleanly', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'partial work', stopReason: 'aborted' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent aborted: partial work')
    expect(result.isError).toBe(true)
  })

  it('succeeds on a benign stop reason', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'all done', stopReason: 'stop' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('all done')
    expect(result.isError).toBeUndefined()
  })

  it('prefers the reported error message over stderr and the final output', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'some output', errorMessage: 'rate limited' }))], stderr: ['stderr noise'], exitCode: 2 })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent failed: rate limited')
  })

  it('falls back to stderr when no error message was reported', async () => {
    script('inspect', { stdout: [say('some output')], stderr: ['crashed hard'], exitCode: 2 })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent failed: crashed hard')
  })

  it('falls back to the final assistant output when stderr is empty', async () => {
    script('inspect', { stdout: [say('what the agent said')], exitCode: 3 })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent failed: what the agent said')
  })

  it('falls back to a no-output marker when nothing at all was produced', async () => {
    script('inspect', { exitCode: 7 })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent failed: (no output)')
  })
})

describe('chain mode', () => {
  const twoStep = {
    chain: [
      { agent: 'scout', task: 'find the bug' },
      { agent: 'scout', task: 'fix: {previous}' },
    ],
  }

  it('feeds each step output into the next step {previous} placeholder', async () => {
    script('find the bug', { stdout: [say('null deref in parser')] })
    script('fix: null deref in parser', { stdout: [say('patched')] })

    const result = await execute('c1', twoStep, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0]).at(-1)).toBe('Task: find the bug')
    expect(piArgs(spawnCalls[1]).at(-1)).toBe('Task: fix: null deref in parser')
    expect(text(result)).toBe('patched')
    expect(results(result).map((r) => r.step)).toEqual([1, 2])
  })

  it('substitutes every occurrence of the placeholder', async () => {
    const chain = [
      { agent: 'scout', task: 'a' },
      { agent: 'scout', task: '{previous} and {previous}' },
    ]
    script('a', { stdout: [say('X')] })
    script('X and X', { stdout: [say('done')] })

    const result = await execute('c1', { chain }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[1]).at(-1)).toBe('Task: X and X')
    expect(text(result)).toBe('done')
  })

  it('substitutes an empty string for the placeholder in the first step', async () => {
    script('summarize ', { stdout: [say('nothing to summarize')] })

    const result = await execute('c1', { chain: [{ agent: 'scout', task: 'summarize {previous}' }] }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0]).at(-1)).toBe('Task: summarize ')
    expect(text(result)).toBe('nothing to summarize')
  })

  it('reports no output when the last step produced none', async () => {
    script('a', { stdout: [say('X')] })
    script('b', {})

    const result = await execute(
      'c1',
      {
        chain: [
          { agent: 'scout', task: 'a' },
          { agent: 'scout', task: 'b' },
        ],
      },
      undefined,
      undefined,
      trustedCtx,
    )

    expect(text(result)).toBe('(no output)')
  })

  it('stops at the failing step and never spawns the rest of the chain', async () => {
    script('find the bug', { stderr: ['scout crashed'], exitCode: 4 })

    const result = await execute('c1', twoStep, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Chain stopped at step 1 (scout): scout crashed')
    expect(result.isError).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(results(result)).toHaveLength(1)
  })

  it('stops at a later step and keeps the earlier results', async () => {
    script('find the bug', { stdout: [say('the bug')] })
    script('fix: the bug', { stdout: [messageEnd(assistantMessage({ text: 'gave up', stopReason: 'error' }))] })

    const result = await execute('c1', twoStep, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Chain stopped at step 2 (scout): gave up')
    expect(results(result).map((r) => r.step)).toEqual([1, 2])
  })

  it('stops on an aborted step reported with a clean exit code', async () => {
    script('find the bug', { stdout: [messageEnd(assistantMessage({ stopReason: 'aborted', errorMessage: 'user interrupted' }))] })

    const result = await execute('c1', twoStep, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Chain stopped at step 1 (scout): user interrupted')
  })

  it('stops with a no-output marker when the failing step said nothing', async () => {
    script('find the bug', { exitCode: 1 })

    const result = await execute('c1', twoStep, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Chain stopped at step 1 (scout): (no output)')
  })

  it('stops the chain on an unknown agent without spawning', async () => {
    const chain = [
      { agent: 'ghost', task: 'a' },
      { agent: 'scout', task: 'b' },
    ]

    const result = await execute('c1', { chain }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Chain stopped at step 1 (ghost): Unknown agent: "ghost". Available agents: "scout".')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('streams each step alongside the results already completed', async () => {
    script('find the bug', { stdout: [say('the bug')] })
    script('fix: the bug', { stdout: [say('patched')] })
    const updates: { text: string; agents: string[]; steps: (number | undefined)[] }[] = []

    await execute('c1', twoStep, undefined, (partial) => updates.push({ text: text(partial), agents: results(partial).map((r) => r.agent), steps: results(partial).map((r) => r.step) }), trustedCtx)

    expect(updates.map((u) => u.text)).toEqual(['the bug', 'patched'])
    expect(updates.map((u) => u.steps)).toEqual([[1], [1, 2]])
    expect(updates[1].agents).toEqual(['scout', 'scout'])
  })
})

describe('parallel mode', () => {
  const tasksOf = (...names: string[]) => names.map((task) => ({ agent: 'scout', task }))

  it('refuses more than eight parallel tasks before spawning anything', async () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: 'scout', task: `t${i}` }))

    const result = await execute('c1', { tasks }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Too many parallel tasks (9). Max is 8.')
    expect(result.details).toMatchObject({ mode: 'parallel', results: [] })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('accepts exactly eight parallel tasks', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `t${i}`)
    for (const name of names) script(name, { stdout: [say(name)] })

    const result = await execute('c1', { tasks: tasksOf(...names) }, undefined, undefined, trustedCtx)

    expect(spawnMock).toHaveBeenCalledTimes(8)
    expect(text(result).split('\n\n')[0]).toBe('Parallel: 8/8 succeeded')
  })

  it('summarizes each task with its completion state and output preview', async () => {
    script('alpha', { stdout: [say('alpha output')] })
    script('beta', { stdout: [say('beta output')], exitCode: 1 })

    const result = await execute('c1', { tasks: tasksOf('alpha', 'beta') }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Parallel: 1/2 succeeded\n\n[scout] completed: alpha output\n\n[scout] failed: beta output')
  })

  it('truncates a task preview past 100 characters', async () => {
    const long = 'z'.repeat(150)
    const exact = 'y'.repeat(100)
    script('alpha', { stdout: [say(long)] })
    script('beta', { stdout: [say(exact)] })

    const result = await execute('c1', { tasks: tasksOf('alpha', 'beta') }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe(`Parallel: 2/2 succeeded\n\n[scout] completed: ${'z'.repeat(100)}...\n\n[scout] completed: ${exact}`)
  })

  it('substitutes a no-output marker for a task that said nothing', async () => {
    script('alpha', {})

    const result = await execute('c1', { tasks: tasksOf('alpha') }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Parallel: 1/1 succeeded\n\n[scout] completed: (no output)')
  })

  it('reports an unknown agent as a failed task rather than aborting the batch', async () => {
    script('alpha', { stdout: [say('fine')] })

    const tasks = [{ agent: 'ghost', task: 'nope' }, ...tasksOf('alpha')]
    const result = await execute('c1', { tasks }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Parallel: 1/2 succeeded\n\n[ghost] failed: (no output)\n\n[scout] completed: fine')
    expect(results(result)[0]).toMatchObject({ agent: 'ghost', agentSource: 'unknown', exitCode: 1 })
  })

  it('marks not-yet-started tasks with a running placeholder in streamed updates', async () => {
    script('alpha', { stdout: [say('alpha done')] })
    script('beta', { stdout: [say('beta done')], delay: 30 })
    const updates: { text: string; exitCodes: number[]; sources: string[] }[] = []

    await execute('c1', { tasks: tasksOf('alpha', 'beta') }, undefined, (partial) => updates.push({ text: text(partial), exitCodes: results(partial).map((r) => r.exitCode), sources: results(partial).map((r) => r.agentSource) }), trustedCtx)

    expect(updates[0]).toEqual({ text: 'Parallel: 1/2 done, 1 running...', exitCodes: [0, -1], sources: ['user', 'unknown'] })
    expect(updates.at(-1)).toEqual({ text: 'Parallel: 2/2 done, 0 running...', exitCodes: [0, 0], sources: ['user', 'user'] })
  })

  it('keeps results aligned with the input task order', async () => {
    script('alpha', { stdout: [say('A')], delay: 30 })
    script('beta', { stdout: [say('B')] })

    const result = await execute('c1', { tasks: tasksOf('alpha', 'beta') }, undefined, undefined, trustedCtx)

    expect(results(result).map((r) => r.task)).toEqual(['alpha', 'beta'])
    expect(text(result)).toBe('Parallel: 2/2 succeeded\n\n[scout] completed: A\n\n[scout] completed: B')
  })

  it('honours a per-task working directory', async () => {
    script('alpha', { stdout: [say('A')] })

    await execute('c1', { tasks: [{ agent: 'scout', task: 'alpha', cwd: '/pkg/a' }] }, undefined, undefined, trustedCtx)

    expect(spawnCalls[0].options.cwd).toBe('/pkg/a')
  })
})
