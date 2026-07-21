import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// pi's loader treats every extensions/*.ts, extensions/*.js (symlinked or not) and
// extensions/*/index.ts|index.js as an entry point and refuses to start when one does
// not default-export a factory (pi dist/core/extensions/loader). Shared helper modules
// must live in a subdirectory that has no index file, where the loader does not look.
const extensionsDir = path.resolve(import.meta.dirname, '..', 'extensions')

const isEntryName = (name: string): boolean => name.endsWith('.ts') || name.endsWith('.js')

function scannedEntries(): [string, string][] {
  const entries: [string, string][] = []
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && isEntryName(entry.name)) {
      entries.push([entry.name, path.join(extensionsDir, entry.name)])
    }
    if (entry.isDirectory()) {
      for (const index of ['index.ts', 'index.js']) {
        const indexPath = path.join(extensionsDir, entry.name, index)
        if (fs.existsSync(indexPath)) entries.push([path.join(entry.name, index), indexPath])
      }
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
