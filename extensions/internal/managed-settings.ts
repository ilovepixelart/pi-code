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

/** The OS managed-settings.json path Claude Code documents per platform. */
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  // The legacy C:\ProgramData\ClaudeCode path was dropped in Claude Code v2.1.75.
  if (platform === 'win32') return String.raw`C:\Program Files\ClaudeCode\managed-settings.json`
  return '/etc/claude-code/managed-settings.json'
}

let managedSettingsFileOverride: string | undefined

/** Test seam: override the managed-settings.json path readers consult. */
export function setManagedSettingsPath(file?: string): void {
  managedSettingsFileOverride = file
}

/** The parsed managed settings object, or {} when absent or malformed. */
export function readManagedSettings(file: string = managedSettingsFileOverride ?? managedSettingsPath()): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // No managed policy on this machine.
  }
  return {}
}
