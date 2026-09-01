import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type AgentWorktree, cleanupAgentWorktree, createAgentWorktree } from '../extensions/subagent/worktree.ts'

/** A real throwaway repo: worktree behavior is git's, so the oracle is git itself. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.txt'), 'base\n')
  git('add', 'a.txt')
  git('commit', '-m', 'base')
  return dir
}

const asWorktree = (created: AgentWorktree | { error: string }): AgentWorktree => {
  if ('error' in created) throw new Error(`expected a worktree, got error: ${created.error}`)
  return created
}

describe('createAgentWorktree', () => {
  it('creates a worktree on a fresh branch from the default branch', async () => {
    const repo = makeRepo()
    const worktree = asWorktree(await createAgentWorktree(repo, 'deploy-bot'))
    expect(existsSync(join(worktree.dir, 'a.txt'))).toBe(true)
    expect(worktree.branch).toContain('deploy-bot')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.dir }).toString().trim()
    expect(head).toBe(worktree.baseSha)
  })

  it('reports an error outside a git repository instead of running unisolated', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'wt-plain-'))
    const created = await createAgentWorktree(plain, 'x')
    expect('error' in created).toBe(true)
  })
})

describe('cleanupAgentWorktree', () => {
  it('removes the worktree and branch when the agent made no changes', async () => {
    // Claude: "The worktree is automatically cleaned up if the subagent makes no changes."
    const repo = makeRepo()
    const worktree = asWorktree(await createAgentWorktree(repo, 'reader'))
    expect(await cleanupAgentWorktree(repo, worktree)).toBe('removed')
    expect(existsSync(worktree.dir)).toBe(false)
    const branches = execFileSync('git', ['branch', '--list'], { cwd: repo }).toString()
    expect(branches).not.toContain(worktree.branch)
  })

  it('keeps the worktree when the tree is dirty', async () => {
    const repo = makeRepo()
    const worktree = asWorktree(await createAgentWorktree(repo, 'writer'))
    writeFileSync(join(worktree.dir, 'a.txt'), 'changed\n')
    expect(await cleanupAgentWorktree(repo, worktree)).toBe('kept')
    expect(existsSync(worktree.dir)).toBe(true)
  })

  it('keeps the worktree when the agent committed past the base', async () => {
    const repo = makeRepo()
    const worktree = asWorktree(await createAgentWorktree(repo, 'committer'))
    writeFileSync(join(worktree.dir, 'b.txt'), 'new\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree.dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    git('config', 'user.email', 'test@test')
    git('config', 'user.name', 'test')
    git('add', 'b.txt')
    git('commit', '-m', 'work')
    expect(await cleanupAgentWorktree(repo, worktree)).toBe('kept')
    expect(existsSync(worktree.dir)).toBe(true)
  })
})
