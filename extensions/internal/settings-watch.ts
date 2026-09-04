/**
 * Mid-session settings watching, Claude's "picked up automatically by the file
 * watcher". Polling stat watchers rather than fs.watch: editors replace files via
 * rename, which event watchers miss on some platforms, and a missing file that
 * appears later must start reporting too, which stat polling handles uniformly.
 */

import * as fs from 'node:fs'
import { parseNumericEnv } from './values.js'

// Captured at module load: the poll must run on real time even under a test's
// fake timers (the stat watcher it replaced lived in libuv and was immune too);
// otherwise fake-timer advances spin the poll and freeze real detection.
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

/** One file's content, or undefined when absent or unreadable. */
function snapshot(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }
}

/** Watch the given settings files, calling `reload` when any of them changes.
 * Returns a dispose function. The poll compares content, not stats: a same-size
 * rewrite within one timestamp tick is invisible to an mtime comparison on a
 * coarse-granularity filesystem, which made detection flaky. Settings files are
 * small, so re-reading them on the poll is negligible. The interval is
 * env-tunable for tests. */
export function watchSettingsFiles(files: string[], reload: () => void): () => void {
  const configured = parseNumericEnv(process.env.PI_CODE_SETTINGS_WATCH_INTERVAL_MS)
  const interval = configured !== undefined && configured > 0 ? configured : 2000
  let last = files.map(snapshot)
  const timer = realSetInterval(() => {
    const next = files.map(snapshot)
    if (next.some((content, index) => content !== last[index])) {
      last = next
      reload()
    }
  }, interval)
  // A watcher alone must never keep a one-shot run alive.
  timer.unref?.()
  return () => realClearInterval(timer)
}
