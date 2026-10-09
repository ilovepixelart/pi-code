import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import memoryExtension, { INDEX_FILE, resolveMemoryDir } from '../extensions/memory.ts'

type CommandSpec = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }

// The external editor is a child process; each spawn is recorded and closed by the test.
const editors = vi.hoisted(() => ({ spawned: [] as Array<{ command: string; args: string[]; options: Record<string, unknown>; child: import('node:events').EventEmitter }> }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      const child = new Emitter()
      editors.spawned.push({ command, args, options, child })
      return child
    },
  }
})

// os.homedir() honors $HOME on POSIX, so point the settings write at a throwaway home.
describe('memory command', () => {
  let home: string
  let savedHome: string | undefined
  let savedDisable: string | undefined
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedHome = process.env.HOME
    home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home // os.homedir() reads USERPROFILE on Windows; global setup restores it
    savedDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    // Config-dir tests set this explicitly; clear it so the rest resolve to ~/.claude.
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedDisable
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  })

  function wire() {
    const commands = new Map<string, CommandSpec>()
    memoryExtension({
      on: () => {},
      registerTool: () => {},
      registerCommand: (name: string, spec: CommandSpec) => commands.set(name, spec),
    } as never)
    return commands
  }
  const settingsFile = () => join(home, '.claude', 'settings.json')
  const ctxFor = (cwd: string, notify = vi.fn()) => ({ cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify } })
  const run = async (args: string, cwd: string, notify = vi.fn()) => {
    await wire().get('memory')?.handler(args, ctxFor(cwd, notify))
    return notify
  }

  it('registers a single memory command', () => {
    expect([...wire().keys()]).toEqual(['memory'])
  })

  it('lists the store, index, CLAUDE.md locations and the enabled state', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const notify = await run('', cwd)
    const text = notify.mock.calls[0][0] as string
    expect(text).toContain(join(home, '.claude', 'CLAUDE.md'))
    expect(text).toContain(join(cwd, 'CLAUDE.md'))
    expect(text).toContain(join(resolveMemoryDir(cwd), INDEX_FILE))
    expect(text).toMatch(/Auto memory:\s*on/i) // enabled by default
  })

  it('writes autoMemoryEnabled off/on while preserving other settings keys', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark', autoMemoryDirectory: '~/mem' }))
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))

    const offNotify = await run('off', cwd)
    const off = JSON.parse(readFileSync(settingsFile(), 'utf-8'))
    expect(off.autoMemoryEnabled).toBe(false)
    expect(off.theme).toBe('dark') // untouched
    expect(off.autoMemoryDirectory).toBe('~/mem') // untouched
    expect(offNotify.mock.calls[0][0]).toMatch(/disabled/i)

    await run('on', cwd)
    const on = JSON.parse(readFileSync(settingsFile(), 'utf-8'))
    expect(on.autoMemoryEnabled).toBe(true)
    expect(on.theme).toBe('dark')
  })

  it('creates the settings file and its directory when missing', async () => {
    expect(existsSync(settingsFile())).toBe(false)
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    await run('on', cwd)
    expect(existsSync(settingsFile())).toBe(true)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf-8')).autoMemoryEnabled).toBe(true)
  })

  it('reflects a just-written disabled state in the listing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    await run('off', cwd)
    const notify = await run('', cwd)
    expect(notify.mock.calls[0][0]).toMatch(/Auto memory:\s*off/i)
  })

  it('notifies usage for an invalid argument', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const notify = await run('bogus', cwd)
    expect(notify.mock.calls[0][0]).toMatch(/usage/i)
    expect(notify.mock.calls[0][1]).toBe('error')
  })

  it('does not clobber a present-but-unparseable settings.json and reports the error', async () => {
    // A malformed settings.json must be left intact: overwriting it would destroy the
    // user's hooks, env and permissions config.
    mkdirSync(join(home, '.claude'), { recursive: true })
    const invalid = '{ this is not valid json'
    writeFileSync(settingsFile(), invalid)
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))

    const notify = await run('on', cwd)
    expect(readFileSync(settingsFile(), 'utf-8')).toBe(invalid) // unchanged
    expect(notify.mock.calls[0][0]).toMatch(/not valid JSON/i)
    expect(notify.mock.calls[0][1]).toBe('error')
  })

  it('reports a settings.json that cannot be read instead of writing over it', async () => {
    // A directory where the file belongs: the read fails with something other than ENOENT.
    mkdirSync(settingsFile(), { recursive: true })
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))

    const notify = await run('off', cwd)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatch(/^Could not update auto memory: /)
    expect(notify.mock.calls[0][1]).toBe('error')
    expect(statSync(settingsFile()).isDirectory()).toBe(true)
  })

  it('lists the autoMemoryDirectory store from the user settings', async () => {
    const store = mkdtempSync(join(tmpdir(), 'mem-store-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ autoMemoryDirectory: store }))
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))

    const text = (await run('', cwd)).mock.calls[0][0] as string
    expect(text).toContain(`  Store:       ${store}\n`)
    expect(text).toContain(`  Index:       ${join(store, INDEX_FILE)}\n`)
  })

  it('reads and writes settings under CLAUDE_CONFIG_DIR when it is set', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mem-config-'))
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      // The listing reads autoMemoryEnabled from the relocated config dir.
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }))
      const listing = await run('', cwd)
      expect(listing.mock.calls[0][0]).toMatch(/Auto memory:\s*off/i)

      // /memory on writes into the relocated config dir, not ~/.claude.
      await run('on', cwd)
      expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')).autoMemoryEnabled).toBe(true)
      expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
})

// Claude's /memory opens a memory file in the user's editor. The editor writes the file
// itself: pi-code hands it the terminal (pi's TUI stopped, as pi's own ctrl+g does) and
// never reads or rewrites the bytes, so nothing is normalised and nothing is overwritten.
describe('/memory edit', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.VISUAL = 'fake-editor --wait'
    editors.spawned.length = 0
  })

  const run = async (cwd: string, pick: (options: string[]) => string | undefined, over: Record<string, unknown> = {}) => {
    const commands = new Map<string, CommandSpec>()
    memoryExtension({ on: () => {}, registerTool: () => {}, registerCommand: (name: string, spec: CommandSpec) => commands.set(name, spec) } as never)
    const order: string[] = []
    const tui = { stop: () => order.push('stop'), start: () => order.push('start'), requestRender: (force?: boolean) => order.push(`render:${force}`) }
    const notify = vi.fn()
    const select = vi.fn(async (_title: string, options: string[]) => pick(options))
    const custom = vi.fn(
      (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) =>
        new Promise((resolve) => {
          factory(tui, {}, {}, resolve)
        }),
    )
    const pending = commands.get('memory')?.handler('edit', { cwd, isProjectTrusted: () => false, hasUI: true, ui: { notify, select, custom }, ...over })
    return { pending, order, notify, select, custom }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  it('opens the chosen file in the configured editor with the terminal handed over', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const file = join(cwd, 'CLAUDE.md')
    writeFileSync(file, '# Rules\r\n\tindented\r\n')
    const probe = await run(cwd, (options) => options.find((option) => option.includes(file)))
    await settle()

    expect(editors.spawned).toHaveLength(1)
    expect(editors.spawned[0].command).toBe('fake-editor')
    expect(editors.spawned[0].args).toEqual(['--wait', file])
    expect(editors.spawned[0].options.stdio).toBe('inherit')
    expect(probe.order).toEqual(['stop'])

    editors.spawned[0].child.emit('close', 0)
    await probe.pending
    expect(probe.order).toEqual(['stop', 'start', 'render:true'])
    // pi-code never touched the bytes; only the editor would have.
    expect(readFileSync(file, 'utf8')).toBe('# Rules\r\n\tindented\r\n')
    expect(probe.notify).not.toHaveBeenCalled()
  })

  it('creates a missing parent directory so the editor can save there', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const file = join(cwd, '.claude', 'CLAUDE.md')
    const probe = await run(cwd, (options) => options.find((option) => option.endsWith(file)))
    await settle()
    expect(existsSync(join(cwd, '.claude'))).toBe(true)
    expect(existsSync(file)).toBe(false)
    editors.spawned[0].child.emit('close', 0)
    await probe.pending
  })

  // Creating a symlink needs elevation on Windows.
  it.skipIf(process.platform === 'win32')('names the real target of a symlinked memory file in the picker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const target = join(home, 'elsewhere.md')
    writeFileSync(target, 'x')
    symlinkSync(target, join(cwd, 'CLAUDE.md'))
    const probe = await run(cwd, () => undefined)
    await probe.pending
    expect(probe.select.mock.calls[0][1]).toContainEqual(expect.stringContaining(`-> ${realpathSync(target)}`))
    expect(editors.spawned).toHaveLength(0)
  })

  it('reports an editor that fails, and restores the terminal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const probe = await run(cwd, (options) => options[1])
    await settle()
    editors.spawned[0].child.emit('close', 2)
    await probe.pending
    expect(probe.order).toEqual(['stop', 'start', 'render:true'])
    expect(probe.notify).toHaveBeenCalledWith('The editor (fake-editor --wait) exited with code 2', 'error')
  })

  it('needs the interactive UI', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
    const probe = await run(cwd, (options) => options[0], { hasUI: false })
    await probe.pending
    expect(probe.select).not.toHaveBeenCalled()
    expect(probe.notify).toHaveBeenCalledWith('/memory edit needs the interactive UI', 'error')
  })
})

describe('memory location listing, per the documented /memory contract', () => {
  const wire = () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
    memoryExtension({ on: () => {}, registerTool: () => {}, registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec) } as never)
    return commands
  }

  it('lists CLAUDE.local.md and the project .claude/CLAUDE.md alternate', async () => {
    // Claude: "/memory lists your CLAUDE.md, CLAUDE.local.md, and other memory
    // file locations across user and project scopes, including entries for files
    // that don't exist yet."
    const cwd = mkdtempSync(join(tmpdir(), 'memcmd-'))
    const notify = vi.fn()
    await wire()
      .get('memory')
      ?.handler('', { cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify } })
    const text = notify.mock.calls[0][0] as string
    expect(text).toContain('CLAUDE.local.md')
    expect(text).toContain(join('.claude', 'CLAUDE.md'))
  })
})
