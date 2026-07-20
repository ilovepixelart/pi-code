import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import memoryExtension, { memoryDir } from '../extensions/memory.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }

// os.homedir() honors $HOME on POSIX, so point memory's store at a throwaway home.
describe('memory tool actions', () => {
  const origHome = process.env.HOME
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
  })

  function setup() {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'mem-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    const handlers = new Map<string, Handler>()
    let tool: Tool | undefined
    memoryExtension({
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      registerTool: (t: Tool) => {
        tool = t
      },
    } as never)
    if (!tool) throw new Error('memory tool not registered')
    return { handlers, tool, cwd, dir: memoryDir(cwd) }
  }

  const start = async (handlers: Map<string, Handler>, cwd: string) => handlers.get('session_start')?.({}, { cwd, ui: { notify: () => {} } })

  it('saves, reads, lists, and deletes a memory', async () => {
    const { handlers, tool, cwd, dir } = setup()
    await start(handlers, cwd)

    const saved = await tool.execute('1', { action: 'save', name: 'Build Cmd', description: 'how to build', content: 'run npm build' })
    expect(saved.content[0].text).toContain('Saved memory build-cmd')
    expect(existsSync(join(dir, 'build-cmd.md'))).toBe(true)

    expect((await tool.execute('2', { action: 'read', name: 'build-cmd' })).content[0].text).toBe('run npm build')
    expect((await tool.execute('3', { action: 'list' })).content[0].text).toContain('build-cmd')

    expect((await tool.execute('4', { action: 'delete', name: 'build-cmd' })).content[0].text).toContain('Deleted')
    expect(existsSync(join(dir, 'build-cmd.md'))).toBe(false)
  })

  it('validates required fields and reports missing reads', async () => {
    const { handlers, tool, cwd } = setup()
    await start(handlers, cwd)
    expect((await tool.execute('1', { action: 'save', name: 'x' })).content[0].text).toContain('requires')
    expect((await tool.execute('2', { action: 'read', name: 'nope' })).content[0].text).toContain('No memory named nope')
    expect((await tool.execute('3', { action: 'list' })).content[0].text).toContain('No memories')
  })

  it('injects the saved memory index into the system prompt', async () => {
    const { handlers, tool, cwd } = setup()
    await start(handlers, cwd)
    await tool.execute('1', { action: 'save', name: 'style', description: 'code style', content: 'tabs' })
    const result = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(result.systemPrompt).toContain('## Memory')
    expect(result.systemPrompt).toContain('style')
  })
})
