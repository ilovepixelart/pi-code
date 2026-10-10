import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { type AgentSession, createAgentSession, createCodemodeExtension, DefaultResourceLoader, type ExtensionFactory, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { describe, expect, it, vi } from 'vitest'

import todoExtension, { type Todo } from '../extensions/todo.ts'

type Snapshot = { action: string; todos: Todo[]; nextId: number }

/** Load only Todo, real Codemode, and a scripted offline model in a private home. */
const setup = (extraFactories: ExtensionFactory[] = [], extraTools: string[] = []) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-session-'))
  const agentDir = path.join(home, 'agent')
  fs.mkdirSync(agentDir)
  vi.stubEnv('HOME', home)
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  vi.stubEnv('PI_OFFLINE', '1')
  const faux = fauxProvider({ provider: 'todo-fixture', api: 'todo-fixture', tokensPerSecond: Infinity })
  let sequence = 0

  /** Recreate the extension runtime for reload and file-backed reopen. */
  const open = async (manager: SessionManager) => {
    const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({
      cwd: home,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [todoExtension, createCodemodeExtension(), (pi) => pi.registerProvider(faux.provider), ...extraFactories],
    })
    await resourceLoader.reload()
    const { session, extensionsResult } = await createAgentSession({ cwd: home, agentDir, settingsManager, resourceLoader, sessionManager: manager, model: faux.getModel(), thinkingLevel: 'off', tools: ['todo', 'codemode', ...extraTools] })
    expect(extensionsResult.errors).toEqual([])
    await session.bindExtensions({
      onError: (error) => {
        throw new Error(JSON.stringify(error))
      },
    })
    return session
  }

  /** Execute real model-issued calls, retaining the parent result on failure. */
  const call = async (session: AgentSession, name: string, arguments_: Parameters<typeof fauxToolCall>[1]) => {
    const id = `todo-${++sequence}`
    faux.setResponses([fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), { stopReason: 'toolUse' }), fauxAssistantMessage('Done.')])
    await session.prompt(`Offline operation ${sequence}`)
    const result = session.messages.filter((message) => message.role === 'toolResult' && message.toolCallId === id).at(-1)
    if (result?.role !== 'toolResult') throw new Error(`Missing result ${id}`)
    return result
  }

  return { home, open, call, faux }
}

/** Inspect the live provider without appending a rescuing direct tool-result snapshot. */
const snapshot = async (session: AgentSession): Promise<Snapshot> => {
  const tool = session.agent.state.tools.find((tool) => tool.name === 'todo')
  if (!tool) throw new Error('Missing Todo provider')
  const result = await tool.execute('inspect', { action: 'list' }, new AbortController().signal)
  return result.details as Snapshot
}

describe('todo session persistence through real Codemode', () => {
  it('keeps ten tasks and allocates eleven after reload and disk reopen', async () => {
    const fixture = setup()
    let session = await fixture.open(SessionManager.create(fixture.home))
    try {
      for (let id = 1; id <= 8; id++) await fixture.call(session, 'todo', { action: 'add', text: `Task ${id}` })
      await fixture.call(session, 'todo', { action: 'complete', id: 2 })
      await fixture.call(session, 'todo', { action: 'start', id: 7, activeForm: 'Working on task seven' })
      const parent = await fixture.call(session, 'codemode', { code: 'await Promise.all([tools.todo({action:"add",text:"Ninth"}),tools.todo({action:"add",text:"Tenth"})]);' })
      expect(parent.isError).toBe(false)
      const live = await snapshot(session)
      expect(live.todos).toHaveLength(10)
      expect(live.nextId).toBe(11)
      expect(session.messages.filter((message) => message.role === 'toolResult' && message.toolName === 'todo')).toHaveLength(10)
      await session.reload()
      expect(await snapshot(session)).toEqual(live)
      const sessionFile = session.sessionFile
      if (!sessionFile) throw new Error('Missing session file')
      session.dispose()
      session = await fixture.open(SessionManager.open(sessionFile))
      expect(await snapshot(session)).toEqual(live)
      const added = await fixture.call(session, 'todo', { action: 'add', text: 'Next' })
      expect((added.details as unknown as Snapshot).todos.at(-1)?.id).toBe(11)
    } finally {
      session.dispose()
    }
  })

  it('replays newer nested mutations even when an older direct result finishes last', async () => {
    let release: () => void = () => {}
    const nestedFinished = new Promise<void>((resolve) => {
      release = resolve
    })
    const fixture = setup([
      (pi) => {
        pi.on('tool_result', async (event) => {
          if (event.toolCallId === 'direct') await nestedFinished
          if (event.parentToolCallId === 'parent' && event.toolName === 'todo') release()
        })
      },
    ])
    const session = await fixture.open(SessionManager.create(fixture.home))
    try {
      session.agent.toolExecution = 'parallel'
      fixture.faux.setResponses([fauxAssistantMessage([fauxToolCall('todo', { action: 'add', text: 'Direct' }, { id: 'direct' }), fauxToolCall('codemode', { code: 'await tools.todo({action:"add",text:"Nested"});' }, { id: 'parent' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Done.')])
      await session.prompt('Mixed concurrent additions')
      const branch = session.sessionManager.getBranch()
      const direct = branch.filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'direct').at(-1)
      const latestSnapshot = branch.filter((entry) => entry.type === 'custom' && entry.customType === 'pi-code:todo').at(-1)
      if (!direct || !latestSnapshot) throw new Error('Missing concurrent persistence entries')
      expect(branch.indexOf(direct)).toBeGreaterThan(branch.indexOf(latestSnapshot))
      const live = await snapshot(session)
      expect(live.todos).toHaveLength(2)
      await session.reload()
      expect(await snapshot(session)).toEqual(live)
    } finally {
      session.dispose()
    }
  })

  it('keeps completed mutations when the enclosing Codemode script is aborted', async () => {
    let started: () => void = () => {}
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const fixture = setup(
      [
        (pi) => {
          pi.registerTool({
            name: 'fixture_wait',
            label: 'Wait',
            description: 'Wait for cancellation',
            parameters: Type.Object({}),
            /** Wait for a real nested abort signal after notifying the test. */
            execute: async (_id, _params, signal) => {
              started()
              return await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true })
              })
            },
          })
        },
      ],
      ['fixture_wait'],
    )
    const session = await fixture.open(SessionManager.create(fixture.home))
    try {
      expect(session.agent.state.tools.some((tool) => tool.name === 'fixture_wait')).toBe(true)
      fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode', { code: 'await tools.todo({action:"add",text:"Before abort"}); await tools.fixture_wait({});' }), { stopReason: 'toolUse' })])
      const prompt = session.prompt('Cancel nested execution')
      expect(await Promise.race([waiting.then(() => 'waiting'), prompt.then(() => 'finished')])).toBe('waiting')
      await session.abort()
      await prompt
      const live = await snapshot(session)
      expect(live.todos[0].text).toBe('Before abort')
      expect(live.nextId).toBe(2)
      await session.reload()
      expect(await snapshot(session)).toEqual(live)
    } finally {
      session.dispose()
    }
  })

  it('keeps completed mutations when the enclosing Codemode script fails', async () => {
    const fixture = setup()
    const session = await fixture.open(SessionManager.create(fixture.home))
    try {
      const parent = await fixture.call(session, 'codemode', { code: 'await tools.todo({action:"add",text:"Committed before failure"}); throw new Error("parent failed");' })
      expect(parent.isError).toBe(true)
      const live = await snapshot(session)
      expect(live.todos[0].text).toBe('Committed before failure')
      await session.reload()
      expect(await snapshot(session)).toEqual(live)
    } finally {
      session.dispose()
    }
  })
})
