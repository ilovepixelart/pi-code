import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import memoryExtension, { INDEX_FILE, resolveMemoryDir } from '../extensions/memory.ts'

type CommandSpec = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }

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
