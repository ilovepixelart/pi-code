import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import commandsExtension from '../extensions/commands.ts'
import planModeExtension from '../extensions/plan-mode/index.ts'

const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

/**
 * Plan mode and the commands extension both snapshot and restore the active tool set, and
 * each one's tests fake only itself. This wires the real extensions to one shared `pi`, the
 * way a session has them, and drives the sequence that broke: a tool-scoped command run
 * inside plan mode, then "Execute the plan".
 */
const ALL_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'question', 'plan_mode_complete', 'edit', 'write']

type Handler = (event: unknown, ctx: unknown) => unknown

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-'))
  dirs.push(dir)
  return dir
}

let savedAgentDir: string | undefined
beforeEach(() => {
  hoisted.home = tempDir()
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = tempDir()
})
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const writePersonalCommand = (name: string, content: string): void => {
  const dir = join(hoisted.home, '.claude', 'commands')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), content)
}

function session() {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const tools = new Map<string, (id: string, params: Record<string, unknown>) => Promise<unknown>>()
  const listeners = new Map<string, Array<(data: unknown) => void>>()
  const registered = [...ALL_TOOLS]
  let active = [...ALL_TOOLS]

  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec.handler),
    registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => tools.set(tool.name, tool.execute),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => false,
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => {
      active = next
    },
    getAllTools: () => registered.map((name) => ({ name })),
    exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
    setModel: async () => true,
    setThinkingLevel: () => {},
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(data)
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
        return () => {}
      },
    },
  }
  commandsExtension(pi as never)
  planModeExtension(pi as never)

  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text }
  const ctx = {
    cwd: tempDir(),
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => 'sess-1', getEntries: () => [] as unknown[], getBranch: () => [] as unknown[] },
    thinkingLevel: 'high',
    model: { id: 'gemma4', name: 'Gemma 4' },
    modelRegistry: { getAvailable: () => [{ id: 'gemma4', name: 'Gemma 4' }] },
    ui: {
      theme,
      confirm: async () => true,
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      // Plan mode's "what next?" menu: the first choice is "Execute the plan".
      select: async (_question: string, choices: string[]) => choices[0],
      editor: async () => '',
    },
  }
  const emit = async (name: string, event: unknown = {}) => {
    let result: unknown
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result
    return result
  }
  return {
    active: () => active,
    /** pi registers the tool and activates it on top of the set in force. */
    registerLateTool: (name: string) => {
      registered.push(name)
      active = [...active, name]
    },
    emit,
    command: (name: string, args = '') => commands.get(name)?.(args, ctx),
    tool: (name: string, params: Record<string, unknown>) => tools.get(name)?.('call-1', params),
    bash: (command: string) => emit('tool_call', { toolName: 'bash', input: { command } }) as Promise<{ block?: boolean; reason?: string } | undefined>,
  }
}

/** /plan, a command that narrows the run to read and `git log`, then the model
 * submits its plan and the user picks "Execute the plan". */
async function planWithScopedCommandThenExecute() {
  writePersonalCommand('triage', '---\nallowed-tools: Read, Bash(git log:*)\n---\nTriage the issue.')
  const s = session()
  await s.emit('session_start', { reason: 'startup' })
  await s.command('plan')
  await s.command('triage')
  await s.tool('plan_mode_complete', { plan: '1. Read the loader\n2. Add the field' })
  await s.emit('agent_end', { messages: [] })
  return s
}

describe('a tool-scoped command run inside plan mode, then "Execute the plan"', () => {
  it("executes with the tools it had before plan mode, not the planning command's scope", async () => {
    // Execution continues in the same run as the command. The command's bash scope still
    // judged every call: `ls` was blocked with "allowed-tools: bash is scoped for this
    // command" although the user had just approved the plan. (`ls` is a read plan mode
    // allows, so only the command's scope can be refusing it.)
    const s = await planWithScopedCommandThenExecute()

    expect(s.active()).toContain('edit')
    expect(s.active()).toContain('write')
    expect(await s.bash('ls')).toBeUndefined()
  })

  it('leaves the full tool set once the run settles, with plan mode off', async () => {
    // agent_settled then restored the snapshot the command took while plan mode was on: the
    // read-only set. The session ended with edit and write gone, plan mode reported off, and
    // no guard: only /new or a restart recovered it.
    const s = await planWithScopedCommandThenExecute()
    await s.emit('agent_settled')

    for (const tool of ALL_TOOLS) expect(s.active()).toContain(tool)
  })

  it('still enforces the command scope while the plan is only being drafted', async () => {
    writePersonalCommand('triage', '---\nallowed-tools: Read, Bash(git log:*)\n---\nTriage the issue.')
    const s = session()
    await s.emit('session_start', { reason: 'startup' })
    await s.command('plan')
    await s.command('triage')

    // Both are reads plan mode allows; only the command's scope tells them apart.
    expect((await s.bash('ls'))?.reason).toContain('scoped for this command')
    expect(await s.bash('git log --oneline')).toBeUndefined()
  })

  it('returns to the read-only set, not the full one, when the run settles and the user stays in plan mode', async () => {
    writePersonalCommand('triage', '---\nallowed-tools: Read, Bash(git log:*)\n---\nTriage the issue.')
    const s = session()
    await s.emit('session_start', { reason: 'startup' })
    await s.command('plan')
    await s.command('triage')
    await s.emit('agent_settled')

    expect(s.active()).toContain('read')
    expect(s.active()).not.toContain('edit')
    expect(s.active()).not.toContain('write')
  })
})

describe('a scoped command run outside plan mode', () => {
  it('still restores the tools it took away, and keeps one registered during its run', async () => {
    writePersonalCommand('triage', '---\nallowed-tools: Read\n---\nRead only.')
    const s = session()
    await s.emit('session_start', { reason: 'startup' })
    await s.command('triage')
    expect(s.active()).toEqual(['read'])

    s.registerLateTool('github_create_issue')
    await s.emit('agent_settled')

    for (const tool of ALL_TOOLS) expect(s.active()).toContain(tool)
    expect(s.active()).toContain('github_create_issue')
  })
})
