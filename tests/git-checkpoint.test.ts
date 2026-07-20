import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import gitCheckpoint, { sessionSlug } from '../extensions/git-checkpoint.ts'

type Handler = (event: any, ctx: any) => Promise<unknown>

describe('sessionSlug', () => {
  it('slugs session file names and falls back to an ephemeral id', () => {
    expect(sessionSlug('/x/y/2026-07-17T10-00-00.jsonl')).toBe('2026-07-17T10-00-00.jsonl')
    expect(sessionSlug(undefined)).toContain('ephemeral-')
  })
})

describe('shadow-repo checkpoint lifecycle', () => {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
  const appended: Array<{ type: string; customType: string; data: any }> = []
  const notifications: string[] = []
  let repo: string
  let sessionFile: string

  const userEntry = {
    type: 'message',
    id: 'user0001',
    parentId: null,
    message: { role: 'user', content: 'refactor the config loader so it validates the schema up front' },
  }
  const makeCtx = (entries: any[], branch: any[], selectAnswers: string[]) => ({
    cwd: repo,
    hasUI: true,
    sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionFile: () => sessionFile },
    ui: {
      select: async () => selectAnswers.shift(),
      notify: (msg: string, level: string) => notifications.push(`[${level}] ${msg}`),
      setEditorText: (text: string) => notifications.push(`[editor] ${text}`),
    },
    navigateTree: async () => ({ editorText: 'restored prompt', cancelled: false }),
  })

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'gcs-test-'))
    sessionFile = join(repo, 'session-test.jsonl')
    execFileSync('git', ['init', '-qb', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
    writeFileSync(join(repo, 'untracked.txt'), 'precious\n')

    gitCheckpoint({
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
      appendEntry: (customType: string, data: any) => appended.push({ type: 'custom', customType, data }),
      exec: async (cmd: string, args: string[], options?: { cwd?: string }) => {
        try {
          return { stdout: execFileSync(cmd, args, { cwd: options?.cwd ?? repo, encoding: 'utf8' }), stderr: '', code: 0, killed: false }
        } catch (err: any) {
          return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err), code: err.status ?? 1, killed: false }
        }
      },
    } as any)
  })

  it('snapshots the whole tree including untracked files', async () => {
    await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx([], [], []))
    await handlers.get('turn_start')?.({ turnIndex: 0 }, makeCtx([], [], []))
    await handlers.get('turn_end')?.({ turnIndex: 0 }, makeCtx([], [userEntry], []))
    expect(appended).toHaveLength(1)
    expect(appended[0].data.ref).toMatch(/^[0-9a-f]{40}$/)
  })

  it('restore resets edits made after the checkpoint and resurrects deleted untracked files', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'overwritten after checkpoint\n')
    rmSync(join(repo, 'untracked.txt'))

    const label = `1. ${new Date(appended[0].data.createdAt).toLocaleTimeString()}  ${appended[0].data.prompt}`
    await commands.get('rewind')?.handler('', makeCtx(appended, [userEntry], [label, 'Code only']))

    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('precious\n')
    expect(notifications.some((n) => n.includes('Rewind complete'))).toBe(true)
  })

  it('dedupes checkpoints per prompt and reuses HEAD for unchanged trees', async () => {
    await handlers.get('turn_start')?.({ turnIndex: 1 }, makeCtx([], [userEntry], []))
    await handlers.get('turn_end')?.({ turnIndex: 1 }, makeCtx([], [userEntry], []))
    expect(appended).toHaveLength(1)
  })

  it('warns on an unknown ref instead of crashing', async () => {
    const bad = { type: 'custom', customType: 'git-checkpoint', data: { entryId: 'user0002', ref: '0'.repeat(40), prompt: 'x', createdAt: new Date().toISOString() } }
    await handlers.get('session_start')?.({ reason: 'resume' }, makeCtx([bad], [userEntry], []))
    const label = `1. ${new Date(bad.data.createdAt).toLocaleTimeString()}  x`
    await commands.get('rewind')?.handler('', makeCtx([bad], [userEntry], [label, 'Code only']))
    expect(notifications.some((n) => n.startsWith('[warning] Code restore failed'))).toBe(true)
  })
})
