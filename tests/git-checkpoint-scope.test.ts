import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import gitCheckpoint from '../extensions/git-checkpoint.ts'

type Handler = (event: any, ctx: any) => Promise<unknown>

/** The extension resolves its shadow repo under os.homedir(); redirect it at a temp dir
 * so the suite never writes into the developer's own ~/.pi/agent/checkpoints. */
const hoisted = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const userEntry = {
  type: 'message',
  id: 'user0001',
  parentId: null,
  message: { role: 'user', content: 'tidy up the config loader' },
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
  const appended: Array<{ customType: string; data: any }> = []
  const notifications: string[] = []

  const repo = mkdtempSync(join(tmpdir(), 'gcscope-repo-'))
  hoisted.home = mkdtempSync(join(tmpdir(), 'gcscope-home-'))
  process.env.PI_CODING_AGENT_DIR = join(hoisted.home, '.pi', 'agent')
  tempDirs.push(repo, hoisted.home)

  const sessionFile = join(repo, 'session-test.jsonl')
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })

  gitCheckpoint({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
    exec: async (cmd: string, args: string[], options?: { cwd?: string }) => {
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
      setEditorText: () => {},
    },
    navigateTree: async () => ({ editorText: '', cancelled: false }),
  })

  return { handlers, commands, appended, notifications, repo, makeCtx }
}

type Harness = ReturnType<typeof setup>

const shadowDir = () => join(hoisted.home, '.pi', 'agent', 'checkpoints', 'session-test.jsonl')

/** The paths a recorded checkpoint actually captured. */
function snapshotPaths(ref: string): string[] {
  const listed = execFileSync('git', ['--git-dir', shadowDir(), 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' })
  return listed.split('\n').filter(Boolean)
}

const start = (t: Harness) => t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx([], [], []))
const beginRun = (t: Harness) => t.handlers.get('agent_start')?.({}, t.makeCtx([], [], []))
const turnStart = (t: Harness) => t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx([], [], []))
const turnEnd = (t: Harness) => t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx([], [userEntry], []))

/** Announce a file edit the way pi does: tool_call fires before the tool touches disk. */
const announceEdit = (t: Harness, path: string, toolName = 'edit') => t.handlers.get('tool_call')?.({ type: 'tool_call', toolCallId: 'tc1', toolName, input: { path } }, t.makeCtx([], [], []))

describe('checkpoint scope', () => {
  it('leaves a file the session never edited out of the snapshot', async () => {
    // Claude Code: "Checkpointing only tracks files that have been edited within the
    // current session." A whole-tree snapshot makes checkpoint size scale with the size
    // of cwd, which is what fills a disk when cwd is $HOME.
    const t = setup()
    writeFileSync(join(t.repo, 'untouched.txt'), 'not mine\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await turnEnd(t)

    expect(t.appended).toHaveLength(1)
    expect(snapshotPaths(t.appended[0].data.ref)).not.toContain('untouched.txt')
  })

  it('captures the pre-edit content of a file the model edits mid-run', async () => {
    // The checkpoint for a prompt must hold what the file looked like before that
    // prompt's edits, including for a file this run is the first to touch.
    const t = setup()
    writeFileSync(join(t.repo, 'loader.ts'), 'before\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(t.repo, 'loader.ts'))
    writeFileSync(join(t.repo, 'loader.ts'), 'after\n')
    await turnEnd(t)

    expect(snapshotPaths(t.appended[0].data.ref)).toContain('loader.ts')
    await t.commands.get('rewind')?.handler('', t.makeCtx(t.appended, [userEntry], [`1. ${new Date(t.appended[0].data.createdAt).toLocaleTimeString()}  ${t.appended[0].data.prompt}`, 'Code only']))
    expect(readFileSync(join(t.repo, 'loader.ts'), 'utf8')).toBe('before\n')
  })

  it('does not grow the snapshot with the size of the working tree', async () => {
    // The defect behind the $HOME report: cwd size, not edit count, drove the snapshot.
    const t = setup()
    mkdirSync(join(t.repo, 'cache'), { recursive: true })
    for (let i = 0; i < 50; i++) writeFileSync(join(t.repo, 'cache', `blob${i}.bin`), `payload ${i}\n`)
    writeFileSync(join(t.repo, 'loader.ts'), 'before\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(t.repo, 'loader.ts'))
    await turnEnd(t)

    expect(snapshotPaths(t.appended[0].data.ref)).toEqual(['loader.ts'])
  })

  it('keeps a gitignored file the model edits out of the snapshot', async () => {
    // .gitignore and the repo-local .git/info/exclude are where secrets and scratch
    // live. Tracking edited files must not become a way to snapshot them.
    const t = setup()
    writeFileSync(join(t.repo, '.gitignore'), '.env\n')
    writeFileSync(join(t.repo, '.env'), 'API_KEY=live\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(t.repo, '.env'), 'write')
    await turnEnd(t)

    expect(t.appended).toHaveLength(1)
    expect(snapshotPaths(t.appended[0].data.ref)).not.toContain('.env')
  })

  it('stages a tracked file, and only that file, in a later run pre-run snapshot', async () => {
    // The path that runs on every prompt after the first: the pre-run snapshot restages
    // the files already in scope. It must pick up their current content and still leave
    // the rest of the working tree alone.
    const t = setup()
    writeFileSync(join(t.repo, 'loader.ts'), 'v1\n')
    writeFileSync(join(t.repo, 'unrelated.txt'), 'not mine\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(t.repo, 'loader.ts'))
    writeFileSync(join(t.repo, 'loader.ts'), 'v2\n')
    await turnEnd(t)

    const second = { ...userEntry, id: 'user0002', message: { role: 'user', content: 'now rename it' } }
    await beginRun(t)
    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry, second], []))

    expect(t.appended).toHaveLength(2)
    expect(snapshotPaths(t.appended[1].data.ref)).toEqual(['loader.ts'])
    writeFileSync(join(t.repo, 'loader.ts'), 'v3\n')
    await t.commands.get('rewind')?.handler('', t.makeCtx(t.appended, [userEntry, second], [`1. ${new Date(t.appended[1].data.createdAt).toLocaleTimeString()}  ${t.appended[1].data.prompt}`, 'Code only']))
    expect(readFileSync(join(t.repo, 'loader.ts'), 'utf8')).toBe('v2\n')
  })

  it('keeps recording checkpoints when a tracked file is deleted between runs', async () => {
    // git aborts the whole pathspec when one entry matches neither a file on disk nor a
    // committed path, which would cost the run its checkpoint entirely.
    const t = setup()
    writeFileSync(join(t.repo, 'loader.ts'), 'v1\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(t.repo, 'loader.ts'))
    await turnEnd(t)
    rmSync(join(t.repo, 'loader.ts'))

    const second = { ...userEntry, id: 'user0002', message: { role: 'user', content: 'now rename it' } }
    await beginRun(t)
    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry, second], []))

    expect(t.appended).toHaveLength(2)
  })

  it('keeps recording checkpoints after the model edits an ignored file', async () => {
    // An ignored file stays in the edit set but never reaches the index, so every later
    // pre-run add carries a pathspec git rejects. One entry rejects the whole add, which
    // would silently end checkpointing for the rest of the session the first time the
    // model touches a .env or a build artifact.
    const t = setup()
    writeFileSync(join(t.repo, '.gitignore'), '.env\n')
    writeFileSync(join(t.repo, '.env'), 'API_KEY=live\n')
    writeFileSync(join(t.repo, 'loader.ts'), 'v1\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(t.repo, '.env'), 'write')
    await announceEdit(t, join(t.repo, 'loader.ts'))
    await turnEnd(t)

    const second = { ...userEntry, id: 'user0002', message: { role: 'user', content: 'now rename it' } }
    await beginRun(t)
    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx([], [], []))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx([], [userEntry, second], []))

    expect(t.appended).toHaveLength(2)
    expect(snapshotPaths(t.appended[1].data.ref)).toEqual(['loader.ts'])
  })

  it('still records a checkpoint when the model edits outside the working tree', async () => {
    // git refuses a pathspec outside the work tree. The conversation checkpoint must
    // survive that, or /rewind loses the prompt entirely.
    const outside = mkdtempSync(join(tmpdir(), 'gcscope-outside-'))
    tempDirs.push(outside)
    const t = setup()
    writeFileSync(join(outside, 'elsewhere.txt'), 'x\n')

    await start(t)
    await beginRun(t)
    await turnStart(t)
    await announceEdit(t, join(outside, 'elsewhere.txt'))
    await turnEnd(t)

    expect(t.appended).toHaveLength(1)
    expect(snapshotPaths(t.appended[0].data.ref)).not.toContain('elsewhere.txt')
  })
})
