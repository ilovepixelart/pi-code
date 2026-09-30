import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cliSettings, setCliSettingsReader } from '../extensions/internal/cli-settings.ts'
import settingsFlagsExtension from '../extensions/settings-flags.ts'

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>

/** A stub host: flags are recorded at registration and answered from `values`. */
function wire(values: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  const flags: Array<{ name: string; options: Record<string, unknown> }> = []
  settingsFlagsExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerFlag: (name: string, options: Record<string, unknown>) => flags.push({ name, options }),
    getFlag: (name: string) => values[name],
  } as never)
  const notifications: Array<{ message: string; type?: string }> = []
  const shutdown = vi.fn()
  const ctx = (hasUI: boolean) => ({ cwd: process.cwd(), hasUI, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) }, shutdown })
  return { handlers, flags, notifications, shutdown, start: (hasUI = true) => handlers.get('session_start')?.({ reason: 'startup' }, ctx(hasUI)) }
}

describe('settings-flags extension', () => {
  afterEach(() => setCliSettingsReader(undefined))

  it("registers Claude's two flags as string flags", () => {
    const { flags } = wire()
    expect(flags.map((flag) => [flag.name, flag.options.type])).toEqual([
      ['settings', 'string'],
      ['setting-sources', 'string'],
    ])
  })

  it('resolves the flags for every consumer once pi has parsed them', async () => {
    const cwd = fs.mkdtempSync(join(tmpdir(), 'flags-'))
    fs.writeFileSync(join(cwd, 'gen.json'), '{"outputStyle":"Explanatory"}')
    const { start } = wire({ settings: join(cwd, 'gen.json'), 'setting-sources': 'user,local' })
    await start()
    const resolved = cliSettings()
    expect(resolved.sources).toEqual(new Set(['user', 'local']))
    expect(resolved.settingsFile).toBeDefined()
    expect(JSON.parse(fs.readFileSync(resolved.settingsFile as string, 'utf-8'))).toEqual({ outputStyle: 'Explanatory' })
  })

  it('is the no-flag default before pi has parsed the flags, and picks them up afterwards', async () => {
    // pi applies flag values after loading every extension, so a read at load time sees
    // none; the reader must not freeze that answer.
    const values: Record<string, unknown> = {}
    const { start } = wire(values)
    expect(cliSettings().sources).toEqual(new Set(['user', 'project', 'local']))
    values['setting-sources'] = 'project'
    await start()
    expect(cliSettings().sources).toEqual(new Set(['project']))
  })

  it('reports each refused flag and shuts the session down, as Claude exits 1', async () => {
    const { start, notifications, shutdown } = wire({ settings: '/nonexistent/settings.json', 'setting-sources': 'bogus' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await start()
    expect(notifications).toEqual([
      { message: 'Settings file not found: /nonexistent/settings.json', type: 'error' },
      { message: 'Invalid setting source: bogus. Valid options are: user, project, local', type: 'error' },
    ])
    expect(error.mock.calls.map((call) => call[0])).toEqual(['pi-code: Settings file not found: /nonexistent/settings.json', 'pi-code: Invalid setting source: bogus. Valid options are: user, project, local'])
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('exits with status 1 in a headless run, where pi ignores a shutdown request', async () => {
    // pi binds an extension's shutdown() only in interactive mode (pi dist/modes/print-mode
    // never passes a shutdownHandler); a scripted run would otherwise carry on with the
    // wrong settings and exit 0.
    const { start, shutdown } = wire({ settings: '/nonexistent/settings.json' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await start(false)
    expect(exit).toHaveBeenCalledWith(1)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('reports nothing and keeps running for valid flags', async () => {
    const { start, notifications, shutdown } = wire({ 'setting-sources': 'user' })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await start(false)
    expect(notifications).toEqual([])
    expect(shutdown).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})
