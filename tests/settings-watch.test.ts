import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchSettingsFiles } from '../extensions/internal/settings-watch.ts'

describe('watchSettingsFiles', () => {
  let dispose: () => void = () => {}
  afterEach(() => dispose())

  it('keeps polling when a reload throws, since the poll has no awaiter', async () => {
    // A throw from the interval callback is an uncaughtException, and pi exits on one: a
    // reload reading a malformed plugin manifest took the whole session down with it.
    process.env.PI_CODE_SETTINGS_WATCH_INTERVAL_MS = '25'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(mkdtempSync(join(tmpdir(), 'watch-')), 'settings.json')
    writeFileSync(file, '{"v":1}')
    let reloads = 0
    dispose = watchSettingsFiles([file], () => {
      reloads++
      if (reloads === 1) throw new Error('malformed manifest')
    })

    writeFileSync(file, '{"v":2}')
    await vi.waitFor(() => expect(reloads).toBe(1), { timeout: 3000 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed manifest'))

    writeFileSync(file, '{"v":3}')
    await vi.waitFor(() => expect(reloads).toBe(2), { timeout: 3000 })
  })
})
