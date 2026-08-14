/**
 * Git Checkpoint Extension
 *
 * Claude Code style /rewind built on a per-session shadow git repo.
 *
 * Snapshots commit the entire working tree (untracked files included, the
 * project's .gitignore is honored) into a bare repo under
 * ~/.pi/agent/checkpoints/<session>, using --git-dir/--work-tree so the
 * project's own git state is never touched. Each user prompt gets one
 * checkpoint persisted as {entryId, ref, prompt, createdAt} in the session
 * file, so /rewind works across restarts, resumes, and forks. Code restore
 * checks the snapshot out over the working tree, resetting file contents to
 * the checkpoint (files created after the checkpoint are left in place).
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'

const CUSTOM_TYPE = 'git-checkpoint'
const PROMPT_SNIPPET_LENGTH = 60
const RESTORE_MODES = ['Code and conversation', 'Conversation only', 'Code only']

interface Checkpoint {
  entryId: string
  ref: string
  prompt: string
  createdAt: string
}

/** Claude deletes checkpoints after 30 days (cleanupPeriodDays). Shadow repos hold
 * full snapshots of every non-ignored file, so unbounded retention grows under $HOME
 * for the life of the machine. */
export const CHECKPOINT_RETENTION_DAYS = 30

/** Claude keeps the 100 most recent checkpoints per session. Older ones drop off the
 * rewind list; their commits stay in the shadow repo until the retention sweep. */
export const MAX_CHECKPOINTS_PER_SESSION = 100

/** The newest entries, up to the per-session cap, oldest first. */
export function capCheckpoints<T>(all: T[]): T[] {
  return all.length <= MAX_CHECKPOINTS_PER_SESSION ? all : all.slice(all.length - MAX_CHECKPOINTS_PER_SESSION)
}

/** Remove shadow repos untouched for longer than the retention window. The live
 * session's repo is always kept, whatever its age: a long session's directory mtime
 * can predate the window. Failures are ignored; this is housekeeping, not a gate. */
export function pruneCheckpointRepos(root: string, retentionDays: number, keepDir?: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (keepDir && path.resolve(dir) === path.resolve(keepDir)) continue
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // a repo we cannot stat or remove stays; housekeeping must not break startup
    }
  }
}

export function sessionSlug(sessionFile: string | undefined): string {
  if (!sessionFile) return `ephemeral-${process.pid}`
  return path.basename(sessionFile).replace(/[^\w.-]+/g, '_')
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
}

function promptSnippet(content: unknown): string {
  const text = extractText(content).replace(/\s+/g, ' ').trim()
  if (text.length <= PROMPT_SNIPPET_LENGTH) return text
  return `${text.slice(0, PROMPT_SNIPPET_LENGTH)}…`
}

function findLastUserMessage(ctx: ExtensionContext): { entryId: string; prompt: string } | undefined {
  const branch = ctx.sessionManager.getBranch()
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry?.type === 'message' && entry.message.role === 'user') {
      return { entryId: entry.id, prompt: promptSnippet(entry.message.content) }
    }
  }
  return undefined
}

function checkpointLabel(checkpoint: Checkpoint, index: number): string {
  const time = new Date(checkpoint.createdAt).toLocaleTimeString()
  const marker = checkpoint.ref ? '' : ' [no code snapshot]'
  return `${index + 1}. ${time}  ${checkpoint.prompt || '(empty prompt)'}${marker}`
}

async function restoreConversation(ctx: ExtensionCommandContext, entryId: string): Promise<boolean> {
  try {
    // navigateTree's published type omits editorText, but it is present at runtime (docs/extensions.md)
    const result = (await ctx.navigateTree(entryId, { summarize: false })) as { cancelled: boolean; editorText?: string }
    if (result.cancelled) return false
    if (typeof result.editorText === 'string') ctx.ui.setEditorText(result.editorText)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`Conversation restore failed: ${message}`, 'error')
    return false
  }
}

export default function gitCheckpointExtension(pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>()
  let pending: { ref: string; createdAt: string } | undefined
  let shadowDir: string | undefined
  let workTree: string | undefined

  function gitShadow(args: string[]): ReturnType<ExtensionAPI['exec']> {
    if (!shadowDir || !workTree) return Promise.resolve({ stdout: '', stderr: 'shadow repo not initialized', code: 1, killed: false })
    return pi.exec('git', ['--git-dir', shadowDir, '--work-tree', workTree, ...args], { cwd: workTree })
  }

  async function ensureShadow(ctx: ExtensionContext): Promise<void> {
    workTree = ctx.cwd
    const sessionFile = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.()
    const checkpointsRoot = path.join(os.homedir(), '.pi', 'agent', 'checkpoints')
    shadowDir = path.join(checkpointsRoot, sessionSlug(sessionFile))
    pruneCheckpointRepos(checkpointsRoot, CHECKPOINT_RETENTION_DAYS, shadowDir)
    const check = await pi.exec('git', ['--git-dir', shadowDir, 'rev-parse', '--git-dir'], { cwd: ctx.cwd })
    if (check.code !== 0) {
      const init = await pi.exec('git', ['init', '--bare', '-b', 'main', shadowDir], { cwd: ctx.cwd })
      if (init.code !== 0) {
        // Every later snapshot fails against the missing repo, so without this the
        // user first learns /rewind is dead at the moment they need it.
        ctx.ui.notify(`Checkpoints disabled: ${init.stderr.trim() || 'git init failed'}`, 'warning')
        return
      }
      await pi.exec('git', ['--git-dir', shadowDir, 'config', 'user.email', 'checkpoint@pi-code'], { cwd: ctx.cwd })
      await pi.exec('git', ['--git-dir', shadowDir, 'config', 'user.name', 'pi-code-checkpoint'], { cwd: ctx.cwd })
    }
  }

  /** `checkout -f <ref> -- .` errors when the ref's tree holds no files, so an empty
   * snapshot restores as a no-op rather than vetoing the whole rewind. */
  async function snapshotIsEmpty(ref: string): Promise<boolean> {
    const files = await gitShadow(['ls-tree', '-r', '--name-only', ref])
    return files.code === 0 && files.stdout.trim() === ''
  }

  async function snapshot(): Promise<{ ref: string; createdAt: string } | undefined> {
    const createdAt = new Date().toISOString()
    const add = await gitShadow(['add', '-A'])
    if (add.code !== 0) return undefined
    // Decide "nothing changed" from the index, not from the commit exit code: a commit can
    // also fail on the user's global signing or hooks config, and reusing HEAD then would
    // record a ref that predates the current tree, so /rewind restores the wrong state.
    const status = await gitShadow(['status', '--porcelain'])
    const nothingChanged = status.code === 0 && status.stdout.trim() === ''
    if (nothingChanged) {
      const head = await gitShadow(['rev-parse', 'HEAD'])
      if (head.code === 0) return { ref: head.stdout.trim(), createdAt }
      const empty = await commitShadow(['--allow-empty'])
      if (empty.code !== 0) return undefined
    } else {
      const commit = await commitShadow([])
      if (commit.code !== 0) return undefined // real failure: do not record a stale ref
    }
    const sha = await gitShadow(['rev-parse', 'HEAD'])
    return sha.code === 0 ? { ref: sha.stdout.trim(), createdAt } : undefined
  }

  /** Commit in the shadow repo, isolated from the user's global signing and hook config. */
  function commitShadow(extra: string[]): ReturnType<ExtensionAPI['exec']> {
    return gitShadow(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', ...extra, '-m', 'checkpoint'])
  }

  async function restoreCode(ctx: ExtensionCommandContext, checkpoint: Checkpoint): Promise<boolean> {
    if (!checkpoint.ref) {
      ctx.ui.notify('Checkpoint has no code snapshot; code left untouched', 'warning')
      return true
    }
    if (await snapshotIsEmpty(checkpoint.ref)) {
      ctx.ui.notify('Checkpoint has no files; code left untouched', 'warning')
      return true
    }
    const result = await gitShadow(['checkout', '-f', checkpoint.ref, '--', '.'])
    if (result.code !== 0) {
      ctx.ui.notify(`Code restore failed: ${result.stderr.trim()}`, 'warning')
      return false
    }
    return true
  }

  async function runRestoreMode(ctx: ExtensionCommandContext, checkpoint: Checkpoint): Promise<void> {
    const mode = await ctx.ui.select('Restore mode:', [...RESTORE_MODES])
    if (!mode) return
    if (mode !== 'Conversation only' && !(await restoreCode(ctx, checkpoint))) return
    if (mode !== 'Code only' && !(await restoreConversation(ctx, checkpoint.entryId))) return
    ctx.ui.notify('Rewind complete', 'info')
  }

  pi.on('session_start', async (_event, ctx) => {
    await ensureShadow(ctx)
    checkpoints.clear()
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== CUSTOM_TYPE) continue
      const checkpoint = entry.data as Checkpoint | undefined
      if (checkpoint?.entryId) checkpoints.set(checkpoint.entryId, checkpoint)
    }
  })

  // Snapshot code state before the LLM acts in this turn. The user message
  // that started the turn is not persisted yet at turn_start (it lands on
  // message_end), so the checkpoint is only keyed and saved at turn_end.
  pi.on('turn_start', async () => {
    pending = await snapshot()
  })

  pi.on('turn_end', async (_event, ctx) => {
    const snap = pending
    pending = undefined
    if (!snap) return

    const target = findLastUserMessage(ctx)
    if (!target || checkpoints.has(target.entryId)) return

    const checkpoint: Checkpoint = { entryId: target.entryId, ref: snap.ref, prompt: target.prompt, createdAt: snap.createdAt }
    checkpoints.set(checkpoint.entryId, checkpoint)
    // Bound the rewind list the way Claude does, dropping the oldest first.
    for (const stale of [...checkpoints.keys()].slice(0, Math.max(0, checkpoints.size - MAX_CHECKPOINTS_PER_SESSION))) {
      checkpoints.delete(stale)
    }
    pi.appendEntry(CUSTOM_TYPE, checkpoint)
  })

  pi.registerCommand('rewind', {
    description: 'Rewind code and/or conversation to a previous checkpoint',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return
      const ordered = [...checkpoints.values()].reverse()
      if (ordered.length === 0) {
        ctx.ui.notify('No checkpoints recorded yet', 'info')
        return
      }
      const labels = ordered.map((checkpoint, index) => checkpointLabel(checkpoint, index))
      const choice = await ctx.ui.select('Rewind to checkpoint:', labels)
      if (!choice) return
      const checkpoint = ordered[labels.indexOf(choice)]
      if (checkpoint) await runRestoreMode(ctx, checkpoint)
    },
  })

  pi.on('session_before_fork', async (event, ctx) => {
    const checkpoint = checkpoints.get(event.entryId)
    if (!checkpoint?.ref || !ctx.hasUI) return

    const choice = await ctx.ui.select('Restore code state?', ['Yes, restore code to that point', 'No, keep current code'])
    if (choice?.startsWith('Yes')) {
      if (await snapshotIsEmpty(checkpoint.ref)) {
        ctx.ui.notify('Checkpoint has no files; code left untouched', 'warning')
        return
      }
      const result = await gitShadow(['checkout', '-f', checkpoint.ref, '--', '.'])
      ctx.ui.notify(result.code === 0 ? 'Code restored to checkpoint' : `Restore failed: ${result.stderr.trim()}`, result.code === 0 ? 'info' : 'warning')
    }
  })
}
