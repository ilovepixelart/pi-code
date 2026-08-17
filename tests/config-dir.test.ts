import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { hookFiles } from '../extensions/hooks.ts'
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
