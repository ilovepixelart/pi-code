/**
 * Loads the package at argv[2] the way pi loads an installed package (pi's package manager
 * expands the manifest, pi's loader imports each entry through jiti) and prints JSON: the
 * load errors, the number of extensions loaded, and every path under the package's
 * extensions directory that a statSync probed and did not find. Runs in its own process so
 * jiti's evaluations of the sources stay out of the suite's coverage.
 */
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

import { DefaultPackageManager, discoverAndLoadExtensions, SettingsManager } from '@earendil-works/pi-coding-agent'

const packageRoot = path.resolve(process.argv[2] ?? '.')
const extensionsDir = path.join(packageRoot, 'extensions')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-probe-'))
// The factories read the user's Claude config; an empty home keeps the developer's out.
process.env.HOME = home
process.env.USERPROFILE = home
const agentDir = path.join(home, 'agent')

// jiti stats through the CommonJS fs object, so the probe wraps that one.
const cjsFs = createRequire(import.meta.url)('node:fs') as typeof fs
const statSync = cjsFs.statSync
const misses = new Set<string>()
cjsFs.statSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
  let stats: fs.Stats | fs.BigIntStats | undefined
  try {
    stats = statSync(target, options)
  } catch (error) {
    misses.add(String(target))
    throw error
  }
  if (stats === undefined) misses.add(String(target))
  return stats
}) as typeof fs.statSync

const manager = new DefaultPackageManager({ cwd: home, agentDir, settingsManager: SettingsManager.inMemory() })
const resolved = await manager.resolveExtensionSources([packageRoot], { temporary: true })
const entries = resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path)
const result = await discoverAndLoadExtensions(entries, home, agentDir)
const sourceMisses = [...misses].filter((miss) => miss.startsWith(extensionsDir) && !miss.split(path.sep).includes('node_modules'))

// Exit once the output has flushed: the extensions leave handles open, and exiting before the
// write completes truncates a large result at the pipe's buffer size.
process.stdout.write(JSON.stringify({ errors: result.errors, loaded: result.extensions.length, sourceMisses }), () => process.exit(0))
