import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import mcpExtension from '../extensions/mcp/index.ts'

// The real SDK on both ends, no mocks: the fake client of mcp-more.test.ts cannot say what
// the SDK actually throws when an HTTP server disappears, and that is what the reconnect
// keys on.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

interface Tool {
  name: string
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>
}

/** A stateful Streamable HTTP server: sessions live in this process, so starting a new one on
 * the same port forgets them all, as a restarted or redeployed server does. */
async function startServer(port: number): Promise<Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const sessionId = request.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (!transport) {
      if (sessionId) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
        return
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport as StreamableHTTPServerTransport)
        },
      })
      const mcp = new McpServer({ name: 'probe', version: '1.0.0' })
      mcp.tool('ping', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
      await mcp.connect(transport)
    }
    await transport.handleRequest(request, response, body)
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

const stop = async (server: Server): Promise<void> => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

const dirs: string[] = []
let savedAgentDir: string | undefined
let server: Server | undefined
let shutdown: (() => Promise<void>) | undefined

beforeEach(() => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'mcp-real-agent-'))
})
afterEach(async () => {
  await shutdown?.()
  if (server) await stop(server)
  shutdown = undefined
  server = undefined
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function session(url: string): Promise<{ tool: Tool; status: () => Promise<string> }> {
  const home = mkdtempSync(join(tmpdir(), 'mcp-real-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-real-proj-'))
  dirs.push(home, cwd)
  hoisted.home = home
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url } } }))

  const tools: Tool[] = []
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  const notes: string[] = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await mcpExtension({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, fn),
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
    registerTool: (tool: Tool) => tools.push(tool),
    sendUserMessage: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as never)
  const ctx = {
    cwd,
    hasUI: false,
    ui: { notify: (message: string) => notes.push(message), confirm: async () => false },
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => 'sess-real' },
  }
  await handlers.get('session_start')?.({ reason: 'startup' }, ctx)
  shutdown = async () => {
    await handlers.get('session_shutdown')?.({}, ctx)
  }
  const tool = tools.find((one) => one.name.endsWith('ping'))
  if (!tool) throw new Error('the ping tool was not registered')
  return {
    tool,
    status: async () => {
      const before = notes.length
      await commands.get('mcp')?.handler('', ctx)
      return notes[before] ?? ''
    },
  }
}

describe('a real HTTP server that restarts mid-session', () => {
  it('is reported disconnected once a call finds it gone, then serves calls again on a new session', async () => {
    server = await startServer(0)
    const port = (server.address() as { port: number }).port
    const { tool, status } = await session(`http://127.0.0.1:${port}/mcp`)
    expect((await tool.execute('1', {})).content[0]?.text).toBe('pong')

    await stop(server)
    server = await startServer(port)

    // The restarted server answers the old session id with 404; the SDK never calls
    // onclose for that, so before the reconnect keyed on the call, this stayed "connected".
    await expect(tool.execute('2', {})).rejects.toThrow()
    expect(await status()).toContain('remote: disconnected')

    // Claude's backoff starts at one second.
    await vi.waitFor(async () => expect(await status()).toContain('remote: connected'), { timeout: 8000, interval: 200 })
    expect((await tool.execute('3', {})).content[0]?.text).toBe('pong')
  })
})
