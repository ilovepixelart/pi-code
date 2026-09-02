import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  applyServerPolicy,
  formatPromptCommandName,
  formatToolName,
  interpolateEnv,
  loadConfigFrom,
  loadUserScope,
  managedSettingsPath,
  mapContent,
  mapPromptArguments,
  mcpAllowDeny,
  normalizeSchema,
  parseHelperHeaders,
  projectConfigPaths,
  projectServerPolicy,
  promptMessageContent,
  urlPatternMatches,
  userConfigPaths,
} from '../extensions/mcp/index.ts'

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
  const names = (list: string[]) => list.map((serverName) => ({ serverName }))

  it('keeps everything when there is no allow list and no deny', () => {
    expect(Object.keys(applyServerPolicy(servers, { allowed: null, denied: [] }))).toEqual(['a', 'b', 'c'])
  })
  it('treats a configured empty allow list as a lockdown (Claude: empty array = deny all)', () => {
    expect(Object.keys(applyServerPolicy(servers, { allowed: [], denied: [] }))).toEqual([])
  })
  it('an allow list is exclusive', () => {
    expect(Object.keys(applyServerPolicy(servers, { allowed: names(['a', 'c']), denied: [] }))).toEqual(['a', 'c'])
  })
  it('deny removes servers and wins over allow (and over no allow list)', () => {
    expect(Object.keys(applyServerPolicy(servers, { allowed: null, denied: names(['b']) }))).toEqual(['a', 'c'])
    expect(Object.keys(applyServerPolicy(servers, { allowed: names(['a', 'b']), denied: names(['b']) }))).toEqual(['a'])
  })

  // Claude: "A server that matches any denylist entry, by URL, command, or name, is
  // blocked. Nothing overrides a denylist match."
  it('denies a remote server by serverUrl wildcard and keeps a non-matching one', () => {
    const remotes = { bad: { url: 'https://mcp.untrusted.example.com/api' }, good: { url: 'https://mcp.example.com/api' } } as never
    const denied = [{ serverUrl: 'https://*.untrusted.example.com/*' }]
    expect(Object.keys(applyServerPolicy(remotes, { allowed: null, denied }))).toEqual(['good'])
  })

  // Claude: "Commands match exactly. Every argument, in order."
  it('denies a stdio server by exact serverCommand and not by a longer or shorter argv', () => {
    const stdio = {
      exact: { command: 'npx', args: ['-y', 'server'] },
      longer: { command: 'npx', args: ['-y', 'server', '--flag'] },
      shorter: { command: 'npx', args: ['server'] },
    } as never
    const denied = [{ serverCommand: ['npx', '-y', 'server'] }]
    expect(Object.keys(applyServerPolicy(stdio, { allowed: null, denied }))).toEqual(['longer', 'shorter'])
  })

  it('allows a remote server through a matching serverUrl entry (a url-only allowlist is not a lockdown)', () => {
    const remotes = { hub: { url: 'https://api.githubcopilot.com/mcp' }, other: { url: 'https://elsewhere.example.com/' } } as never
    const allowed = [{ serverUrl: 'https://api.githubcopilot.com/*' }]
    expect(Object.keys(applyServerPolicy(remotes, { allowed, denied: [] }))).toEqual(['hub'])
  })

  // Claude: "A serverName match counts only when the allowlist contains no serverUrl
  // entries" (and no serverCommand entries for stdio).
  it('suppresses the serverName fallback for a transport that has typed allow entries', () => {
    const mixed = { foo: { url: 'https://other.example.com/' }, bar: { command: 'bar' } } as never
    const allowed = [{ serverUrl: 'https://allowed.example.com/*' }, { serverName: 'foo' }, { serverName: 'bar' }]
    // foo is remote and url entries exist, so its name match does not count; bar is
    // stdio with no serverCommand entries, so its name match does.
    expect(Object.keys(applyServerPolicy(mixed, { allowed, denied: [] }))).toEqual(['bar'])
  })
})

describe('urlPatternMatches', () => {
  // The doc's pattern table, row by row.
  it('matches all paths on a specific domain', () => {
    expect(urlPatternMatches('https://mcp.example.com/*', 'https://mcp.example.com/api')).toBe(true)
    expect(urlPatternMatches('https://mcp.example.com/*', 'https://mcp.example.com')).toBe(true)
    expect(urlPatternMatches('https://mcp.example.com/*', 'https://other.example.com/api')).toBe(false)
  })
  it('a pattern with no path matches any path', () => {
    expect(urlPatternMatches('https://mcp.example.com', 'https://mcp.example.com/deep/path')).toBe(true)
  })
  it('matches any subdomain, any localhost port, and any scheme', () => {
    expect(urlPatternMatches('https://*.example.com/*', 'https://sub.example.com/x')).toBe(true)
    expect(urlPatternMatches('http://localhost:*/*', 'http://localhost:8931/session')).toBe(true)
    expect(urlPatternMatches('*://mcp.example.com/*', 'wss://mcp.example.com/feed')).toBe(true)
  })
  // Claude: "Hostname matching is case-insensitive and ignores a trailing FQDN dot
  // ... Paths stay case-sensitive."
  it('compares the host case-insensitively with a trailing-dot fold, and the path case-sensitively', () => {
    expect(urlPatternMatches('https://Mcp.Example.com/*', 'https://mcp.example.com./api')).toBe(true)
    expect(urlPatternMatches('https://mcp.example.com/API', 'https://mcp.example.com/api')).toBe(false)
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

  const writeScope = (settings: unknown): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'mcp-scope-')), 'settings.json')
    writeFileSync(file, JSON.stringify(settings))
    return file
  }

  it('reads allow/deny from managed settings, keeping serverUrl and serverCommand entries typed', () => {
    const file = writeManaged({ allowedMcpServers: [{ serverName: 'github' }, { serverUrl: 'https://mcp.example.com/*' }], deniedMcpServers: [{ serverName: 'filesystem' }, { serverCommand: ['npx', '-y', 'evil'] }] })
    const { allowed, denied } = mcpAllowDeny([], file)
    expect(allowed).toEqual([{ serverName: 'github' }, { serverUrl: 'https://mcp.example.com/*' }])
    expect(denied).toEqual([{ serverName: 'filesystem' }, { serverCommand: ['npx', '-y', 'evil'] }])
  })

  it('tolerates bare-string entries and drops malformed ones', () => {
    const file = writeManaged({ allowedMcpServers: ['a', { serverName: 'b' }, { name: 'c' }, 5] })
    expect(mcpAllowDeny([], file).allowed).toEqual([{ serverName: 'a' }, { serverName: 'b' }])
  })

  // Claude: an allowlist serverName "is limited to letters, numbers, hyphens, and
  // underscores"; a denylist serverName "accepts any non-empty string".
  it('drops an allowlist serverName with characters outside the documented set, keeping it in a denylist', () => {
    const file = writeManaged({ allowedMcpServers: [{ serverName: 'claude.ai Slack' }, { serverName: 'ok_name-1' }], deniedMcpServers: [{ serverName: 'claude.ai Slack' }] })
    const { allowed, denied } = mcpAllowDeny([], file)
    expect(allowed).toEqual([{ serverName: 'ok_name-1' }])
    expect(denied).toEqual([{ serverName: 'claude.ai Slack' }])
  })

  it('returns a null allow list when unset (no restriction) and empty deny', () => {
    const file = writeManaged({})
    const { allowed, denied } = mcpAllowDeny([], file)
    expect(allowed).toBeNull()
    expect(denied).toEqual([])
  })

  it('returns an empty (lockdown) allow list for an explicit empty array', () => {
    const file = writeManaged({ allowedMcpServers: [] })
    expect(mcpAllowDeny([], file).allowed).toEqual([])
  })

  it('treats a missing managed file as no policy', () => {
    const { allowed, denied } = mcpAllowDeny([], join(tmpdir(), 'no-such-managed-settings.json'))
    expect(allowed).toBeNull()
    expect(denied).toEqual([])
  })

  // Claude: "Allowlist and denylist entries from every settings scope combine into
  // one allowlist and one denylist."
  it('merges deny and allow entries from the settings chain with the managed lists', () => {
    const managed = writeManaged({ deniedMcpServers: [{ serverName: 'm-deny' }] })
    const user = writeScope({ allowedMcpServers: [{ serverName: 'u-allow' }], deniedMcpServers: [{ serverName: 'u-deny' }] })
    const { allowed, denied } = mcpAllowDeny([user], managed)
    expect(allowed).toEqual([{ serverName: 'u-allow' }])
    expect(denied).toEqual([{ serverName: 'm-deny' }, { serverName: 'u-deny' }])
  })

  // Claude: "When allowManagedMcpServersOnly is true, only the managed allowlist is
  // kept; the denylist always merges from every scope."
  it('keeps only the managed allowlist under allowManagedMcpServersOnly while still merging denies', () => {
    const managed = writeManaged({ allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: 'approved' }] })
    const user = writeScope({ allowedMcpServers: [{ serverName: 'broadened' }], deniedMcpServers: [{ serverName: 'u-deny' }] })
    const { allowed, denied } = mcpAllowDeny([user], managed)
    expect(allowed).toEqual([{ serverName: 'approved' }])
    expect(denied).toEqual([{ serverName: 'u-deny' }])
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a set-but-empty variable still expands to empty
    expect(interpolateEnv('${EMPTY}', { EMPTY: '' } as NodeJS.ProcessEnv)).toBe('')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a default is used when the variable is unset
    expect(interpolateEnv('${MISSING:-fallback}', {} as NodeJS.ProcessEnv)).toBe('fallback')
  })

  it('keeps a missing ${VAR} literal and reports it rather than silently emptying', () => {
    const missing: string[] = []
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exercising the unset-no-default path
    const out = interpolateEnv('Bearer ${TOKEN}', {} as NodeJS.ProcessEnv, (name) => missing.push(name))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is preserved so the failure is visible, not a blank Bearer
    expect(out).toBe('Bearer ${TOKEN}')
    expect(missing).toEqual(['TOKEN'])
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

  it('resolves HOME-scope config under CLAUDE_CONFIG_DIR while leaving project scope alone', () => {
    // Claude relocates ~/.claude.json and ~/.claude/settings.json inside CLAUDE_CONFIG_DIR;
    // the sweep must follow, or the user-scope MCP config splits across extensions.
    const saved = process.env.CLAUDE_CONFIG_DIR
    const cfg = mkdtempSync(join(tmpdir(), 'mcp-cfg-'))
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      // .claude.json now lives inside the config dir; .pi is pi's own tree, untouched.
      expect(userConfigPaths('/home')).toEqual([join(cfg, '.claude.json'), join('/home', '.pi', 'agent', 'mcp.json')])
      // The per-project local scope is read from the relocated .claude.json too.
      writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ projects: { '/work/p': { mcpServers: { local: { command: 'l' } } } } }))
      expect(Object.keys(loadUserScope('/home', '/work/p'))).toEqual(['local'])
      // projectServerPolicy reads the user settings.json from the config dir.
      writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
      expect(projectServerPolicy('/proj', '/home', false).consentAll).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
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

  it('flattens a root-level combinator schema so its parameters survive', () => {
    // A bare anyOf/oneOf/allOf has no top-level `type`; emptying it would force the model
    // to call the tool with no arguments. anyOf/oneOf are alternatives, so required stays open.
    const anyOf = normalizeSchema({ anyOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } } }] })
    expect(anyOf).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } })
    // allOf means every branch applies, so its required union is kept.
    const allOf = normalizeSchema({
      allOf: [
        { properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    })
    expect(allOf).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] })
    // A schema with neither a type nor a combinator is still the empty object schema,
    // as before (a typeless schema carries no parameters to preserve).
    expect(normalizeSchema({ foo: 'x' })).toEqual({ type: 'object', properties: {} })
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
  it('keeps hyphens in the server name, folding only characters outside A-Za-z0-9_-', () => {
    // Claude: "replaces any character in the server name outside A-Z, a-z, 0-9, _,
    // and - with _, and uses the prompt name as the server declares it".
    expect(formatPromptCommandName('demo', 'greet')).toBe('mcp__demo__greet')
    expect(formatPromptCommandName('my-server', 'pr-review')).toBe('mcp__my-server__pr-review')
    // Per-character replacement: each out-of-class character becomes its own underscore.
    expect(formatPromptCommandName('my server', 'greet')).toBe('mcp__my_server__greet')
    expect(formatPromptCommandName('a!b', 'x')).toBe('mcp__a_b__x')
  })

  it('keeps the prompt name as declared, except whitespace, which pi command dispatch cannot carry', () => {
    // Divergence: Claude uses the prompt name verbatim; pi dispatches commands on the
    // first whitespace-delimited token, so a space would make the command unreachable.
    expect(formatPromptCommandName('demo', 'code review')).toBe('mcp__demo__code_review')
  })
})

describe('mcp prompt argument mapping', () => {
  it('maps whitespace-separated tokens positionally onto the declared arguments', () => {
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], 'one two')).toEqual({ a: 'one', b: 'two' })
  })

  it('treats a quoted run as plain tokens: Claude splits on whitespace, one token per argument', () => {
    // Claude: "splits the arguments on whitespace, so each argument is a single token".
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], '"one two" three')).toEqual({ a: '"one', b: 'two"' })
  })

  it('gives each declared argument exactly one token, dropping extra trailing tokens', () => {
    expect(mapPromptArguments([{ name: 'a' }, { name: 'b' }], 'one two three four')).toEqual({ a: 'one', b: 'two' })
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

describe('plugin server substitution safety', () => {
  const plugin = (over: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-plugin-'))
    return { name: 'toolbox', root: dir, dataDir: join(dir, 'data'), manifest: { mcpServers: over }, userConfig: { TOKEN: 'sekrit' } }
  }

  it('substitutes ${CLAUDE_PROJECT_DIR} in plugin server config, as Claude documents', async () => {
    const { loadPluginServers } = await import('../extensions/mcp/index.ts')
    const servers = loadPluginServers([plugin({ db: { command: '${CLAUDE_PROJECT_DIR}/bin/server', args: ['--root', '${CLAUDE_PROJECT_DIR}'] } }) as never], '/work/repo')
    expect((servers.db as { command: string }).command).toBe('/work/repo/bin/server')
    expect((servers.db as { args: string[] }).args).toEqual(['--root', '/work/repo'])
  })

  it('rejects a plugin server whose headersHelper references ${user_config.*} instead of substituting into a shell command', async () => {
    // Claude: "A plugin-provided headersHelper can't reference the plugin's
    // ${user_config.*} values, because the command runs through a shell. Claude Code
    // reports the server as misconfigured with an error and doesn't substitute."
    const { loadPluginServers } = await import('../extensions/mcp/index.ts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const servers = loadPluginServers([plugin({ api: { type: 'http', url: 'https://api.example.com', headersHelper: 'auth-helper --token ${user_config.TOKEN}' } }) as never], '/work/repo')
      expect(servers.api).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('user_config'))
    } finally {
      warn.mockRestore()
    }
  })

  it('still substitutes user_config outside headersHelper and plugin path vars inside it', async () => {
    const { loadPluginServers } = await import('../extensions/mcp/index.ts')
    const servers = loadPluginServers([plugin({ api: { type: 'http', url: 'https://api.example.com', headers: { Authorization: 'Bearer ${user_config.TOKEN}' }, headersHelper: '${CLAUDE_PLUGIN_ROOT}/helper.sh' } }) as never], '/work/repo')
    const api = servers.api as { headers: Record<string, string>; headersHelper: string }
    expect(api.headers.Authorization).toBe('Bearer sekrit')
    expect(api.headersHelper).toMatch(/\/helper\.sh$/)
    expect(api.headersHelper).not.toContain('${CLAUDE_PLUGIN_ROOT}')
  })

  it('treats 403 as an authentication failure alongside 401, as Claude documents', async () => {
    // Claude: "either status code flags it in /mcp so you can complete the OAuth flow".
    const { isUnauthorized } = await import('../extensions/mcp/transport.ts')
    expect(isUnauthorized(Object.assign(new Error('denied'), { code: 403 }))).toBe(true)
    expect(isUnauthorized(Object.assign(new Error('denied'), { code: 401 }))).toBe(true)
    expect(isUnauthorized(Object.assign(new Error('gone'), { code: 404 }))).toBe(false)
  })

  it('records the plugin root on plugin server configs for the helper environment', async () => {
    // Claude sets CLAUDE_PLUGIN_ROOT when a plugin provides the server's headersHelper.
    const { loadPluginServers } = await import('../extensions/mcp/index.ts')
    const declared = plugin({ api: { type: 'http', url: 'https://api.example.com' } }) as { root: string }
    const servers = loadPluginServers([declared as never], '/work/repo')
    expect((servers.api as { pluginRoot?: string }).pluginRoot).toBe(declared.root)
  })

  it('keeps hyphens in the tool alias prefix, folding only characters outside A-Za-z0-9_-', async () => {
    // Claude's plugin tool names keep the plugin and server names' hyphens; only
    // characters outside A-Za-z0-9_- become underscores.
    const { loadPluginServers } = await import('../extensions/mcp/index.ts')
    const withName = { ...(plugin({ 'db-tools': { command: 'srv' } }) as { name: string }), name: 'my-plugin' }
    const servers = loadPluginServers([withName as never], '/work/repo')
    expect((servers['db-tools'] as { aliasPrefix: string }).aliasPrefix).toBe('mcp__plugin_my-plugin_db-tools__')
  })

  it('loads a manifest mcpServers array as a list of config file paths, merging all of them', async () => {
    // plugins-reference: mcpServers is string|array|object; the array form lists
    // MCP config paths.
    const { loadPluginServers } = await import('../extensions/mcp/index.ts')
    const base = plugin() as { name: string; root: string; manifest: Record<string, unknown> }
    writeFileSync(join(base.root, 'a.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a-srv' } } }))
    writeFileSync(join(base.root, 'b.json'), JSON.stringify({ mcpServers: { beta: { command: 'b-srv' } } }))
    base.manifest = { mcpServers: ['./a.json', './b.json'] }
    const servers = loadPluginServers([base as never], '/work/repo')
    expect((servers.alpha as { command: string }).command).toBe('a-srv')
    expect((servers.beta as { command: string }).command).toBe('b-srv')
  })
})

describe('connect misconfiguration diagnostics', () => {
  // Each connect attempt targets something that fails fast; the diagnostic must
  // land before the failure so a misconfigured server never dies silently.
  const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('warns about an undefined ${VAR} reference instead of failing with a mystery', async () => {
    const { connect } = await import('../extensions/mcp/transport.ts')
    const warn = spyWarn()
    try {
      await expect(connect('s', { command: '/nonexistent-mcp-${PI_CODE_TEST_UNSET_VAR}' } as never)).rejects.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('undefined variable'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PI_CODE_TEST_UNSET_VAR'))
    } finally {
      warn.mockRestore()
    }
  })

  it('warns that configured auth is ignored on a WebSocket server', async () => {
    const { connect } = await import('../extensions/mcp/transport.ts')
    const warn = spyWarn()
    try {
      await expect(connect('w', { type: 'ws', url: 'ws://127.0.0.1:1/', headers: { Authorization: 'Bearer x' } } as never)).rejects.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('headers/bearerToken/headersHelper are ignored'))
    } finally {
      warn.mockRestore()
    }
  })

  it('warns that oauth.authServerMetadataUrl cannot override SDK discovery', async () => {
    const { connect } = await import('../extensions/mcp/transport.ts')
    const warn = spyWarn()
    try {
      await expect(connect('h', { type: 'http', url: 'http://127.0.0.1:1/', oauth: { authServerMetadataUrl: 'http://127.0.0.1:1/meta' } } as never)).rejects.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('standard discovery'))
    } finally {
      warn.mockRestore()
    }
  })
})
