import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import permissionGate from '../extensions/permission-gate.ts'

type Handler = (event: any, ctx: any) => Promise<{ block: boolean; reason: string } | undefined>

describe('permission gate (non-interactive: ask fails closed)', () => {
  const handlers = new Map<string, Handler>()
  let ctx: any

  const bash = (command: string) => handlers.get('tool_call')?.({ toolName: 'bash', input: { command } }, ctx)

  beforeAll(async () => {
    const pi = {
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      registerCommand: () => {},
    }
    permissionGate(pi as any)

    const cwd = mkdtempSync(join(tmpdir(), 'perm-test-'))
    mkdirSync(join(cwd, '.pi'))
    writeFileSync(join(cwd, '.pi', 'permissions.json'), JSON.stringify({ bash: { 'npm test *': 'allow', 'git push *': 'ask', 'curl *': 'deny' } }))

    ctx = { cwd, hasUI: false, ui: { notify: () => {}, select: async () => 'No (block)' } }
    await handlers.get('session_start')?.({}, ctx)
  })

  it('passes a plain safe command', async () => {
    expect(await bash('ls -la')).toBeUndefined()
  })

  it('passes an allow rule silently', async () => {
    expect(await bash('npm test -- --watch')).toBeUndefined()
  })

  it('blocks an ask rule without UI', async () => {
    expect((await bash('git push origin main'))?.block).toBe(true)
  })

  it('blocks a deny rule', async () => {
    expect((await bash('curl https://x.com'))?.reason).toContain('Denied by permission rule')
  })

  it('escalates a dangerous unit inside a chain', async () => {
    expect((await bash('ls && rm -rf /tmp/x'))?.block).toBe(true)
  })

  it('floors wrappers from allow to ask', async () => {
    expect((await bash('sudo ls'))?.block).toBe(true)
  })

  it('passes unlisted benign commands', async () => {
    expect(await bash('git status')).toBeUndefined()
  })

  it('passes write calls with no matching rule', async () => {
    const result = await handlers.get('tool_call')?.({ toolName: 'write', input: { path: '/etc/hosts' } }, ctx)
    expect(result).toBeUndefined()
  })
})
