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

  describe('/memory edit', () => {
    // Claude's /memory opens a memory file for editing; pi's seam is ctx.ui.editor. The
    // picker offers each listed CLAUDE.md location; `pick` chooses the one naming `file`.
    const editCtx = (cwd: string, file: string | undefined, edited: string | undefined) => {
      const notify = vi.fn()
      const select = vi.fn(async (_title: string, options: string[]) => (file === undefined ? undefined : options.find((option) => option.includes(file))))
      const editor = vi.fn(async (_title: string, _prefill?: string) => edited)
      return { ctx: { cwd, isProjectTrusted: () => false, hasUI: true, ui: { notify, select, editor } }, notify, select, editor }
    }
    const edit = async (cwd: string, file: string | undefined, edited: string | undefined) => {
      const probe = editCtx(cwd, file, edited)
      await wire().get('memory')?.handler('edit', probe.ctx)
      return probe
    }

    it('offers every CLAUDE.md location the listing names', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      const { select } = await edit(cwd, undefined, undefined)
      expect(select.mock.calls[0][1]).toEqual([expect.stringContaining(join(home, '.claude', 'CLAUDE.md')), expect.stringContaining(join(cwd, 'CLAUDE.md')), expect.stringContaining(join(cwd, 'CLAUDE.local.md')), expect.stringContaining(join(cwd, '.claude', 'CLAUDE.md'))])
    })

    it('opens the chosen file prefilled with its content and writes the edit back', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      writeFileSync(join(cwd, 'CLAUDE.md'), 'old rules\n')
      const { editor } = await edit(cwd, join(cwd, 'CLAUDE.md'), 'new rules\n')
      expect(editor.mock.calls[0][1]).toBe('old rules\n')
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf-8')).toBe('new rules\n')
    })

    it('creates a missing file, and its directory, from an empty editor', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      const target = join(cwd, '.claude', 'CLAUDE.md')
      const { editor } = await edit(cwd, target, 'alternate\n')
      expect(editor.mock.calls[0][1]).toBe('')
      expect(readFileSync(target, 'utf-8')).toBe('alternate\n')
    })

    it('writes nothing when the picker or the editor is cancelled, or nothing changed', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      const user = join(home, '.claude', 'CLAUDE.md')
      writeFileSync(join(cwd, 'CLAUDE.md'), 'kept\n')

      const cancelled = await edit(cwd, undefined, 'ignored')
      expect(cancelled.editor).not.toHaveBeenCalled()
      await edit(cwd, user, undefined)
      expect(existsSync(user)).toBe(false)
      await edit(cwd, user, '')
      expect(existsSync(user)).toBe(false)
      await edit(cwd, join(cwd, 'CLAUDE.md'), 'kept\n')
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf-8')).toBe('kept\n')
    })

    it('refuses a file it cannot read rather than opening an empty editor over it', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      mkdirSync(join(cwd, 'CLAUDE.md')) // reading a directory fails with EISDIR, not ENOENT
      const { editor, notify } = await edit(cwd, join(cwd, 'CLAUDE.md'), 'clobber')
      expect(editor).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledWith(`Cannot read ${join(cwd, 'CLAUDE.md')}`, 'error')
    })

    it('needs the interactive UI', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'))
      const probe = editCtx(cwd, join(cwd, 'CLAUDE.md'), 'x')
      await wire()
        .get('memory')
        ?.handler('edit', { ...probe.ctx, hasUI: false })
      expect(probe.select).not.toHaveBeenCalled()
      expect(probe.notify).toHaveBeenCalledWith('/memory edit needs the interactive UI', 'error')
      expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false)
    })
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
