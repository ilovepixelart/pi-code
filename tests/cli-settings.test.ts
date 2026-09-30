import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cliSettings, parseSettingSources, resolveCliSettings, resolveSettingsFlag, setCliSettingsReader } from '../extensions/internal/cli-settings.ts'

const ALL = new Set(['user', 'project', 'local'])

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf-8'))

describe('parseSettingSources', () => {
  // Claude: "Comma-separated list of setting sources to load (user, project, local)".
  it('loads every source without the flag', () => {
    expect(parseSettingSources(undefined)).toEqual({ sources: ALL })
  })

  it('keeps only the listed sources', () => {
    expect(parseSettingSources('user,project')).toEqual({ sources: new Set(['user', 'project']) })
  })

  it('loads no file source for an empty list, as the SDK documents for []', () => {
    expect(parseSettingSources('')).toEqual({ sources: new Set() })
  })

  it('tolerates whitespace and repeats', () => {
    expect(parseSettingSources(' user , local,user ')).toEqual({ sources: new Set(['user', 'local']) })
  })

  it('rejects an unknown source with Claude Code 2.1.285 wording and falls back to every source', () => {
    // Measured: `claude --setting-sources bogus` prints "Error processing --setting-sources:
    // Invalid setting source: bogus. Valid options are: user, project, local" and exits 1.
    expect(parseSettingSources('user,bogus')).toEqual({ sources: ALL, error: 'Invalid setting source: bogus. Valid options are: user, project, local' })
  })
})

describe('resolveSettingsFlag', () => {
  const dir = () => fs.mkdtempSync(join(tmpdir(), 'cli-settings-'))

  it('resolves a relative path against cwd and returns a private copy holding the same settings', () => {
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'gen.json'), '{"outputStyle":"Explanatory","hooks":{}}')
    const result = resolveSettingsFlag('./gen.json', cwd)
    expect(result).toHaveProperty('file')
    const { file } = result as { file: string }
    expect(file).not.toBe(resolve(cwd, 'gen.json'))
    expect(readJson(file)).toEqual({ outputStyle: 'Explanatory', hooks: {} })
  })

  it('keeps the copy private to the user', () => {
    if (process.platform === 'win32') return
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'gen.json'), '{}')
    const { file } = resolveSettingsFlag('gen.json', cwd) as { file: string }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('is a snapshot: a later edit of the original does not reach the copy', () => {
    // Claude: the reload covers user, project, local and managed settings, not --settings,
    // and a generated file shared by concurrent invocations must not leak between them.
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'gen.json'), '{"a":1}')
    const { file } = resolveSettingsFlag('gen.json', cwd) as { file: string }
    fs.writeFileSync(join(cwd, 'gen.json'), '{"a":2}')
    expect(readJson(file)).toEqual({ a: 1 })
  })

  it('accepts an inline JSON object', () => {
    const { file } = resolveSettingsFlag('{"model":"x"}', dir()) as { file: string }
    expect(readJson(file)).toEqual({ model: 'x' })
  })

  it('treats a value that is not JSON as a path, as Claude Code does', () => {
    // Measured: `claude --settings '{bad json'` reports "Settings file not found: <cwd>/{bad json".
    const cwd = dir()
    expect(resolveSettingsFlag('{bad json', cwd)).toEqual({ error: `Settings file not found: ${join(cwd, '{bad json')}` })
  })

  it('reports a missing file with the absolute path', () => {
    const cwd = dir()
    expect(resolveSettingsFlag('missing.json', cwd)).toEqual({ error: `Settings file not found: ${join(cwd, 'missing.json')}` })
  })

  it('refuses a path that is not a regular file', () => {
    // Claude: "The file must be a regular file no larger than 2 MiB."
    const cwd = dir()
    fs.mkdirSync(join(cwd, 'settings.d'))
    expect(resolveSettingsFlag('settings.d', cwd)).toEqual({ error: `Cannot use settings file (not a regular file): ${join(cwd, 'settings.d')}` })
  })

  it('accepts a file of exactly 2 MiB and refuses one byte more', () => {
    const cwd = dir()
    const wrap = (padding: number): string => `{"pad":"${'x'.repeat(padding)}"}`
    const limit = 2 * 1024 * 1024
    fs.writeFileSync(join(cwd, 'max.json'), wrap(limit - '{"pad":""}'.length))
    fs.writeFileSync(join(cwd, 'over.json'), wrap(limit - '{"pad":""}'.length + 1))
    expect(fs.statSync(join(cwd, 'max.json')).size).toBe(limit)
    expect(resolveSettingsFlag('max.json', cwd)).toHaveProperty('file')
    expect(resolveSettingsFlag('over.json', cwd)).toEqual({ error: `Cannot use settings file (larger than 2 MiB): ${join(cwd, 'over.json')}` })
  })

  it('refuses a file that is not valid JSON, naming the file', () => {
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'bad.json'), '{ not json')
    const result = resolveSettingsFlag('bad.json', cwd) as { error: string }
    expect(result.error).toMatch(/^Cannot use settings file \(.+\): /)
    expect(result.error.endsWith(join(cwd, 'bad.json'))).toBe(true)
  })

  it('refuses JSON that is not an object', () => {
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'arr.json'), '[1,2]')
    expect(resolveSettingsFlag('arr.json', cwd)).toEqual({ error: `Cannot use settings file (not a JSON object): ${join(cwd, 'arr.json')}` })
  })
})

describe('resolveCliSettings', () => {
  const dir = () => fs.mkdtempSync(join(tmpdir(), 'cli-settings-'))

  it('is the no-flag default without either flag', () => {
    expect(resolveCliSettings({}, dir())).toEqual({ settingsFile: undefined, sources: ALL, forwardArgs: [], errors: [] })
  })

  it('hands a child the copy and the raw source list so it reads the same settings', () => {
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'gen.json'), '{"a":1}')
    const resolved = resolveCliSettings({ settings: 'gen.json', settingSources: 'user' }, cwd)
    expect(resolved.settingsFile).toBeDefined()
    expect(resolved.forwardArgs).toEqual(['--settings', resolved.settingsFile, '--setting-sources', 'user'])
    expect(resolved.sources).toEqual(new Set(['user']))
    expect(resolved.errors).toEqual([])
  })

  it('forwards an empty source list as an empty value', () => {
    expect(resolveCliSettings({ settingSources: '' }, dir()).forwardArgs).toEqual(['--setting-sources', ''])
  })

  it('collects both errors, applies neither flag, and forwards nothing', () => {
    const cwd = dir()
    const resolved = resolveCliSettings({ settings: 'missing.json', settingSources: 'nope' }, cwd)
    expect(resolved).toEqual({
      settingsFile: undefined,
      sources: ALL,
      forwardArgs: [],
      errors: [`Settings file not found: ${join(cwd, 'missing.json')}`, 'Invalid setting source: nope. Valid options are: user, project, local'],
    })
  })

  it('ignores a boolean flag value (a bare --settings with no value)', () => {
    expect(resolveCliSettings({ settings: true, settingSources: true }, dir())).toEqual({ settingsFile: undefined, sources: ALL, forwardArgs: [], errors: [] })
  })
})

describe('cliSettings slot', () => {
  afterEach(() => setCliSettingsReader(undefined))

  it('is the no-flag default until an extension registers a reader', () => {
    expect(cliSettings()).toEqual({ settingsFile: undefined, sources: ALL, forwardArgs: [], errors: [] })
  })

  it('returns what the registered reader resolves', () => {
    const resolved = { settingsFile: '/copy/settings.json', sources: new Set(['user'] as const), forwardArgs: ['--settings', '/copy/settings.json'], errors: [] }
    setCliSettingsReader(() => resolved)
    expect(cliSettings()).toBe(resolved)
  })
})
