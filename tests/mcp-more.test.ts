import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

interface PromptDef {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

interface PromptPage {
  prompts: PromptDef[]
  nextCursor?: string
}

interface PromptResult {
  messages: Array<{ role: string; content: Record<string, unknown> }>
}

const hoisted = vi.hoisted(() => {
  const state = {
    home: '',
    transports: [] as TransportRecord[],
    clients: [] as ClientRecord[],
    callOptions: [] as Array<unknown>,
    closed: [] as ClientRecord[],
    // Codes handed to a transport's finishAuth, so the interactive OAuth exchange is observable.
    finishAuthCalls: [] as string[],
    notify: new Map<string, () => void | Promise<void>>(),
    // Client constructor options (capabilities) and roots/list-style request handlers.
    clientOptions: [] as Array<unknown>,
    requests: new Map<string, (request: unknown) => unknown>(),
    control: {} as {
      connect: (transport: TransportRecord, client: ClientRecord) => Promise<void>
      listTools: (args: { cursor?: string }, client: ClientRecord) => Promise<ListPage>
      callTool: (args: { name: string; arguments: unknown }, client: ClientRecord) => Promise<CallResult>
      close: (client: ClientRecord) => Promise<void>
      getServerCapabilities: (client: ClientRecord) => Record<string, unknown> | undefined
      listPrompts: (args: { cursor?: string }, client: ClientRecord) => Promise<{ prompts: PromptDef[]; nextCursor?: string }>
      getPrompt: (args: { name: string; arguments?: Record<string, string> }, client: ClientRecord) => Promise<{ messages: Array<{ role: string; content: Record<string, unknown> }> }>
      listResources: (args: { cursor?: string }, client: ClientRecord) => Promise<{ resources: Array<Record<string, unknown>>; nextCursor?: string }>
      listResourceTemplates: (args: { cursor?: string }, client: ClientRecord) => Promise<{ resourceTemplates: Array<Record<string, unknown>>; nextCursor?: string }>
      readResource: (args: { uri: string }, client: ClientRecord) => Promise<{ contents: Array<Record<string, unknown>> }>
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
    constructor(
      public info: { name: string; version: string },
      options?: unknown,
    ) {
      hoisted.clients.push(this)
      hoisted.clientOptions.push(options)
    }
    setRequestHandler(schema: unknown, handler: (request: unknown) => unknown): void {
      const shape = (schema as { shape?: { method?: { value?: string } } })?.shape
      hoisted.requests.set(shape?.method?.value ?? 'unknown', handler)
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
    getServerCapabilities(): Record<string, unknown> | undefined {
      return hoisted.control.getServerCapabilities(this)
    }
    listPrompts(args?: { cursor?: string }): Promise<PromptPage> {
      return hoisted.control.listPrompts(args ?? {}, this)
    }
    getPrompt(args: { name: string; arguments?: Record<string, string> }, _options?: unknown): Promise<PromptResult> {
      return hoisted.control.getPrompt(args, this)
    }
    listResources(args?: { cursor?: string }, _options?: unknown): Promise<{ resources: Array<Record<string, unknown>>; nextCursor?: string }> {
      return hoisted.control.listResources(args ?? {}, this)
    }
    listResourceTemplates(args?: { cursor?: string }, _options?: unknown): Promise<{ resourceTemplates: Array<Record<string, unknown>>; nextCursor?: string }> {
      return hoisted.control.listResourceTemplates(args ?? {}, this)
    }
    readResource(args: { uri: string }, _options?: unknown): Promise<{ contents: Array<Record<string, unknown>> }> {
      return hoisted.control.readResource(args, this)
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
    // The SDK exchanges the authorization code here; recording it lets a test drive the
    // interactive login and assert the code reached the transport.
    async finishAuth(code: string): Promise<void> {
      hoisted.finishAuthCalls.push(code)
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

const mcpExtension = (await import('../extensions/mcp/index.ts')).default
const { splitByPolicy, expandCwd, resolveBearerToken, mapContent, setManagedSettingsPath } = await import('../extensions/mcp/index.ts')

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: { error?: string } }>
}

type Notification = { message: string; level: string }

interface Harness {
  tools: RegisteredTool[]
  notifications: Notification[]
  warnings: string[]
  emitted: Array<{ channel: string; data: unknown }>
  sent: string[]
  sentOptions: unknown[]
  home: string
  cwd: string
  sessionStart: (trusted?: boolean | undefined, approve?: boolean) => Promise<void>
  shutdown: () => Promise<void>
  mcpCommand: () => Promise<void>
  toolNames: () => string[]
  commandNames: () => string[]
  runSlash: (name: string, args: string, idle?: boolean) => Promise<void>
  input: (text: string) => Promise<unknown>
}

const writeServers = (file: string, servers: Record<string, unknown>): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ mcpServers: servers }))
}

/** Boots a fresh extension instance against temp-dir user/project config. */
const setup = async (opts: { user?: Record<string, unknown>; project?: Record<string, unknown>; confirm?: () => Promise<boolean> } = {}): Promise<Harness> => {
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
  const sent: string[] = []
  const sentOptions: unknown[] = []
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()

  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.join(' '))
  })

  // Project config now needs approval as well as trust: pi reports a .claude-shaped repo
  // as trusted without ever asking, so project-approval prompts at the point of use.
  const makeCtx = (trusted?: boolean, approve = true, idle = true): unknown => ({
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      confirm: opts.confirm ?? (async () => approve),
    },
    // Always provide the capability: without it the first sessionStart in the
    // file emits the once-per-module runtime-too-old warning into whichever
    // test runs first, making notification assertions order-dependent under
    // shuffle. The old-runtime path is tested in project-approval.test.ts.
    isProjectTrusted: () => trusted === true,
    isIdle: () => idle,
  })

  await mcpExtension({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn),
    registerCommand: (name: string, opts2: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts2),
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    sendUserMessage: (text: string, options?: unknown) => {
      sent.push(text)
      sentOptions.push(options)
    },
    events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
  } as never)

  return {
    tools,
    notifications,
    warnings,
    emitted,
    sent,
    sentOptions,
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
    commandNames: () => [...commands.keys()],
    runSlash: async (name: string, args: string, idle = true) => {
      await commands.get(name)?.handler(args, makeCtx(true, true, idle))
    },
    input: async (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, makeCtx(true)),
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

/** Poll a condition to a deadline; for interleaving a step into an in-flight
 * connect flow. Runs on the real clock, so the budget is generous for starved
 * CI runners; vi.waitFor reports the elapsed wait on failure. */
const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error('condition not met within timeout')
    },
    { timeout: timeoutMs, interval: 10 },
  )
}

const defaultControl = (): typeof hoisted.control => ({
  connect: async () => {},
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  close: async () => {},
  getServerCapabilities: () => undefined,
  listPrompts: async () => ({ prompts: [] }),
  getPrompt: async () => ({ messages: [] }),
  listResources: async () => ({ resources: [] }),
  listResourceTemplates: async () => ({ resourceTemplates: [] }),
  readResource: async () => ({ contents: [] }),
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
  hoisted.finishAuthCalls.length = 0
  hoisted.control = defaultControl()
  hoisted.notify.clear()
  hoisted.clientOptions.length = 0
  hoisted.requests.clear()
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

  it('lets a consented project server outrank a user server of the same name', async () => {
    // Claude's precedence is project over user for a duplicate name. Here the user has
    // consented to the project server in their own settings, so the project definition
    // connects and the user server of the same name is not connected.
    withTools([{ name: 'query' }])
    const harness = await setup({ user: { shared: { command: 'user-server' } }, project: { shared: { command: 'proj-server' } } })
    mkdirSync(join(harness.home, '.claude'), { recursive: true })
    writeFileSync(join(harness.home, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['shared'] }))
    await harness.sessionStart(true)

    expect(hoisted.transports).toHaveLength(1)
    expect(hoisted.transports[0].options.command).toBe('proj-server')
  })

  it('lets a local-scope server outrank a consented project server of the same name', async () => {
    // Claude's scope precedence is local over project over user: the per-project
    // entry in ~/.claude.json wins the name clash with the project's .mcp.json.
    withTools([{ name: 'query' }])
    const harness = await setup({ project: { shared: { command: 'proj-server' } } })
    writeFileSync(join(harness.home, '.claude.json'), JSON.stringify({ projects: { [harness.cwd]: { mcpServers: { shared: { command: 'local-server' } } } } }))
    mkdirSync(join(harness.home, '.claude'), { recursive: true })
    writeFileSync(join(harness.home, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['shared'] }))
    await harness.sessionStart(true)

    expect(hoisted.transports).toHaveLength(1)
    expect(hoisted.transports[0].options.command).toBe('local-server')
  })

  it('never connects a user server listed in the per-project disabledMcpServers toggle', async () => {
    // Claude records the /mcp panel's off toggle per project in ~/.claude.json under
    // disabledMcpServers, an opt-out list for user-configured and plugin servers.
    withTools([{ name: 'query' }])
    const harness = await setup()
    writeFileSync(
      join(harness.home, '.claude.json'),
      JSON.stringify({
        mcpServers: { muted: { command: 'muted-server' }, live: { command: 'live-server' } },
        projects: { [harness.cwd]: { disabledMcpServers: ['muted'] } },
      }),
    )
    await harness.sessionStart()

    expect(hoisted.transports).toHaveLength(1)
    expect(hoisted.transports[0].options.command).toBe('live-server')
  })

  it('scopes the disabledMcpServers toggle to its own project', async () => {
    // The toggle is recorded per project; another project's entry must not mute
    // this session's server.
    withTools([{ name: 'query' }])
    const harness = await setup()
    writeFileSync(
      join(harness.home, '.claude.json'),
      JSON.stringify({
        mcpServers: { muted: { command: 'muted-server' } },
        projects: { '/some/other/project': { disabledMcpServers: ['muted'] } },
      }),
    )
    await harness.sessionStart()

    expect(hoisted.transports).toHaveLength(1)
    expect(hoisted.transports[0].options.command).toBe('muted-server')
  })

  it('connects project config only once across repeated sessions', async () => {
    withTools([{ name: 'query' }])
    const harness = await setup({ project: { proj: { command: 'proj-server' } } })

    await harness.sessionStart(true)
    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual(['proj_query'])
    expect(hoisted.transports).toHaveLength(1)
  })

  it('initiates the user scope and consented project scope connects concurrently', async () => {
    withTools([{ name: 'go' }])
    // Defer every connect: neither resolves until the test releases it, so the
    // assertion below observes which transports exist while both are still pending.
    const release = new Map<string, () => void>()
    hoisted.control.connect = (transport) =>
      new Promise<void>((resolve) => {
        release.set(String(transport.options.command), resolve)
      })
    const harness = await setup({ user: { local: { command: 'user-server' } }, project: { proj: { command: 'proj-server' } } })
    mkdirSync(join(harness.home, '.claude'), { recursive: true })
    writeFileSync(join(harness.home, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['proj'] }))

    const started = harness.sessionStart(true)
    // Drain microtasks without resolving either connect. The consented project server
    // has no ordering dependency on the user scope, so its transport must already be
    // constructed instead of waiting behind the unresolved user connect.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(hoisted.transports.map((t) => t.options.command).sort()).toEqual(['proj-server', 'user-server'])

    release.get('user-server')?.()
    release.get('proj-server')?.()
    await started
    expect(harness.toolNames().sort()).toEqual(['local_go', 'proj_go'])
    expect(hoisted.transports).toHaveLength(2)
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

  it('interpolates ${VAR} into the stdio environment', async () => {
    setEnv('MCP_TEST_SECRET', 'sekret')
    withTools([{ name: 'go' }])
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

  it('interpolates ${VAR} into the url and the headers', async () => {
    setEnv('MCP_TEST_HOST', 'api.example.com')
    setEnv('MCP_TEST_TENANT', 'acme')
    withTools([{ name: 'go' }])
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

describe('interactive OAuth serialization', () => {
  it('runs interactive OAuth logins one at a time, and both servers still connect', async () => {
    // The user scope and consented project scope connect concurrently, so two servers
    // that both 401 would otherwise pop two confirm dialogs and open two browser tabs
    // at once. The interactive flow is serialized: the second confirm must not fire
    // until the first login settles. Silent connects stay parallel.
    withTools([{ name: 'go' }])
    // A silent connect (no authProvider) 401s; the interactive retry carries an
    // authProvider, so it succeeds and the server ends connected.
    hoisted.control.connect = async (transport) => {
      if ((transport.options as { authProvider?: unknown }).authProvider === undefined) {
        throw Object.assign(new Error('needs login'), { code: 401 })
      }
    }

    let confirmCount = 0
    let releaseFirst!: (value: boolean) => void
    const firstGate = new Promise<boolean>((resolve) => {
      releaseFirst = resolve
    })
    const confirm = async (): Promise<boolean> => {
      confirmCount++
      return confirmCount === 1 ? firstGate : true
    }

    const harness = await setup({ user: { alpha: { url: 'https://alpha.example/mcp' }, beta: { url: 'https://beta.example/mcp' } }, confirm })
    const started = harness.sessionStart()

    // Both silent connects 401 in parallel and both reach the interactive stage, but
    // only the first login's confirm has fired; the second is queued behind it. Wait
    // for the first confirm (the connect flow crosses real fs I/O, so a single tick
    // is not enough on slow runners), then give the queued one a turn to (wrongly) fire.
    await waitFor(() => confirmCount >= 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(confirmCount).toBe(1)

    releaseFirst(true)
    await started

    // The queued login proceeded once the first settled, and both servers connected.
    expect(confirmCount).toBe(2)
    expect(harness.toolNames().sort()).toEqual(['alpha_go', 'beta_go'])
  })

  it('exchanges the code through finishAuth and reconnects when the server 401s until authorized', async () => {
    // The most real path: FileOAuthProvider, startCallbackServer and waitForAuthCode all run
    // for real, so the loopback listener, the CSRF state echo and the code exchange are
    // exercised end to end. Only the transport connect and the http client are stubbed, since
    // the harness cannot reach a real OAuth server. Tradeoff: driving the real loopback means
    // interleaving a fetch mid-flow (poll for the provider transport, then deliver the code),
    // rather than stubbing waitForAuthCode, which would leave the callback plumbing untested.
    withTools([{ name: 'go' }])
    hoisted.control.connect = async (transport) => {
      const authProvider = (transport.options as { authProvider?: unknown }).authProvider
      // No provider is the silent first attempt; a provider before the exchange is the
      // still-unauthorized retry. Both 401. Only a provider carrying the exchanged code connects.
      if (!authProvider || hoisted.finishAuthCalls.length === 0) throw Object.assign(new Error('needs login'), { code: 401 })
    }

    const harness = await setup({ user: { remote: { url: 'https://example.com/mcp' } }, confirm: async () => true })
    const started = harness.sessionStart()

    // The interactive login builds a transport carrying the real provider; its redirect url
    // reveals the loopback port the callback server actually bound.
    const providerTransport = (): TransportRecord | undefined => hoisted.transports.find((t) => t.options.authProvider !== undefined)
    await waitFor(() => providerTransport() !== undefined)
    const provider = providerTransport()?.options.authProvider as { redirectUrl: string; state: () => string }

    // Deliver the code to the real listener, echoing the provider's state so the CSRF check
    // in waitForAuthCode passes; a wrong state would 400 and the login would hang.
    const port = new URL(provider.redirectUrl).port
    const redirect = await fetch(`http://127.0.0.1:${port}/callback?code=exchange-me&state=${provider.state()}`)
    expect(redirect.status).toBe(200)

    await started

    expect(hoisted.finishAuthCalls).toEqual(['exchange-me'])
    expect(harness.toolNames()).toEqual(['remote_go'])
    expect(await statusLinesOf(harness)).toEqual(['remote: connected (1 tools)'])
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
    // The outer race now uses the 4h wall budget (the idle timeout lives inside the SDK,
    // which is stubbed here), so a fully hung call rejects at the wall.
    const assertion = expect(pending).rejects.toThrow('sonar_qube_search_issues timed out after 14400000ms')
    await vi.advanceTimersByTimeAsync(14_400_000)
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

  it('accepts scientific-notation and digit-separator spellings of MCP_TOOL_TIMEOUT', async () => {
    // Claude's numeric env vars "accept scientific notation and digit-separator
    // spellings", reading 2e3 as 2000 and 64_000 as 64000.
    setEnv('MCP_TOOL_TIMEOUT', '64_000')
    hoisted.control.callTool = () => new Promise<CallResult>(() => {})
    const harness = await registerOne()
    vi.useFakeTimers()

    const pending = harness.tools[0].execute('call-1', {})
    const assertion = expect(pending).rejects.toThrow('timed out after 64000ms')
    await vi.advanceTimersByTimeAsync(64_000)
    await assertion
  })

  it('passes the two-tier timeout to the SDK so its shorter default cannot fire first', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerOne()

    await harness.tools[0].execute('call-1', {})

    // The SDK gets the idle window as its per-quiet-period deadline (reset on progress),
    // capped at the 4h wall; its own 60s default can no longer fire first. registerOne
    // is a stdio server, so the idle tier is Claude's 30-minute stdio window.
    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 1_800_000, resetTimeoutOnProgress: true, maxTotalTimeout: 14_400_000, onprogress: expect.any(Function) })
  })
})

describe('mcp tool-call idle timeout', () => {
  const registerGo = async (config: Record<string, unknown> = { command: 'x' }): Promise<Harness> => {
    withTools([{ name: 'go' }])
    return setupStarted({ user: { srv: config } })
  }

  it('gives a stdio server the 30-minute idle window under the 4h wall budget, resetting on progress', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo()

    await harness.tools[0].execute('c1', {})

    // Claude: the idle window "defaults to five minutes for HTTP, SSE, WebSocket...
    // and to 30 minutes for stdio servers". The idle window is the SDK's
    // per-quiet-period deadline, reset on every progress notification; maxTotalTimeout
    // caps the wall clock; onprogress is required so the server addresses progress
    // here and the SDK resets the timer on it.
    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 1_800_000, resetTimeoutOnProgress: true, maxTotalTimeout: 14_400_000, onprogress: expect.any(Function) })
  })

  it('gives a remote server the 5-minute idle window under the 4h wall budget', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo({ type: 'http', url: 'https://mcp.example.com/mcp' })

    await harness.tools[0].execute('c1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 300_000, resetTimeoutOnProgress: true, maxTotalTimeout: 14_400_000, onprogress: expect.any(Function) })
  })

  it('honors CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT for the idle window', async () => {
    setEnv('CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', '60000')
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo()

    await harness.tools[0].execute('c1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 14_400_000, onprogress: expect.any(Function) })
  })

  it('disables the idle window for CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0, leaving only the wall budget', async () => {
    setEnv('CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', '0')
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo()

    await harness.tools[0].execute('c1', {})

    // A plain wall-clock timeout, no progress machinery.
    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 14_400_000 })
  })

  it('collapses to a plain wall timeout when the per-server budget sits under the idle window', async () => {
    // A 10 min per-server budget under the 30 min stdio idle window: the idle window
    // can never fire before the wall, so only the wall budget applies.
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo({ command: 'x', timeout: 600_000 })

    await harness.tools[0].execute('c1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 600_000 })
  })

  it('floors an overridden idle window at a per-server timeout of at least 1000', async () => {
    // Claude: "A per-server timeout of at least 1000 also acts as a floor on the idle
    // timeout". The 60s override is lifted to the 10 min per-server budget, which
    // equals the wall, so only the wall budget applies.
    setEnv('CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', '60000')
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo({ type: 'http', url: 'https://mcp.example.com/mcp', timeout: 600_000 })

    await harness.tools[0].execute('c1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 600_000 })
  })

  it('ignores a per-server timeout below 1000, falling through to the MCP_TOOL_TIMEOUT wall', async () => {
    // Claude: per-server timeout "Values below 1000 are ignored and fall through to
    // MCP_TOOL_TIMEOUT", and such a value places no floor on the idle window.
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo({ command: 'x', timeout: 500 })

    await harness.tools[0].execute('c1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 1_800_000, resetTimeoutOnProgress: true, maxTotalTimeout: 14_400_000, onprogress: expect.any(Function) })
  })

  it('uses a plain wall timeout when a per-server budget is tighter than the idle window', async () => {
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const harness = await registerGo({ command: 'x', timeout: 2000 })

    await harness.tools[0].execute('c1', {})

    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 2000 })
  })

  it('rejects a fully hung call at the wall budget, not the idle window', async () => {
    // The stubbed SDK never enforces the idle timeout (that lives inside the real SDK), so
    // the outer race is what fires: it must use the wall budget so a legitimately
    // progressing call is never cut off at the idle window.
    const harness = await registerGo({ command: 'x', timeout: 600_000 })
    hoisted.control.callTool = () => new Promise<CallResult>(() => {})
    vi.useFakeTimers()

    const pending = harness.tools[0].execute('c1', {})
    const assertion = expect(pending).rejects.toThrow('srv_go timed out after 600000ms')
    await vi.advanceTimersByTimeAsync(600_000)
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

  it('times out a connect that never settles after the 30s default connect budget', async () => {
    // Claude's MCP_TIMEOUT default is 30 seconds.
    hoisted.control.connect = () => new Promise<void>(() => {})
    vi.useFakeTimers()

    const harness = await setup({ user: { hung: { command: 'sleep' } } })
    const booting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(30_000)
    await booting

    expect(await statusLinesOf(harness)).toEqual(['hung: failed: connect hung timed out after 30000ms (0 tools)'])
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

  it('accepts a scientific-notation MCP_TIMEOUT spelling, reading 2e3 as 2000', async () => {
    setEnv('MCP_TIMEOUT', '2e3')
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
    await vi.advanceTimersByTimeAsync(30_000)
    resolveConnect?.() // the server finishes connecting after the deadline
    await booting

    expect(hoisted.closed).toHaveLength(1)
  })

  it('times out a tool listing that never settles', async () => {
    hoisted.control.listTools = () => new Promise<ListPage>(() => {})
    vi.useFakeTimers()

    const harness = await setup({ user: { slow: { command: 'x' } } })
    const booting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(30_000)
    await booting

    expect(await statusLinesOf(harness)).toEqual(['slow: failed: list tools slow timed out after 30000ms (0 tools)'])
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

describe('mcp second in-process session', () => {
  it('reconnects the same server and reports its real tool count, not zero', async () => {
    // session_start -> session_shutdown -> session_start with the same server. The
    // shutdown must drop the closed client from the map (not rely on a deferred onclose),
    // so the second session reconnects; the banner and /mcp must count the tools from the
    // registered map (pi cannot unregister them) rather than registerTools' return, which
    // is 0 on a reconnect because they are already registered.
    withTools([{ name: 'go' }, { name: 'stop' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })
    const first = hoisted.clients.at(-1)
    expect(harness.notifications).toEqual([{ message: 'MCP: 2 tools from 1 servers', level: 'info' }])

    await harness.shutdown()
    await harness.sessionStart()
    const second = hoisted.clients.at(-1)
    // The closed client was replaced, not skipped as a lingering duplicate.
    expect(second).not.toBe(first)

    // The second banner counts the real tools, not zero.
    expect(harness.notifications.at(-1)).toEqual({ message: 'MCP: 2 tools from 1 servers', level: 'info' })
    // /mcp shows the server connected with its true tool count.
    expect(await statusLinesOf(harness)).toEqual(['srv: connected (2 tools)'])

    // The still-registered tool executes against the SECOND client instance.
    const calledOn: unknown[] = []
    hoisted.control.callTool = async (_args, client) => {
      calledOn.push(client)
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await harness.tools[0].execute('call-1', {})
    expect(calledOn).toEqual([second])
  })

  it('drops a server removed from the config from /mcp on the next session', async () => {
    // A server present in the first session but not the second must not linger in /mcp:
    // the status map is reset per session so it reflects only the current config.
    withTools([{ name: 'go' }])
    const harness = await setup({ user: { keep: { command: 'k' }, drop: { command: 'd' } } })
    await harness.sessionStart()
    expect((await statusLinesOf(harness)).sort()).toEqual(['drop: connected (1 tools)', 'keep: connected (1 tools)'])

    await harness.shutdown()
    writeServers(join(harness.home, '.claude.json'), { keep: { command: 'k' } })
    await harness.sessionStart()

    expect(await statusLinesOf(harness)).toEqual(['keep: connected (1 tools)'])
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
    // A per-server budget below the idle window is the plain wall-clock timeout.
    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 1500 })

    // Below Claude's documented 1s minimum the per-server value is ignored, so the call
    // falls back to the global default, whose SDK deadline is the idle window (the
    // 30-minute stdio tier) under the 4h wall.
    await harness.tools[1].execute('c2', {})
    expect(hoisted.callOptions.at(-1)).toEqual({ timeout: 1_800_000, resetTimeoutOnProgress: true, maxTotalTimeout: 14_400_000, onprogress: expect.any(Function) })
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

  it('routes a tool call to the reconnected client, not the closed one', async () => {
    // pi has no tool unregister, so after a drop-and-reconnect the tool stays registered
    // from the first connect; its execute must call the live client, not the closed one
    // captured at registration, or every call fails with "Not connected".
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { live: { command: 'ok' } } })
    const first = hoisted.clients.at(-1)
    ;(first as unknown as { onclose?: () => void }).onclose?.()

    withTools([{ name: 'go' }])
    await harness.sessionStart()
    const second = hoisted.clients.at(-1)
    expect(second).not.toBe(first)

    const calledOn: unknown[] = []
    hoisted.control.callTool = async (_args, client) => {
      calledOn.push(client)
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await harness.tools[0].execute('call-1', {})
    expect(calledOn).toEqual([second])
  })
})

describe('mcp prompts as slash commands', () => {
  const withPrompts = (prompts: PromptDef[]): void => {
    hoisted.control.getServerCapabilities = () => ({ prompts: {} })
    hoisted.control.listPrompts = async () => ({ prompts })
  }

  it('registers a /mcp__server__prompt command per advertised prompt, keeping the declared name', async () => {
    // Claude uses the prompt name as the server declares it, so the hyphen stays.
    withPrompts([{ name: 'code-review', description: 'Review code' }])
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    expect(harness.commandNames()).toContain('mcp__demo__code-review')
  })

  it('does not list prompts from a server that lacks the prompts capability', async () => {
    let listed = false
    hoisted.control.listPrompts = async () => {
      listed = true
      return { prompts: [] }
    }
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    expect(listed).toBe(false)
    expect(harness.commandNames()).toEqual(['mcp'])
  })

  it('registers every page of a paginated prompt list', async () => {
    hoisted.control.getServerCapabilities = () => ({ prompts: {} })
    hoisted.control.listPrompts = async ({ cursor }) => {
      if (!cursor) return { prompts: [{ name: 'one' }], nextCursor: 'page-2' }
      return { prompts: [{ name: 'two' }] }
    }
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    expect(harness.commandNames()).toEqual(expect.arrayContaining(['mcp__demo__one', 'mcp__demo__two']))
  })

  it('maps args onto the declared arguments and sends the prompt content as a user message', async () => {
    const calls: unknown[] = []
    withPrompts([{ name: 'greet', arguments: [{ name: 'who', required: true }] }])
    hoisted.control.getPrompt = async (args) => {
      calls.push(args)
      return {
        messages: [
          { role: 'user', content: { type: 'text', text: 'Hello Alex' } },
          { role: 'user', content: { type: 'text', text: 'Be nice' } },
        ],
      }
    }
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    await harness.runSlash('mcp__demo__greet', 'Alex')

    expect(calls).toEqual([{ name: 'greet', arguments: { who: 'Alex' } }])
    expect(harness.sent).toEqual([
      [
        { type: 'text', text: 'Hello Alex' },
        { type: 'text', text: 'Be nice' },
      ],
    ])
  })

  it('carries a prompt image block through to the user message', async () => {
    withPrompts([{ name: 'shot' }])
    hoisted.control.getPrompt = async () => ({
      messages: [
        { role: 'user', content: { type: 'text', text: 'see the screenshot' } },
        { role: 'user', content: { type: 'image', data: 'ZZZZ', mimeType: 'image/png' } },
      ],
    })
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    await harness.runSlash('mcp__demo__shot', '')

    expect(harness.sent).toEqual([
      [
        { type: 'text', text: 'see the screenshot' },
        { type: 'image', data: 'ZZZZ', mimeType: 'image/png' },
      ],
    ])
  })

  it('sends bare while idle but queues as a followUp while the agent is streaming', async () => {
    withPrompts([{ name: 'greet' }])
    hoisted.control.getPrompt = async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] })
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    await harness.runSlash('mcp__demo__greet', '')
    await harness.runSlash('mcp__demo__greet', '', false)

    expect(harness.sentOptions).toEqual([{}, { deliverAs: 'followUp' }])
  })

  it('reports instead of driving a turn when a prompt returns no content', async () => {
    withPrompts([{ name: 'empty' }])
    hoisted.control.getPrompt = async () => ({ messages: [] })
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    await harness.runSlash('mcp__demo__empty', '')

    expect(harness.sent).toEqual([])
    expect(harness.notifications.some((n) => n.message.includes('no content'))).toBe(true)
  })

  it('skips a second same-server prompt whose name normalizes onto one already taken', async () => {
    // Hyphens no longer fold, so the collision surface is whitespace (pi's dispatch
    // constraint): two prompts differing only by space vs underscore clash.
    withPrompts([{ name: 'deploy prod' }, { name: 'deploy_prod' }])
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    expect(harness.commandNames().filter((n) => n === 'mcp__demo__deploy_prod')).toEqual(['mcp__demo__deploy_prod'])
    expect(harness.warnings.some((w) => w.includes('skipping colliding prompt command mcp__demo__deploy_prod'))).toBe(true)
  })

  it('omits the arguments field when the prompt declares none', async () => {
    const calls: unknown[] = []
    withPrompts([{ name: 'plain' }])
    hoisted.control.getPrompt = async (args) => {
      calls.push(args)
      return { messages: [{ role: 'user', content: { type: 'text', text: 'ok' } }] }
    }
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    await harness.runSlash('mcp__demo__plain', '')

    expect(calls).toEqual([{ name: 'plain' }])
  })

  it('registers prompts announced later via prompts list_changed without duplicating existing ones', async () => {
    withPrompts([{ name: 'first' }])
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })
    expect(harness.commandNames()).toEqual(['mcp', 'mcp__demo__first'])

    hoisted.control.listPrompts = async () => ({ prompts: [{ name: 'first' }, { name: 'second' }] })
    await hoisted.notify.get('notifications/prompts/list_changed')?.()

    expect(harness.commandNames()).toEqual(['mcp', 'mcp__demo__first', 'mcp__demo__second'])
  })

  it('notifies at error level instead of sending when getPrompt fails', async () => {
    withPrompts([{ name: 'boom' }])
    hoisted.control.getPrompt = async () => {
      throw new Error('prompt exploded')
    }
    const harness = await setupStarted({ user: { demo: { command: 'x' } } })

    await harness.runSlash('mcp__demo__boom', '')

    expect(harness.sent).toEqual([])
    expect(harness.notifications.some((n) => n.level === 'error' && n.message.includes('prompt exploded'))).toBe(true)
  })
})

describe('mcp resource tools', () => {
  const withResourceCapability = (): void => {
    hoisted.control.getServerCapabilities = () => ({ resources: {} })
  }
  const resourceTool = (harness: Harness, name: string): RegisteredTool => {
    const tool = harness.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`${name} was not registered`)
    return tool
  }

  it('registers no resource tools when no connected server advertises resources', async () => {
    const harness = await setupStarted({ user: { plain: { command: 'x' } } })

    expect(harness.toolNames()).not.toContain('list_mcp_resources')
    expect(harness.toolNames()).not.toContain('read_mcp_resource')
  })

  it('registers the list and read tools exactly once across resource-capable servers', async () => {
    withResourceCapability()
    const harness = await setupStarted({ user: { one: { command: 'x' }, two: { command: 'y' } } })

    expect(harness.toolNames().filter((n) => n === 'list_mcp_resources')).toHaveLength(1)
    expect(harness.toolNames().filter((n) => n === 'read_mcp_resource')).toHaveLength(1)
  })

  it('lists resources and templates across servers, naming the server on each entry', async () => {
    withResourceCapability()
    hoisted.control.listResources = async (_args, client) => (client.transport?.options.command === 'x' ? { resources: [{ uri: 'db://a', name: 'A' }] } : { resources: [{ uri: 'db://b', name: 'B' }] })
    hoisted.control.listResourceTemplates = async (_args, client) => (client.transport?.options.command === 'x' ? { resourceTemplates: [{ uriTemplate: 'db://{id}', name: 'ById' }] } : { resourceTemplates: [] })
    const harness = await setupStarted({ user: { one: { command: 'x' }, two: { command: 'y' } } })

    const out = await resourceTool(harness, 'list_mcp_resources').execute('c1', {})

    const entries = JSON.parse(out.content[0].text ?? '') as Array<Record<string, unknown>>
    expect(entries).toContainEqual(expect.objectContaining({ server: 'one', uri: 'db://a' }))
    expect(entries).toContainEqual(expect.objectContaining({ server: 'two', uri: 'db://b' }))
    expect(entries).toContainEqual(expect.objectContaining({ server: 'one', uriTemplate: 'db://{id}' }))
  })

  it('filters the listing to the requested server and rejects an unknown one', async () => {
    withResourceCapability()
    hoisted.control.listResources = async (_args, client) => (client.transport?.options.command === 'x' ? { resources: [{ uri: 'db://a', name: 'A' }] } : { resources: [{ uri: 'db://b', name: 'B' }] })
    const harness = await setupStarted({ user: { one: { command: 'x' }, two: { command: 'y' } } })
    const tool = resourceTool(harness, 'list_mcp_resources')

    const out = await tool.execute('c1', { server: 'two' })
    const entries = JSON.parse(out.content[0].text ?? '') as Array<Record<string, unknown>>
    expect(entries).toEqual([expect.objectContaining({ server: 'two', uri: 'db://b' })])

    await expect(tool.execute('c2', { server: 'ghost' })).rejects.toThrow('not connected')
  })

  it('keeps the resource listing when a server does not support templates', async () => {
    withResourceCapability()
    hoisted.control.listResources = async () => ({ resources: [{ uri: 'db://a', name: 'A' }] })
    hoisted.control.listResourceTemplates = async () => {
      throw new Error('Method not found')
    }
    const harness = await setupStarted({ user: { one: { command: 'x' } } })

    const out = await resourceTool(harness, 'list_mcp_resources').execute('c1', {})

    const entries = JSON.parse(out.content[0].text ?? '') as Array<Record<string, unknown>>
    expect(entries).toEqual([expect.objectContaining({ server: 'one', uri: 'db://a' })])
    expect(entries.every((entry) => !('error' in entry))).toBe(true)
  })

  it('reads a resource and routes its text through the output budget', async () => {
    withResourceCapability()
    hoisted.control.readResource = async (args) => ({ contents: [{ uri: args.uri, text: 'y'.repeat(60_000), mimeType: 'text/plain' }] })
    const harness = await setupStarted({ user: { one: { command: 'x' } } })

    const out = await resourceTool(harness, 'read_mcp_resource').execute('c1', { server: 'one', uri: 'db://big' })

    expect(out.content[0].text).toContain('[Resource: db://big]')
    expect(out.content[0].text).toContain('[truncated')
  })

  it('maps an image blob to an image block and other blobs to a placeholder', async () => {
    withResourceCapability()
    hoisted.control.readResource = async () => ({
      contents: [
        { uri: 'img://shot', blob: 'AAAA', mimeType: 'image/png' },
        { uri: 'bin://blob', blob: 'BBBB', mimeType: 'application/octet-stream' },
      ],
    })
    const harness = await setupStarted({ user: { one: { command: 'x' } } })

    const out = await resourceTool(harness, 'read_mcp_resource').execute('c1', { server: 'one', uri: 'img://shot' })

    expect(out.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    expect(out.content[1].text).toContain('bin://blob')
    expect(out.content[1].text).not.toContain('BBBB')
  })

  it('rejects a read against a server that is not connected', async () => {
    withResourceCapability()
    const harness = await setupStarted({ user: { one: { command: 'x' } } })

    await expect(resourceTool(harness, 'read_mcp_resource').execute('c1', { server: 'ghost', uri: 'db://a' })).rejects.toThrow('not connected')
  })

  it('registers the tools from resources list_changed when the capability settled late', async () => {
    let capabilities: Record<string, unknown> | undefined
    hoisted.control.getServerCapabilities = () => capabilities
    const harness = await setupStarted({ user: { one: { command: 'x' } } })
    expect(harness.toolNames()).not.toContain('list_mcp_resources')

    capabilities = { resources: {} }
    await hoisted.notify.get('notifications/resources/list_changed')?.()

    expect(harness.toolNames()).toEqual(expect.arrayContaining(['list_mcp_resources', 'read_mcp_resource']))
  })

  it('reserves the resource tool names against a shadowing server tool', async () => {
    withTools([{ name: 'mcp-resource' }])
    const harness = await setupStarted({ user: { read: { command: 'x' } } })

    expect(harness.toolNames()).not.toContain('read_mcp_resource')
    expect(harness.warnings.join('\n')).toContain('read_mcp_resource')
  })
})

describe('managed-mcp.json exclusive control', () => {
  // managed-mcp.json lives beside managed-settings.json; point the extension at a throwaway
  // pair in a temp dir so managedMcpPath resolves the sibling from the managed settings path.
  const withManagedMcp = (mcp: unknown, settings: unknown = {}): void => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-managed-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify(settings))
    writeFileSync(join(dir, 'managed-mcp.json'), typeof mcp === 'string' ? mcp : JSON.stringify(mcp))
    setManagedSettingsPath(join(dir, 'managed-settings.json'))
  }
  const withoutManagedMcp = (settings: unknown = {}): void => {
    // Managed settings present, but no managed-mcp.json sibling: normal loading.
    const dir = mkdtempSync(join(tmpdir(), 'mcp-managed-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify(settings))
    setManagedSettingsPath(join(dir, 'managed-settings.json'))
  }
  afterEach(() => setManagedSettingsPath(undefined))

  it('loads only the managed servers, suppressing user and project scopes', async () => {
    withTools([{ name: 'go' }])
    withManagedMcp({ mcpServers: { managed: { command: 'm' } } })
    const harness = await setup({ user: { fromUser: { command: 'u' } }, project: { fromProject: { command: 'p' } } })

    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual(['managed_go'])
    expect(hoisted.transports.map((t) => t.options.command)).toEqual(['m'])
  })

  it('disables MCP entirely for an empty managed map', async () => {
    withTools([{ name: 'go' }])
    withManagedMcp({ mcpServers: {} })
    const harness = await setup({ user: { fromUser: { command: 'u' } } })

    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual([])
    expect(hoisted.transports).toEqual([])
  })

  it('still filters the managed set through the managed allow/deny lists', async () => {
    withTools([{ name: 'go' }])
    withManagedMcp({ mcpServers: { keep: { command: 'k' }, drop: { command: 'd' } } }, { deniedMcpServers: [{ serverName: 'drop' }] })
    const harness = await setup()

    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual(['keep_go'])
  })

  it('leaves normal loading untouched when no managed-mcp.json is present', async () => {
    withTools([{ name: 'go' }])
    withoutManagedMcp()
    const harness = await setup({ user: { fromUser: { command: 'u' } } })

    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual(['fromUser_go'])
  })

  it('fails closed (deny-all) when a present managed-mcp.json is invalid JSON', async () => {
    // Deliberately the opposite of the old regression guard, which failed OPEN: a
    // corrupt policy file used to reopen the user/project/plugin scopes. Under the
    // lockdown intent a deployed-but-unparseable managed-mcp.json is a deny-all, exactly
    // like an empty map, so a truncated write cannot silently allow every server.
    withTools([{ name: 'go' }])
    withManagedMcp('{not json')
    const harness = await setup({ user: { fromUser: { command: 'u' } } })

    await harness.sessionStart(true)

    expect(harness.toolNames()).toEqual([])
    expect(hoisted.transports).toEqual([])
    expect(harness.warnings.join('\n')).toMatch(/managed-mcp\.json.*not valid JSON/)
  })

  it('evicts an already-connected non-managed server when a policy is deployed mid-process', async () => {
    // A user server connects on the first session with no managed policy present. A later
    // managed-mcp.json takes exclusive control, so re-firing session_start must close the
    // surviving user client and leave only the managed set connected, not let it linger.
    withTools([{ name: 'go' }])
    const harness = await setup({ user: { fromUser: { command: 'u' } } })

    withoutManagedMcp()
    await harness.sessionStart(true)
    const userClient = hoisted.clients.find((c) => c.transport?.options?.command === 'u')
    expect(userClient).toBeDefined()
    expect(hoisted.closed).not.toContain(userClient)

    withManagedMcp({ mcpServers: { managed: { command: 'm' } } })
    await harness.sessionStart(true)

    // The user client was closed; only the managed server remains connected.
    expect(hoisted.closed).toContain(userClient)
    const lines = await statusLinesOf(harness)
    expect(lines).toContain('fromUser: disabled by managed policy (0 tools)')
    expect(lines.some((l) => l.startsWith('managed: connected'))).toBe(true)
    expect(hoisted.transports.map((t) => t.options.command)).toEqual(['u', 'm'])
  })

  it('gives up on a hung eviction close after the timeout instead of stalling session start', async () => {
    // The evicted user client's close() hangs. Without a per-close deadline the eviction
    // loop would await it forever and the managed servers would never connect, so the new
    // session start must proceed once the close budget elapses, exactly like shutdown.
    hoisted.control.close = async (client) => {
      if (client.transport?.options.command === 'u') return new Promise<void>(() => {})
    }
    withTools([{ name: 'go' }])
    const harness = await setup({ user: { fromUser: { command: 'u' } } })

    withoutManagedMcp()
    await harness.sessionStart(true)

    withManagedMcp({ mcpServers: { managed: { command: 'm' } } })
    vi.useFakeTimers()
    const starting = harness.sessionStart(true)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(starting).resolves.toBeUndefined()
    // The managed server still connected despite the hung eviction close.
    expect(hoisted.transports.map((t) => t.options.command)).toEqual(['u', 'm'])
  })
})

describe('mcp stdio session context', () => {
  it('sets CLAUDE_PROJECT_DIR in a stdio server environment, as Claude documents', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' }, plugged: { command: 'y', pluginRoot: '/plug/root' } } })

    // The harness cwd has no repo markers, so the project root falls back to cwd.
    const env = hoisted.transports[0].options.env as Record<string, string>
    expect(env.CLAUDE_PROJECT_DIR).toBe(harness.cwd)
    // Claude sets CLAUDECODE=1 in stdio MCP server subprocesses; the long-lived
    // server never gets CLAUDE_CODE_CHILD_SESSION, which marks per-call children.
    expect(env.CLAUDECODE).toBe('1')
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    // A plugin-provided stdio server also gets CLAUDE_PLUGIN_ROOT, which Claude
    // exports to MCP server subprocesses.
    const pluggedEnv = hoisted.transports[1].options.env as Record<string, string>
    expect(pluggedEnv.CLAUDE_PLUGIN_ROOT).toBe('/plug/root')
  })

  it('declares the roots capability and answers roots/list with the session launch directory', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })

    // Claude Code answers roots/list with the session's launch directory (pi has no
    // additional working directories, so the set is static and never changes).
    expect(hoisted.clientOptions[0]).toMatchObject({ capabilities: { roots: {} } })
    const handler = hoisted.requests.get('roots/list')
    expect(handler).toBeDefined()
    const result = handler?.({ method: 'roots/list' }) as { roots: Array<{ uri: string }> }
    expect(result.roots).toHaveLength(1)
    expect(result.roots[0].uri).toBe(pathToFileURL(harness.cwd).href)
  })
})

describe('mcp headersHelper environment', () => {
  it('passes the server name and a credential-redacted url to the helper', async () => {
    // Claude sets CLAUDE_CODE_MCP_SERVER_NAME and CLAUDE_CODE_MCP_SERVER_URL when
    // executing the helper; a url part expanded from a credential-named variable
    // reaches the helper as REDACTED while the transport gets the real value.
    setEnv('TEST_HELPER_KEY', 'sekret')
    withTools([{ name: 'go' }])
    const helper = `echo "{\\"X-N\\":\\"$CLAUDE_CODE_MCP_SERVER_NAME\\",\\"X-U\\":\\"$CLAUDE_CODE_MCP_SERVER_URL\\"}"`
    await setupStarted({ user: { srv: { type: 'http', url: 'https://api.example/${TEST_HELPER_KEY}/mcp', headersHelper: helper } } })

    const headers = (hoisted.transports[0].options as { requestInit: { headers: Record<string, string> } }).requestInit.headers
    expect(headers['X-N']).toBe('srv')
    expect(headers['X-U']).toBe('https://api.example/REDACTED/mcp')
    expect(String(hoisted.transports[0].url)).toBe('https://api.example/sekret/mcp')
  })

  // Off Windows only: a real Windows host resolves its Git install ahead of the PATH shim,
  // and there the un-skipped helper tests above run through the real Git Bash.
  it.skipIf(process.platform === 'win32')('runs the helper through Git Bash on Windows', async () => {
    // A Git for Windows layout on PATH whose bash.exe is a shim: on this host it marks
    // the environment and hands the command to /bin/sh, so the header says which shell ran.
    const root = mkdtempSync(join(tmpdir(), 'mcp-gitbash-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'cmd'), { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'cmd', 'git.exe'), 'MZ')
    writeFileSync(join(root, 'bin', 'bash.exe'), '#!/bin/sh\nPI_CODE_TEST_SHELL=git-bash exec /bin/sh "$@"\n', { mode: 0o755 })
    setEnv('PATH', `${join(root, 'cmd')}:${process.env.PATH ?? ''}`)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      withTools([{ name: 'go' }])
      await setupStarted({ user: { srv: { type: 'http', url: 'https://api.example/mcp', headersHelper: 'echo "{\\"X-Shell\\":\\"${PI_CODE_TEST_SHELL-sh}\\"}"' } } })
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }

    const headers = (hoisted.transports[0].options as { requestInit: { headers: Record<string, string> } }).requestInit.headers
    expect(headers['X-Shell']).toBe('git-bash')
  })

  it('strips credential-named variables from a project server helper environment', async () => {
    // A helper a repository supplies runs without credential variables such as
    // ANTHROPIC_API_KEY: any name with TOKEN/SECRET/PASSWORD/KEY/AUTH in it.
    setEnv('MY_PROJ_TOKEN', 'leak')
    withTools([{ name: 'go' }])
    const helper = `echo "{\\"X-T\\":\\"\${MY_PROJ_TOKEN-absent}\\"}"`
    const harness = await setup({ project: { proj: { type: 'http', url: 'https://api.example/mcp', headersHelper: helper } } })
    mkdirSync(join(harness.home, '.claude'), { recursive: true })
    writeFileSync(join(harness.home, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['proj'] }))
    await harness.sessionStart(true)

    const headers = (hoisted.transports[0].options as { requestInit: { headers: Record<string, string> } }).requestInit.headers
    expect(headers['X-T']).toBe('absent')
  })

  it('keeps credential variables for a user-scope helper, which the user wrote', async () => {
    setEnv('MY_USER_TOKEN', 'mine')
    withTools([{ name: 'go' }])
    const helper = `echo "{\\"X-T\\":\\"\${MY_USER_TOKEN-absent}\\"}"`
    await setupStarted({ user: { srv: { type: 'http', url: 'https://api.example/mcp', headersHelper: helper } } })

    const headers = (hoisted.transports[0].options as { requestInit: { headers: Record<string, string> } }).requestInit.headers
    expect(headers['X-T']).toBe('mine')
  })

  it('gives a plugin server helper CLAUDE_PLUGIN_ROOT and the credential stripping', async () => {
    setEnv('MY_PLUGIN_TOKEN', 'leak')
    withTools([{ name: 'go' }])
    const helper = `echo "{\\"X-R\\":\\"$CLAUDE_PLUGIN_ROOT\\",\\"X-T\\":\\"\${MY_PLUGIN_TOKEN-absent}\\"}"`
    await setupStarted({ user: { srv: { type: 'http', url: 'https://api.example/mcp', headersHelper: helper, pluginRoot: '/plug/root' } } })

    const headers = (hoisted.transports[0].options as { requestInit: { headers: Record<string, string> } }).requestInit.headers
    expect(headers['X-R']).toBe('/plug/root')
    expect(headers['X-T']).toBe('absent')
  })
})

describe('mcp configured authorization', () => {
  it('fails a 401 server with a static Authorization header instead of starting OAuth', async () => {
    // Claude: for a server whose Authorization header you configured, a 401 or 403
    // while connecting reports the connection as failed; the credential to fix is
    // the configured one, so there is no OAuth fallback.
    withTools([{ name: 'go' }])
    hoisted.control.connect = async () => {
      throw Object.assign(new Error('denied'), { code: 401 })
    }
    let confirms = 0
    const harness = await setup({
      user: { locked: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer abc' } } },
      confirm: async () => {
        confirms++
        return true
      },
    })
    await harness.sessionStart()

    expect(confirms).toBe(0)
    const [line] = await statusLinesOf(harness)
    expect(line.startsWith('locked: failed: ')).toBe(true)
  })

  it('fails a 401 server whose helper supplied Authorization instead of starting OAuth', async () => {
    withTools([{ name: 'go' }])
    hoisted.control.connect = async () => {
      throw Object.assign(new Error('denied'), { code: 401 })
    }
    let confirms = 0
    const helper = `echo "{\\"Authorization\\":\\"Bearer xyz\\"}"`
    const harness = await setup({
      user: { locked: { type: 'http', url: 'https://api.example/mcp', headersHelper: helper } },
      confirm: async () => {
        confirms++
        return true
      },
    })
    await harness.sessionStart()

    expect(confirms).toBe(0)
    const [line] = await statusLinesOf(harness)
    expect(line.startsWith('locked: failed: ')).toBe(true)
  })
})

describe('mcp automatic reconnection', () => {
  const dropLastClient = (): void => {
    const client = hoisted.clients.at(-1) as { onclose?: () => void }
    client.onclose?.()
  }

  it('reconnects a dropped remote server after a one-second backoff', async () => {
    // Claude reconnects a remote server that drops mid-session with exponential
    // backoff, starting at one second.
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { remote: { type: 'http', url: 'https://api.example/mcp' } } })
    const before = hoisted.transports.length
    vi.useFakeTimers()

    dropLastClient()
    expect((await statusLinesOf(harness))[0]).toContain('disconnected')
    await vi.advanceTimersByTimeAsync(1000)

    expect(hoisted.transports.length).toBeGreaterThan(before)
    expect((await statusLinesOf(harness))[0]).toContain('remote: connected')
  })

  it('doubles the delay each attempt and gives up after five failed reconnects', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { remote: { type: 'http', url: 'https://api.example/mcp' } } })
    const before = hoisted.transports.length
    hoisted.control.connect = async () => {
      throw new Error('still down')
    }
    vi.useFakeTimers()

    dropLastClient()
    // Delays 1+2+4+8+16 = 31s cover all five attempts.
    await vi.advanceTimersByTimeAsync(31_000)
    const afterFive = hoisted.transports.length
    expect(afterFive - before).toBe(5)

    // No sixth attempt, and the server reports failed.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hoisted.transports.length).toBe(afterFive)
    expect((await statusLinesOf(harness))[0]).toContain('remote: failed')
  })

  it('does not reconnect a dropped stdio server, which is a local process', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { local: { command: 'x' } } })
    const before = hoisted.transports.length
    vi.useFakeTimers()

    dropLastClient()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(hoisted.transports.length).toBe(before)
    expect((await statusLinesOf(harness))[0]).toContain('disconnected')
  })

  it('retries a transient first connect of a remote server, but not an auth error', async () => {
    // Claude retries an HTTP/SSE first connection after a transient error (5xx,
    // connection refused, timeout), up to three times.
    withTools([{ name: 'go' }])
    let attempts = 0
    hoisted.control.connect = async () => {
      attempts++
      if (attempts === 1) throw Object.assign(new Error('bad gateway'), { code: 502 })
    }
    vi.useFakeTimers()
    const harness = await setup({ user: { flaky: { type: 'http', url: 'https://api.example/mcp' } } })
    const starting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(1000)
    await starting

    expect(attempts).toBe(2)
    expect((await statusLinesOf(harness))[0]).toContain('flaky: connected')
  })

  it('gives up a transient first connect after three retries', async () => {
    withTools([{ name: 'go' }])
    let attempts = 0
    hoisted.control.connect = async () => {
      attempts++
      throw Object.assign(new Error('bad gateway'), { code: 502 })
    }
    vi.useFakeTimers()
    const harness = await setup({ user: { down: { type: 'http', url: 'https://api.example/mcp' } } })
    const starting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(31_000)
    await starting

    expect(attempts).toBe(4)
    expect((await statusLinesOf(harness))[0]).toContain('down: failed')
  })

  it('does not retry a not-found first connect or a stdio spawn failure', async () => {
    withTools([{ name: 'go' }])
    let attempts = 0
    hoisted.control.connect = async () => {
      attempts++
      throw Object.assign(new Error('no such endpoint'), { code: 404 })
    }
    vi.useFakeTimers()
    const harness = await setup({ user: { gone: { type: 'http', url: 'https://api.example/mcp' }, broken: { command: 'x' } } })
    const starting = harness.sessionStart()
    await vi.advanceTimersByTimeAsync(31_000)
    await starting

    expect(attempts).toBe(2) // one per server, no retries
  })
})

describe('mcp tool-call auth retry', () => {
  it('reconnects and retries a tool call once after a 401, picking up fresh headers', async () => {
    // Claude: on a 401/403 tool result, re-run the helper, reconnect, retry once.
    withTools([{ name: 'go' }])
    let calls = 0
    hoisted.control.callTool = async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('expired'), { code: 401 })
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    const harness = await setupStarted({ user: { srv: { type: 'http', url: 'https://api.example/mcp' } } })
    const before = hoisted.transports.length

    const result = await harness.tools[0].execute('c1', {})

    expect(calls).toBe(2)
    expect(hoisted.transports.length).toBeGreaterThan(before)
    expect((result.content[0] as { text: string }).text).toBe('ok')
  })

  it('retries the call only once: a second 401 surfaces as the error', async () => {
    withTools([{ name: 'go' }])
    let calls = 0
    hoisted.control.callTool = async () => {
      calls++
      throw Object.assign(new Error('expired'), { code: 401 })
    }
    const harness = await setupStarted({ user: { srv: { type: 'http', url: 'https://api.example/mcp' } } })

    await expect(harness.tools[0].execute('c1', {})).rejects.toThrow('expired')
    expect(calls).toBe(2)
  })
})

describe('mcp resource mentions', () => {
  it('inlines an @server:uri resource mention into the prompt', async () => {
    // Claude: MCP resources are referenced with @ mentions and fetched into the
    // conversation when referenced.
    withTools([{ name: 'go' }])
    hoisted.control.readResource = async (args) => ({ contents: [{ uri: args.uri, text: 'RESOURCE BODY' }] })
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })

    const result = (await harness.input('analyze @srv:file:///spec.md please')) as { action: string; text: string } | undefined
    expect(result?.action).toBe('transform')
    expect(result?.text).toContain('analyze @srv:file:///spec.md please')
    expect(result?.text).toContain('RESOURCE BODY')
  })

  it('leaves a mention for an unconnected server untouched', async () => {
    withTools([{ name: 'go' }])
    const harness = await setupStarted({ user: { srv: { command: 'x' } } })

    expect(await harness.input('email me @nosuch:thing please')).toBeUndefined()
  })
})

describe('the registered mcp_tool caller (cross-extension joint)', () => {
  // Both halves of the seam were green against stubs while the real registered
  // callback had zero executions; these pin the joint with only the SDK client faked.
  it('serves callMcpTool through the real callback: config lookup, text mapping, isError', async () => {
    const { callMcpTool } = await import('../extensions/internal/mcp-call.ts')
    const calls: Array<Record<string, unknown>> = []
    await setupStarted({ user: { db: { command: 'db-server' } } })
    hoisted.control.callTool = async (params: Record<string, unknown>) => {
      calls.push(params)
      return {
        content: [
          { type: 'text', text: 'row 1' },
          { type: 'text', text: 'row 2' },
        ],
      }
    }

    await expect(callMcpTool('db', 'query', { sql: 'select 1' })).resolves.toEqual({ text: 'row 1\nrow 2', isError: false })
    expect(calls[0]).toMatchObject({ name: 'query', arguments: { sql: 'select 1' } })
  })

  it('maps a server-reported tool error to isError true', async () => {
    const { callMcpTool } = await import('../extensions/internal/mcp-call.ts')
    await setupStarted({ user: { db: { command: 'db-server' } } })
    hoisted.control.callTool = async () => ({ content: [{ type: 'text', text: 'no such table' }], isError: true })

    await expect(callMcpTool('db', 'query', {})).resolves.toEqual({ text: 'no such table', isError: true })
  })

  it('rejects for a server name that is not connected', async () => {
    const { callMcpTool } = await import('../extensions/internal/mcp-call.ts')
    await setupStarted({ user: { db: { command: 'db-server' } } })

    await expect(callMcpTool('nosuch', 'query', {})).rejects.toThrow('not connected')
  })
})
