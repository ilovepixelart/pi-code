/**
 * The shared Claude settings chain: the ordered settings.json files a home-and-project
 * setting is read from, newest winning. User settings always lead; the project's
 * settings.json and settings.local.json (each the nearest of its name at or above cwd,
 * falling back to cwd's own `.claude/`) follow only when the project is included, the
 * trust gate every caller applies. Hooks, output styles, memory, the CLAUDE.md excludes,
 * and the skill-shell policy all resolve their files through this one chain.
 */

import * as path from 'node:path'
import { claudeConfigDir } from './config-dir.js'
import { findNearestFile } from './project-root.js'

/** The user settings.json, then (only when `includeProject`) the nearest project
 * settings.json and settings.local.json at or above cwd, with cwd's own `.claude/` as
 * the fallback for each. Later files win. */
export function claudeSettingsChain(cwd: string, home: string, includeProject: boolean): string[] {
  const files = [path.join(claudeConfigDir(home), 'settings.json')]
  if (!includeProject) return files
  for (const name of ['settings.json', 'settings.local.json']) {
    files.push(findNearestFile(cwd, path.join('.claude', name)) ?? path.join(cwd, '.claude', name))
  }
  return files
}
