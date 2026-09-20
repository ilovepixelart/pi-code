import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { type CreateAgentSessionRuntimeFactory, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, type ExtensionContext, SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

// pi's loader treats every extensions/*.ts, extensions/*.js (symlinked or not) and
// extensions/*/index.ts|index.js as an entry point and refuses to start when one does
// not default-export a factory (pi dist/core/extensions/loader). Shared helper modules
// must live in a subdirectory that has no index file, where the loader does not look.
const extensionsDir = path.resolve(import.meta.dirname, '..', 'extensions')

const isEntryName = (name: string): boolean => name.endsWith('.ts') || name.endsWith('.js')

function scannedEntries(): [string, string][] {
  const entries: [string, string][] = []
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && isEntryName(entry.name)) {
      entries.push([entry.name, path.join(extensionsDir, entry.name)])
    }
    if (entry.isDirectory()) {
      for (const index of ['index.ts', 'index.js']) {
        const indexPath = path.join(extensionsDir, entry.name, index)
        if (fs.existsSync(indexPath)) entries.push([path.join(entry.name, index), indexPath])
      }
    }
  }
  return entries
}

describe('pi extension loader contract', () => {
  it.each(scannedEntries())('%s default-exports a factory function', async (_name, file) => {
    const mod = await import(file)
    expect(typeof mod.default).toBe('function')
  })
})

// pi loads every extension entry through its own module graph (pi dist/core/extensions/loader
// builds one jiti instance per entry with moduleCache off), so an `internal/` module imported
// by two extensions is evaluated twice and a module-level `let` is a different variable in
// each. A seam where one extension registers a function and another calls it has to meet
// somewhere both graphs share. Two imports around resetModules model the two graphs.
describe('cross-extension seams meet across module graphs', () => {
  const twoGraphs = async <T>(file: string): Promise<[T, T]> => {
    const first = (await import(file)) as T
    vi.resetModules()
    return [first, (await import(file)) as T]
  }

  it('an agent hook reaches the runner the subagent extension registered', async () => {
    type Seam = typeof import('../extensions/internal/agent-run.ts')
    const [registrar, consumer] = await twoGraphs<Seam>('../extensions/internal/agent-run.ts')
    registrar.setAgentRunner(async (request) => `ran: ${request.prompt}`)
    try {
      await expect(consumer.runAgent({ prompt: 'verify' })).resolves.toBe('ran: verify')
    } finally {
      registrar.setAgentRunner(undefined)
    }
  })

  it('an mcp_tool hook reaches the caller the mcp extension registered', async () => {
    type Seam = typeof import('../extensions/internal/mcp-call.ts')
    const [registrar, consumer] = await twoGraphs<Seam>('../extensions/internal/mcp-call.ts')
    registrar.setMcpToolCaller(async (server, tool) => ({ text: `${server}/${tool}`, isError: false }))
    try {
      await expect(consumer.callMcpTool('github', 'search', {})).resolves.toMatchObject({ text: 'github/search' })
    } finally {
      registrar.setMcpToolCaller(undefined)
    }
  })

  it('a subagent spawn reaches the SubagentStart runner the hooks extension registered', async () => {
    type Seam = typeof import('../extensions/internal/subagent-hooks.ts')
    const [registrar, consumer] = await twoGraphs<Seam>('../extensions/internal/subagent-hooks.ts')
    registrar.setSubagentStartHookRunner(async (agentType) => [`context for ${agentType}`])
    try {
      await expect(consumer.runSubagentStartHooks('explore', 'id-1')).resolves.toEqual(['context for explore'])
    } finally {
      registrar.setSubagentStartHookRunner(undefined)
    }
  })
})

// The settings watchers in hooks, status-line and env-settings outlive the handler that
// arms them, so their cleanup rests on what pi does on /new, /resume, /fork and /reload
// (pi dist/core/agent-session-runtime teardownCurrent, then the host's createRuntime).
// Pinned against the real runtime: a pi upgrade that changes any of it has to fail here,
// not as an uncaughtException in a user's terminal.
describe('pi session replacement contract', () => {
  it('runs session_shutdown on a live ctx, then invalidates it and hands the next session a fresh instance', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contract-cwd-')))
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-agent-'))
    const instances: Array<{ ctx?: ExtensionContext; liveAtShutdown?: boolean }> = []
    const reads = (ctx: ExtensionContext | undefined): boolean => {
      try {
        return typeof ctx?.cwd === 'string'
      } catch {
        return false
      }
    }
    // Services are rebuilt per replacement, as pi's CLI does (pi dist/main createRuntime).
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          noExtensions: true,
          extensionFactories: [
            (pi) => {
              const instance: (typeof instances)[number] = {}
              instances.push(instance)
              pi.on('session_start', async (_event, ctx) => {
                instance.ctx = ctx
              })
              pi.on('session_shutdown', async () => {
                instance.liveAtShutdown = reads(instance.ctx)
              })
            },
          ],
        },
      })
      return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services, diagnostics: services.diagnostics }
    }

    const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) })
    await runtime.session.bindExtensions({})
    await runtime.newSession()
    await runtime.session.bindExtensions({})

    try {
      expect(instances).toHaveLength(2)
      expect(instances[0].liveAtShutdown).toBe(true)
      expect(() => instances[0].ctx?.cwd).toThrow(/stale/)
      expect(reads(instances[1].ctx)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
