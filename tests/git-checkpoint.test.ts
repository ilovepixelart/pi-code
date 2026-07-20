import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import gitCheckpoint, { sessionSlug } from '../extensions/git-checkpoint.ts'

type Handler = (event: any, ctx: any) => Promise<unknown>

/**
 * The extension resolves its shadow repo under os.homedir(), so homedir is
 * redirected at a per-test temp dir: without this the suite writes a real bare
 * repo into the developer's ~/.pi/agent/checkpoints and carries it between runs.
 */
const hoisted = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const userEntry = {
  type: 'message',
  id: 'user0001',
  parentId: null,
  message: { role: 'user', content: 'refactor the config loader so it validates the schema up front' },
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Fresh repo, shadow home and extension instance so tests share no state and may run in any order. */
function setup() {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
  const appended: Array<{ type: string; customType: string; data: any }> = []
  const notifications: string[] = []

  const repo = mkdtempSync(join(tmpdir(), 'gcs-test-'))
  hoisted.home = mkdtempSync(join(tmpdir(), 'gcs-home-'))
  tempDirs.push(repo, hoisted.home)

  const sessionFile = join(repo, 'session-test.jsonl')
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

  return { handlers, commands, appended, notifications, repo, makeCtx }
}

type Harness = ReturnType<typeof setup>

/** Drive one full turn so a checkpoint exists; shadowDir is only initialized by session_start. */
async function checkpointOneTurn(t: Harness, turnIndex = 0): Promise<void> {
  await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx([], [], []))
  await t.handlers.get('turn_start')?.({ turnIndex }, t.makeCtx([], [], []))
  await t.handlers.get('turn_end')?.({ turnIndex }, t.makeCtx([], [userEntry], []))
}

const rewindLabel = (data: { createdAt: string; prompt: string }) => `1. ${new Date(data.createdAt).toLocaleTimeString()}  ${data.prompt}`

describe('sessionSlug', () => {
  it('slugs session file names and falls back to an ephemeral id', () => {
    expect(sessionSlug('/x/y/2026-07-17T10-00-00.jsonl')).toBe('2026-07-17T10-00-00.jsonl')
    expect(sessionSlug(undefined)).toContain('ephemeral-')
  })
})

describe('shadow-repo checkpoint lifecycle', () => {
  it('snapshots the whole tree including untracked files', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    expect(t.appended).toHaveLength(1)
    expect(t.appended[0].data.ref).toMatch(/^[0-9a-f]{40}$/)
  })

  it('restore resets edits made after the checkpoint and resurrects deleted untracked files', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    writeFileSync(join(t.repo, 'tracked.txt'), 'overwritten after checkpoint\n')
    rmSync(join(t.repo, 'untracked.txt'))

    await t.commands.get('rewind')?.handler('', t.makeCtx(t.appended, [userEntry], [rewindLabel(t.appended[0].data), 'Code only']))

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(t.repo, 'untracked.txt'))).toBe(true)
    expect(readFileSync(join(t.repo, 'untracked.txt'), 'utf8')).toBe('precious\n')
    expect(t.notifications.some((n) => n.includes('Rewind complete'))).toBe(true)
  })

  it('dedupes checkpoints per prompt and reuses HEAD for unchanged trees', async () => {
    const t = setup()
    await checkpointOneTurn(t, 0)

    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry], []))

    expect(t.appended).toHaveLength(1)
  })

  it('warns on an unknown ref instead of crashing', async () => {
    const t = setup()
    const bad = { type: 'custom', customType: 'git-checkpoint', data: { entryId: 'user0002', ref: '0'.repeat(40), prompt: 'x', createdAt: new Date().toISOString() } }

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx([bad], [userEntry], []))
    await t.commands.get('rewind')?.handler('', t.makeCtx([bad], [userEntry], [rewindLabel(bad.data), 'Code only']))

    expect(t.notifications.some((n) => n.startsWith('[warning] Code restore failed'))).toBe(true)
  })
})
