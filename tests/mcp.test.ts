import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyServerPolicy, formatPromptCommandName, formatToolName, interpolateEnv, loadConfigFrom, loadUserScope, managedSettingsPath, mapContent, mapPromptArguments, mcpAllowDeny, normalizeSchema, parseHelperHeaders, projectConfigPaths, promptMessageContent, userConfigPaths } from '../extensions/mcp.ts'

describe('parseHelperHeaders', () => {
  it('keeps string-valued header entries and drops the rest', () => {
    expect(parseHelperHeaders('{"Authorization":"Bearer x","X-N":5,"Y":"z"}')).toEqual({ Authorization: 'Bearer x', Y: 'z' })
  })
  it('returns empty on invalid or non-object output', () => {
    expect(parseHelperHeaders('not json')).toEqual({})
    expect(parseHelperHeaders('["a"]')).toEqual({})
    expect(parseHelperHeaders('null')).toEqual({})
  })
})

describe('applyServerPolicy', () => {
  const servers = { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } } as never

  it('keeps everything when there is no allow list and no deny', () => {
    expect(Object.keys(applyServerPolicy(servers, null, new Set()))).toEqual(['a', 'b', 'c'])
  })
  it('treats a configured empty allow list as a lockdown (Claude: empty array = deny all)', () => {
    expect(Object.keys(applyServerPolicy(servers, new Set(), new Set()))).toEqual([])
  })
  it('an allow list is exclusive', () => {
    expect(Object.keys(applyServerPolicy(servers, new Set(['a', 'c']), new Set()))).toEqual(['a', 'c'])
  })
  it('deny removes servers and wins over allow (and over no allow list)', () => {
    expect(Object.keys(applyServerPolicy(servers, null, new Set(['b'])))).toEqual(['a', 'c'])
    expect(Object.keys(applyServerPolicy(servers, new Set(['a', 'b']), new Set(['b'])))).toEqual(['a'])
  })
})

describe('managedSettingsPath', () => {
  it('maps each platform to its ClaudeCode managed-settings.json location', () => {
    expect(managedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    expect(managedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json')
    expect(managedSettingsPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json')
  })
})

describe('mcpAllowDeny', () => {
  const writeManaged = (settings: unknown): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'mcp-managed-')), 'managed-settings.json')
    writeFileSync(file, JSON.stringify(settings))
    return file
  }

  it('reads allow/deny from managed settings as {serverName} objects', () => {
    const file = writeManaged({ allowedMcpServers: [{ serverName: 'github' }], deniedMcpServers: [{ serverName: 'filesystem' }] })
    const { allowed, denied } = mcpAllowDeny(file)
    expect([...(allowed ?? [])]).toEqual(['github'])
    expect([...denied]).toEqual(['filesystem'])
  })

  it('tolerates bare-string entries and drops malformed ones', () => {
    const file = writeManaged({ allowedMcpServers: ['a', { serverName: 'b' }, { name: 'c' }, 5] })
    expect([...(mcpAllowDeny(file).allowed ?? [])]).toEqual(['a', 'b'])
  })

  it('returns a null allow list when unset (no restriction) and empty deny', () => {
    const file = writeManaged({})
    const { allowed, denied } = mcpAllowDeny(file)
    expect(allowed).toBeNull()
    expect(denied.size).toBe(0)
  })

  it('returns an empty (lockdown) allow set for an explicit empty array', () => {
    const file = writeManaged({ allowedMcpServers: [] })
    const { allowed } = mcpAllowDeny(file)
    expect(allowed).not.toBeNull()
    expect(allowed?.size).toBe(0)
  })

  it('treats a missing managed file as no policy', () => {
    const { allowed, denied } = mcpAllowDeny(join(tmpdir(), 'no-such-managed-settings.json'))
    expect(allowed).toBeNull()
    expect(denied.size).toBe(0)
  })
})

describe('loadUserScope', () => {
  it('merges local-scope per-project servers over the global user servers', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'))
    const cwd = '/work/project'
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { global: { command: 'g' }, shared: { command: 'user-shared' } },
        projects: { '/work/project': { mcpServers: { local: { command: 'l' }, shared: { command: 'local-shared' } } } },
      }),
    )
    const servers = loadUserScope(home, cwd)
    expect(Object.keys(servers).sort()).toEqual(['global', 'local', 'shared'])
    expect((servers.shared as { command: string }).command).toBe('local-shared')
  })

  it('returns the global user servers when the project has no local scope', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { g: { command: 'g' } } }))
    expect(Object.keys(loadUserScope(home, '/some/other'))).toEqual(['g'])
  })
})

describe('mcp adapter helpers', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title documents the ${VAR} syntax interpolateEnv parses
  it('interpolates ${VAR} from the environment', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${} syntax is exactly what interpolateEnv parses
    expect(interpolateEnv('Bearer ${TOKEN}', { TOKEN: 'abc' } as NodeJS.ProcessEnv)).toBe('Bearer abc')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${MISSING}', {} as NodeJS.ProcessEnv)).toBe('')
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title documents the ${VAR:-default} syntax Claude's .mcp.json supports
  it('expands ${VAR:-default} to the fallback when unset or empty, like shell :-', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal syntax under test
    expect(interpolateEnv('${MISSING:-fallback}', {} as NodeJS.ProcessEnv)).toBe('fallback')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${SET:-fallback}', { SET: 'real' } as NodeJS.ProcessEnv)).toBe('real')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${MISSING:-}', {} as NodeJS.ProcessEnv)).toBe('')
    // Shell :- substitutes on unset OR empty, and this syntax borrows shell's.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${EMPTY:-fallback}', { EMPTY: '' } as NodeJS.ProcessEnv)).toBe('fallback')
    // A bare reference to a set-but-empty variable stays empty.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${EMPTY}', { EMPTY: '' } as NodeJS.ProcessEnv)).toBe('')
  })

  it('merges config files with later files winning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
    const global = join(dir, 'global.json')
    const project = join(dir, 'project.json')
    writeFileSync(global, JSON.stringify({ mcpServers: { a: { command: 'one' }, b: { command: 'two' } } }))
    writeFileSync(project, JSON.stringify({ mcpServers: { b: { command: 'override' } } }))
    const merged = loadConfigFrom([global, project])
    expect(Object.keys(merged).sort()).toEqual(['a', 'b'])
    expect((merged.b as { command: string }).command).toBe('override')
  })

  it('skips missing and invalid config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{not json')
    expect(loadConfigFrom([join(dir, 'absent.json'), broken])).toEqual({})
  })

  it('separates always-loaded user config from trust-gated project config', () => {
    expect(userConfigPaths('/home')).toEqual(['/home/.claude.json', '/home/.pi/agent/mcp.json'])
    expect(projectConfigPaths('/proj')).toEqual(['/proj/.mcp.json', '/proj/.pi/mcp.json'])
  })

  it('finds project mcp config at the repository root from a subdirectory session', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mcp-repo-'))
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.mcp.json'), '{}')
    const sub = join(repo, 'src')
    mkdirSync(sub)
    // .pi/mcp.json exists nowhere, so its entry stays anchored at the session cwd.
    expect(projectConfigPaths(sub)).toEqual([join(repo, '.mcp.json'), join(sub, '.pi', 'mcp.json')])
  })

  it('lets pi config override a Claude server of the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
    const claude = join(dir, '.mcp.json')
    const pi = join(dir, 'pi.json')
    writeFileSync(claude, JSON.stringify({ mcpServers: { db: { command: 'claude-db' } } }))
    writeFileSync(pi, JSON.stringify({ mcpServers: { db: { command: 'pi-db' } } }))
    expect((loadConfigFrom([claude, pi]).db as { command: string }).command).toBe('pi-db')
  })

  it('formats tool names as server_tool with dashes replaced', () => {
    expect(formatToolName('sonar-qube', 'search-issues')).toBe('sonar_qube_search_issues')
  })

  it('normalizes schemas by stripping $schema and additionalProperties', () => {
    const schema = normalizeSchema({ $schema: 'x', additionalProperties: false, type: 'object', properties: { a: { type: 'string' } } })
    expect(schema).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(normalizeSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })

  it('maps text, image, and resource content blocks', () => {
    const mapped = mapContent([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'base64data', mimeType: 'image/jpeg' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'body' } },
    ])
    expect(mapped[0]).toEqual({ type: 'text', text: 'hello' })
    expect(mapped[1]).toEqual({ type: 'image', data: 'base64data', mimeType: 'image/jpeg' })
    expect((mapped[2] as { text: string }).text).toContain('[Resource: file:///x]')
  })

  it('falls back to structuredContent for empty results and truncates huge text', () => {
    expect(mapContent([], { ok: true })).toEqual([{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])
    const big = mapContent([{ type: 'text', text: 'x'.repeat(60_000) }])
    expect((big[0] as { text: string }).text).toContain('[truncated')
  })

  it('caps a huge resource block, not just text blocks', () => {
    const mapped = mapContent([{ type: 'resource', resource: { uri: 'file:///big', text: 'y'.repeat(60_000) } }])
    expect((mapped[0] as { text: string }).text).toContain('[truncated')
  })
})

describe('mcp prompt command naming', () => {
  it('builds mcp__server__prompt with dashes and spaces normalized to underscores', () => {
    expect(formatPromptCommandName('demo', 'greet')).toBe('mcp__demo__greet')
    expect(formatPromptCommandName('my-server', 'code review')).toBe('mcp__my_server__code_review')
  })
})

describe('mcp prompt argument mapping', () => {
  it('maps space-separated tokens positionally onto the declared arguments', () => {
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], 'one two')).toEqual({ a: 'one', b: 'two' })
  })

  it('keeps a quoted run together as one value, like slash-command args', () => {
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], '"one two" three')).toEqual({ a: 'one two', b: 'three' })
  })

  it('folds extra trailing tokens into the last declared argument so no input is dropped', () => {
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], 'one two three four')).toEqual({ a: 'one', b: 'two three four' })
  })

  it('omits declared arguments with no token, and maps nothing when none are declared', () => {
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], 'one')).toEqual({ a: 'one' })
    expect(mapPromptArguments([], 'stray')).toEqual({})
    expect(mapPromptArguments(undefined, 'stray')).toEqual({})
  })
})

describe('mcp prompt message content', () => {
  it('maps text and resource message content to injected text blocks', () => {
    const blocks = promptMessageContent([{ content: { type: 'text', text: 'first line' } }, { content: { type: 'resource', resource: { uri: 'file:///ctx', text: 'body' } } }])
    expect(blocks).toEqual([
      { type: 'text', text: 'first line' },
      { type: 'text', text: '[Resource: file:///ctx]\nbody' },
    ])
  })

  it('carries an image block through instead of dropping it', () => {
    const blocks = promptMessageContent([{ content: { type: 'text', text: 'look at this' } }, { content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }])
    expect(blocks).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ])
  })

  it('keeps an image-only prompt as a real turn', () => {
    const blocks = promptMessageContent([{ content: { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' } }])
    expect(blocks).toEqual([{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }])
  })

  it('yields no blocks for an empty message list, so no turn is driven on a sentinel', () => {
    expect(promptMessageContent([])).toEqual([])
  })

  it('yields no blocks when every message carries only empty text', () => {
    expect(promptMessageContent([{ content: { type: 'text', text: '   ' } }, { content: { type: 'text', text: '' } }])).toEqual([])
  })

  it('caps a prompt whose messages exceed the output budget', () => {
    const blocks = promptMessageContent([{ content: { type: 'text', text: 'x'.repeat(60_000) } }])
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect(blocks[0].type === 'text' && blocks[0].text).toContain('[truncated')
  })
})
