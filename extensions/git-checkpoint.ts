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

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { claudeConfigDir } from './internal/config-dir.js'
import { errorMessage } from './internal/values.js'

const CUSTOM_TYPE = 'git-checkpoint'
/** Sidecar inside the bare shadow repo recording the work tree it snapshots. */
const WORK_TREE_FILE = 'pi-work-tree'
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

/** The retention period in effect: Claude keeps checkpoints for 30 days and says to
 * "change the period with cleanupPeriodDays". Read from the user scope, which is where a
 * setting about the user's own disk belongs; a non-positive or unreadable value keeps the
 * default rather than sweeping everything away. */
export function checkpointRetentionDays(home: string = os.homedir()): number {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(home), 'settings.json'), 'utf-8'))
    const declared = (parsed as { cleanupPeriodDays?: unknown }).cleanupPeriodDays
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return declared
  } catch {
    // No user settings, or unreadable: the default period stands.
  }
  return CHECKPOINT_RETENTION_DAYS
}

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

/** A stable per-directory key, so a session resumed elsewhere gets its own shadow. */
function cwdSlug(cwd: string): string {
  const resolved = path.resolve(cwd)
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8)
  return `${path.basename(resolved).replace(/[^\w.-]+/g, '_')}-${hash}`
}

/** The work tree a shadow repo was created against, or undefined for a repo that
 * predates the sidecar or does not exist yet. */
function recordedWorkTree(shadowDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(shadowDir, WORK_TREE_FILE), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function rememberWorkTree(shadowDir: string, cwd: string): void {
  try {
    fs.writeFileSync(path.join(shadowDir, WORK_TREE_FILE), `${cwd}\n`)
  } catch {
    // best effort: without the marker the next resume simply cannot detect a move
  }
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
    const message = errorMessage(error)
    ctx.ui.notify(`Conversation restore failed: ${message}`, 'error')
    return false
  }
}

export default function gitCheckpointExtension(pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>()
  let pending: { ref: string; createdAt: string } | undefined
  // A run (one user message) needs a single pre-run snapshot, no matter how many
  // assistant turns it drives. before_agent_start starts a run; the first turn_start
  // then snapshots and clears this, so turns 2..n skip the wasted git work.
  let runNeedsSnapshot = true
  let shadowDir: string | undefined
  let workTree: string | undefined

  function gitShadow(args: string[]): ReturnType<ExtensionAPI['exec']> {
    if (!shadowDir || !workTree) return Promise.resolve({ stdout: '', stderr: 'shadow repo not initialized', code: 1, killed: false })
    // A snapshot layer must be byte-faithful: with the host's autocrlf (the
    // Windows default) the shadow checkout would rewrite every restored file's
    // line endings, so conversion is pinned off for every shadow operation.
    return pi.exec('git', ['-c', 'core.autocrlf=false', '--git-dir', shadowDir, '--work-tree', workTree, ...args], { cwd: workTree })
  }

  async function ensureShadow(ctx: ExtensionContext): Promise<void> {
    workTree = ctx.cwd
    const sessionFile = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.()
    const checkpointsRoot = path.join(os.homedir(), '.pi', 'agent', 'checkpoints')
    shadowDir = path.join(checkpointsRoot, sessionSlug(sessionFile))
    // A resumed session can arrive from a different directory than the one the shadow
    // snapshotted; restoring those commits here would silently overwrite unrelated
    // same-named files. Key a fresh shadow to this directory instead of ever checking
    // one tree out into another. Resuming back in the recorded directory takes the
    // original shadow again, so its checkpoints stay restorable there.
    const recorded = recordedWorkTree(shadowDir)
    if (recorded && path.resolve(recorded) !== path.resolve(ctx.cwd)) {
      shadowDir = path.join(checkpointsRoot, `${sessionSlug(sessionFile)}-${cwdSlug(ctx.cwd)}`)
      ctx.ui.notify(`Checkpoints for this session were recorded in ${recorded}; starting fresh checkpoints for ${ctx.cwd} (earlier ones are not restorable here)`, 'warning')
    }
    pruneCheckpointRepos(checkpointsRoot, checkpointRetentionDays(os.homedir()), shadowDir)
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
    // Written on every start, so repos that predate the sidecar pick it up too.
    rememberWorkTree(shadowDir, ctx.cwd)
    await mirrorLocalExcludes(ctx)
  }

  /** git reads ignore rules from the tree's .gitignore files, the user's global excludes,
   * and $GIT_DIR/info/exclude. The shadow is the GIT_DIR here, so the repo's own
   * .git/info/exclude (where secrets and scratch that must never be committed live)
   * would be snapshotted and restored. Mirror it into the shadow on every start; the
   * global excludes stay untouched (core.excludesFile is single-valued, so pointing it
   * at the repo file would replace them). */
  async function mirrorLocalExcludes(ctx: ExtensionContext): Promise<void> {
    const cwd = ctx.cwd
    if (!shadowDir) return
    // Resolved through git so a linked worktree maps to its common dir; outside a repo
    // git exits 128 and there is nothing to mirror.
    const located = await pi.exec('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd })
    const target = path.join(shadowDir, 'info', 'exclude')
    try {
      const source = located.code === 0 ? path.resolve(cwd, located.stdout.trim()) : undefined
      if (source && fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target)
      } else {
        fs.rmSync(target, { force: true })
      }
    } catch (error) {
      // Without the mirror, files the user excluded locally are snapshotted into the
      // checkpoint store and restored by /rewind, so this is not a silent fallback.
      ctx.ui.notify(`Checkpoints cannot honor this repository's .git/info/exclude: ${errorMessage(error)}`, 'warning')
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
    // One extension instance serves every session. A mid-turn /new fires session_start on
    // the same instance after turn_start took the pre-run snapshot but before turn_end saved
    // it; that pending ref belongs to the previous session and must not attach to the next
    // session's first turn_end. Re-arm runNeedsSnapshot too, so the next run snapshots its
    // own tree even though the prior run left it false.
    pending = undefined
    runNeedsSnapshot = true
    await ensureShadow(ctx)
    checkpoints.clear()
    const stored: Checkpoint[] = []
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== CUSTOM_TYPE) continue
      const checkpoint = entry.data as Checkpoint | undefined
      if (checkpoint?.entryId) stored.push(checkpoint)
    }
    // The same cap the append path enforces: a resumed long session must not
    // rebuild a rewind list beyond the per-session limit.
    for (const checkpoint of capCheckpoints(stored)) checkpoints.set(checkpoint.entryId, checkpoint)
  })

  // A new agent loop starts a run: the next turn_start snapshots the pre-run tree.
  // agent_start, not before_agent_start: before_agent_start does not fire for a queued
  // follow-up message delivered through agent.continue, so gating on it would leave that
  // follow-up's user message with no checkpoint. agent_start re-fires per agent.continue
  // (a retry, a compaction, or a follow-up), and the extra snapshot a retry produces is
  // discarded at turn_end, since that user message already has its checkpoint.
  pi.on('agent_start', async () => {
    runNeedsSnapshot = true
  })

  // Snapshot code state before the LLM acts, once per run. The user message that
  // started the turn is not persisted yet at turn_start (it lands on message_end), so
  // the checkpoint is only keyed and saved at turn_end. The snapshot is awaited here so
  // `git add -A` captures the tree before the model's first edit; turn_end reads the
  // resolved value.
  pi.on('turn_start', async () => {
    if (!runNeedsSnapshot) return
    runNeedsSnapshot = false
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
