import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import gitCheckpoint from '../extensions/git-checkpoint.ts'

type Handler = (event: any, ctx: any) => Promise<unknown>

describe('git checkpoint lifecycle', () => {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
  const appended: Array<{ type: string; customType: string; data: any }> = []
  const notifications: string[] = []
  let repo: string

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  const userEntry = {
    type: 'message',
    id: 'user0001',
    parentId: null,
    message: { role: 'user', content: 'fix the login bug in the authentication middleware please, it throws on refresh' },
  }
  const makeCtx = (entries: any[], branch: any[], selectAnswers: string[]) => ({
    hasUI: true,
    sessionManager: { getEntries: () => entries, getBranch: () => branch },
    ui: {
      select: async () => selectAnswers.shift(),
      notify: (msg: string, level: string) => notifications.push(`[${level}] ${msg}`),
      setEditorText: (text: string) => notifications.push(`[editor] ${text}`),
    },
    navigateTree: async () => ({ editorText: 'restored prompt', cancelled: false }),
  })

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'gc-test-'))
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    git('add', 'a.txt')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'a.txt'), 'v2-checkpoint-state\n')

    gitCheckpoint({
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
      appendEntry: (customType: string, data: any) => appended.push({ type: 'custom', customType, data }),
      exec: async (cmd: string, args: string[]) => {
        try {
          return { stdout: execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' }), stderr: '', code: 0, killed: false }
        } catch (err: any) {
          return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err), code: err.status ?? 1, killed: false }
        }
      },
    } as any)
  })

  it('persists one checkpoint per prompt at turn_end, deduped, steering included', async () => {
    await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx([], [], []))
    await handlers.get('turn_start')?.({ turnIndex: 0 }, makeCtx([], [], []))
    expect(appended).toHaveLength(0)

    await handlers.get('turn_end')?.({ turnIndex: 0 }, makeCtx([], [userEntry], []))
    expect(appended).toHaveLength(1)
    expect(appended[0].data.entryId).toBe('user0001')
    expect(appended[0].data.ref).toMatch(/^[0-9a-f]{40}$/)
    expect(appended[0].data.prompt.endsWith('…')).toBe(true)

    await handlers.get('turn_start')?.({ turnIndex: 1 }, makeCtx([], [userEntry], []))
    await handlers.get('turn_end')?.({ turnIndex: 1 }, makeCtx([], [userEntry], []))
    expect(appended).toHaveLength(1)

    const steer = { type: 'message', id: 'user0002s', parentId: 'x', message: { role: 'user', content: 'also rename it' } }
    await handlers.get('turn_start')?.({ turnIndex: 2 }, makeCtx([], [userEntry], []))
    await handlers.get('turn_end')?.({ turnIndex: 2 }, makeCtx([], [userEntry, steer], []))
    expect(appended).toHaveLength(2)
    expect(appended[1].data.entryId).toBe('user0002s')
    appended.pop()
  })

  it('restores code and conversation through /rewind after a restart', async () => {
    await handlers.get('session_start')?.({ reason: 'resume' }, makeCtx(appended, [userEntry], []))

    git('checkout', '--', 'a.txt')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v1\n')

    const label = `1. ${new Date(appended[0].data.createdAt).toLocaleTimeString()}  ${appended[0].data.prompt}`
    await commands.get('rewind')?.handler('', makeCtx(appended, [userEntry], [label, 'Code only']))
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v2-checkpoint-state\n')
    expect(notifications.some((n) => n.includes('Rewind complete'))).toBe(true)

    await commands.get('rewind')?.handler('', makeCtx(appended, [userEntry], [label, 'Conversation only']))
    expect(notifications).toContain('[editor] restored prompt')
  })

  it('warns on a GC-ed ref instead of crashing', async () => {
    const bad = { type: 'custom', customType: 'git-checkpoint', data: { entryId: 'user0002', ref: '0'.repeat(40), prompt: 'x', createdAt: new Date().toISOString() } }
    await handlers.get('session_start')?.({ reason: 'resume' }, makeCtx([bad], [userEntry], []))
    const label = `1. ${new Date(bad.data.createdAt).toLocaleTimeString()}  x`
    await commands.get('rewind')?.handler('', makeCtx([bad], [userEntry], [label, 'Code only']))
    expect(notifications.some((n) => n.startsWith('[warning] Code restore failed'))).toBe(true)
  })

  it('offers and applies restore on fork', async () => {
    git('checkout', '--', 'a.txt')
    await handlers.get('session_start')?.({ reason: 'resume' }, makeCtx(appended, [userEntry], []))
    await handlers.get('session_before_fork')?.({ entryId: 'user0001', position: 'before' }, makeCtx(appended, [userEntry], ['Yes, restore code to that point']))
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v2-checkpoint-state\n')
  })
})
