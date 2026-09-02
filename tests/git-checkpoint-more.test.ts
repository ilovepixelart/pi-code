import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import gitCheckpoint from '../extensions/git-checkpoint.ts'

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

const SESSION_FILE_NAME = 'session-test.jsonl'

const userEntry = {
  type: 'message',
  id: 'user0001',
  parentId: null,
  message: { role: 'user', content: 'refactor the config loader so it validates the schema up front' },
}

const messageEntry = (id: string, content: unknown) => ({ type: 'message', id, parentId: null, message: { role: 'user', content } })

const checkpointEntry = (data: { entryId: string; ref: string; prompt: string; createdAt?: string }) => ({
  type: 'custom',
  customType: 'git-checkpoint',
  data: { createdAt: '2026-07-20T08:00:00.000Z', ...data },
})

interface CtxOptions {
  entries?: any[]
  branch?: any[]
  /** Answers consumed by ui.select in order: a number picks that option index, a string is returned verbatim, undefined cancels. */
  answers?: Array<string | number | undefined>
  hasUI?: boolean
  cwd?: string
  navigateTree?: (entryId: string, options: unknown) => Promise<unknown>
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
  const appended: Array<{ customType: string; data: any }> = []
  const notifications: string[] = []
  const selects: Array<{ title: string; options: string[] }> = []
  const execArgs: string[][] = []
  const editorTexts: string[] = []
  const navigations: string[] = []

  const repo = mkdtempSync(join(tmpdir(), 'gcm-test-'))
  hoisted.home = mkdtempSync(join(tmpdir(), 'gcm-home-'))
  tempDirs.push(repo, hoisted.home)

  const shadowHome = hoisted.home
  const sessionFile = join(repo, SESSION_FILE_NAME)
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
  writeFileSync(join(repo, 'tracked.txt'), 'v1\n')

  gitCheckpoint({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
    exec: async (cmd: string, args: string[], options?: { cwd?: string }) => {
      execArgs.push(args)
      try {
        return { stdout: execFileSync(cmd, args, { cwd: options?.cwd ?? repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '', code: 0, killed: false }
      } catch (err: any) {
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err), code: err.status ?? 1, killed: false }
      }
    },
  } as any)

  const makeCtx = (options: CtxOptions = {}) => ({
    cwd: options.cwd ?? repo,
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getBranch: () => options.branch ?? [],
      getSessionFile: () => sessionFile,
    },
    ui: {
      select: async (title: string, choices: string[]) => {
        selects.push({ title, options: [...choices] })
        const answer = options.answers?.shift()
        return typeof answer === 'number' ? choices[answer] : answer
      },
      notify: (msg: string, level: string) => notifications.push(`[${level}] ${msg}`),
      setEditorText: (text: string) => editorTexts.push(text),
    },
    navigateTree:
      options.navigateTree ??
      (async (entryId: string) => {
        navigations.push(entryId)
        return { editorText: 'restored prompt', cancelled: false }
      }),
  })

  return { handlers, commands, appended, notifications, selects, execArgs, editorTexts, navigations, repo, shadowHome, makeCtx }
}

type Harness = ReturnType<typeof setup>

/** Drive one full turn so a real snapshot ref exists; shadowDir is only initialized by session_start. */
async function checkpointOneTurn(t: Harness, branch: any[] = [userEntry]): Promise<void> {
  await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())
  await t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx())
  await t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx({ branch }))
}

const rewind = (t: Harness, options: CtxOptions) => t.commands.get('rewind')?.handler('', t.makeCtx(options))

describe('shadow repo initialization', () => {
  it('creates the bare repo under the session slug in the home directory', async () => {
    const t = setup()

    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())

    expect(existsSync(join(t.shadowHome, '.pi', 'agent', 'checkpoints', SESSION_FILE_NAME, 'HEAD'))).toBe(true)
  })

  it('configures the checkpoint committer identity on a freshly created shadow repo', async () => {
    const t = setup()

    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())

    const configured = t.execArgs.filter((args) => args[2] === 'config').map((args) => args.slice(2))
    expect(configured).toEqual([
      ['config', 'user.email', 'checkpoint@pi-code'],
      ['config', 'user.name', 'pi-code-checkpoint'],
    ])
  })

  it('reuses an existing shadow repo instead of re-initializing it', async () => {
    const t = setup()

    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())
    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx())

    expect(t.execArgs.filter((args) => args[0] === 'init')).toHaveLength(1)
  })

  it('rehydrates checkpoints recorded in the session on resume', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: 'a'.repeat(40), prompt: 'earlier prompt' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await rewind(t, { entries: [entry], answers: [undefined] })

    expect(t.selects[0].options).toEqual([expect.stringContaining('earlier prompt')])
  })

  it('ignores session entries that are not checkpoints', async () => {
    const t = setup()
    const entries = [userEntry, { type: 'custom', customType: 'other-extension', data: { entryId: 'user0001' } }]

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries }))
    await rewind(t, { entries, answers: [undefined] })

    expect(t.notifications).toEqual(['[info] No checkpoints recorded yet'])
  })

  it('ignores a checkpoint entry that carries no entry id', async () => {
    const t = setup()
    const entries = [{ type: 'custom', customType: 'git-checkpoint', data: { ref: 'a'.repeat(40), prompt: 'orphan' } }]

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries }))
    await rewind(t, { entries, answers: [undefined] })

    expect(t.notifications).toEqual(['[info] No checkpoints recorded yet'])
  })

  it('drops in-memory checkpoints when a session starts with no recorded entries', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())
    await rewind(t, { answers: [undefined] })

    expect(t.notifications).toEqual(['[info] No checkpoints recorded yet'])
  })
})

describe('snapshotting', () => {
  it('records no checkpoint when the shadow repo was never initialized', async () => {
    const t = setup()

    await t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx())
    await t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx({ branch: [userEntry] }))

    expect(t.appended).toEqual([])
    expect(t.execArgs).toEqual([])
  })

  it('records no checkpoint for a turn that never started', async () => {
    const t = setup()
    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())

    await t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx({ branch: [userEntry] }))

    expect(t.appended).toEqual([])
  })

  it('records no checkpoint when the branch holds no user message', async () => {
    const t = setup()
    const assistant = { type: 'message', id: 'asst0001', parentId: null, message: { role: 'assistant', content: 'done' } }

    await checkpointOneTurn(t, [assistant])

    expect(t.appended).toEqual([])
  })

  it('checkpoints an empty working tree with an empty commit', async () => {
    const t = setup()
    const empty = mkdtempSync(join(tmpdir(), 'gcm-empty-'))
    tempDirs.push(empty)

    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx({ cwd: empty }))
    await t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx({ cwd: empty }))
    await t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx({ cwd: empty, branch: [userEntry] }))

    expect(t.appended).toHaveLength(1)
    expect(t.appended[0].data.ref).toMatch(/^[0-9a-f]{40}$/)
  })

  it('keys the checkpoint on the last user message of the branch', async () => {
    const t = setup()
    const first = messageEntry('user0001', 'first prompt')
    const second = messageEntry('user0002', 'second prompt')

    await checkpointOneTurn(t, [first, second])

    expect(t.appended[0].data.entryId).toBe('user0002')
    expect(t.appended[0].data.prompt).toBe('second prompt')
  })

  it('appends the checkpoint under the git-checkpoint custom type', async () => {
    const t = setup()

    await checkpointOneTurn(t)

    expect(t.appended.map((e) => e.customType)).toEqual(['git-checkpoint'])
  })

  it('keeps a 60-character prompt intact', async () => {
    const t = setup()
    const prompt = 'a'.repeat(60)

    await checkpointOneTurn(t, [messageEntry('user0001', prompt)])

    expect(t.appended[0].data.prompt).toBe(prompt)
  })

  it('truncates a 61-character prompt to 60 characters plus an ellipsis', async () => {
    const t = setup()

    await checkpointOneTurn(t, [messageEntry('user0001', 'b'.repeat(61))])

    expect(t.appended[0].data.prompt).toBe(`${'b'.repeat(60)}…`)
  })

  it('collapses runs of whitespace in the prompt snippet', async () => {
    const t = setup()

    await checkpointOneTurn(t, [messageEntry('user0001', '  fix   the\n\tparser  ')])

    expect(t.appended[0].data.prompt).toBe('fix the parser')
  })

  it('joins the text parts of a structured prompt and skips non-text parts', async () => {
    const t = setup()
    const content = [
      { type: 'text', text: 'alpha' },
      { type: 'image', source: 'x' },
      { type: 'text', text: 'beta' },
    ]

    await checkpointOneTurn(t, [messageEntry('user0001', content)])

    expect(t.appended[0].data.prompt).toBe('alpha beta')
  })

  it('records an empty prompt for content of an unsupported shape', async () => {
    const t = setup()

    await checkpointOneTurn(t, [messageEntry('user0001', { text: 'not an array' })])

    expect(t.appended[0].data.prompt).toBe('')
  })
})

describe('/rewind checkpoint picker', () => {
  it('reports that nothing is recorded when no checkpoint exists', async () => {
    const t = setup()

    await rewind(t, {})

    expect(t.notifications).toEqual(['[info] No checkpoints recorded yet'])
    expect(t.selects).toEqual([])
  })

  it('does nothing at all without a UI', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, { hasUI: false, answers: [0, 'Code only'] })

    expect(t.selects).toEqual([])
    expect(t.notifications).toEqual([])
  })

  it('lists checkpoints newest first, numbered from one', async () => {
    const t = setup()
    const older = checkpointEntry({ entryId: 'user0001', ref: 'a'.repeat(40), prompt: 'older prompt' })
    const newer = checkpointEntry({ entryId: 'user0002', ref: 'b'.repeat(40), prompt: 'newer prompt' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [older, newer] }))
    await rewind(t, { entries: [older, newer], answers: [undefined] })

    const [first, second] = t.selects[0].options
    expect(first.startsWith('1. ')).toBe(true)
    expect(first.endsWith('  newer prompt')).toBe(true)
    expect(second.startsWith('2. ')).toBe(true)
    expect(second.endsWith('  older prompt')).toBe(true)
  })

  it('marks a checkpoint that carries no code snapshot', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: '', prompt: 'no snapshot here' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await rewind(t, { entries: [entry], answers: [undefined] })

    expect(t.selects[0].options[0].endsWith('  no snapshot here [no code snapshot]')).toBe(true)
  })

  it('labels an empty prompt as (empty prompt)', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: 'a'.repeat(40), prompt: '' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await rewind(t, { entries: [entry], answers: [undefined] })

    expect(t.selects[0].options[0].endsWith('  (empty prompt)')).toBe(true)
  })

  it('asks under a rewind heading', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, { answers: [undefined] })

    expect(t.selects[0].title).toBe('Rewind to checkpoint:')
  })

  it('stops without asking for a restore mode when the picker is cancelled', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, { answers: [undefined] })

    expect(t.selects).toHaveLength(1)
    expect(t.notifications).toEqual([])
  })

  it('stops without asking for a restore mode when the choice matches no checkpoint', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, { answers: ['7. not a real label'] })

    expect(t.selects).toHaveLength(1)
    expect(t.notifications).toEqual([])
  })
})

describe('/rewind restore modes', () => {
  it('offers code, conversation and combined restore', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, { branch: [userEntry], answers: [0, undefined] })

    expect(t.selects[1]).toEqual({
      title: 'Restore mode:',
      options: ['Code and conversation', 'Conversation only', 'Code only'],
    })
  })

  it('leaves everything untouched when the restore mode is cancelled', async () => {
    const t = setup()
    await checkpointOneTurn(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited after checkpoint\n')

    await rewind(t, { branch: [userEntry], answers: [0, undefined] })

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('edited after checkpoint\n')
    expect(t.notifications).toEqual([])
  })

  it('restores the conversation without touching the code in conversation-only mode', async () => {
    const t = setup()
    await checkpointOneTurn(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited after checkpoint\n')

    await rewind(t, { branch: [userEntry], answers: [0, 'Conversation only'] })

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('edited after checkpoint\n')
    expect(t.editorTexts).toEqual(['restored prompt'])
    expect(t.notifications).toEqual(['[info] Rewind complete'])
  })

  it('navigates to the entry the checkpoint was keyed on', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, { branch: [userEntry], answers: [0, 'Conversation only'] })

    expect(t.navigations).toEqual(['user0001'])
  })

  it('restores both the code and the conversation in combined mode', async () => {
    const t = setup()
    await checkpointOneTurn(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited after checkpoint\n')

    await rewind(t, { branch: [userEntry], answers: [0, 'Code and conversation'] })

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('v1\n')
    expect(t.editorTexts).toEqual(['restored prompt'])
    expect(t.notifications).toEqual(['[info] Rewind complete'])
  })

  it('does not complete the rewind when the conversation navigation is cancelled', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, {
      branch: [userEntry],
      answers: [0, 'Code and conversation'],
      navigateTree: async () => ({ cancelled: true }),
    })

    expect(t.editorTexts).toEqual([])
    expect(t.notifications).toEqual([])
  })

  it('leaves the editor alone when the navigation returns no editor text', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, {
      branch: [userEntry],
      answers: [0, 'Conversation only'],
      navigateTree: async () => ({ cancelled: false }),
    })

    expect(t.editorTexts).toEqual([])
    expect(t.notifications).toEqual(['[info] Rewind complete'])
  })

  it('reports the failure message when the conversation navigation throws', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, {
      branch: [userEntry],
      answers: [0, 'Conversation only'],
      navigateTree: async () => {
        throw new Error('branch is detached')
      },
    })

    expect(t.notifications).toEqual(['[error] Conversation restore failed: branch is detached'])
  })

  it('stringifies a non-Error navigation failure', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await rewind(t, {
      branch: [userEntry],
      answers: [0, 'Conversation only'],
      navigateTree: async () => {
        throw 'plain string failure'
      },
    })

    expect(t.notifications).toEqual(['[error] Conversation restore failed: plain string failure'])
  })

  it('warns but still completes when the chosen checkpoint has no code snapshot', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: '', prompt: 'no snapshot here' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await rewind(t, { entries: [entry], answers: [0, 'Code only'] })

    expect(t.notifications).toEqual(['[warning] Checkpoint has no code snapshot; code left untouched', '[info] Rewind complete'])
  })

  it('skips the conversation restore when the code restore fails', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: '0'.repeat(40), prompt: 'unknown ref' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await rewind(t, { entries: [entry], answers: [0, 'Code and conversation'] })

    expect(t.navigations).toEqual([])
    expect(t.notifications).toHaveLength(1)
    expect(t.notifications[0].startsWith('[warning] Code restore failed: ')).toBe(true)
  })
})

describe('session_before_fork code restore', () => {
  const forkEntry = checkpointEntry({ entryId: 'user0001', ref: 'a'.repeat(40), prompt: 'forked prompt' })

  it('offers to restore the code state for the forked entry', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ answers: [undefined] }))

    expect(t.selects).toEqual([{ title: 'Restore code state?', options: ['Yes, restore code to that point', 'No, keep current code'] }])
  })

  it('restores the working tree when the fork restore is accepted', async () => {
    const t = setup()
    await checkpointOneTurn(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited after checkpoint\n')

    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ answers: ['Yes, restore code to that point'] }))

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('v1\n')
    expect(t.notifications).toEqual(['[info] Code restored to checkpoint'])
  })

  it('keeps the current code when the fork restore is declined', async () => {
    const t = setup()
    await checkpointOneTurn(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited after checkpoint\n')

    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ answers: ['No, keep current code'] }))

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('edited after checkpoint\n')
    expect(t.notifications).toEqual([])
  })

  it('keeps the current code when the fork prompt is cancelled', async () => {
    const t = setup()
    await checkpointOneTurn(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited after checkpoint\n')

    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ answers: [undefined] }))

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('edited after checkpoint\n')
    expect(t.notifications).toEqual([])
  })

  it('warns when the fork restore fails', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: '0'.repeat(40), prompt: 'unknown ref' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ entries: [entry], answers: ['Yes, restore code to that point'] }))

    expect(t.notifications).toHaveLength(1)
    expect(t.notifications[0].startsWith('[warning] Restore failed: ')).toBe(true)
  })

  it('asks nothing when the forked entry has no checkpoint', async () => {
    const t = setup()
    await checkpointOneTurn(t)

    await t.handlers.get('session_before_fork')?.({ entryId: 'user9999' }, t.makeCtx({ answers: [0] }))

    expect(t.selects).toEqual([])
  })

  it('asks nothing when the forked checkpoint carries no code snapshot', async () => {
    const t = setup()
    const entry = checkpointEntry({ entryId: 'user0001', ref: '', prompt: 'no snapshot here' })

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ entries: [entry], answers: [0] }))

    expect(t.selects).toEqual([])
  })

  it('asks nothing without a UI', async () => {
    const t = setup()

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [forkEntry] }))
    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ entries: [forkEntry], hasUI: false, answers: [0] }))

    expect(t.selects).toEqual([])
  })
})

describe('empty snapshots', () => {
  /** Checkpoint an empty directory, then scaffold a file, as a fresh-project session does. */
  async function emptyDirCheckpoint(t: Harness): Promise<string> {
    const empty = mkdtempSync(join(tmpdir(), 'gcm-empty-'))
    tempDirs.push(empty)
    await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx({ cwd: empty }))
    await t.handlers.get('turn_start')?.({ turnIndex: 0 }, t.makeCtx({ cwd: empty }))
    await t.handlers.get('turn_end')?.({ turnIndex: 0 }, t.makeCtx({ cwd: empty, branch: [userEntry] }))
    writeFileSync(join(empty, 'scaffolded.txt'), 'new work\n')
    return empty
  }

  it('rewinds to an empty snapshot as a no-op instead of failing', async () => {
    const t = setup()
    const empty = await emptyDirCheckpoint(t)

    await rewind(t, { answers: [0, 0], branch: [userEntry] })

    expect(t.notifications).toContain('[info] Rewind complete')
    expect(t.notifications.some((n) => n.includes('restore failed'))).toBe(false)
    expect(t.navigations).toEqual(['user0001'])
    expect(existsSync(join(empty, 'scaffolded.txt'))).toBe(true)
  })

  it('skips the checkout before a fork when the snapshot is empty', async () => {
    const t = setup()
    await emptyDirCheckpoint(t)

    await t.handlers.get('session_before_fork')?.({ entryId: 'user0001' }, t.makeCtx({ answers: [0] }))

    expect(t.notifications.some((n) => n.includes('Restore failed'))).toBe(false)
    expect(t.notifications.some((n) => n.includes('code left untouched'))).toBe(true)
  })
})

describe('resume from a different working directory', () => {
  /** Checkpoint in the original repo, then resume the same session from another
   * directory holding an unrelated file of the same name. */
  async function resumeElsewhere(t: Harness): Promise<{ other: string; entry: any }> {
    writeFileSync(join(t.repo, 'only-in-original.txt'), 'from the original tree\n')
    await checkpointOneTurn(t)
    const entry = checkpointEntry({ entryId: 'user0001', ref: t.appended[0].data.ref, prompt: 'earlier prompt' })
    const other = mkdtempSync(join(tmpdir(), 'gcm-moved-'))
    tempDirs.push(other)
    writeFileSync(join(other, 'tracked.txt'), 'unrelated file, same name\n')
    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ cwd: other, entries: [entry] }))
    return { other, entry }
  }

  it('never restores the original directory snapshot over the resumed directory', async () => {
    const t = setup()
    const { other, entry } = await resumeElsewhere(t)

    await rewind(t, { cwd: other, entries: [entry], branch: [userEntry], answers: [0, 'Code only'] })

    // The snapshot holds the original tree; checking it out here would silently
    // overwrite this unrelated same-named file and materialize the original's files.
    expect(readFileSync(join(other, 'tracked.txt'), 'utf8')).toBe('unrelated file, same name\n')
    expect(existsSync(join(other, 'only-in-original.txt'))).toBe(false)
  })

  it('notifies that earlier checkpoints belong to another directory', async () => {
    const t = setup()
    await resumeElsewhere(t)

    expect(t.notifications.some((n) => n.startsWith('[warning]') && n.includes(t.repo))).toBe(true)
  })

  it('checkpoints the resumed directory in a fresh shadow and restores it normally', async () => {
    const t = setup()
    const { other } = await resumeElsewhere(t)

    await t.handlers.get('agent_start')?.({}, t.makeCtx({ cwd: other }))
    await t.handlers.get('turn_start')?.({ turnIndex: 1 }, t.makeCtx({ cwd: other }))
    await t.handlers.get('turn_end')?.({ turnIndex: 1 }, t.makeCtx({ cwd: other, branch: [messageEntry('user0002', 'work here')] }))
    expect(t.appended).toHaveLength(2)
    writeFileSync(join(other, 'tracked.txt'), 'edited after the move\n')

    await rewind(t, { cwd: other, answers: [0, 'Code only'] })

    expect(readFileSync(join(other, 'tracked.txt'), 'utf8')).toBe('unrelated file, same name\n')
  })

  it('keeps the original checkpoints restorable when resumed back in the original directory', async () => {
    const t = setup()
    const { entry } = await resumeElsewhere(t)
    writeFileSync(join(t.repo, 'tracked.txt'), 'edited meanwhile\n')

    await t.handlers.get('session_start')?.({ reason: 'resume' }, t.makeCtx({ entries: [entry] }))
    await rewind(t, { entries: [entry], branch: [userEntry], answers: [0, 'Code only'] })

    expect(readFileSync(join(t.repo, 'tracked.txt'), 'utf8')).toBe('v1\n')
  })
})

describe('shadow repo init failure', () => {
  // chmod 0o555 does not make a directory unwritable on Windows, so the failure
  // this test simulates cannot be produced there.
  it.skipIf(process.platform === 'win32')('notifies that checkpoints are disabled when the shadow repo cannot be created', async () => {
    const t = setup()
    chmodSync(hoisted.home, 0o555)
    try {
      await t.handlers.get('session_start')?.({ reason: 'startup' }, t.makeCtx())
    } finally {
      chmodSync(hoisted.home, 0o755)
    }

    expect(t.notifications.some((n) => n.startsWith('[warning] Checkpoints disabled:'))).toBe(true)
  })
})
