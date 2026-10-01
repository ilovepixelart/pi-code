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

  it('the --settings flags reach the chain from the extension that registered them', async () => {
    type Seam = typeof import('../extensions/internal/cli-settings.ts')
    const [registrar, consumer] = await twoGraphs<Seam>('../extensions/internal/cli-settings.ts')
    const resolved = { settingsFile: '/copy/settings.json', sources: new Set(['user'] as const), forwardArgs: [], errors: [] }
    registrar.setCliSettingsReader(() => resolved)
    try {
      expect(consumer.cliSettings()).toBe(resolved)
    } finally {
      registrar.setCliSettingsReader(undefined)
    }
  })

  it('the --add-dir value reaches the status line from context-imports, which owns the flag', async () => {
    type Seam = typeof import('../extensions/internal/add-dir-flag.ts')
    const [registrar, consumer] = await twoGraphs<Seam>('../extensions/internal/add-dir-flag.ts')
    registrar.setAddDirReader(() => '/work/api')
    try {
      expect(consumer.addDirFlagValue()).toBe('/work/api')
    } finally {
      registrar.setAddDirReader(undefined)
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

// pi added `agent_settled` in 0.80.4, which was never published; 0.80.5 is the first
// release with it (its CHANGELOG: "Added extension and RPC
// agent_settled events plus session-level idle waiting for fully settled agent runs").
// Several extensions rely on it unconditionally, so on an older runtime it simply never
// arrives and the work it gates never happens: a command's tool restrictions and an
// ultrathink escalation are never lifted, and the "Ready for input" notification never
// fires. Unlike the `ctx.isProjectTrusted` floor, which a runtime feature check guards
// (internal/project-approval.ts), this one cannot be feature-detected: registering a
// handler for an event that never fires looks identical to one that has not fired yet.
// pi installs packages with peer resolution disabled (--omit=peer, --legacy-peer-deps), so a
// peerDependencies range cannot enforce it either. The README's stated floor is therefore the
// only guard, so it is pinned here with its reason.
describe('the documented pi version floor', () => {
  const AGENT_SETTLED_SINCE = [0, 80, 4]

  const parseMinimum = (readme: string): number[] => {
    const match = /pi `>=\s*(\d+)\.(\d+)\.(\d+)`/.exec(readme)
    if (!match) throw new Error('README states no pi `>=x.y.z` floor this test can read')
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }

  const atLeast = (declared: number[], required: number[]): boolean => {
    for (let i = 0; i < required.length; i++) {
      if ((declared[i] ?? 0) !== required[i]) return (declared[i] ?? 0) > required[i]
    }
    return true
  }

  it('covers every runtime feature the extensions use unconditionally', () => {
    const readme = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'README.md'), 'utf-8')

    expect(atLeast(parseMinimum(readme), AGENT_SETTLED_SINCE)).toBe(true)
  })

  it('still has extensions depending on agent_settled, the reason for that floor', () => {
    // If this ever finds none, the floor above may be loosened deliberately; until then
    // the pin has a live reason rather than being folklore.
    const users = fs
      .readdirSync(extensionsDir, { recursive: true, encoding: 'utf-8' })
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => fs.readFileSync(path.join(extensionsDir, entry), 'utf-8').includes("pi.on('agent_settled'"))

    expect(users.length).toBeGreaterThan(0)
  })
})

// pi's resource loader (HOST_PROVIDED_EXTENSION_PACKAGES in core/resource-loader.js) warns on
// every start when a package lists one of these in `dependencies`: an installed copy bypasses the
// loader's redirect to the host module and can create a duplicate runtime. pi's docs/packages.md
// asks for them in peerDependencies with a "*" range instead.
describe('host-provided packages', () => {
  const HOST_PROVIDED = ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@mariozechner/pi-agent-core', '@mariozechner/pi-ai', '@mariozechner/pi-coding-agent', '@mariozechner/pi-tui', '@sinclair/typebox', 'typebox']

  it('are peers with a "*" range, never runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    expect(Object.keys(pkg.dependencies).filter((name) => HOST_PROVIDED.includes(name))).toEqual([])
    expect(Object.entries(pkg.peerDependencies).filter(([name, range]) => !HOST_PROVIDED.includes(name) || range !== '*')).toEqual([])
  })
})

// context-imports reads the rule files claude-rules adds to the prompt options in the same
// before_agent_start, so claude-rules has to load first. pi loads a package directory in
// readdir order (pi dist/core/package-manager collectAutoExtensionEntries), which APFS
// sorts and ext4 does not, so the manifest names claude-rules ahead of the directory.
describe('pi load order', () => {
  const repo = path.resolve(import.meta.dirname, '..')

  it('names claude-rules ahead of the extensions directory in the package manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf-8')) as { pi: { extensions: string[] } }
    expect(manifest.pi.extensions.indexOf('./extensions/claude-rules.ts')).toBeGreaterThanOrEqual(0)
    expect(manifest.pi.extensions.indexOf('./extensions/claude-rules.ts')).toBeLessThan(manifest.pi.extensions.indexOf('./extensions'))
  })

  it("loads every extension once through pi's own resolver, claude-rules before context-imports", async () => {
    const { DefaultPackageManager, SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-agent-'))
    const manager = new DefaultPackageManager({ cwd: repo, agentDir, settingsManager: SettingsManager.inMemory() })
    const resolved = await manager.resolveExtensionSources([repo], { temporary: true })
    const loaded = resolved.extensions.filter((entry) => entry.enabled).map((entry) => path.relative(repo, entry.path))
    expect(new Set(loaded).size).toBe(loaded.length)
    expect(loaded.indexOf(path.join('extensions', 'claude-rules.ts'))).toBeLessThan(loaded.indexOf(path.join('extensions', 'context-imports.ts')))
    expect(loaded.length).toBe(scannedEntries().length)
  })
})
