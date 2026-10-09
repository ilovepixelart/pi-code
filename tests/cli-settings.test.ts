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

  it('rejects an unknown source with Claude Code 2.1.285 wording and loads no source', () => {
    // Measured: `claude --setting-sources bogus` prints "Error processing --setting-sources:
    // Invalid setting source: bogus. Valid options are: user, project, local" and exits 1.
    // Nothing runs there; here the session ends after the handlers already running, so
    // the refusal fails closed rather than loading every source in the meantime.
    expect(parseSettingSources('user,bogus')).toEqual({ sources: new Set(), error: 'Invalid setting source: bogus. Valid options are: user, project, local' })
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

  it('collects both errors, loads no file source, and forwards nothing', () => {
    const cwd = dir()
    const resolved = resolveCliSettings({ settings: 'missing.json', settingSources: 'nope' }, cwd)
    expect(resolved).toEqual({
      settingsFile: undefined,
      sources: new Set(),
      forwardArgs: [],
      errors: [`Settings file not found: ${join(cwd, 'missing.json')}`, 'Invalid setting source: nope. Valid options are: user, project, local'],
    })
  })

  it('fails closed on a refused --settings alone: no file source loads until the session ends', () => {
    // Handlers of extensions loaded before settings-flags run their session start on
    // this result before the refusal ends the session.
    const cwd = dir()
    const resolved = resolveCliSettings({ settings: 'missing.json', settingSources: 'user' }, cwd)
    expect(resolved.sources).toEqual(new Set())
    expect(resolved.forwardArgs).toEqual([])
  })

  it('ignores a boolean flag value (a bare --settings with no value)', () => {
    expect(resolveCliSettings({ settings: true, settingSources: true }, dir())).toEqual({ settingsFile: undefined, sources: ALL, forwardArgs: [], errors: [] })
  })
})

describe('resolveCliSettings: --mcp-config and --strict-mcp-config', () => {
  // Claude: "--mcp-config | Load MCP servers from JSON files or strings (space-separated)";
  // "--strict-mcp-config | Only use MCP servers from --mcp-config, ignoring all other MCP
  // configurations". The refusals below are Claude Code 2.1.295's, measured with
  // `claude -p "Reply with exactly: OK" --mcp-config <value>`: each exits 1 before a turn.
  const dir = () => fs.mkdtempSync(join(tmpdir(), 'cli-mcp-'))
  const server = (marker: string) => ({ command: 'sh', args: ['-c', marker] })
  const write = (cwd: string, name: string, servers: Record<string, unknown>): string => {
    fs.writeFileSync(join(cwd, name), JSON.stringify({ mcpServers: servers }))
    return name
  }
  const managedDir = (present: boolean): string => {
    const managed = dir()
    if (present) fs.writeFileSync(join(managed, 'managed-mcp.json'), '{"mcpServers":{}}')
    return join(managed, 'managed-settings.json')
  }

  it('leaves the MCP scopes alone without either flag', () => {
    expect(resolveCliSettings({}, dir()).mcp).toBeUndefined()
  })

  it('loads the servers of a file named relative to cwd', () => {
    const cwd = dir()
    write(cwd, 'extra.json', { a: server('a') })
    expect(resolveCliSettings({ mcpConfig: ['extra.json'] }, cwd).mcp).toEqual({ servers: { a: server('a') }, strict: false })
  })

  it('loads the servers of an inline JSON string', () => {
    const inline = JSON.stringify({ mcpServers: { inl: server('inl') } })
    expect(resolveCliSettings({ mcpConfig: [inline] }, dir()).mcp).toEqual({ servers: { inl: server('inl') }, strict: false })
  })

  it('merges several values, a later value winning a shared name', () => {
    // Measured: `--mcp-config dx1.json dx2.json`, both naming "x", spawned dx2's command.
    const cwd = dir()
    write(cwd, 'one.json', { a: server('a'), x: server('first') })
    write(cwd, 'two.json', { b: server('b'), x: server('second') })
    expect(resolveCliSettings({ mcpConfig: ['one.json', 'two.json'] }, cwd).mcp?.servers).toEqual({ a: server('a'), b: server('b'), x: server('second') })
  })

  it('takes --strict-mcp-config alone as an empty server set', () => {
    // Measured: `claude -p ... --strict-mcp-config` lists no MCP server at all.
    expect(resolveCliSettings({ strictMcpConfig: true }, dir()).mcp).toEqual({ servers: {}, strict: true })
  })

  it('refuses a missing file with the absolute path, failing closed to no server at all', () => {
    // Measured: "Error: Invalid MCP configuration:\nMCP config file not found: <path>",
    // exit 1, even with a valid value beside it. Extensions loaded earlier start their
    // session before the refusal ends it, so no MCP scope may connect in that window.
    const cwd = dir()
    write(cwd, 'good.json', { a: server('a') })
    const resolved = resolveCliSettings({ mcpConfig: ['good.json', 'nope.json'] }, cwd)
    expect(resolved.errors).toEqual([`Invalid MCP configuration:\nMCP config file not found: ${join(cwd, 'nope.json')}`])
    expect(resolved.mcp).toEqual({ servers: {}, strict: true })
    expect(resolved.forwardArgs).toEqual([])
  })

  it('treats a value that is not a JSON object as a path', () => {
    // Measured: `--mcp-config '{bad'` reports "MCP config file not found: <cwd>/{bad".
    const cwd = dir()
    expect(resolveCliSettings({ mcpConfig: ['{bad'] }, cwd).errors).toEqual([`Invalid MCP configuration:\nMCP config file not found: ${join(cwd, '{bad')}`])
  })

  it('refuses a file that is not valid JSON', () => {
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'bad.json'), '{bad')
    expect(resolveCliSettings({ mcpConfig: ['bad.json'] }, cwd).errors).toEqual(['Invalid MCP configuration:\nMCP config is not a valid JSON'])
  })

  it('refuses a config without an mcpServers record, file or inline', () => {
    const cwd = dir()
    fs.writeFileSync(join(cwd, 'empty.json'), '{}')
    const message = 'Invalid MCP configuration:\nmcpServers: Invalid input: expected record, received undefined'
    expect(resolveCliSettings({ mcpConfig: ['empty.json'] }, cwd).errors).toEqual([message])
    expect(resolveCliSettings({ mcpConfig: ['{"x":1}'] }, cwd).errors).toEqual([message])
  })

  it('refuses either flag while a managed-mcp.json is deployed', () => {
    // Claude's managed-mcp doc: on a workstation Claude Code "exits at startup with `You
    // cannot dynamically configure MCP servers when an enterprise MCP config is
    // present`", and --strict-mcp-config "exits at startup ... alike".
    const cwd = dir()
    write(cwd, 'extra.json', { a: server('a') })
    const message = 'You cannot dynamically configure MCP servers when an enterprise MCP config is present'
    expect(resolveCliSettings({ mcpConfig: ['extra.json'] }, cwd, managedDir(true)).errors).toEqual([message])
    expect(resolveCliSettings({ strictMcpConfig: true }, cwd, managedDir(true)).errors).toEqual([message])
    expect(resolveCliSettings({ mcpConfig: ['extra.json'] }, cwd, managedDir(false)).errors).toEqual([])
  })

  it('hands a child a private copy that resolves to the same servers, wherever the child runs', () => {
    // Claude's subagents run in-process and see the parent's MCP servers; a pi child is a
    // new process, so it is handed the flags, and a relative path must not depend on its cwd.
    const cwd = dir()
    write(cwd, 'extra.json', { a: server('a') })
    const parent = resolveCliSettings({ mcpConfig: ['extra.json'], strictMcpConfig: true }, cwd)
    const at = parent.forwardArgs.indexOf('--mcp-config')
    expect(at).toBeGreaterThanOrEqual(0)
    const copy = parent.forwardArgs[at + 1]
    if (process.platform !== 'win32') expect(fs.statSync(copy).mode & 0o777).toBe(0o600)
    expect(parent.forwardArgs).toContain('--strict-mcp-config=true')
    const child = resolveCliSettings({ mcpConfig: [copy], strictMcpConfig: true }, dir())
    expect(child.mcp).toEqual(parent.mcp)
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
