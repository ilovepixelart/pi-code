import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
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

  it('truncates a memory larger than the context budget on read', async () => {
    const { handlers, tool, cwd } = setup()
    await start(handlers, cwd)

    // pi's guide: tools MUST truncate their output; the built-in budget is 50KB / 2000 lines.
    const huge = 'x'.repeat(60_000)
    await tool.execute('1', { action: 'save', name: 'big', description: 'oversized', content: huge })

    const read = (await tool.execute('2', { action: 'read', name: 'big' })).content[0].text
    expect(read.length).toBeLessThan(huge.length)
    expect(read).toContain('truncated')
  })

  it('returns a small memory whole', async () => {
    const { handlers, tool, cwd } = setup()
    await start(handlers, cwd)

    await tool.execute('1', { action: 'save', name: 'small', description: 'fits', content: 'just this' })
    expect((await tool.execute('2', { action: 'read', name: 'small' })).content[0].text).toBe('just this')
  })

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

describe('memory index robustness', () => {
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

  it('refuses to save while the index is unreadable instead of clobbering it', async () => {
    const { handlers, tool, cwd, dir } = setup()
    await start(handlers, cwd)
    await tool.execute('1', { action: 'save', name: 'first', description: 'existing entry', content: 'kept' })

    const indexPath = join(dir, 'MEMORY.md')
    chmodSync(indexPath, 0o000)
    const result = (await tool.execute('2', { action: 'save', name: 'second', description: 'new entry', content: 'other' })).content[0].text
    chmodSync(indexPath, 0o644)

    expect(result).not.toContain('Saved memory')
    expect(readFileSync(indexPath, 'utf-8')).toContain('- [first](first.md):')
  })

  it('waits for an in-flight queued index mutation instead of racing it', async () => {
    const { handlers, tool, cwd, dir } = setup()
    await start(handlers, cwd)
    await tool.execute('1', { action: 'save', name: 'first', description: 'existing entry', content: 'kept' })
    const indexPath = join(dir, 'MEMORY.md')

    // A built-in edit holds the per-file mutation queue across its whole
    // read-modify-write. A save that does not join that queue reads the same old
    // index while the edit is parked mid-window, and one of the two updates is lost.
    let releaseEdit = () => {}
    const editParked = new Promise<void>((resolve) => {
      releaseEdit = resolve
    })
    let editRead = () => {}
    const editReadDone = new Promise<void>((resolve) => {
      editRead = resolve
    })
    const edit = withFileMutationQueue(indexPath, async () => {
      const before = readFileSync(indexPath, 'utf-8')
      editRead()
      await editParked
      writeFileSync(indexPath, before.replace('existing entry', 'edited entry'))
    })

    await editReadDone
    const save = tool.execute('2', { action: 'save', name: 'second', description: 'new entry', content: 'body' })
    // Give the save time to reach the queue (or, unqueued, to run to completion).
    await new Promise((resolve) => setImmediate(resolve))
    releaseEdit()
    await Promise.all([edit, save])

    const index = readFileSync(indexPath, 'utf-8')
    expect(index).toContain('- [first](first.md): edited entry')
    expect(index).toContain('- [second](second.md): new entry')
  })

  it('lands both of two concurrent saves in the index', async () => {
    const { handlers, tool, cwd, dir } = setup()
    await start(handlers, cwd)

    await Promise.all([tool.execute('1', { action: 'save', name: 'alpha', description: 'first of a pair', content: 'a' }), tool.execute('2', { action: 'save', name: 'beta', description: 'second of a pair', content: 'b' })])

    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
    expect(index).toContain('- [alpha](alpha.md): first of a pair')
    expect(index).toContain('- [beta](beta.md): second of a pair')
  })

  it('refuses to delete while the index is unreadable, keeping the memory file', async () => {
    const { handlers, tool, cwd, dir } = setup()
    await start(handlers, cwd)
    await tool.execute('1', { action: 'save', name: 'keep', description: 'to survive', content: 'body' })

    const indexPath = join(dir, 'MEMORY.md')
    chmodSync(indexPath, 0o000)
    const result = (await tool.execute('2', { action: 'delete', name: 'keep' })).content[0].text
    chmodSync(indexPath, 0o644)

    expect(result).not.toContain('Deleted')
    expect(existsSync(join(dir, 'keep.md'))).toBe(true)
    expect(readFileSync(indexPath, 'utf-8')).toContain('- [keep](keep.md):')
  })
})
