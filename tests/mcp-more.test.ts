import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Exercises the extension body of mcp.ts (transport selection, tool registration,
 * failure reporting, /mcp, lifecycle hooks) with the MCP SDK stubbed out.
 * No test starts a server, spawns a process, or opens a socket: the transport
 * classes are replaced by inert recorders and `os.homedir()` points at a temp dir
 * so the developer's real ~/.claude.json is never read.
 */

interface TransportRecord {
  kind: 'stdio' | 'http' | 'sse' | 'ws'
  options: Record<string, unknown>
  url?: URL
}

interface ToolDef {
  name: string
  description?: string
  inputSchema?: unknown
}

interface ClientRecord {
  info: { name: string; version: string }
  transport?: TransportRecord
}

interface ListPage {
  tools: ToolDef[]
  nextCursor?: string
}

interface CallResult {
  content?: unknown[]
  structuredContent?: unknown
  isError?: boolean
}

const hoisted = vi.hoisted(() => {
  const state = {
    home: '',
    transports: [] as TransportRecord[],
    clients: [] as ClientRecord[],
    callOptions: [] as Array<unknown>,
    closed: [] as ClientRecord[],
    notify: new Map<string, () => void | Promise<void>>(),
    control: {} as {
      connect: (transport: TransportRecord, client: ClientRecord) => Promise<void>
      listTools: (args: { cursor?: string }, client: ClientRecord) => Promise<ListPage>
      callTool: (args: { name: string; arguments: unknown }, client: ClientRecord) => Promise<CallResult>
      close: (client: ClientRecord) => Promise<void>
    },
  }
  return state
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient implements ClientRecord {
    transport?: TransportRecord
    constructor(public info: { name: string; version: string }) {
      hoisted.clients.push(this)
    }
    async connect(transport: TransportRecord): Promise<void> {
      this.transport = transport
      await hoisted.control.connect(transport, this)
    }
    listTools(args: { cursor?: string }): Promise<ListPage> {
      return hoisted.control.listTools(args, this)
    }
    callTool(args: { name: string; arguments: unknown }, _schema?: unknown, options?: unknown): Promise<CallResult> {
      hoisted.callOptions.push(options)
      return hoisted.control.callTool(args, this)
    }
    close(): Promise<void> {
      hoisted.closed.push(this)
      return hoisted.control.close(this)
    }
    setNotificationHandler(schema: unknown, handler: () => void | Promise<void>): void {
      // The SDK passes a zod schema whose method is a literal in its shape.
      const shape = (schema as { shape?: { method?: { value?: string } } })?.shape
      hoisted.notify.set(shape?.method?.value ?? 'unknown', handler)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({ PATH: '/usr/bin:/bin', HOME: '/home/tester' }),
  StdioClientTransport: class implements TransportRecord {
    kind = 'stdio' as const
    constructor(public options: Record<string, unknown>) {
      hoisted.transports.push(this)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class implements TransportRecord {
    kind = 'http' as const
    constructor(
      public url: URL,
      public options: Record<string, unknown>,
    ) {
      hoisted.transports.push(this)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: class implements TransportRecord {
    kind = 'ws' as const
    options: Record<string, unknown> = {}
    constructor(public url: URL) {
      hoisted.transports.push(this)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class implements TransportRecord {
    kind = 'sse' as const
    constructor(
      public url: URL,
      public options: Record<string, unknown>,
    ) {
      hoisted.transports.push(this)
    }
  },
}))

const mcpExtension = (await import('../extensions/mcp.ts')).default
const { splitByPolicy, expandCwd, resolveBearerToken, mapContent, setManagedSettingsPath } = await import('../extensions/mcp.ts')

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; details: { error?: string } }>
}

type Notification = { message: string; level: string }

interface Harness {
  tools: RegisteredTool[]
  notifications: Notification[]
  warnings: string[]
  emitted: Array<{ channel: string; data: unknown }>
  home: string
  cwd: string
  sessionStart: (trusted?: boolean | undefined, approve?: boolean) => Promise<void>
  shutdown: () => Promise<void>
  mcpCommand: () => Promise<void>
  toolNames: () => string[]
}

const writeServers = (file: string, servers: Record<string, unknown>): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ mcpServers: servers }))
}

/** Boots a fresh extension instance against temp-dir user/project config. */
const setup = async (opts: { user?: Record<string, unknown>; project?: Record<string, unknown> } = {}): Promise<Harness> => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-proj-'))
  tempDirs.push(home, cwd)
  hoisted.home = home
  if (opts.user) writeServers(join(home, '.claude.json'), opts.user)
  if (opts.project) writeServers(join(cwd, '.mcp.json'), opts.project)

  const tools: RegisteredTool[] = []
  const notifications: Notification[] = []
  const warnings: string[] = []
  const emitted: Array<{ channel: string; data: unknown }> = []
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()

  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.join(' '))
  })

  // Project config now needs approval as well as trust: pi reports a .claude-shaped repo
  // as trusted without ever asking, so project-approval prompts at the point of use.
  const makeCtx = (trusted?: boolean, approve = true): unknown => ({
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      confirm: async () => approve,
    },
    isProjectTrusted: trusted === undefined ? undefined : () => trusted,
  })

  await mcpExtension({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn),
    registerCommand: (name: string, opts2: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts2),
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
  } as never)

  return {
    tools,
    notifications,
    warnings,
    emitted,
    home,
    cwd,
    sessionStart: async (trusted?: boolean, approve = true) => {
      await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx(trusted, approve))
    },
    shutdown: async () => {
      await handlers.get('session_shutdown')?.({}, makeCtx(true))
    },
    mcpCommand: async () => {
      await commands.get('mcp')?.handler('', makeCtx(true))
    },
    toolNames: () => tools.map((t) => t.name),
  }
}

/** setup() plus the session_start that connections now hang off. */
const setupStarted = async (opts: Parameters<typeof setup>[0] = {}): Promise<Harness> => {
  const harness = await setup(opts)
  await harness.sessionStart()
  return harness
}

/** The /mcp handler notifies one multi-line blob; split it back into per-server lines. */
const statusLinesOf = async (harness: Harness): Promise<string[]> => {
  const before = harness.notifications.length
  await harness.mcpCommand()
  const emitted = harness.notifications[before]
  return emitted.message.split('\n')
}

const withTools = (tools: ToolDef[]): void => {
  hoisted.control.listTools = async () => ({ tools })
}

const defaultControl = (): typeof hoisted.control => ({
  connect: async () => {},
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  close: async () => {},
})

const savedEnv: Record<string, string | undefined> = {}
const setEnv = (key: string, value: string): void => {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}
const unsetEnv = (key: string): void => {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

const tempDirs: string[] = []

let savedAgentDir: string | undefined
beforeEach(() => {
  // getAgentDir() lives in the SDK, so mocking node:os here does not reach it: without
  // this the suite writes trust decisions into the developer's real ~/.pi/agent.
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'agentdir-'))

  hoisted.transports.length = 0
  hoisted.clients.length = 0
  hoisted.callOptions.length = 0
  hoisted.closed.length = 0
  hoisted.control = defaultControl()
  hoisted.notify.clear()
})

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir

  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
})

describe('mcp defers connecting until a session starts', () => {
  it('connects no transport from the extension factory', async () => {
    withTools([{ name: 'go' }])
    // pi runs the factory for invocations that never start a session (pi list, pi config),
    // so spawning servers here would launch every stdio server for those too.
    const h = await setup({ user: { local: { command: 'node' } } })

    expect(hoisted.transports).toHaveLength(0)
    expect(h.toolNames()).toEqual([])

    await h.sessionStart()
    expect(hoisted.transports).toHaveLength(1)
    expect(h.toolNames()).toEqual(['local_go'])
  })
})

describe('mcp startup config scoping', () => {
  it('connects user config on the first session without needing project trust', async () => {
    withTools([{ name: 'query' }])
    const harness = await setupStarted({ user: { db: { command: 'db-server' } } })

    expect(harness.toolNames()).toEqual(['db_query'])
    expect(hoisted.transports).toHaveLength(1)
  })

  it('does not connect project config until the project is trusted', async () => {
    withTools([{ name: 'query' }])
    const harness = await setup({ project: { risky: { command: 'arbitrary-command' } } })

    await harness.sessionStart(false)

    expect(hoisted.transports).toEqual([])
    expect(harness.toolNames()).toEqual([])
  })

  it('does not connect project config when the host exposes no trust check', async () => {
    withTools([{ name: 'query' }])
    const harness = await setup({ project: { risky: { command: 'arbitrary-command' } } })

    await harness.sessionStart(undefined)

    expect(hoisted.transports).toEqual([])
  })

  it('connects project config once the project is trusted', async () => {
    withTools([{ name: 'query' }])
    const harness = await setup({ project: { proj: { command: 'proj-server' } } })

    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual(['proj_query'])
  })

  it('does not connect project config when the approval prompt is declined', async () => {
    withTools([{ name: 'go' }])
    const harness = await setup({ project: { risky: { command: 'arbitrary-command' } } })

    await harness.sessionStart(true, false)

    expect(hoisted.transports).toHaveLength(0)
    expect(harness.toolNames()).toEqual([])
  })

  it('keeps a user server when a project server claims the same name', async () => {
    // Connecting the duplicate would evict the user client from the map, so it would
    // never be closed at shutdown and /mcp would report the project server's status.
    withTools([{ name: 'query' }])
    const harness = await setup({ user: { shared: { command: 'user-server' } }, project: { shared: { command: 'proj-server' } } })
    await harness.sessionStart(true)

    expect(hoisted.transports).toHaveLength(1)
    expect(hoisted.transports[0].options.command).toBe('user-server')
    expect(harness.warnings.join('\n')).toContain('shared')

    const closed: ClientRecord[] = []
    hoisted.control.close = async (client) => {
      closed.push(client)
    }
    await harness.shutdown()
    expect(closed).toHaveLength(1)
  })

  it('connects project config only once across repeated sessions', async () => {
    withTools([{ name: 'query' }])
    const harness = await setup({ project: { proj: { command: 'proj-server' } } })

    await harness.sessionStart(true)
    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual(['proj_query'])
    expect(hoisted.transports).toHaveLength(1)
  })
})

describe('mcp transport selection', () => {
  it('connects a type: ws server over the WebSocket transport', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { rt: { type: 'ws', url: 'wss://example.com/mcp' } } })
    expect(hoisted.transports.map((t) => t.kind)).toEqual(['ws'])
    expect(String(hoisted.transports[0].url)).toBe('wss://example.com/mcp')
    expect(harness.toolNames()).toEqual(['rt_go'])
  })

  it('warns and connects url-only when a ws server declares auth the transport cannot carry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { rt: { type: 'ws', url: 'wss://example.com/mcp', bearerToken: 'secret', headersHelper: 'echo {}' } } })
    // The ws branch returns before the headersHelper runs; the socket still opens.
    expect(hoisted.transports.map((t) => t.kind)).toEqual(['ws'])
    expect(harness.toolNames()).toEqual(['rt_go'])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/WebSocket.*url-only|ignored/i)
    warn.mockRestore()
  })

  // The managed allow/deny lists are an enterprise policy file, not user/project
  // settings, so point the extension at a throwaway managed-settings.json.
  const withManaged = (settings: unknown): void => {
    const file = join(mkdtempSync(join(tmpdir(), 'mcp-managed-')), 'managed-settings.json')
    writeFileSync(file, JSON.stringify(settings))
    setManagedSettingsPath(file)
  }
  afterEach(() => setManagedSettingsPath(undefined))

  it('does not connect a server on the managed deny list', async () => {
    withTools([{ name: 'go' }])
    withManaged({ deniedMcpServers: [{ serverName: 'blocked' }] })
    const harness = await setupStarted({ user: { blocked: { command: 'x' }, ok: { command: 'y' } } })
    expect(harness.toolNames()).toEqual(['ok_go'])
  })

  it('connects only managed-allow-listed servers when an allow list is set', async () => {
    withTools([{ name: 'go' }])
    withManaged({ allowedMcpServers: [{ serverName: 'keep' }] })
    const harness = await setupStarted({ user: { keep: { command: 'x' }, drop: { command: 'y' } } })
    expect(harness.toolNames()).toEqual(['keep_go'])
  })

  it('interpolates env vars in the command and args', async () => {
    setEnv('MCP_BIN', '/opt/bin/server')
    withTools([{ name: 'go' }])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} config syntax under test
    await setupStarted({ user: { local: { command: '${MCP_BIN}', args: ['--port', '${MCP_PORT:-9000}'] } } })

    const transport = hoisted.transports[0]
    expect(transport.options.command).toBe('/opt/bin/server')
    expect(transport.options.args).toEqual(['--port', '9000'])
  })

  it('builds a stdio transport from command, args and cwd', async () => {
    withTools([{ name: 'go' }])
    await setupStarted({ user: { local: { command: 'node', args: ['server.js'], cwd: '/srv/app' } } })

    const transport = hoisted.transports[0]
    expect(transport.kind).toBe('stdio')
    expect(transport.options.command).toBe('node')
    expect(transport.options.args).toEqual(['server.js'])
    expect(transport.options.cwd).toBe('/srv/app')
    expect(transport.options.stderr).toBe('ignore')
  })

  it('expands a leading ~ in cwd to the home directory', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { local: { command: 'node', cwd: '~/projects' } } })

    expect(hoisted.transports[0].options.cwd).toBe(`${harness.home}/projects`)
  })

  it('does not expand a tilde that is not a home-directory prefix', async () => {
    withTools([{ name: 'go' }])
    await setupStarted({ user: { local: { command: 'node', cwd: '~backup/data' } } })

    expect(hoisted.transports[0].options.cwd).toBe('~backup/data')
  })

  it('defaults args to an empty list when omitted', async () => {
    withTools([{ name: 'go' }])
    await setupStarted({ user: { local: { command: 'node' } } })

    expect(hoisted.transports[0].options.args).toEqual([])
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title documents the ${VAR} syntax interpolateEnv parses
  it('interpolates ${VAR} into the stdio environment', async () => {
    setEnv('MCP_TEST_SECRET', 'sekret')
    withTools([{ name: 'go' }])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${} syntax is exactly what the config interpolation resolves
    await setupStarted({ user: { local: { command: 'node', env: { API_KEY: 'k-${MCP_TEST_SECRET}', PLAIN: 'literal' } } } })

    const env = hoisted.transports[0].options.env as Record<string, string>
    expect(env.API_KEY).toBe('k-sekret')
    expect(env.PLAIN).toBe('literal')
  })

  it('gives a stdio server the SDK default environment, not the whole process env', async () => {
    setEnv('MCP_TEST_SECRET', 'sekret')
    withTools([{ name: 'go' }])
    await setupStarted({ user: { local: { command: 'node', env: { PLAIN: 'literal' } } } })

    const env = hoisted.transports[0].options.env as Record<string, string>
    // Its own config and the SDK allowlist come through; an unrelated secret does not.
    expect(env.PLAIN).toBe('literal')
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.MCP_TEST_SECRET).toBeUndefined()
  })

  it('treats a config carrying both command and url as stdio', async () => {
    withTools([{ name: 'go' }])
    await setupStarted({ user: { both: { command: 'node', url: 'https://example.com/mcp' } } })

    expect(hoisted.transports[0].kind).toBe('stdio')
  })

  it('builds a streamable HTTP transport for a url config', async () => {
    withTools([{ name: 'go' }])
    await setupStarted({ user: { remote: { url: 'https://example.com/mcp' } } })

    const transport = hoisted.transports[0]
    expect(transport.kind).toBe('http')
    expect(transport.url?.href).toBe('https://example.com/mcp')
    expect((transport.options.requestInit as { headers: Record<string, string> }).headers).toEqual({})
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title documents the ${VAR} syntax interpolateEnv parses
  it('interpolates ${VAR} into the url and the headers', async () => {
    setEnv('MCP_TEST_HOST', 'api.example.com')
    setEnv('MCP_TEST_TENANT', 'acme')
    withTools([{ name: 'go' }])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${} syntax is exactly what the config interpolation resolves
    await setupStarted({ user: { remote: { url: 'https://${MCP_TEST_HOST}/mcp', headers: { 'X-Tenant': '${MCP_TEST_TENANT}' } } } })

    const transport = hoisted.transports[0]
    expect(transport.url?.href).toBe('https://api.example.com/mcp')
    expect((transport.options.requestInit as { headers: Record<string, string> }).headers['X-Tenant']).toBe('acme')
  })

  it('sends a literal bearerToken as an Authorization header', async () => {
    withTools([{ name: 'go' }])
    await setupStarted({ user: { remote: { url: 'https://example.com/mcp', bearerToken: 'tok-123' } } })

    const headers = (hoisted.transports[0].options.requestInit as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer tok-123')
  })

  it('interpolates an env var inside a literal bearerToken', async () => {
    setEnv('MCP_TEST_TOKEN', 'sekret')
    withTools([{ name: 'go' }])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} config syntax under test
    await setupStarted({ user: { remote: { url: 'https://example.com/mcp', bearerToken: 'Bearer-${MCP_TEST_TOKEN}' } } })

    const headers = (hoisted.transports[0].options.requestInit as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer Bearer-sekret')
  })

  it('reads the bearer token from the environment variable named by bearerTokenEnv', async () => {
    setEnv('MCP_TEST_BEARER', 'env-tok')
    withTools([{ name: 'go' }])
    await setupStarted({ user: { remote: { url: 'https://example.com/mcp', bearerTokenEnv: 'MCP_TEST_BEARER' } } })

    const headers = (hoisted.transports[0].options.requestInit as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer env-tok')
  })

  it('prefers an explicit bearerToken over bearerTokenEnv', async () => {
    setEnv('MCP_TEST_BEARER', 'env-tok')
    withTools([{ name: 'go' }])
    await setupStarted({ user: { remote: { url: 'https://example.com/mcp', bearerToken: 'literal-tok', bearerTokenEnv: 'MCP_TEST_BEARER' } } })

    const headers = (hoisted.transports[0].options.requestInit as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer literal-tok')
  })

  it('omits Authorization when bearerTokenEnv names an unset variable', async () => {
    unsetEnv('MCP_TEST_ABSENT')
    withTools([{ name: 'go' }])
    await setupStarted({ user: { remote: { url: 'https://example.com/mcp', bearerTokenEnv: 'MCP_TEST_ABSENT' } } })

    const headers = (hoisted.transports[0].options.requestInit as { headers: Record<string, string> }).headers
    expect(headers).toEqual({})
  })

  it('falls back to SSE when the streamable transport fails to connect', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.kind === 'http') throw new Error('404 Not Found')
    }
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { remote: { url: 'https://example.com/mcp', bearerToken: 'tok' } } })

    expect(hoisted.transports.map((t) => t.kind)).toEqual(['http', 'sse'])
    const sse = hoisted.transports[1]
    expect(sse.url?.href).toBe('https://example.com/mcp')
    expect((sse.options.requestInit as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok')
    expect(harness.toolNames()).toEqual(['remote_go'])
  })

  it('connects an explicit type sse server over SSE directly', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { legacy: { type: 'sse', url: 'https://example.com/sse' } } })

    expect(hoisted.transports.map((t) => t.kind)).toEqual(['sse'])
    expect(harness.toolNames()).toEqual(['legacy_go'])
  })

  it('does not degrade an explicit type http server to SSE on failure', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.kind === 'http') throw new Error('connect refused')
    }
    const harness = await setupStarted({ user: { remote: { type: 'http', url: 'https://example.com/mcp' } } })

    expect(hoisted.transports.map((t) => t.kind)).toEqual(['http'])
    expect(await statusLinesOf(harness)).toEqual(['remote: failed: connect refused (0 tools)'])
  })

  it('lets an explicit type override a command field left in the config', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { remote: { type: 'http', command: 'stale', url: 'https://example.com/mcp' } } })

    expect(hoisted.transports.map((t) => t.kind)).toEqual(['http'])
    expect(harness.toolNames()).toEqual(['remote_go'])
  })

  it('does not retry over SSE when the streamable transport reports a 401', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.kind === 'http') {
        // What the SDK throws for a 401 with no authProvider: a transport error
        // carrying the status code, not the literal word Unauthorized.
        throw Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint'), { code: 401 })
      }
    }
    // Declining the OAuth login keeps the failure an auth failure: a typeless url
    // must not read it as a transport mismatch and retry the whole flow over SSE.
    const harness = await setup({ user: { remote: { url: 'https://example.com/mcp' } } })
    await harness.sessionStart(undefined, false)

    // No SSE retry AND the flow reached the decline path: both only happen if the
    // bare 401 (no 'Unauthorized' text) was recognized as an auth failure.
    expect(hoisted.transports.map((t) => t.kind)).toEqual(['http'])
    expect(await statusLinesOf(harness)).toEqual(['remote: failed: login declined for remote (0 tools)'])
  })

  it('reports a malformed url as a failure without constructing any transport', async () => {
    const harness = await setupStarted({ user: { remote: { url: 'not a url' } } })

    expect(hoisted.transports).toEqual([])
    const [line] = await statusLinesOf(harness)
    expect(line.startsWith('remote: failed: ')).toBe(true)
    expect(line.endsWith(' (0 tools)')).toBe(true)
  })
})

describe('plugin mcp servers', () => {
  it('connects an enabled plugin server with plugin vars substituted and the plugin tool alias', async () => {
    const harness = await setup()
    const root = join(harness.home, '.claude', 'plugins', 'cache', 'market', 'toolbox', '1.0.0')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'toolbox' }))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server' } } }))
    mkdirSync(join(harness.home, '.claude'), { recursive: true })
    writeFileSync(join(harness.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { toolbox: true } }))
    withTools([{ name: 'query' }])

    await harness.sessionStart()

    expect(harness.toolNames()).toEqual(['db_query'])
    expect(hoisted.transports.map((t) => t.kind)).toEqual(['stdio'])
    expect((hoisted.transports[0].options as { command: string }).command).toBe(`${root}/bin/server`)
    const aliasEvent = harness.emitted.find((entry) => entry.channel === 'pi-code:mcp-tools')
    expect(aliasEvent?.data).toEqual([{ pi: 'db_query', claude: 'mcp__plugin_toolbox_db__query' }])
  })
})

describe('mcp tool registration', () => {
  it('namespaces the tool under the server and replaces dashes with underscores', async () => {
    withTools([{ name: 'search-issues' }])
    const harness = await setupStarted({ user: { 'sonar-qube': { command: 'sonar' } } })

    expect(harness.toolNames()).toEqual(['sonar_qube_search_issues'])
  })

  it('labels the tool with the undecorated server and tool names', async () => {
    withTools([{ name: 'search-issues', description: 'Find issues' }])
    const harness = await setupStarted({ user: { 'sonar-qube': { command: 'sonar' } } })

    expect(harness.tools[0].label).toBe('sonar-qube: search-issues')
    expect(harness.tools[0].description).toBe('Find issues')
  })

  it('synthesizes a description when the server supplies none', async () => {
    withTools([{ name: 'query' }])
    const harness = await setupStarted({ user: { db: { command: 'db' } } })

    expect(harness.tools[0].description).toBe('MCP tool query from db')
  })

  it('exposes the normalized input schema as the tool parameters', async () => {
    withTools([{ name: 'query', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', additionalProperties: false, type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }])
    const harness = await setupStarted({ user: { db: { command: 'db' } } })

    expect(JSON.parse(JSON.stringify(harness.tools[0].parameters))).toEqual({ type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] })
  })

  it('substitutes an empty object schema when the server declares no input schema', async () => {
    withTools([{ name: 'ping' }])
    const harness = await setupStarted({ user: { db: { command: 'db' } } })

    expect(JSON.parse(JSON.stringify(harness.tools[0].parameters))).toEqual({ type: 'object', properties: {} })
  })

  it('registers every page of a paginated tool list', async () => {
    hoisted.control.listTools = async ({ cursor }) => {
      if (!cursor) return { tools: [{ name: 'one' }], nextCursor: 'page-2' }
      if (cursor === 'page-2') return { tools: [{ name: 'two' }], nextCursor: 'page-3' }
      return { tools: [{ name: 'three' }] }
    }
    const harness = await setupStarted({ user: { db: { command: 'db' } } })

    expect(harness.toolNames()).toEqual(['db_one', 'db_two', 'db_three'])
    expect(await statusLinesOf(harness)).toEqual(['db: connected (3 tools)'])
  })

  it('skips a tool whose namespaced name would shadow a first-party pi-code tool', async () => {
    withTools([{ name: 'fetch' }, { name: 'search' }])
    const h = await setup({ user: { web: { command: 'node' } } })
    await h.sessionStart()

    // An MCP server called "web" produces web_fetch / web_search, and mcp.ts registers
    // before web.ts, so without the guard it would replace the SSRF-checked fetch.
    expect(h.toolNames()).not.toContain('web_fetch')
    expect(h.toolNames()).not.toContain('web_search')
    expect(h.warnings.join('\n')).toContain('web_fetch')
  })

  it('skips a tool whose namespaced name collides with an already registered one', async () => {
    hoisted.control.listTools = async (_args, client) => {
      const command = client.transport?.options.command
      return command === 'first' ? { tools: [{ name: 'x' }] } : { tools: [{ name: 'qube_x' }, { name: 'other' }] }
    }
    const harness = await setupStarted({ user: { 'sonar-qube': { command: 'first' }, sonar: { command: 'second' } } })

    expect(harness.toolNames()).toEqual(['sonar_qube_x', 'sonar_other'])
    expect(harness.warnings).toEqual(['pi-code-mcp: skipping colliding tool name sonar_qube_x'])
    expect(await statusLinesOf(harness)).toEqual(['sonar-qube: connected (1 tools)', 'sonar: connected (1 tools)'])
  })

  it('registers nothing and reports zero tools for a server that exposes none', async () => {
    withTools([])
    const harness = await setupStarted({ user: { empty: { command: 'empty' } } })

    expect(harness.toolNames()).toEqual([])
    expect(await statusLinesOf(harness)).toEqual(['empty: connected (0 tools)'])
  })
})

describe('mcp tool execution', () => {
  const registerOne = async (inputSchema?: unknown): Promise<Harness> => {
    withTools([{ name: 'search-issues', inputSchema }])
    return setupStarted({ user: { 'sonar-qube': { command: 'sonar' } } })
  }

  it('forwards the undecorated tool name and the caller arguments to the server', async () => {
    const calls: Array<{ name: string; arguments: unknown }> = []
    hoisted.control.callTool = async (args) => {
      calls.push(args)
      return { content: [{ type: 'text', text: 'done' }] }
    }
    const harness = await registerOne()

    await harness.tools[0].execute('call-1', { severity: 'BLOCKER' })

    expect(calls).toEqual([{ name: 'search-issues', arguments: { severity: 'BLOCKER' } }])
  })

  it('returns the mapped content and no error detail on success', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'two issues' }] })
    const harness = await registerOne()

    const result = await harness.tools[0].execute('call-1', {})

    expect(result.content).toEqual([{ type: 'text', text: 'two issues' }])
    expect(result.details).toEqual({})
  })

  it('falls back to the structured content when the server returns no blocks', async () => {
    hoisted.control.callTool = async () => ({ content: [], structuredContent: { total: 2 } })
    const harness = await registerOne()

    const result = await harness.tools[0].execute('call-1', {})

    expect(result.content).toEqual([{ type: 'text', text: '{\n  "total": 2\n}' }])
  })

  it('passes an unrecognized content block through as its JSON serialization', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'audio', data: 'AAA', mimeType: 'audio/wav' }, { type: 'image' }, { type: 'resource' }] })
    const harness = await registerOne()

    const result = await harness.tools[0].execute('call-1', {})

    expect(result.content).toEqual([
      { type: 'text', text: '{"type":"audio","data":"AAA","mimeType":"audio/wav"}' },
      { type: 'text', text: '{"type":"image"}' },
      { type: 'text', text: '{"type":"resource"}' },
    ])
  })

  it('flags a server-reported error and appends the expected input schema', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'bad argument' }], isError: true })
    const harness = await registerOne({ type: 'object', properties: { severity: { type: 'string' } }, additionalProperties: true })

    const result = await harness.tools[0].execute('call-1', {})

    expect(result.details.error).toBe('tool_error')
    expect(result.content).toEqual([
      { type: 'text', text: 'bad argument' },
      { type: 'text', text: 'Tool reported an error. Expected input schema: {"type":"object","properties":{"severity":{"type":"string"}}}' },
    ])
  })

  it('caps the schema hint on error, so a huge schema cannot escape the output budget', async () => {
    // The hint is appended after mapContent, so it is the one part of a result the
    // aggregate cap never sees. The schema is server-controlled.
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'bad argument' }], isError: true })
    const harness = await registerOne({ type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(400_000) } } })

    const result = await harness.tools[0].execute('call-1', {})

    const hint = result.content.at(-1)
    expect(Buffer.byteLength(hint?.text ?? '', 'utf-8')).toBeLessThan(60_000)
  })

  it('propagates a call timeout as a rejection naming the namespaced tool', async () => {
    hoisted.control.callTool = () => new Promise<CallResult>(() => {})
    const harness = await registerOne()
    vi.useFakeTimers()

    const pending = harness.tools[0].execute('call-1', {})
    const assertion = expect(pending).rejects.toThrow('sonar_qube_search_issues timed out after 120000ms')
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
  })

  it('honors MCP_TOOL_TIMEOUT for the per-call budget', async () => {
    setEnv('MCP_TOOL_TIMEOUT', '5000')
    hoisted.control.callTool = () => new Promise<CallResult>(() => {})
    const harness = await registerOne()
    vi.useFakeTimers()

    const pending = harness.tools[0].execute('call-1', {})
    const assertion = expect(pending).rejects.toThrow('timed out after 5000ms')
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 5000 })
  })

  it('passes the call timeout to the SDK so its shorter default cannot fire first', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerOne()

    await harness.tools[0].execute('call-1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 120_000 })
  })
})

it('truncates a result with too many lines even when it is under the byte budget', async () => {
  // pi's budget is 50KB or 2000 lines, whichever hits first; 3000 short lines is well
  // under the byte cap but still floods the context.
  const many = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
  hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: many }] })
  withTools([{ name: 'dump' }])
  const harness = await setupStarted({ user: { srv: { command: 'x' } } })

  const out = await harness.tools[0].execute('c1', {})
  const text = out.content[0].text ?? ''
  expect(text.split('\n').length).toBeLessThan(2100)
  expect(text).toContain('truncated')
})

describe('mcp failure reporting', () => {
  it('records the error message of a server that fails to connect', async () => {
    hoisted.control.connect = async () => {
      throw new Error('spawn ENOENT')
    }
    const harness = await setupStarted({ user: { broken: { command: 'missing-binary' } } })

    expect(await statusLinesOf(harness)).toEqual(['broken: failed: spawn ENOENT (0 tools)'])
    expect(harness.toolNames()).toEqual([])
  })

  it('stringifies a non-Error rejection', async () => {
    hoisted.control.connect = async () => {
      throw 'plain string failure'
    }
    const harness = await setupStarted({ user: { broken: { command: 'x' } } })

    expect(await statusLinesOf(harness)).toEqual(['broken: failed: plain string failure (0 tools)'])
  })

  it('times out a connect that never settles after the connect budget', async () => {
    hoisted.control.connect = () => new Promise<void>(() => {})
    vi.useFakeTimers()

    const harness = await setup({ user: { hung: { command: 'sleep' } } })
    const booting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(10_000)
    await booting

    expect(await statusLinesOf(harness)).toEqual(['hung: failed: connect hung timed out after 10000ms (0 tools)'])
  })

  it('honors MCP_TIMEOUT for the connect budget', async () => {
    setEnv('MCP_TIMEOUT', '2000')
    hoisted.control.connect = () => new Promise<void>(() => {})
    vi.useFakeTimers()

    const harness = await setup({ user: { hung: { command: 'sleep' } } })
    const booting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(2_000)
    await booting

    expect(await statusLinesOf(harness)).toEqual(['hung: failed: connect hung timed out after 2000ms (0 tools)'])
  })

  it('closes a client whose connect exceeded the budget so it cannot orphan', async () => {
    // The connect resolves just after the deadline; without a close the transport would
    // finish connecting unreferenced (process/socket alive, invisible to shutdown).
    let resolveConnect: (() => void) | undefined
    hoisted.control.connect = () => new Promise<void>((r) => (resolveConnect = r))
    vi.useFakeTimers()

    const harness = await setup({ user: { slow: { command: 'x' } } })
    const booting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(10_000)
    resolveConnect?.() // the server finishes connecting after the deadline
    await booting

    expect(hoisted.closed).toHaveLength(1)
  })

  it('times out a tool listing that never settles', async () => {
    hoisted.control.listTools = () => new Promise<ListPage>(() => {})
    vi.useFakeTimers()

    const harness = await setup({ user: { slow: { command: 'x' } } })
    const booting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(10_000)
    await booting

    expect(await statusLinesOf(harness)).toEqual(['slow: failed: list tools slow timed out after 10000ms (0 tools)'])
  })

  it('keeps connecting the remaining servers after one fails', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.options.command === 'bad') throw new Error('nope')
    }
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { broken: { command: 'bad' }, healthy: { command: 'good' } } })

    expect(harness.toolNames()).toEqual(['healthy_go'])
    expect(await statusLinesOf(harness)).toEqual(['broken: failed: nope (0 tools)', 'healthy: connected (1 tools)'])
  })
})

describe('mcp /mcp command', () => {
  it('explains where to configure servers when none are known', async () => {
    const harness = await setupStarted()

    await harness.mcpCommand()

    expect(harness.notifications).toEqual([{ message: 'No MCP servers configured. Add them to .mcp.json, .pi/mcp.json, ~/.claude.json, or ~/.pi/agent/mcp.json', level: 'info' }])
  })

  it('lists one line per server with its state and tool count', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.options.command === 'bad') throw new Error('nope')
    }
    hoisted.control.listTools = async () => ({ tools: [{ name: 'a' }, { name: 'b' }] })
    const harness = await setupStarted({ user: { good: { command: 'ok' }, broken: { command: 'bad' } } })

    await harness.mcpCommand()

    // session_start notifies its own summary first; /mcp appends the per-server listing.
    expect(harness.notifications.at(-1)).toEqual({ message: 'good: connected (2 tools)\nbroken: failed: nope (0 tools)', level: 'info' })
  })
})

describe('mcp session_start notification', () => {
  it('stays silent when no servers are configured', async () => {
    const harness = await setup()

    await harness.sessionStart(true)

    expect(harness.notifications).toEqual([])
  })

  it('totals the tools across connected servers at info level', async () => {
    hoisted.control.listTools = async (_args, client) => (client.transport?.options.command === 'one' ? { tools: [{ name: 'a' }, { name: 'b' }] } : { tools: [{ name: 'c' }] })
    const harness = await setup({ user: { first: { command: 'one' }, second: { command: 'two' } } })

    await harness.sessionStart(true)

    expect(harness.notifications).toEqual([{ message: 'MCP: 3 tools from 2 servers', level: 'info' }])
  })

  it('warns and counts the failures when a server did not connect', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.options.command === 'bad') throw new Error('nope')
    }
    withTools([{ name: 'a' }])
    const harness = await setup({ user: { good: { command: 'ok' }, broken: { command: 'bad' } } })

    await harness.sessionStart(true)

    expect(harness.notifications).toEqual([{ message: 'MCP: 1 tools from 1 servers, 1 failed', level: 'warning' }])
  })

  it('counts servers connected from the trusted project config in the same notification', async () => {
    withTools([{ name: 'a' }])
    const harness = await setup({ user: { fromUser: { command: 'u' } }, project: { fromProject: { command: 'p' } } })

    await harness.sessionStart(true)

    expect(harness.notifications).toEqual([{ message: 'MCP: 2 tools from 2 servers', level: 'info' }])
  })
})

describe('mcp session_shutdown', () => {
  it('closes every connected client', async () => {
    const closed: string[] = []
    hoisted.control.close = async (client) => {
      closed.push(String(client.transport?.options.command))
    }
    withTools([{ name: 'a' }])
    const harness = await setupStarted({ user: { first: { command: 'one' }, second: { command: 'two' } } })

    await harness.shutdown()

    expect(closed.sort()).toEqual(['one', 'two'])
  })

  it('does not close a client that never connected', async () => {
    const closed: string[] = []
    hoisted.control.connect = async (transport) => {
      if (transport.options.command === 'bad') throw new Error('nope')
    }
    hoisted.control.close = async (client) => {
      closed.push(String(client.transport?.options.command))
    }
    withTools([{ name: 'a' }])
    const harness = await setupStarted({ user: { broken: { command: 'bad' }, healthy: { command: 'good' } } })

    await harness.shutdown()

    expect(closed).toEqual(['good'])
  })

  it('still shuts down when a client close rejects', async () => {
    const closed: string[] = []
    hoisted.control.close = async (client) => {
      if (client.transport?.options.command === 'one') throw new Error('already gone')
      closed.push('two')
    }
    withTools([{ name: 'a' }])
    const harness = await setupStarted({ user: { first: { command: 'one' }, second: { command: 'two' } } })

    await expect(harness.shutdown()).resolves.toBeUndefined()
    expect(closed).toEqual(['two'])
  })

  it('gives up on a hung close after the shutdown budget instead of stalling exit', async () => {
    const closed: string[] = []
    hoisted.control.close = async (client) => {
      if (client.transport?.options.command === 'hang') return new Promise<void>(() => {})
      closed.push('quick')
    }
    withTools([{ name: 'a' }])
    const harness = await setupStarted({ user: { hung: { command: 'hang' }, quick: { command: 'quick' } } })
    vi.useFakeTimers()

    const shutting = harness.shutdown()
    await vi.advanceTimersByTimeAsync(3000)

    await expect(shutting).resolves.toBeUndefined()
    expect(closed).toEqual(['quick'])
  })
})

describe('MCP tool alias publication', () => {
  it('publishes pi-to-Claude tool name aliases on the shared bus with original names', async () => {
    withTools([{ name: 'web-search' }])
    const harness = await setup({ user: { 'brave-search': { command: 'srv' } } })
    await harness.sessionStart()
    expect(harness.emitted).toContainEqual({
      channel: 'pi-code:mcp-tools',
      data: [{ pi: 'brave_search_web_search', claude: 'mcp__brave-search__web-search' }],
    })
  })
})

describe('per-server project approvals', () => {
  const writeClaudeSettings = (root: string, name: string, settings: Record<string, unknown>): void => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', name), JSON.stringify(settings))
  }

  it('never connects a server listed in disabledMcpjsonServers, even when the project is approved', async () => {
    withTools([{ name: 'a' }])
    const harness = await setup({ project: { keep: { command: 'k' }, blocked: { command: 'b' } } })
    writeClaudeSettings(harness.cwd, 'settings.json', { disabledMcpjsonServers: ['blocked'] })
    await harness.sessionStart(true, true)
    expect(harness.toolNames()).toEqual(['keep_a'])
  })

  it('connects an enabledMcpjsonServers entry from the user settings without the project confirm', async () => {
    withTools([{ name: 'a' }])
    const harness = await setup({ project: { consented: { command: 'c' }, other: { command: 'o' } } })
    // The user's own settings file is outside the repository, so its consent stands
    // on its own; the unlisted server still waits for the project confirm.
    writeClaudeSettings(harness.home, 'settings.json', { enabledMcpjsonServers: ['consented'] })
    await harness.sessionStart(true, false)
    expect(harness.toolNames()).toEqual(['consented_a'])
  })

  it('connects every project server under enableAllProjectMcpServers from settings.local.json', async () => {
    withTools([{ name: 'a' }])
    const harness = await setup({ project: { one: { command: '1' }, two: { command: '2' } } })
    writeClaudeSettings(harness.cwd, 'settings.local.json', { enableAllProjectMcpServers: true })
    await harness.sessionStart(true, true)
    expect(harness.toolNames().sort()).toEqual(['one_a', 'two_a'])
  })

  it('ignores consent keys from the repo-controlled project settings.json', async () => {
    // A checked-in file must not approve its own servers; only the restrictive key counts.
    withTools([{ name: 'a' }])
    const harness = await setup({ project: { sneaky: { command: 's' } } })
    writeClaudeSettings(harness.cwd, 'settings.json', { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['sneaky'] })
    await harness.sessionStart(true, false)
    expect(harness.toolNames()).toEqual([])
  })

  it('lets disabled win over enabled for the same server', async () => {
    withTools([{ name: 'a' }])
    const harness = await setup({ project: { contested: { command: 'c' } } })
    writeClaudeSettings(harness.cwd, 'settings.local.json', { enabledMcpjsonServers: ['contested'], disabledMcpjsonServers: ['contested'] })
    await harness.sessionStart(true, true)
    expect(harness.toolNames()).toEqual([])
  })
})

describe('small MCP parity', () => {
  it('honors a per-server timeout over the global default, with a 1s floor', async () => {
    withTools([{ name: 'quick' }])
    const harness = await setupStarted({ user: { srv: { command: 'x', timeout: 1500 }, floored: { command: 'y', timeout: 10 } } })
    await harness.tools[0].execute('c1', {})
    expect((hoisted.callOptions.at(-1) as { timeout: number }).timeout).toBe(1500)

    // Below Claude's documented 1s minimum the per-server value is ignored.
    await harness.tools[1].execute('c2', {})
    expect((hoisted.callOptions.at(-1) as { timeout: number }).timeout).toBe(120_000)
  })

  it('expands environment variables in cwd', async () => {
    setEnv('PROJ_ROOT', '/tmp/proj')
    withTools([])
    await setupStarted({ user: { srv: { command: 'x', cwd: '${PROJ_ROOT}/sub' } } })
    expect((hoisted.transports[0].options as { cwd?: string }).cwd).toBe('/tmp/proj/sub')
    unsetEnv('PROJ_ROOT')
  })

  it('warns about a url entry that declares no type', async () => {
    withTools([])
    const harness = await setupStarted({ user: { srv: { url: 'https://example.com/mcp' } } })
    expect(harness.warnings.some((w) => w.includes('no "type"'))).toBe(true)
  })
})

describe('policy split and cwd expansion helpers', () => {
  const policy = (over: Partial<{ disabled: Set<string>; consented: Set<string>; consentAll: boolean }> = {}) => ({
    disabled: over.disabled ?? new Set<string>(),
    consented: over.consented ?? new Set<string>(),
    consentAll: over.consentAll ?? false,
  })

  it('drops disabled servers, separates consented from gated', () => {
    const candidates = { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } }
    const split = splitByPolicy(candidates, policy({ disabled: new Set(['a']), consented: new Set(['b']) }))
    expect(Object.keys(split.consented)).toEqual(['b'])
    expect(Object.keys(split.gated)).toEqual(['c'])
  })

  it('treats every surviving server as consented under consentAll', () => {
    const split = splitByPolicy({ a: { command: 'a' }, b: { command: 'b' } }, policy({ consentAll: true, disabled: new Set(['b']) }))
    expect(Object.keys(split.consented)).toEqual(['a'])
    expect(split.gated).toEqual({})
  })

  it('expands a cwd through ${VAR} then a leading tilde, or leaves it unset', () => {
    setEnv('CWD_ROOT', '/srv')
    expect(expandCwd('${CWD_ROOT}/x')).toBe('/srv/x')
    expect(expandCwd(undefined)).toBeUndefined()
    expect(expandCwd('~/proj')).toBe(`${hoisted.home}/proj`)
    unsetEnv('CWD_ROOT')
  })
})

describe('resolveBearerToken', () => {
  it('prefers an interpolated inline token, falls back to the named env var, else undefined', () => {
    setEnv('TOK_INLINE', 'inline-secret')
    setEnv('TOK_NAMED', 'named-secret')
    expect(resolveBearerToken({ bearerToken: '${TOK_INLINE}' })).toBe('inline-secret')
    expect(resolveBearerToken({ bearerTokenEnv: 'TOK_NAMED' })).toBe('named-secret')
    expect(resolveBearerToken({ bearerToken: 'literal', bearerTokenEnv: 'TOK_NAMED' })).toBe('literal')
    expect(resolveBearerToken({})).toBeUndefined()
    unsetEnv('TOK_INLINE')
    unsetEnv('TOK_NAMED')
  })
})

describe('tool list refresh', () => {
  it('registers newly appeared tools when the server signals list_changed', async () => {
    withTools([{ name: 'first' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })
    expect(harness.toolNames()).toEqual(['srv_first'])

    withTools([{ name: 'first' }, { name: 'second' }])
    await hoisted.notify.get('notifications/tools/list_changed')?.()

    expect(harness.toolNames().sort()).toEqual(['srv_first', 'srv_second'])
  })

  it('does not re-register a tool that is still listed', async () => {
    withTools([{ name: 'only' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })
    await hoisted.notify.get('notifications/tools/list_changed')?.()
    expect(harness.toolNames()).toEqual(['srv_only'])
  })

  it('publishes the refreshed aliases so hook matchers see the new tools', async () => {
    withTools([{ name: 'first' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })
    withTools([{ name: 'first' }, { name: 'second' }])
    await hoisted.notify.get('notifications/tools/list_changed')?.()

    const published = harness.emitted.filter((e) => e.channel === 'pi-code:mcp-tools').at(-1)?.data as Array<{ claude: string }>
    expect(published.map((entry) => entry.claude)).toContain('mcp__srv__second')
  })
})

describe('in-project consent cannot self-approve', () => {
  it('ignores settings.local.json consent when the user declines the project', async () => {
    // A hostile repo can commit .claude/settings.local.json; honoring it regardless
    // would spawn its .mcp.json server command after the user said no.
    withTools([{ name: 'a' }])
    const harness = await setup({ project: { evil: { command: 'sh' } } })
    mkdirSync(join(harness.cwd, '.claude'), { recursive: true })
    writeFileSync(join(harness.cwd, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }))

    await harness.sessionStart(false, false)

    expect(harness.toolNames()).toEqual([])
    expect(hoisted.transports).toEqual([])
  })
})

describe('aggregate tool-output budget', () => {
  const textBytes = (blocks: ReturnType<typeof mapContent>): number => blocks.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf-8') : 0), 0)

  it('bounds the whole result, not each block, and states how many blocks were omitted', () => {
    // A server answering with one block per file multiplies the per-block cap by the
    // block count; 200 blocks of 40KB used to reach the model as ~8MB. Driven through
    // mapContent because asserting capTotal directly would pass even if mapContent
    // stopped calling it.
    const blocks = Array.from({ length: 200 }, () => ({ type: 'text', text: 'x'.repeat(40_000) }))
    const capped = mapContent(blocks)

    expect(textBytes(capped)).toBeLessThan(60_000)
    // One block fits, 199 do not: the count must name the blocks the model never saw.
    expect(capped.at(-1)).toEqual({ type: 'text', text: '[199 further content blocks omitted: tool output budget spent]' })
  })

  it('reports no omission when the server sent a single oversized block', () => {
    // That block reaches the model whole; claiming a further block exists invites a
    // re-call for content that was never sent.
    const capped = mapContent([{ type: 'text', text: 'x'.repeat(60_000) }])

    expect(capped).toHaveLength(1)
    expect(capped[0]?.type === 'text' && capped[0].text).toContain('[truncated:')
  })

  it('keeps what reaches the model a prefix of what the server sent', () => {
    // Skipping an oversized block and resuming with smaller ones would hand the model
    // blocks 1 and 3 under a notice saying one was omitted, which reads as contiguous.
    const capped = mapContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'B'.repeat(60_000) },
      { type: 'text', text: 'third' },
    ])

    expect(capped.some((block) => block.type === 'text' && block.text === 'third')).toBe(false)
    expect(capped.at(-1)).toEqual({ type: 'text', text: '[2 further content blocks omitted: tool output budget spent]' })
  })

  it('keeps the caption alongside an oversized image', () => {
    // The screenshot shape: one image over the whole text budget plus a one-line
    // caption. Charging the image against the budget deleted the only text the model
    // could act on, and the marker replacing it was larger than the caption itself.
    const image = { type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/png' }
    const capped = mapContent([image, { type: 'text', text: 'Clicked the login button at (120,340)' }])

    expect(capped).toEqual([
      { type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/png' },
      { type: 'text', text: 'Clicked the login button at (120,340)' },
    ])
  })

  it('passes a small result through untouched', () => {
    const blocks = [
      { type: 'text', text: 'small' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
    ]
    expect(mapContent(blocks)).toEqual([
      { type: 'text', text: 'small' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
    ])
  })
})

describe('mcp client lifecycle', () => {
  it('closes and releases a client whose tool listing fails', async () => {
    hoisted.control.listTools = async () => {
      throw new Error('boom')
    }
    const harness = await setupStarted({ user: { flaky: { command: 'ok' } } })

    expect(await statusLinesOf(harness)).toEqual(['flaky: failed: boom (0 tools)'])
    // Closed at failure time; a client left in the map would idle its process for
    // the whole session and block the name for every later scope.
    expect(hoisted.closed).toHaveLength(1)

    await harness.shutdown()
    expect(hoisted.closed).toHaveLength(1)
  })

  it('reconnects a name whose first connection failed after connect', async () => {
    hoisted.control.listTools = async () => {
      throw new Error('boom')
    }
    const harness = await setupStarted({ user: { flaky: { command: 'ok' } } })
    withTools([{ name: 'go' }])
    await harness.sessionStart()

    expect(harness.toolNames()).toEqual(['flaky_go'])
    expect(await statusLinesOf(harness)).toEqual(['flaky: connected (1 tools)'])
  })

  it('flips a server to disconnected when its transport closes mid-session', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { live: { command: 'ok' } } })
    expect(await statusLinesOf(harness)).toEqual(['live: connected (1 tools)'])

    const client = hoisted.clients.at(-1) as { onclose?: () => void } | undefined
    client?.onclose?.()

    expect(await statusLinesOf(harness)).toEqual(['live: disconnected (0 tools)'])
  })
})
