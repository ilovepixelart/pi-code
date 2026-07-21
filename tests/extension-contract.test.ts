import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// pi's loader treats every extensions/*.ts and extensions/*/index.ts as an entry point and
// refuses to start when one does not default-export a factory (pi docs/extensions.md,
// "Extension Locations"). Shared helper modules must live in a subdirectory that has no
// index.ts, where the loader does not look.
const extensionsDir = path.resolve(import.meta.dirname, '..', 'extensions')

function scannedEntries(): [string, string][] {
  const entries: [string, string][] = []
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      entries.push([entry.name, path.join(extensionsDir, entry.name)])
    }
    if (entry.isDirectory()) {
      const index = path.join(extensionsDir, entry.name, 'index.ts')
      if (fs.existsSync(index)) entries.push([path.join(entry.name, 'index.ts'), index])
    }
  }
  return entries
}

describe('pi extension loader contract', () => {
  it.each(scannedEntries())('%s default-exports a factory function', async (_name, file) => {
    const mod = await import(file)
    expect(typeof mod.default).toBe('function')
  })
})
