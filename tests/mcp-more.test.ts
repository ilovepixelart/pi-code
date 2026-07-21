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
  kind: 'stdio' | 'http' | 'sse'
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
    callTool(args: { name: string; arguments: unknown }): Promise<CallResult> {
      return hoisted.control.callTool(args, this)
    }
    close(): Promise<void> {
      return hoisted.control.close(this)
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
  } as never)

  return {
    tools,
    notifications,
    warnings,
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

beforeEach(() => {
  hoisted.transports.length = 0
  hoisted.clients.length = 0
  hoisted.control = defaultControl()
})

afterEach(() => {
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

  it('does not retry over SSE when the streamable transport reports Unauthorized', async () => {
    hoisted.control.connect = async (transport) => {
      if (transport.kind === 'http') throw new Error('Unauthorized')
    }
    const harness = await setupStarted({ user: { remote: { url: 'https://example.com/mcp' } } })

    expect(hoisted.transports.map((t) => t.kind)).toEqual(['http'])
    expect(await statusLinesOf(harness)).toEqual(['remote: failed: Unauthorized (0 tools)'])
  })

  it('reports a malformed url as a failure without constructing any transport', async () => {
    const harness = await setupStarted({ user: { remote: { url: 'not a url' } } })

    expect(hoisted.transports).toEqual([])
    const [line] = await statusLinesOf(harness)
    expect(line.startsWith('remote: failed: ')).toBe(true)
    expect(line.endsWith(' (0 tools)')).toBe(true)
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

  it('propagates a call timeout as a rejection naming the namespaced tool', async () => {
    hoisted.control.callTool = () => new Promise<CallResult>(() => {})
    const harness = await registerOne()
    vi.useFakeTimers()

    const pending = harness.tools[0].execute('call-1', {})
    const assertion = expect(pending).rejects.toThrow('sonar_qube_search_issues timed out after 120000ms')
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
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
