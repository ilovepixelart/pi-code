import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cliSettings, setCliSettingsReader } from '../extensions/internal/cli-settings.ts'
import settingsFlagsExtension from '../extensions/settings-flags.ts'

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>

/** A stub host: flags are recorded at registration and answered from `values`, with
 * `guard` run on every read so a test can make the host stale. Stderr is captured
 * with the write callback held back, so a test decides when the write has flushed. */
function wire(values: Record<string, unknown> = {}, guard: () => void = () => {}) {
  const handlers = new Map<string, Handler>()
  const flags: Array<{ name: string; options: Record<string, unknown> }> = []
  settingsFlagsExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerFlag: (name: string, options: Record<string, unknown>) => flags.push({ name, options }),
    getFlag: (name: string) => {
      guard()
      return values[name]
    },
  } as never)
  const notifications: Array<{ message: string; type?: string }> = []
  const shutdown = vi.fn()
  const written: string[] = []
  let pending: (() => void) | undefined
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk))
    pending = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined
    return true
  }) as never)
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const ctx = (hasUI: boolean) => ({ cwd: process.cwd(), hasUI, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) }, shutdown })
  return {
    handlers,
    flags,
    notifications,
    shutdown,
    exit,
    written,
    flush: () => pending?.(),
    start: (hasUI = true) => handlers.get('session_start')?.({ reason: 'startup' }, ctx(hasUI)),
  }
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

  it('keeps the last resolution once the host is stale and every flag read throws', async () => {
    // pi invalidates a replaced session's extension API, so a watcher poll that reads
    // the chain between the old instance and the new one must still see the flags.
    let stale = false
    const { start } = wire({ 'setting-sources': 'project' }, () => {
      if (stale) throw new Error('Extension is stale')
    })
    await start()
    stale = true
    expect(cliSettings().sources).toEqual(new Set(['project']))
  })

  it('reports each refused flag on stderr and in the UI, then shuts the session down once the write has flushed', async () => {
    // A relative name: the flag resolves against the process cwd, and a POSIX absolute
    // path would gain a drive letter on Windows.
    const { start, notifications, shutdown, written, flush } = wire({ settings: 'missing-settings.json', 'setting-sources': 'bogus' })
    await start()
    const missing = resolve(process.cwd(), 'missing-settings.json')
    expect(notifications).toEqual([
      { message: `Settings file not found: ${missing}`, type: 'error' },
      { message: 'Invalid setting source: bogus. Valid options are: user, project, local', type: 'error' },
    ])
    expect(written).toEqual([`pi-code: Settings file not found: ${missing}\npi-code: Invalid setting source: bogus. Valid options are: user, project, local\n`])
    expect(shutdown).not.toHaveBeenCalled()
    flush()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('exits with status 1 in a headless run, after the refusal has flushed, where pi ignores a shutdown request', async () => {
    // pi binds an extension's shutdown() only in interactive mode (pi dist/modes/print-mode
    // never passes a shutdownHandler); a scripted run would otherwise carry on with the
    // wrong settings and exit 0. Piped stderr is asynchronous on some platforms, so the
    // exit waits for the write callback or the message could be lost.
    const { start, shutdown, exit, written, flush } = wire({ settings: 'missing-settings.json' })
    await start(false)
    expect(written).toEqual([`pi-code: Settings file not found: ${resolve(process.cwd(), 'missing-settings.json')}\n`])
    expect(exit).not.toHaveBeenCalled()
    flush()
    expect(exit).toHaveBeenCalledWith(1)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('reports nothing and keeps running for valid flags', async () => {
    const { start, notifications, shutdown, exit, written } = wire({ 'setting-sources': 'user' })
    await start(false)
    expect(notifications).toEqual([])
    expect(written).toEqual([])
    expect(shutdown).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})
