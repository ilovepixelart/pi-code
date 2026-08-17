import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasAgentRunner, runAgent, setAgentRunner } from '../extensions/internal/agent-run.ts'
import subagentExtension, { AGENT_HOOK_SYSTEM, agentMemoryDir, agentMemorySection, buildHookAgent, withMemoryTools } from '../extensions/subagent/index.ts'

// The agent-memory tests read settings and stores under the home directory; point
// homedir at a throwaway dir so the developer's real ~/.claude cannot influence them.
const osHoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => osHoisted.home || actual.homedir() }
})

const spawnMock = vi.hoisted(() => vi.fn())
const discoverAgentsMock = vi.hoisted(() => vi.fn())
const startBackgroundRunMock = vi.hoisted(() => vi.fn((_agent: string, _task: string, _invocation: { command: string; args: string[]; cwd: string }, _onComplete: (run: unknown) => void): string | null => 'bg-deadbeef'))
const backgroundStatusTextMock = vi.hoisted(() => vi.fn(() => 'No background runs in this session.'))
const cancelBackgroundRunMock = vi.hoisted(() => vi.fn())
const resumeBackgroundRunMock = vi.hoisted(() => vi.fn())
const activeBackgroundRunsMock = vi.hoisted(() => vi.fn(() => 0))
const backgroundRunMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), spawn: spawnMock }))
vi.mock('../extensions/subagent/agents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../extensions/subagent/agents.js')>()),
  discoverAgents: discoverAgentsMock,
}))
vi.mock('../extensions/subagent/background.js', () => ({
  backgroundStatusText: backgroundStatusTextMock,
  cancelBackgroundRun: cancelBackgroundRunMock,
  resumeBackgroundRun: resumeBackgroundRunMock,
  startBackgroundRun: startBackgroundRunMock,
  activeBackgroundRuns: activeBackgroundRunsMock,
  backgroundRun: backgroundRunMock,
  MAX_BACKGROUND_RUNS: 8,
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

type ToolResult = AgentToolResult<{ mode: string; agentScope: string; projectAgentsDir: string | null; results: ResultShape[] }>

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
const emittedEvents: Array<{ channel: string; data: unknown }> = []

const eventHandlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()

const getExecute = (): Execute => {
  let execute: Execute | undefined
  subagentExtension({
    registerTool: (t: { name: string; execute: Execute }) => {
      if (t.name === 'subagent') execute = t.execute
    },
    sendMessage: sendMessageMock,
    events: { emit: (channel: string, data: unknown) => emittedEvents.push({ channel, data }), on: () => () => {} },
    on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => eventHandlers.set(name, fn),
  } as never)
  if (!execute) throw new Error('subagent tool was not registered')
  return execute
}

const agentConfig = (over: Partial<{ name: string; systemPrompt: string; source: string; model: string; tools: string[]; disallowedTools: string[]; effort: string; filePath: string; memory: 'user' | 'project' | 'local' }> = {}) => ({
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
  cancelBackgroundRunMock.mockReset()
  resumeBackgroundRunMock.mockReset()
  activeBackgroundRunsMock.mockReturnValue(0)
  sendMessageMock.mockClear()
  emittedEvents.length = 0
  eventHandlers.clear()
  trustedCtx.ui.confirm.mockClear()
  discoverAgentsMock.mockReturnValue({ agents: [agentConfig()], projectAgentsDir: null })
  execute = getExecute()
})

// ---------------------------------------------------------------------------

describe('agent hook runner', () => {
  afterEach(() => setAgentRunner(undefined))

  it('builds a read-only inspection agent, appending a hook systemPrompt', () => {
    const plain = buildHookAgent({})
    expect(plain.tools).toEqual(['read', 'grep', 'find'])
    expect(plain.systemPrompt).toBe(AGENT_HOOK_SYSTEM)
    expect(plain.model).toBeUndefined()

    const custom = buildHookAgent({ model: 'fast-1', systemPrompt: 'extra rules' })
    expect(custom.model).toBe('fast-1')
    expect(custom.systemPrompt).toBe(`${AGENT_HOOK_SYSTEM}\n\nextra rules`)
  })

  it('registers a runner on session_start that spawns a restricted subagent and returns its text', async () => {
    await eventHandlers.get('session_start')?.({}, { cwd: '/repo', modelRegistry: { getAvailable: () => [{ id: 'm1' }] } })
    expect(hasAgentRunner()).toBe(true)

    const decision = '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"reads /etc"}}'
    script('inspect the command', { stdout: [say(decision)], exitCode: 0 })

    const out = await runAgent({ prompt: 'inspect the command', model: 'fast-1' })
    expect(out).toBe(decision)
    const args = piArgs(spawnCalls[0])
    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('read,grep,find')
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('fast-1')
    // The child's system prompt is the JSON-decision instruction.
    expect(spawnCalls[0].promptFile?.content).toContain('permissionDecision')
  })

  it('refuses to run inside a subagent session', async () => {
    await eventHandlers.get('session_start')?.({}, { cwd: '/repo', modelRegistry: { getAvailable: () => [] } })
    const saved = process.env.PI_CODE_SUBAGENT
    process.env.PI_CODE_SUBAGENT = '1'
    try {
      await expect(runAgent({ prompt: 'x' })).rejects.toThrow(/subagent/i)
    } finally {
      if (saved === undefined) delete process.env.PI_CODE_SUBAGENT
      else process.env.PI_CODE_SUBAGENT = saved
    }
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('execute dispatch', () => {
  it('returns the background status listing and runs nothing when status is set', async () => {
    backgroundStatusTextMock.mockReturnValue('bg-1 scout: running - audit')
    const result = await execute('c1', { status: true, agent: 'scout', task: 'ignored' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('bg-1 scout: running - audit')
    // trustedCtx has no Claude-shaped config, so the default scope resolves to both.
    expect(result.details).toMatchObject({ mode: 'single', agentScope: 'both', projectAgentsDir: null, results: [] })
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
    const result = await execute('c1', { status: true, agentScope: 'user' }, undefined, undefined, trustedCtx)

    expect(discoverAgentsMock).toHaveBeenCalledWith('/repo', 'user')
    expect(result.details).toMatchObject({ agentScope: 'user' })
  })

  it('defaults the scope to both for an approved project, so every listed agent resolves', async () => {
    // The roster advertises project agents under the same condition; a default call
    // must be able to reach what the roster lists, as Claude's Task does.
    const result = await execute('c1', { status: true }, undefined, undefined, trustedCtx)

    expect(discoverAgentsMock).toHaveBeenCalledWith('/repo', 'both')
    expect(result.details).toMatchObject({ agentScope: 'both' })
  })

  it('defaults the scope to user when the project is not approved', async () => {
    const ctx = { ...trustedCtx, isProjectTrusted: () => false }
    const result = await execute('c1', { status: true }, undefined, undefined, ctx)

    expect(discoverAgentsMock).toHaveBeenCalledWith('/repo', 'user')
    expect(result.details).toMatchObject({ agentScope: 'user' })
  })
})

describe('project agent gate', () => {
  const projectAgents = { agents: [agentConfig({ name: 'repo', source: 'project', filePath: '/repo/.pi/agents/repo.md' })], projectAgentsDir: '/repo/.pi/agents' }

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

  it('does not consult project approval when the run uses no project agents', async () => {
    // isProjectApproved can prompt and persist a decision; a user-scope run that
    // consumes no project config must not trigger that, even in a claude-shaped repo.
    const cwd = fs.mkdtempSync(join(tmpdir(), 'sa-noproj-'))
    fs.mkdirSync(join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(join(cwd, '.claude', 'settings.json'), '{}')
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(join(tmpdir(), 'sa-agentdir-'))
    try {
      discoverAgentsMock.mockReturnValue({ agents: [agentConfig()], projectAgentsDir: null })
      const confirm = vi.fn(async () => true)
      const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { confirm } }
      script('inspect', { stdout: [say('ok')] })

      await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, ctx)

      expect(confirm).not.toHaveBeenCalled()
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir
    }
  })

  it('names the directory each project agent actually came from', async () => {
    // projectAgentsDir only ever held .pi/agents, so a .claude/agents project read "(unknown)".
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ name: 'repo', source: 'project', filePath: '/repo/.claude/agents/repo.md' })], projectAgentsDir: null })
    const confirm = vi.fn(async () => false)
    const ctx = { ...trustedCtx, hasUI: true, isProjectTrusted: () => false, ui: { confirm } }

    await execute('c1', { agent: 'repo', task: 't' }, undefined, undefined, ctx)

    expect(confirm).toHaveBeenCalledWith('Run project-local agents?', 'Agents: repo\nSource: /repo/.claude/agents\n\nProject agents are repo-controlled. Only continue for trusted repositories.')
  })

  it('does not let an agent name forge the provenance line', async () => {
    const forged = 'helper\n\nSource: ~/.pi/agent/agents\n(user-installed, already approved)'
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ name: forged, source: 'project', filePath: '/repo/.claude/agents/x.md' })], projectAgentsDir: null })
    const confirm = vi.fn(async () => false)
    const ctx = { ...trustedCtx, hasUI: true, isProjectTrusted: () => false, ui: { confirm } }

    await execute('c1', { agent: forged, task: 't' }, undefined, undefined, ctx)

    const [, body] = confirm.mock.calls[0] as unknown as [string, string]
    // The name is collapsed to one line, so it cannot introduce a second Source: line.
    expect(body.split('\n').filter((line) => line.startsWith('Source:'))).toHaveLength(1)
    expect(body.split('\n')[0]).toContain('already approved')
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

describe('recursion guard', () => {
  it('refuses to run inside a subagent session', async () => {
    process.env.PI_CODE_SUBAGENT = '1'
    try {
      const result = await execute('c1', { agent: 'scout', task: 'x' }, undefined, undefined, trustedCtx)
      expect(text(result)).toContain('already a subagent')
      expect(spawnCalls).toHaveLength(0)
    } finally {
      delete process.env.PI_CODE_SUBAGENT
    }
  })

  it('marks spawned children as subagent runs', async () => {
    script('inspect', { stdout: [say('ok')] })
    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)
    expect((spawnCalls[0].options as { env?: Record<string, string> }).env?.PI_CODE_SUBAGENT).toBe('1')
  })
})

describe('background mode', () => {
  it('refuses to start another background run at the concurrency cap', async () => {
    activeBackgroundRunsMock.mockReturnValue(8)

    const result = await execute('c1', { background: true, agent: 'scout', task: 'x' }, undefined, undefined, trustedCtx)

    expect(text(result)).toContain('Too many background runs')
    expect(startBackgroundRunMock).not.toHaveBeenCalled()
  })

  it('reports the cap and removes the temp prompt when the spawn-time check refuses', async () => {
    // The pre-check can be raced by a parallel tool-call batch; startBackgroundRun's
    // own atomic refusal (null) must surface the same error and leak nothing.
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'You audit.' })], projectAgentsDir: null })
    startBackgroundRunMock.mockReturnValue(null)

    const result = await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)

    expect(text(result)).toContain('Too many background runs')
    const invocation = startBackgroundRunMock.mock.calls[0][2]
    const promptPath = invocation.args[invocation.args.indexOf('--append-system-prompt') + 1]
    expect(fs.existsSync(promptPath)).toBe(false)
  })

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

  it('passes disallowedTools as an exclude list and effort as a thinking suffix', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ model: 'gpt-oss:20b', effort: 'high', disallowedTools: ['write', 'edit'] })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0])).toEqual(['--mode', 'json', '-p', '--no-session', '--model', 'gpt-oss:20b:high', '--exclude-tools', 'write,edit', 'Task: inspect'])
  })

  it('carries effort through --thinking when no model is pinned', async () => {
    // pi reads the level from the model pattern when one is pinned, and from --thinking
    // otherwise, so an agent that only sets effort no longer loses it.
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ effort: 'high' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0])).toEqual(['--mode', 'json', '-p', '--no-session', '--thinking', 'high', 'Task: inspect'])
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

describe('effort and skills', () => {
  it('passes effort as --thinking when the agent pins no model', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ effort: 'high' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('done')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--thinking')
    expect(args[args.indexOf('--thinking') + 1]).toBe('high')
    expect(args).not.toContain('--model')
  })

  it('keeps the model:effort suffix when a model is pinned', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ model: 'gpt-oss:20b', effort: 'low' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('done')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-oss:20b:low')
    expect(args).not.toContain('--thinking')
  })
})

describe('cancelResultText', () => {
  it('reports cancelled, already-finished and unknown ids distinctly', async () => {
    const { cancelResultText } = await import('../extensions/subagent/index.ts')

    cancelBackgroundRunMock.mockReturnValue('cancelled')
    expect(cancelResultText('bg-1')).toBe('Cancelled background run bg-1.')

    cancelBackgroundRunMock.mockReturnValue('not-running')
    expect(cancelResultText('bg-2')).toContain('already finished')

    cancelBackgroundRunMock.mockReturnValue('unknown')
    backgroundStatusTextMock.mockReturnValue('STATUS_LISTING')
    const unknown = cancelResultText('bg-3')
    expect(unknown).toContain('Unknown background run: bg-3')
    // The status listing rides along so the model can see the real ids.
    expect(unknown).toContain('STATUS_LISTING')
  })
})

describe('resumeResultText', () => {
  it('requires a task and reports each resume outcome', async () => {
    const { resumeResultText } = await import('../extensions/subagent/index.ts')
    const noop = () => {}

    expect(resumeResultText('bg-1', undefined, noop)).toContain('Pass task with resume')

    resumeBackgroundRunMock.mockReturnValue('resumed')
    expect(resumeResultText('bg-1', 'follow up', noop)).toContain('Resumed background run bg-1')

    resumeBackgroundRunMock.mockReturnValue('still-running')
    expect(resumeResultText('bg-1', 'follow up', noop)).toContain('still running')

    resumeBackgroundRunMock.mockReturnValue('at-capacity')
    expect(resumeResultText('bg-1', 'follow up', noop)).toContain('cap reached')

    resumeBackgroundRunMock.mockReturnValue('unknown')
    backgroundStatusTextMock.mockReturnValue('LISTING')
    const unknown = resumeResultText('bg-9', 'follow up', noop)
    expect(unknown).toContain('Unknown background run: bg-9')
    expect(unknown).toContain('LISTING')
  })

  it('reports a resumed run to the lifecycle callback', async () => {
    const { resumeResultText } = await import('../extensions/subagent/index.ts')
    resumeBackgroundRunMock.mockReturnValue('resumed')
    backgroundRunMock.mockReturnValue({ id: 'bg-1', agent: 'scout' })
    const started: unknown[] = []

    resumeResultText(
      'bg-1',
      'follow up',
      () => {},
      (run) => started.push(run),
    )

    expect(started).toEqual([{ id: 'bg-1', agent: 'scout' }])
  })
})

describe('backgroundCompletionText diagnostics', () => {
  it('appends the stderr tail for a failed run and omits it for a clean one', async () => {
    const { backgroundCompletionText } = await import('../extensions/subagent/index.ts')
    const failed = backgroundCompletionText({ id: 'bg-1', agent: 'scout', state: 'failed', turns: 0, stderr: 'unknown model id x' })
    expect(failed).toContain('stderr tail:')
    expect(failed).toContain('unknown model id x')

    const done = backgroundCompletionText({ id: 'bg-2', agent: 'scout', state: 'done', turns: 3, output: 'all good', stderr: 'noise' })
    expect(done).not.toContain('stderr tail:')
  })
})

describe('agent roster', () => {
  it('appends nothing when no agents are discovered', async () => {
    getExecute()
    discoverAgentsMock.mockReturnValueOnce({ agents: [], projectAgentsDir: null })
    await expect(eventHandlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, trustedCtx)).resolves.toBeUndefined()
  })

  it('appends the discovered agents with descriptions to the system prompt', async () => {
    getExecute()
    const result = (await eventHandlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, trustedCtx)) as { systemPrompt: string }
    expect(result.systemPrompt).toContain('BASE')
    expect(result.systemPrompt).toContain('## Subagents')
    // Discovery is module-mocked here; builtin discovery is covered in the agents suite.
    expect(result.systemPrompt).toMatch(/- scout \(user\): /)
  })
})

describe('single mode', () => {
  it('returns the final assistant text on success', async () => {
    script('inspect', { stdout: [say('first answer'), say('final answer')] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('final answer')
    expect(results(result)[0]).toMatchObject({ agent: 'scout', agentSource: 'user', task: 'inspect', exitCode: 0 })
  })

  it('publishes start and stop lifecycle events for the child run on the shared bus', async () => {
    script('inspect', { stdout: [say('done')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    const phases = emittedEvents.filter((e) => e.channel === 'pi-code:subagent').map((e) => e.data as { phase: string; agentType: string; agentId: string })
    expect(phases.map((p) => ({ phase: p.phase, agentType: p.agentType }))).toEqual([
      { phase: 'start', agentType: 'scout' },
      { phase: 'stop', agentType: 'scout' },
    ])
    expect(phases[0].agentId).toMatch(/^fg-[0-9a-f]{8}$/)
    expect(phases[1].agentId).toBe(phases[0].agentId)
  })

  it('publishes no lifecycle events for an unknown agent', async () => {
    await execute('c1', { agent: 'ghost', task: 'inspect' }, undefined, undefined, trustedCtx)
    expect(emittedEvents.filter((e) => e.channel === 'pi-code:subagent')).toEqual([])
  })

  it('reports no output when the child exits cleanly with no assistant text', async () => {
    script('inspect', {})

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('(no output)')
  })

  it('names the stop reason in the failure text when one is reported', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'partial', stopReason: 'error', errorMessage: 'model overloaded' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent error: model overloaded')
  })

  it('fails an aborted run even though the child exited cleanly', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'partial work', stopReason: 'aborted' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('Agent aborted: partial work')
  })

  it('succeeds on a benign stop reason', async () => {
    script('inspect', { stdout: [messageEnd(assistantMessage({ text: 'all done', stopReason: 'stop' }))] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe('all done')
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

  it('bounds a large previous-step output before it rides the next step argv', async () => {
    // Without a cap the whole prior report becomes one argv string and the OS spawn fails.
    const huge = 'z'.repeat(200_000)
    const chain = [
      { agent: 'scout', task: 'a' },
      { agent: 'scout', task: 'use: {previous}' },
    ]
    script('a', { stdout: [say(huge)] })
    const result = await execute('c1', { chain }, undefined, undefined, trustedCtx)

    const secondArg = piArgs(spawnCalls[1]).at(-1) as string
    expect(secondArg.length).toBeLessThan(60_000)
    expect(secondArg.startsWith('Task: use: zzz')).toBe(true)
  })

  it('passes previous output containing $-patterns through verbatim', async () => {
    // String.replaceAll with a string replacement interprets $$, $&, $` and $'; a shell
    // snippet or awk line in the previous step's report must reach the next step intact.
    const chain = [
      { agent: 'scout', task: 'a' },
      { agent: 'scout', task: 'apply: {previous}' },
    ]
    script('a', { stdout: [say("kill $$ && echo '$&'")] })
    script("apply: kill $$ && echo '$&'", { stdout: [say('done')] })

    const result = await execute('c1', { chain }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[1]).at(-1)).toBe("Task: apply: kill $$ && echo '$&'")
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

  it('returns each task output in full so the caller can synthesize from it', async () => {
    const long = 'z'.repeat(150)
    script('alpha', { stdout: [say(long)] })
    script('beta', { stdout: [say('short')] })

    const result = await execute('c1', { tasks: tasksOf('alpha', 'beta') }, undefined, undefined, trustedCtx)

    expect(text(result)).toBe(`Parallel: 2/2 succeeded\n\n[scout] completed: ${long}\n\n[scout] completed: short`)
  })

  it('caps the combined parallel report at pi tool-output budget', async () => {
    const many = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, i) => `line ${i}`).join('\n')
    script('alpha', { stdout: [say(many)] })

    const result = await execute('c1', { tasks: tasksOf('alpha') }, undefined, undefined, trustedCtx)

    expect(text(result).split('\n').length).toBeLessThan(DEFAULT_MAX_LINES + 10)
    expect(text(result)).toContain('truncated')
  })

  it('caps single-mode output at pi tool-output budget', async () => {
    const many = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, i) => `l${i}`).join('\n')
    script('inspect', { stdout: [say(many)] })

    const result = await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(text(result).split('\n').length).toBeLessThan(DEFAULT_MAX_LINES + 10)
    expect(text(result)).toContain('truncated')
  })

  it('caps chain final output at pi tool-output budget', async () => {
    const many = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, i) => `l${i}`).join('\n')
    script('solo', { stdout: [say(many)] })

    const result = await execute('c1', { chain: [{ agent: 'scout', task: 'solo' }] }, undefined, undefined, trustedCtx)

    expect(text(result).split('\n').length).toBeLessThan(DEFAULT_MAX_LINES + 10)
    expect(text(result)).toContain('truncated')
  })

  it('caps the background completion notification at pi tool-output budget', async () => {
    await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)
    const onComplete = startBackgroundRunMock.mock.calls[0][3]
    const many = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, i) => `l${i}`).join('\n')

    onComplete({ id: 'bg-9', agent: 'scout', state: 'done', turns: 1, output: many })

    const lastCall = sendMessageMock.mock.calls.at(-1) as [{ content: string }]
    const content = lastCall[0].content
    expect(content.split('\n').length).toBeLessThan(DEFAULT_MAX_LINES + 10)
    expect(content).toContain('truncated')
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

    // alpha has emitted its message but not yet closed, so it is still running.
    expect(updates[0]).toEqual({ text: 'Parallel: 0/2 done, 2 running...', exitCodes: [-1, -1], sources: ['user', 'unknown'] })
    expect(updates.at(-1)).toEqual({ text: 'Parallel: 2/2 done, 0 running...', exitCodes: [0, 0], sources: ['user', 'user'] })
  })

  it('does not count a task done while it is still streaming', async () => {
    // A child that has emitted a message but not closed is still running; the streamed
    // update must not flip it to done (which would show ✓ and overcount).
    script('alpha', { stdout: [say('first turn'), say('second turn')] })
    const updates: { text: string; exitCodes: number[] }[] = []

    await execute('c1', { tasks: tasksOf('alpha') }, undefined, (partial) => updates.push({ text: text(partial), exitCodes: results(partial).map((r) => r.exitCode) }), trustedCtx)

    // Updates before the child closes report the task as running.
    expect(updates[0]).toEqual({ text: 'Parallel: 0/1 done, 1 running...', exitCodes: [-1] })
    expect(updates.at(-1)).toEqual({ text: 'Parallel: 1/1 done, 0 running...', exitCodes: [0] })
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

describe('agent memory', () => {
  let home: string
  let savedDisable: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(join(tmpdir(), 'sa-home-'))
    osHoisted.home = home
    savedDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  })
  afterEach(() => {
    osHoisted.home = ''
    if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedDisable
  })

  const writeStore = (dir: string, content: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, 'MEMORY.md'), content)
  }

  it('resolves the store directory per scope, keyed on the project root', () => {
    expect(agentMemoryDir('user', 'scout', '/repo', '/home/u')).toBe(join('/home/u', '.claude', 'agent-memory', 'scout'))

    const repo = fs.mkdtempSync(join(tmpdir(), 'sa-repo-'))
    fs.mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'packages', 'api')
    fs.mkdirSync(sub, { recursive: true })
    expect(agentMemoryDir('project', 'scout', sub, '/home/u')).toBe(join(repo, '.claude', 'agent-memory', 'scout'))
    expect(agentMemoryDir('local', 'scout', sub, '/home/u')).toBe(join(repo, '.claude', 'agent-memory-local', 'scout'))
    // Without a project marker the cwd itself is the root.
    expect(agentMemoryDir('project', 'scout', '/nowhere', '/home/u')).toBe(join('/nowhere', '.claude', 'agent-memory', 'scout'))
  })

  it('sanitizes a repo-controlled agent name before it becomes a path segment', () => {
    expect(agentMemoryDir('user', '../../etc/passwd', '/repo', '/home/u')).toBe(join('/home/u', '.claude', 'agent-memory', '.._.._etc_passwd'))
    // A name of only dots survives the character filter but would still traverse.
    expect(agentMemoryDir('user', '..', '/repo', '/home/u')).toBe(join('/home/u', '.claude', 'agent-memory', '_'))
  })

  it('appends the memory section with the stored MEMORY.md to the child prompt', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'user' })], projectAgentsDir: null })
    const dir = agentMemoryDir('user', 'scout', '/repo', home)
    writeStore(dir, '# Scout memory\n- prefers ripgrep\n')
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    const content = spawnCalls[0].promptFile?.content as string
    expect(content.startsWith('Be terse.')).toBe(true)
    expect(content).toContain('## Agent memory')
    expect(content).toContain(dir)
    expect(content).toContain('- prefers ripgrep')
  })

  it('caps the MEMORY.md carried into the section at the startup bound', () => {
    const long = ['# idx', ...Array.from({ length: 300 }, (_, i) => `- [m${i}](m${i}.md): entry ${i}`)].join('\n')
    const section = agentMemorySection('/mem/scout', long)
    expect(section).toContain('- [m0](m0.md): entry 0')
    expect(section).not.toContain('- [m250](m250.md)')
    expect(section).toContain('not shown')
  })

  it('tells a memory-enabled child where to start when no MEMORY.md exists yet', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'user' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    const content = spawnCalls[0].promptFile?.content as string
    expect(content).toContain('## Agent memory')
    expect(content).toContain('does not exist yet')
  })

  it('adds nothing when auto memory is disabled by the env kill switch', async () => {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'user', tools: ['grep'] })], projectAgentsDir: null })
    writeStore(agentMemoryDir('user', 'scout', '/repo', home), '- kept out\n')
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(spawnCalls[0].promptFile?.content).toBe('Be terse.')
    const args = piArgs(spawnCalls[0])
    expect(args[args.indexOf('--tools') + 1]).toBe('grep')
  })

  it('adds nothing when user settings disable auto memory', async () => {
    fs.mkdirSync(join(home, '.claude'), { recursive: true })
    fs.writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }))
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'user' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(spawnCalls[0].promptFile?.content).toBe('Be terse.')
  })

  it('widens a restricted allowlist with read, write, edit so the child can manage its store', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ memory: 'user', tools: ['grep', 'read'] })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    const args = piArgs(spawnCalls[0])
    expect(args[args.indexOf('--tools') + 1]).toBe('grep,read,write,edit')
  })

  it('leaves an unrestricted memory-enabled agent without a --tools flag', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ memory: 'user' })], projectAgentsDir: null })
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, trustedCtx)

    expect(piArgs(spawnCalls[0])).not.toContain('--tools')
  })

  it('withMemoryTools leaves no allowlist alone and never duplicates a tool', () => {
    expect(withMemoryTools(undefined)).toBeUndefined()
    expect(withMemoryTools(['bash', 'edit'])).toEqual(['bash', 'edit', 'read', 'write'])
  })

  it('skips a project-scoped store when the project is not approved', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'project' })], projectAgentsDir: null })
    const ctx = { ...trustedCtx, isProjectTrusted: () => false }
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, ctx)

    expect(spawnCalls[0].promptFile?.content).toBe('Be terse.')
  })

  it('anchors project memory at the session repo, never a model-supplied cwd', async () => {
    // The store must come from the approved session repo, not an arbitrary cwd the
    // model passes; otherwise an unapproved clone's agent-memory injects as trusted.
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'project' })], projectAgentsDir: null })
    const sessionRepo = fs.mkdtempSync(join(tmpdir(), 'sa-session-'))
    fs.mkdirSync(join(sessionRepo, '.git'))
    const otherRepo = fs.mkdtempSync(join(tmpdir(), 'sa-other-'))
    fs.mkdirSync(join(otherRepo, '.git'))
    writeStore(agentMemoryDir('project', 'scout', sessionRepo, home), '- session store\n')
    writeStore(agentMemoryDir('project', 'scout', otherRepo, home), '- DECOY from an unapproved cwd\n')
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect', cwd: otherRepo }, undefined, undefined, { ...trustedCtx, cwd: sessionRepo })

    const content = spawnCalls[0].promptFile?.content as string
    expect(content).toContain('- session store')
    expect(content).not.toContain('DECOY')
  })

  it('keeps a user-scoped store even when the project is not approved', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'Be terse.', memory: 'user' })], projectAgentsDir: null })
    writeStore(agentMemoryDir('user', 'scout', '/repo', home), '- crosses projects\n')
    const ctx = { ...trustedCtx, isProjectTrusted: () => false }
    script('inspect', { stdout: [say('ok')] })

    await execute('c1', { agent: 'scout', task: 'inspect' }, undefined, undefined, ctx)

    expect(spawnCalls[0].promptFile?.content).toContain('- crosses projects')
  })

  it('carries the memory section and widened tools into a background run', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agentConfig({ systemPrompt: 'You audit.', memory: 'user', tools: ['grep'] })], projectAgentsDir: null })
    writeStore(agentMemoryDir('user', 'scout', '/repo', home), '- audit patterns\n')

    await execute('c1', { background: true, agent: 'scout', task: 'audit' }, undefined, undefined, trustedCtx)

    const invocation = startBackgroundRunMock.mock.calls[0][2]
    expect(invocation.args[invocation.args.indexOf('--tools') + 1]).toBe('grep,read,write,edit')
    const promptPath = invocation.args[invocation.args.indexOf('--append-system-prompt') + 1]
    const content = fs.readFileSync(promptPath, 'utf-8')
    expect(content).toContain('## Agent memory')
    expect(content).toContain('- audit patterns')
  })
})

describe('foreground abort process group', () => {
  it('spawns the child detached and signals its whole group on abort', async () => {
    const controller = new AbortController()
    script('inspect', { stdout: [say('too late')], delay: 30 })
    const groupKills: Array<[unknown, unknown]> = []
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string) => {
      groupKills.push([pid, sig])
      return true
    }) as never)
    try {
      const pending = execute('c1', { agent: 'scout', task: 'inspect' }, controller.signal, undefined, trustedCtx)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect((spawnCalls[0].options as { detached?: boolean }).detached).toBe(true)
      ;(spawnedChildren[0] as { pid?: number }).pid = 424242
      controller.abort()
      await expect(pending).rejects.toThrow('Subagent was aborted')
      expect(groupKills).toContainEqual([-424242, 'SIGTERM'])
    } finally {
      killSpy.mockRestore()
    }
  })
})
