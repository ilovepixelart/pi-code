/**
 * Claude's subagent `isolation: worktree`: a temporary git worktree giving the
 * child an isolated copy of the repository, branched from the repository's default
 * branch (origin/HEAD, falling back to main/master, then the current HEAD) rather
 * than the parent session's HEAD, and automatically cleaned up when the subagent
 * makes no changes. Divergence, documented in the subagent README: pi sets the
 * child's working directory into the worktree but does not police commands that
 * navigate back out, which Claude additionally enforces per call.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { errorMessage } from '../internal/values.js'

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await promisify(execFile)('git', args, { cwd })
  return stdout.trim()
}

export interface AgentWorktree {
  dir: string
  branch: string
  /** The commit the worktree started from; unchanged HEAD plus a clean tree means
   * the agent made no changes and the worktree can go. */
  baseSha: string
}

async function defaultBranch(repoCwd: string): Promise<string> {
  try {
    return await git(repoCwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  } catch {
    // No origin/HEAD (local-only repo, or never fetched): try the conventional names.
  }
  for (const name of ['main', 'master']) {
    try {
      await git(repoCwd, 'show-ref', '--verify', `refs/heads/${name}`)
      return name
    } catch {
      // Not this one.
    }
  }
  return 'HEAD'
}

/** Create the temporary worktree, or explain why it cannot exist (not a git
 * repository, git failure): the caller must fail the run rather than silently
 * dropping the isolation boundary the agent declared. */
export async function createAgentWorktree(repoCwd: string, agentName: string): Promise<AgentWorktree | { error: string }> {
  try {
    await git(repoCwd, 'rev-parse', '--is-inside-work-tree')
  } catch {
    return { error: `${repoCwd} is not a git repository` }
  }
  const suffix = randomUUID().slice(0, 8)
  const safeName = agentName.replace(/[^A-Za-z0-9_-]+/g, '-')
  const dir = path.join(os.tmpdir(), `pi-agent-worktree-${safeName}-${suffix}`)
  const branch = `agent/${safeName}-${suffix}`
  try {
    await git(repoCwd, 'worktree', 'add', '-b', branch, dir, await defaultBranch(repoCwd))
    return { dir, branch, baseSha: await git(dir, 'rev-parse', 'HEAD') }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

/** Remove the worktree and its branch when the agent made no changes (clean tree,
 * HEAD still at the base), as Claude documents; keep both otherwise so the changes
 * survive for the parent to inspect. A cleanup that fails keeps the worktree:
 * losing work is the only unacceptable outcome here. */
export async function cleanupAgentWorktree(repoCwd: string, worktree: AgentWorktree): Promise<'removed' | 'kept'> {
  try {
    const status = await git(worktree.dir, 'status', '--porcelain')
    const head = await git(worktree.dir, 'rev-parse', 'HEAD')
    if (status.length > 0 || head !== worktree.baseSha) return 'kept'
    await git(repoCwd, 'worktree', 'remove', worktree.dir)
    await git(repoCwd, 'branch', '-D', worktree.branch)
    return 'removed'
  } catch {
    return 'kept'
  }
}
