import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { hookFiles } from '../extensions/hooks/index.ts'
import { claudeConfigDir } from '../extensions/internal/config-dir.ts'

const HOME = '/home/testuser'

describe('claudeConfigDir', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  it('defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeConfigDir(HOME)).toBe(path.join(HOME, '.claude'))
  })

  it('honors an absolute CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = '/opt/claude-config'
    expect(claudeConfigDir(HOME)).toBe('/opt/claude-config')
  })

  it('expands a leading ~ against home', () => {
    process.env.CLAUDE_CONFIG_DIR = '~/nested/cfg'
    expect(claudeConfigDir(HOME)).toBe(path.join(HOME, 'nested', 'cfg'))
  })

  it('resolves a relative CLAUDE_CONFIG_DIR to an absolute path', () => {
    process.env.CLAUDE_CONFIG_DIR = 'relative/cfg'
    expect(claudeConfigDir(HOME)).toBe(path.resolve('relative/cfg'))
  })

  it('ignores a blank CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = '   '
    expect(claudeConfigDir(HOME)).toBe(path.join(HOME, '.claude'))
  })
})

describe('config-dir sweep', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  it('a swept consumer (hookFiles) resolves the user settings under CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = '/opt/claude-config'
    const [userSettings] = hookFiles('/some/proj', HOME, false)
    expect(userSettings).toBe(path.join('/opt/claude-config', 'settings.json'))
  })
})

describe('ancestorDirs', () => {
  it('returns every matching directory from cwd up to the repository root, nearest first', async () => {
    const { ancestorDirs } = await import('../extensions/internal/project-root.ts')
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'walk-'))
    writeFileSync(join(root, 'package.json'), '{}')
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
    mkdirSync(join(root, 'apps', 'web', '.claude', 'agents'), { recursive: true })
    const cwd = join(root, 'apps', 'web')
    expect(ancestorDirs(cwd, join('.claude', 'agents'))).toEqual([join(cwd, '.claude', 'agents'), join(root, '.claude', 'agents')])
  })

  it('does not walk past the repository root', async () => {
    const { ancestorDirs } = await import('../extensions/internal/project-root.ts')
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const outer = mkdtempSync(join(tmpdir(), 'walk-'))
    mkdirSync(join(outer, '.claude', 'agents'), { recursive: true })
    const root = join(outer, 'repo')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    expect(ancestorDirs(root, join('.claude', 'agents'))).toEqual([])
  })
})
