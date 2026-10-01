/**
 * pi-code's own version, read from the package.json packaging publishes, so it lives in
 * exactly one place. Empty when the manifest cannot be read.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const PACKAGE_VERSION = ((): string => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8')).version ?? '')
  } catch {
    return ''
  }
})()
