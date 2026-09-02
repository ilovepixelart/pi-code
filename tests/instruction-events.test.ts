import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { INSTRUCTIONS_CHANNEL, isInstructionLoadEvent, memoryTypeForPath, publishInstructionLoad } from '../extensions/internal/instruction-events.ts'

describe('isInstructionLoadEvent', () => {
  const minimal = { file_path: '/repo/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' }

  it('accepts a minimal event and one carrying the optional lazy-load fields', () => {
    expect(isInstructionLoadEvent(minimal)).toBe(true)
    expect(isInstructionLoadEvent({ ...minimal, load_reason: 'path_glob_match', globs: ['db/**'], trigger_file_path: '/repo/db/schema.sql' })).toBe(true)
    expect(isInstructionLoadEvent({ ...minimal, load_reason: 'include', parent_file_path: '/repo/CLAUDE.md' })).toBe(true)
  })

  it('accepts every memory type Claude documents', () => {
    for (const memoryType of ['User', 'Project', 'Local', 'Managed']) {
      expect(isInstructionLoadEvent({ ...minimal, memory_type: memoryType })).toBe(true)
    }
  })

  it('rejects junk, missing fields, and an unknown memory_type', () => {
    expect(isInstructionLoadEvent(null)).toBe(false)
    expect(isInstructionLoadEvent('junk')).toBe(false)
    expect(isInstructionLoadEvent({})).toBe(false)
    expect(isInstructionLoadEvent({ ...minimal, file_path: 42 })).toBe(false)
    expect(isInstructionLoadEvent({ ...minimal, load_reason: undefined })).toBe(false)
    expect(isInstructionLoadEvent({ ...minimal, memory_type: 'Enterprise' })).toBe(false)
  })

  it('rejects malformed optional fields rather than passing them to hook payloads', () => {
    expect(isInstructionLoadEvent({ ...minimal, globs: 'db/**' })).toBe(false)
    expect(isInstructionLoadEvent({ ...minimal, globs: [42] })).toBe(false)
    expect(isInstructionLoadEvent({ ...minimal, trigger_file_path: 42 })).toBe(false)
    expect(isInstructionLoadEvent({ ...minimal, parent_file_path: 42 })).toBe(false)
  })
})

describe('memoryTypeForPath', () => {
  // The classifier compares against root + path.sep, so the fixtures must carry
  // the platform separator; join derives them for both.
  const home = join('/home', 'u')
  const repo = join('/repo')

  it('classifies CLAUDE.local.md as Local wherever it sits', () => {
    expect(memoryTypeForPath(join(repo, 'CLAUDE.local.md'), home, repo)).toBe('Local')
    expect(memoryTypeForPath(join(home, 'proj', 'CLAUDE.local.md'), home, join(home, 'proj'))).toBe('Local')
  })

  it('classifies a file under home but outside the project as User', () => {
    expect(memoryTypeForPath(join(home, '.claude', 'CLAUDE.md'), home, repo)).toBe('User')
  })

  it('classifies a project file as Project even when the project lives under home', () => {
    expect(memoryTypeForPath(join(home, 'proj', 'CLAUDE.md'), home, join(home, 'proj'))).toBe('Project')
    expect(memoryTypeForPath(join(home, 'proj', '.claude', 'CLAUDE.md'), home, join(home, 'proj'))).toBe('Project')
  })

  it('does not treat a sibling directory with a home-prefixed name as under home', () => {
    expect(memoryTypeForPath(join('/home', 'username', 'x', 'CLAUDE.md'), home, repo)).toBe('Project')
  })

  it('classifies a git-root file above the nearest package marker as Project (monorepo)', () => {
    // repoRoot stops at the nearest .git OR package.json, so a subpackage session
    // reports a projectRoot below the git root; a context file in an ancestor of
    // that root is still project memory, not user config.
    expect(memoryTypeForPath(join(home, 'mono', 'CLAUDE.md'), home, join(home, 'mono', 'packages', 'app'))).toBe('Project')
  })

  it('keeps a home-level context file User even though home is an ancestor of the project', () => {
    expect(memoryTypeForPath(join(home, 'AGENTS.md'), home, join(home, 'proj'))).toBe('User')
  })

  it('falls back to Project for a path under neither root', () => {
    expect(memoryTypeForPath(join('/srv', 'shared', 'CLAUDE.md'), home, repo)).toBe('Project')
  })
})

describe('publishInstructionLoad', () => {
  const event = { file_path: '/repo/style.md', memory_type: 'Project' as const, load_reason: 'include', parent_file_path: '/repo/CLAUDE.md' }

  it('emits the event on the instructions channel', () => {
    const emitted: Array<{ channel: string; data: unknown }> = []
    publishInstructionLoad({ emit: (channel, data) => emitted.push({ channel, data }) }, event)
    expect(emitted).toEqual([{ channel: INSTRUCTIONS_CHANNEL, data: event }])
    expect(isInstructionLoadEvent(emitted[0].data)).toBe(true)
  })

  it('is a no-op without a bus, so a stub host cannot crash a producer', () => {
    expect(() => publishInstructionLoad(undefined, event)).not.toThrow()
  })
})
