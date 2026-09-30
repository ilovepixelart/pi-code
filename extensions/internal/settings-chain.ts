/**
 * The shared Claude settings chain: the ordered settings.json files a home-and-project
 * setting is read from, newest winning. User settings lead; the project's
 * settings.json and settings.local.json (each the nearest of its name at or above cwd,
 * falling back to cwd's own `.claude/`) follow only when the project is included, the
 * trust gate every caller applies; the `--settings` flag's snapshot comes last, above
 * them all, and `--setting-sources` drops the file sources it does not name (see
 * internal/cli-settings). Hooks, output styles, memory, the CLAUDE.md excludes, and
 * the skill-shell policy all resolve their files through this one chain.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { type CliSettings, cliSettings, type SettingSource } from './cli-settings.js'
import { claudeConfigDir } from './config-dir.js'
import { repoRoot } from './project-root.js'
import { isRecord } from './values.js'

/** Whether every path given exists and belongs to the user running this process.
 * A path that is absent is not someone else's, so it does not disqualify the root. */
function ownedByUser(paths: string[]): boolean {
  const uid = process.getuid?.()
  if (uid === undefined) return true
  return paths.every((target) => {
    try {
      return fs.statSync(target).uid === uid
    } catch {
      return true
    }
  })
}

/** Where `settings.local.json` lives, per Claude's four exceptions: it sits at the
 * repository root, except outside a repository, when that root is the home directory,
 * on Windows, or when the root or its `.git` or `.claude` entry belongs to someone
 * else. In each of those it stays beside `.claude/settings.json` in the working
 * directory instead. In a worktree the root is the main checkout, which repoRoot
 * resolves. */
function localSettingsDir(cwd: string, home: string, platform: NodeJS.Platform, owned: (paths: string[]) => boolean): string {
  const root = repoRoot(cwd)
  if (root === undefined || root === home) return cwd
  if (platform === 'win32') return cwd
  if (!owned([root, path.join(root, '.git'), path.join(root, '.claude')])) return cwd
  return root
}

/** Where a chain entry came from: a file source `--setting-sources` can name, or the
 * `--settings` flag. */
export type SettingsScope = SettingSource | 'flag'

export interface SettingsSource {
  file: string
  scope: SettingsScope
}

/** The chain with each file's scope, for the consumers that treat scopes differently
 * (the env sanitizer, the MCP consent rules). The user settings.json, then (only when
 * `includeProject`) the project files by Claude's placement rules: the shared
 * `.claude/settings.json` is read from the session's primary working directory (never
 * an ancestor; "to use a file committed at the repository root, start Claude Code
 * there"), while `settings.local.json` lives at the repository root, subject to the
 * exceptions in localSettingsDir. A legacy local file at the primary directory is
 * still read, with the root's values winning. The `--settings` snapshot ends the
 * chain whatever `includeProject` says: it is the user's own input, not the
 * repository's. Later files win. */
export function claudeSettingsSources(cwd: string, home: string, includeProject: boolean, platform: NodeJS.Platform = process.platform, owned: (paths: string[]) => boolean = ownedByUser, cli: CliSettings = cliSettings()): SettingsSource[] {
  const sources: SettingsSource[] = []
  if (cli.sources.has('user')) sources.push({ file: path.join(claudeConfigDir(home), 'settings.json'), scope: 'user' })
  if (includeProject && cli.sources.has('project')) sources.push({ file: path.join(cwd, '.claude', 'settings.json'), scope: 'project' })
  if (includeProject && cli.sources.has('local')) {
    // Compared as the directory the placement rule returned, not re-derived from a
    // joined path: path.join normalizes separators, so a cwd given POSIX-style on
    // Windows would never equal its own joined form and the legacy entry would repeat.
    const localDir = localSettingsDir(cwd, home, platform, owned)
    if (localDir !== cwd) sources.push({ file: path.join(cwd, '.claude', 'settings.local.json'), scope: 'local' })
    sources.push({ file: path.join(localDir, '.claude', 'settings.local.json'), scope: 'local' })
  }
  if (cli.settingsFile !== undefined) sources.push({ file: cli.settingsFile, scope: 'flag' })
  return sources
}

/** The chain as files alone: what most consumers read, in order, later files winning. */
export function claudeSettingsChain(cwd: string, home: string, includeProject: boolean, platform: NodeJS.Platform = process.platform, owned: (paths: string[]) => boolean = ownedByUser, cli: CliSettings = cliSettings()): string[] {
  return claudeSettingsSources(cwd, home, includeProject, platform, owned, cli).map((source) => source.file)
}

/** The settings.local.json the chain reads last, which is also where a setting a
 * command persists (an output-style choice, an MCP consent) must be written for the
 * chain to read it back: a file at any other level is never consulted. */
export function localSettingsFile(cwd: string, home: string, platform: NodeJS.Platform = process.platform, owned: (paths: string[]) => boolean = ownedByUser): string {
  return path.join(localSettingsDir(cwd, home, platform, owned), '.claude', 'settings.local.json')
}

/** One settings file as a JSON object, or undefined when missing, unparseable or not
 * an object: the single-file case of the chain, for the user-only settings a
 * repository must not influence (a notification channel, a question timeout, a
 * retention period). */
export function readSettingsFile(file: string): Record<string, unknown> | undefined {
  const first = readSettingsChain([file]).next()
  return first.done ? undefined : first.value
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
