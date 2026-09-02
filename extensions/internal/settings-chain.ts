/**
 * The shared Claude settings chain: the ordered settings.json files a home-and-project
 * setting is read from, newest winning. User settings always lead; the project's
 * settings.json and settings.local.json (each the nearest of its name at or above cwd,
 * falling back to cwd's own `.claude/`) follow only when the project is included, the
 * trust gate every caller applies. Hooks, output styles, memory, the CLAUDE.md excludes,
 * and the skill-shell policy all resolve their files through this one chain.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { claudeConfigDir } from './config-dir.js'
import { repoRoot } from './project-root.js'
import { isRecord } from './values.js'

/** The user settings.json, then (only when `includeProject`) the project files by
 * Claude's placement rules: the shared `.claude/settings.json` is read from the
 * session's primary working directory (never an ancestor; "to use a file committed
 * at the repository root, start Claude Code there"), while `settings.local.json`
 * lives at the repository root, falling back to the primary directory outside a
 * repository or when the root is the home directory. A legacy local file at the
 * primary directory is still read, with the root's values winning. Later files win. */
export function claudeSettingsChain(cwd: string, home: string, includeProject: boolean): string[] {
  const files = [path.join(claudeConfigDir(home), 'settings.json')]
  if (!includeProject) return files
  files.push(path.join(cwd, '.claude', 'settings.json'))
  const root = repoRoot(cwd)
  const localDir = root !== undefined && root !== home ? root : cwd
  if (localDir !== cwd) files.push(path.join(cwd, '.claude', 'settings.local.json'))
  files.push(path.join(localDir, '.claude', 'settings.local.json'))
  return files
}

/** Every readable settings object in the chain, in order, so the last one a caller
 * sees for a key is the one that wins. A file that is missing, unparseable, or not a
 * JSON object is skipped: a corrupt settings.json must not end the chain, or the
 * user-level values behind it would silently vanish along with it. Lazy, so a caller
 * that stops early does not read the rest. */
export function* readSettingsChain(files: readonly string[]): Generator<Record<string, unknown>> {
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      continue
    }
    if (isRecord(parsed)) yield parsed
  }
}
