/**
 * Mid-session settings watching, Claude's "picked up automatically by the file
 * watcher". Polling stat watchers rather than fs.watch: editors replace files via
 * rename, which event watchers miss on some platforms, and a missing file that
 * appears later must start reporting too, which stat polling handles uniformly.
 */

import * as fs from 'node:fs'

/** Watch the given settings files, calling `reload` when any of them changes.
 * Returns a dispose function. The poll interval is env-tunable for tests. */
export function watchSettingsFiles(files: string[], reload: () => void): () => void {
  const interval = Number(process.env.PI_CODE_SETTINGS_WATCH_INTERVAL_MS) || 2000
  const listeners: Array<[string, (curr: fs.Stats, prev: fs.Stats) => void]> = []
  for (const file of files) {
    const listener = (curr: fs.Stats, prev: fs.Stats): void => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) reload()
    }
    // persistent: false, so a watcher alone never keeps a one-shot run alive.
    fs.watchFile(file, { interval, persistent: false }, listener)
    listeners.push([file, listener])
  }
  return () => {
    for (const [file, listener] of listeners) fs.unwatchFile(file, listener)
  }
}
