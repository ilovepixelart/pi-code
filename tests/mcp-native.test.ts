import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeMode, nativeToolAliases, piMcpRunning, toNativeServer } from '../extensions/mcp/native.ts'

const session = { projectDir: '/repo', launchDir: '/repo/sub', sessionId: 'sess-1' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('toNativeServer (MCPN-003)', () => {
  it('translates a stdio server with Claude variables, direct exposure and the stdio idle budget', () => {
    expect(toNativeServer('fixture', { type: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'fast' } }, session, {})).toEqual({
      native: {
        name: 'fixture',
        config: {
          command: 'node',
          args: ['server.js'],
          env: { MODE: 'fast', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: '/repo', CLAUDE_CODE_SESSION_ID: 'sess-1' },
          exposure: 'direct',
          timeout: 1800,
        },
      },
    })
  })

  it('translates a streamable HTTP server with the remote idle budget', () => {
    expect(toNativeServer('docs', { type: 'http', url: 'https://example.com/mcp' }, session, {})).toEqual({
      native: { name: 'docs', config: { url: 'https://example.com/mcp', exposure: 'direct', timeout: 300 } },
    })
  })

  it('treats an untyped url as streamable HTTP', () => {
    expect(toNativeServer('docs', { url: 'https://example.com/mcp' }, session, {})).toEqual({
      native: { name: 'docs', config: { url: 'https://example.com/mcp', exposure: 'direct', timeout: 300 } },
    })
  })

  it('expands ${VAR} and ${VAR:-default} before handing values to pi', () => {
    const env = { BIN: '/opt/bin/srv', TOKEN: 'abc', HOST: 'example.com' }
    const stdio = toNativeServer('s', { command: '${BIN}', args: ['--level=${LEVEL:-info}'], env: { KEY: '${TOKEN}' } }, undefined, env)
    const http = toNativeServer('h', { type: 'http', url: 'https://${HOST}/mcp', headers: { 'X-Key': '${TOKEN}' } }, undefined, env)

    expect(stdio).toEqual({ native: { name: 's', config: { command: '/opt/bin/srv', args: ['--level=info'], env: { KEY: 'abc', CLAUDECODE: '1' }, exposure: 'direct', timeout: 1800 } } })
    expect(http).toEqual({ native: { name: 'h', config: { url: 'https://example.com/mcp', headers: { 'X-Key': 'abc' }, exposure: 'direct', timeout: 300 } } })
  })

  it('escapes env and header values so pi neither runs nor expands them', () => {
    const stdio = toNativeServer('s', { command: 'srv', env: { A: '!rm -rf /', B: 'pa$$word', C: '$HOME' } }, undefined, {})
    const http = toNativeServer('h', { type: 'http', url: 'https://example.com/mcp', headers: { 'X-A': '!curl evil', 'X-B': 'a$b' } }, undefined, {})

    expect(stdio).toEqual({ native: { name: 's', config: { command: 'srv', args: [], env: { A: '$!rm -rf /', B: 'pa$$$$word', C: '$$HOME', CLAUDECODE: '1' }, exposure: 'direct', timeout: 1800 } } })
    expect(http).toEqual({ native: { name: 'h', config: { url: 'https://example.com/mcp', headers: { 'X-A': '$!curl evil', 'X-B': 'a$$b' }, exposure: 'direct', timeout: 300 } } })
  })

  it('keeps an undefined variable literal, escaped', () => {
    expect(toNativeServer('h', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${MISSING}' } }, undefined, {})).toEqual({
      native: { name: 'h', config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer $${MISSING}' }, exposure: 'direct', timeout: 300 } },
    })
  })

  it('sends bearerToken and bearerTokenEnv as an Authorization header', () => {
    const inline = toNativeServer('a', { type: 'http', url: 'https://example.com/mcp', bearerToken: '${TOKEN}' }, undefined, { TOKEN: 'tok-1' })
    const named = toNativeServer('b', { type: 'http', url: 'https://example.com/mcp', bearerTokenEnv: 'GH' }, undefined, { GH: 'tok-2' })

    expect(inline).toEqual({ native: { name: 'a', config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer tok-1' }, exposure: 'direct', timeout: 300 } } })
    expect(named).toEqual({ native: { name: 'b', config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer tok-2' }, exposure: 'direct', timeout: 300 } } })
  })

  it('maps the oauth client, callback port, scopes and MCP_CLIENT_SECRET to pi fields', () => {
    const result = toNativeServer('o', { type: 'http', url: 'https://example.com/mcp', oauth: { clientId: 'cid', callbackPort: 8765, scopes: 'read write' } }, undefined, { MCP_CLIENT_SECRET: 's$cret' })

    expect(result).toEqual({
      native: { name: 'o', config: { url: 'https://example.com/mcp', oauth: { clientId: 'cid', clientSecret: 's$$cret', callbackPort: 8765, scope: 'read write' }, exposure: 'direct', timeout: 300 } },
    })
  })

  it('passes a stdio cwd with ${VAR} and ~ expanded', () => {
    const home = toNativeServer('s', { command: 'srv', cwd: '~/app' }, undefined, {})
    const variable = toNativeServer('s', { command: 'srv', cwd: '${WORK}/app' }, undefined, { WORK: '/srv/work' })

    expect(home).toMatchObject({ native: { config: { cwd: `${homedir()}/app` } } })
    expect(variable).toEqual({
      native: { name: 's', config: { command: 'srv', args: [], env: { CLAUDECODE: '1' }, cwd: '/srv/work/app', exposure: 'direct', timeout: 1800 } },
    })
  })
})

describe('toNativeServer timeout (MCPN-003)', () => {
  it('floors the idle budget with a per-server timeout of at least 1000 ms, in whole seconds', () => {
    expect(toNativeServer('s', { command: 'srv', timeout: 3_600_500 }, undefined, {})).toMatchObject({ native: { config: { timeout: 3601 } } })
  })

  it('ignores a per-server timeout below 1000 ms', () => {
    expect(toNativeServer('h', { type: 'http', url: 'https://example.com/mcp', timeout: 999 }, undefined, {})).toMatchObject({ native: { config: { timeout: 300 } } })
  })

  it('uses CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT as the budget', () => {
    vi.stubEnv('CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', '90000')
    expect(toNativeServer('h', { type: 'http', url: 'https://example.com/mcp' }, undefined, {})).toMatchObject({ native: { config: { timeout: 90 } } })
  })

  it('falls back to the MCP_TOOL_TIMEOUT wall budget when the idle timeout is disabled', () => {
    vi.stubEnv('CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', '0')
    vi.stubEnv('MCP_TOOL_TIMEOUT', '600000')
    expect(toNativeServer('h', { type: 'http', url: 'https://example.com/mcp' }, undefined, {})).toMatchObject({ native: { config: { timeout: 600 } } })
  })
})

describe('toNativeServer for plugin servers (MCPN-004)', () => {
  it('registers under the flat plugin name and exports the plugin directories', () => {
    const config = { command: 'srv', aliasPrefix: 'mcp__plugin_tools_github__', baseName: 'github', pluginRoot: '/plugins/tools', pluginDataDir: '/data/tools' }
    expect(toNativeServer('plugin:tools:github', config, session, {})).toEqual({
      native: {
        name: 'plugin_tools_github',
        config: {
          command: 'srv',
          args: [],
          env: { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: '/repo', CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_PLUGIN_ROOT: '/plugins/tools', CLAUDE_PLUGIN_DATA: '/data/tools' },
          exposure: 'direct',
          timeout: 1800,
        },
      },
    })
  })
})

describe('toNativeServer keeps what pi cannot connect (MCPN-005)', () => {
  it.each([
    ['an SSE server', 's', { type: 'sse' as const, url: 'https://example.com/sse' }, 'sse transport'],
    ['a WebSocket server', 'w', { type: 'ws' as const, url: 'wss://example.com' }, 'ws transport'],
    ['a websocket-typed server', 'w', { type: 'websocket' as const, url: 'wss://example.com' }, 'websocket transport'],
    ['a server with a headersHelper', 'h', { type: 'http' as const, url: 'https://example.com/mcp', headersHelper: 'get-headers' }, 'headersHelper'],
    ['a name pi rejects', 'my.server', { command: 'srv' }, 'server name'],
  ])('keeps %s on pi-code', (_label, name, config, reason) => {
    expect(toNativeServer(name, config, undefined, {})).toEqual({ reason })
  })
})

describe('nativeMode (MCPN-001)', () => {
  const api = { registerMcpServer: () => {} }
  const noPolicy = { allowed: null, denied: [] }

  it('is native when pi has registerMcpServer and no MCP policy is set', () => {
    expect(nativeMode(api, null, noPolicy)).toBe(true)
  })

  it('is not native on a pi without registerMcpServer', () => {
    expect(nativeMode({}, null, noPolicy)).toBe(false)
  })

  it('is not native when managed-mcp.json is present, even empty', () => {
    expect(nativeMode(api, {}, noPolicy)).toBe(false)
  })

  it('is not native when an allowlist is set, even empty', () => {
    expect(nativeMode(api, null, { allowed: [], denied: [] })).toBe(false)
  })

  it('is not native when a denylist is set', () => {
    expect(nativeMode(api, null, { allowed: null, denied: [{ serverName: 'x' }] })).toBe(false)
  })
})

describe('piMcpRunning (MCPN-009)', () => {
  it("is true when pi's own /mcp is loaded", () => {
    expect(piMcpRunning([{ name: 'mcp', sourceInfo: { path: 'builtin:mcp' } }])).toBe(true)
  })

  it("is false when another extension's /mcp replaced it", () => {
    expect(piMcpRunning([{ name: 'mcp', sourceInfo: { path: '/home/u/.pi/agent/npm/node_modules/other-mcp/index.ts' } }])).toBe(false)
  })

  it('is false when no /mcp is loaded', () => {
    expect(piMcpRunning([{ name: 'model', sourceInfo: { path: 'builtin:model' } }])).toBe(false)
  })
})

describe('nativeToolAliases (MCPN-008)', () => {
  it("lists pi's mcp__ tools under their own names and nothing else", () => {
    expect(nativeToolAliases([{ name: 'mcp__srv__go' }, { name: 'read' }, { name: 'srv_go' }])).toEqual([{ pi: 'mcp__srv__go', claude: 'mcp__srv__go' }])
  })
})

describe("escaped values through pi's own resolver (MCPN-003)", () => {
  // pi's package index does not export the resolver, so it is loaded from the dist file.
  const resolverPath = join(import.meta.dirname, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'resolve-config-value.js')
  const loadResolver = async () => (await import(pathToFileURL(resolverPath).href)) as { resolveConfigValueOrThrow: (value: string, description: string, env?: Record<string, string>) => string }

  it('resolves every header value back to the literal pi-code sent, running nothing', async () => {
    const { resolveConfigValueOrThrow } = await loadResolver()
    // The characters pi treats specially, mixed with plain text.
    const value = fc.stringMatching(/^[!$a-zA-Z{}_ ]{1,24}$/)
    fc.assert(
      fc.property(value, (text) => {
        const translated = toNativeServer('h', { type: 'http', url: 'https://example.com/mcp', headers: { 'X-V': text } }, undefined, {})
        const sent = 'native' in translated ? (translated.native.config as { headers: Record<string, string> }).headers['X-V'] : ''
        expect(resolveConfigValueOrThrow(sent, 'header', { HOME: '/should-not-appear', a: 'EXPANDED' })).toBe(text)
      }),
      { numRuns: 500 },
    )
  })

  it('does not run a value that starts with !', async () => {
    const { resolveConfigValueOrThrow } = await loadResolver()
    const translated = toNativeServer('s', { command: 'srv', env: { A: '!echo pwned' } }, undefined, {})
    const sent = 'native' in translated ? (translated.native.config as { env: Record<string, string> }).env.A : ''

    expect(resolveConfigValueOrThrow(sent, 'env')).toBe('!echo pwned')
  })
})
