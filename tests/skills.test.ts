import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import skillsExt, { skillDirs } from '../extensions/skills.ts'

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

describe('skills trust gating', () => {
  it('omits the project skills directory until the project is approved', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    // A project skill's name and description reach the model's prompt, so an
    // unapproved repository must not contribute them.
    expect(skillDirs(cwd, home, false)).toEqual([join(home, '.claude', 'skills')])
  })
})

describe('skillDirs', () => {
  it('returns nothing when no .claude/skills directory exists', () => {
    expect(skillDirs(tempDir('cs-proj-'), tempDir('cs-home-'), true)).toEqual([])
  })

  it('returns the project skills directory when it exists', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    expect(skillDirs(cwd, home, true)).toEqual([join(cwd, '.claude', 'skills')])
  })

  it('lists user skills before project skills', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    expect(skillDirs(cwd, home, true)).toEqual([join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')])
  })

  it('ignores a .claude/skills path that is a file, not a directory', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'skills'), 'not a dir')
    expect(skillDirs(cwd, home, true)).toEqual([])
  })
})

describe('extension wiring', () => {
  it('returns skillPaths from resources_discover when skills exist', async () => {
    const cwd = tempDir('cs-proj-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    // A .claude/skills directory is itself claude-shaped config, so a project pi
    // trusts silently still has no stored decision and contributes nothing.
    const ctx = { cwd, isProjectTrusted: () => true }
    const result = (await handlers.get('resources_discover')?.({ reason: 'startup' }, ctx)) as { skillPaths: string[] } | undefined
    expect(result?.skillPaths ?? []).not.toContain(join(cwd, '.claude', 'skills'))

    const untrusted = (await handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd, isProjectTrusted: () => false })) as { skillPaths: string[] } | undefined
    expect(untrusted?.skillPaths ?? []).not.toContain(join(cwd, '.claude', 'skills'))
  })
})
