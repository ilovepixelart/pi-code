import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import gitCheckpoint, { CHECKPOINT_RETENTION_DAYS, capCheckpoints, MAX_CHECKPOINTS_PER_SESSION, pruneCheckpointRepos, sessionSlug } from '../extensions/git-checkpoint.ts'

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
  const execLog: string[][] = []

  const repo = mkdtempSync(join(tmpdir(), 'gcs-test-'))
  hoisted.home = mkdtempSync(join(tmpdir(), 'gcs-home-'))
  tempDirs.push(repo, hoisted.home)

  const sessionFile = join(repo, 'session-test.jsonl')
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
  writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
  writeFileSync(join(repo, 'untracked.txt'), 'precious\n')

  gitCheckpoint({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    appendEntry: (customType: string, data: any) => appended.push({ type: 'custom', customType, data }),
    exec: async (cmd: string, args: string[], options?: { cwd?: string }) => {
      execLog.push([cmd, ...args])
      try {
        return { stdout: execFileSync(cmd, args, { cwd: options?.cwd ?? repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '', code: 0, killed: false }
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

  return { handlers, commands, appended, notifications, execLog, repo, makeCtx }
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

  it('captures the tree even when the user global config forces commit signing', async () => {
    // A global commit.gpgsign=true (with no usable gpg) would fail the shadow commit;
    // the snapshot must isolate itself from the user config and still record the change.
    const globalCfg = mkdtempSync(join(tmpdir(), 'gcs-cfg-'))
    tempDirs.push(globalCfg)
    writeFileSync(join(globalCfg, 'config'), '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent-gpg-binary\n')
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = join(globalCfg, 'config')
    try {
      const t = setup()
      await checkpointOneTurn(t)

      expect(t.appended).toHaveLength(1)
      expect(t.appended[0].data.ref).toMatch(/^[0-9a-f]{40}$/)
      // The recorded ref's tree must actually contain the working-tree file.
      writeFileSync(join(t.repo, 'tracked.txt'), 'changed after checkpoint\n')
      await t.commands.get('rewind')?.handler('', t.makeCtx(t.appended, [userEntry], [rewindLabel(t.appended[0].data), 'Code only']))
      expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('v1\n')
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal
    }
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

  it('dedupes checkpoints per prompt', async () => {
    const t = setup()
    await checkpointOneTurn(t, 0)

    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry], []))

    expect(t.appended).toHaveLength(1)
  })

  it('awaits the pre-run snapshot in turn_start so it captures the tree before the model acts', async () => {
    // The snapshot must capture the tree before the model's first edit, so turn_start
    // awaits it to completion rather than deferring the git work to turn_end. By the
    // time turn_start resolves, the commit has run; an un-awaited kickoff would still
    // be mid-flight, having reached only `git add -A`.
    const t = setup()
    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx([], [], []))
    await t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx([], [], []))

    expect(t.execLog.some((c) => c[0] === 'git' && c.includes('commit'))).toBe(true)
  })

  it('snapshots once per run, not once per turn, and still records the checkpoint', async () => {
    // A `git add -A` before every assistant turn (awaited, so it blocks the model call)
    // is wasted when the run has already checkpointed the pre-run tree; snapshot once per
    // run (gated by agent_start) instead.
    const t = setup()
    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx([], [], []))
    await t.handlers.get('agent_start')?.({}, t.makeCtx([], [], []))
    await t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx([], [], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx([], [userEntry], []))
    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry], []))

    const addCalls = t.execLog.filter((c) => c[0] === 'git' && c.includes('add') && c.includes('-A')).length
    expect(addCalls).toBe(1)
    expect(t.appended).toHaveLength(1)
  })

  it('reuses the existing HEAD ref when the tree has not changed', async () => {
    const t = setup()
    await checkpointOneTurn(t, 0)

    // A distinct prompt in a new run gets past the per-entry dedupe, so the snapshot
    // runs again; with an untouched work tree it must resolve to the same commit.
    const secondPrompt = { ...userEntry, id: 'user0002', message: { role: 'user', content: 'now add a regression test for it' } }
    await t.handlers.get('agent_start')?.({}, t.makeCtx([], [], []))
    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry, secondPrompt], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry, secondPrompt], []))

    expect(t.appended).toHaveLength(2)
    expect(t.appended[1].data.ref).toBe(t.appended[0].data.ref)
  })

  it('warns on an unknown ref instead of crashing', async () => {
    const t = setup()
    const bad = { type: 'custom', customType: 'git-checkpoint', data: { entryId: 'user0002', ref: '0'.repeat(40), prompt: 'x', createdAt: new Date().toISOString() } }

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx([bad], [userEntry], []))
    await t.commands.get('rewind')?.handler('', t.makeCtx([bad], [userEntry], [rewindLabel(bad.data), 'Code only']))

    expect(t.notifications.some((n) => n.startsWith('[warning] Code restore failed'))).toBe(true)
  })
})

describe('pruneCheckpointRepos', () => {
  const mkRepo = (root: string, name: string, ageDays: number): string => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
    utimesSync(dir, when, when)
    return dir
  }

  it('removes shadow repos past the retention window and keeps recent ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'ckpt-root-'))
    const old = mkRepo(root, 'old-session', 45)
    const fresh = mkRepo(root, 'fresh-session', 2)

    pruneCheckpointRepos(root, CHECKPOINT_RETENTION_DAYS)

    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('never removes the repo of the live session and tolerates a missing root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ckpt-root-'))
    const live = mkRepo(root, 'live-session', 90)

    pruneCheckpointRepos(root, CHECKPOINT_RETENTION_DAYS, live)
    expect(existsSync(live)).toBe(true)

    expect(() => pruneCheckpointRepos(join(root, 'absent'), CHECKPOINT_RETENTION_DAYS)).not.toThrow()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('capCheckpoints', () => {
  const entry = (n: number) => ({ entryId: `e${n}`, ref: `ref${n}`, prompt: `p${n}`, createdAt: new Date(2026, 0, n + 1).toISOString() })

  it('keeps the most recent entries up to the cap', () => {
    const many = Array.from({ length: MAX_CHECKPOINTS_PER_SESSION + 5 }, (_, i) => entry(i))
    const capped = capCheckpoints(many)
    expect(capped).toHaveLength(MAX_CHECKPOINTS_PER_SESSION)
    // The oldest five are dropped, the newest kept.
    expect(capped.at(-1)?.entryId).toBe(many.at(-1)?.entryId)
    expect(capped.map((c) => c.entryId)).not.toContain('e0')
  })

  it('leaves a list under the cap untouched', () => {
    const few = [entry(1), entry(2)]
    expect(capCheckpoints(few)).toEqual(few)
  })
})
