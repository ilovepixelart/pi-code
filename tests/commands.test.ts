import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import commandsExt, { commandDirs } from '../extensions/commands.ts'

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

describe('commandDirs', () => {
  it('returns nothing when no .claude/commands directory exists', () => {
    expect(commandDirs(tempDir('cc-proj-'), tempDir('cc-home-'))).toEqual([])
  })

  it('returns the project commands directory when it exists', () => {
    const cwd = tempDir('cc-proj-')
    const home = tempDir('cc-home-')
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })
    expect(commandDirs(cwd, home)).toEqual([join(cwd, '.claude', 'commands')])
  })

  it('lists user commands before project commands', () => {
    const cwd = tempDir('cc-proj-')
    const home = tempDir('cc-home-')
    mkdirSync(join(home, '.claude', 'commands'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })
    expect(commandDirs(cwd, home)).toEqual([join(home, '.claude', 'commands'), join(cwd, '.claude', 'commands')])
  })

  it('ignores a .claude/commands path that is a file, not a directory', () => {
    const cwd = tempDir('cc-proj-')
    const home = tempDir('cc-home-')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    // .claude/commands exists but is not a directory
    writeFileSync(join(cwd, '.claude', 'commands'), 'not a dir')
    expect(commandDirs(cwd, home)).toEqual([])
  })
})

describe('extension wiring', () => {
  it('returns promptPaths from resources_discover when commands exist', async () => {
    const cwd = tempDir('cc-proj-')
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    commandsExt({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    const result = (await handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd })) as { promptPaths: string[] } | undefined

    expect(result?.promptPaths).toContain(join(cwd, '.claude', 'commands'))
  })
})
