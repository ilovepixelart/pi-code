/**
 * Managed settings: Claude's enterprise policy file.
 *
 * Claude Code reads managed-settings.json from an OS-level location that IT
 * deploys and that is not user- or repo-writable in the normal flow, so keys
 * sourced from it carry organizational authority (managed `claudeMd`, exclusion
 * lists, MCP allow/deny). Managed-only keys are honored from this file alone:
 * the same key in user or project settings is ignored, so a repository or a
 * local settings edit can neither impersonate nor override the policy.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { isRecord } from './values.js'

/** The OS managed-settings.json path Claude Code documents per platform. */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  // Claude reads the Windows file from Program Files; the older ProgramData location is not consulted.
  if (platform === 'win32') return String.raw`C:\Program Files\ClaudeCode\managed-settings.json`
  return '/etc/claude-code/managed-settings.json'
}

let managedSettingsFileOverride: string | undefined

/** Test seam: override the managed-settings.json path readers consult. */
export function setManagedSettingsPath(file?: string): void {
  managedSettingsFileOverride = file
}

/** The managed-settings.json path in effect, honoring the test-seam override. */
export function managedSettingsFile(): string {
  return managedSettingsFileOverride ?? managedSettingsPath()
}

/** Files already reported as unparsable. Managed settings are read from sixteen call
 * sites, several of them once per turn, so one warning per broken file is the whole
 * budget; the same warn-once shape project-approval.ts uses for its runtime notice. */
const warnedUnparsable = new Set<string>()

function readOneSettingsFile(file: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return {} // no such file: genuinely no managed policy on this machine
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) return parsed
  } catch {
    // Present but unparsable is an administrator's typo, not an absent policy. Silence
    // there disabled every policy the file carries (exclusion lists, MCP allow and deny,
    // enabledPlugins, disableAllHooks) on every session, with nothing said anywhere.
    if (!warnedUnparsable.has(file)) {
      warnedUnparsable.add(file)
      console.warn(`pi-code: ignoring ${file}: not valid JSON; the managed policy it carries is not applied`)
    }
  }
  return {}
}

/** Claude's managed-settings.d merge rules: a later single value replaces, lists
 * combine with duplicates removed, and nested blocks merge key by key with each
 * key following these same rules. */
function mergeManagedKey(base: unknown, next: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(next)) return [...new Set([...base, ...next])]
  if (isRecord(base) && isRecord(next)) {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(next)) merged[key] = key in merged ? mergeManagedKey(merged[key], value) : value
    return merged
  }
  return next
}

/** The parsed managed settings object, or {} when absent or malformed. Claude also
 * merges an optional managed-settings.d/ directory next to the file: every *.json
 * in alphabetical order after the base file, hidden files and non-json ignored. */
export function readManagedSettings(file: string = managedSettingsFileOverride ?? managedSettingsPath()): Record<string, unknown> {
  let merged = readOneSettingsFile(file)
  const dropInDir = path.join(path.dirname(file), 'managed-settings.d')
  let entries: string[]
  try {
    entries = fs.readdirSync(dropInDir)
  } catch {
    return merged
  }
  for (const entry of entries.filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort((a, b) => a.localeCompare(b, 'en'))) {
    merged = mergeManagedKey(merged, readOneSettingsFile(path.join(dropInDir, entry))) as Record<string, unknown>
  }
  return merged
}
