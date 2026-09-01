/**
 * settings.json `env` injection.
 *
 * Claude Code lets any settings scope carry an `env` object whose keys are exported
 * into the session's environment. This extension applies that chain to process.env:
 * managed-settings.json (enterprise policy), ~/.claude/settings.json (user), and the
 * project's .claude/settings.json plus settings.local.json.
 *
 * Two things run this. The factory body applies managed + user immediately (as pi
 * loads extensions), so those variables are present before the first turn; a session
 * that never approves a project still gets them. session_start refreshes and, only
 * when the project is approved, folds in the project scope. The project scope stays
 * approval-gated on purpose: a checked-out repository's env can redirect providers
 * (ANTHROPIC_BASE_URL and friends), so an untrusted repo must not reach process.env.
 *
 * Precedence is per key, managed > project (settings.local.json overlaying
 * settings.json inside the project scope) > user, matching Claude's settings
 * precedence: a scope only supplies keys it names and never wipes another scope's
 * keys. Values must be strings; a number or boolean is coerced via String,
 * anything else is skipped.
 *
 * A settings value replaces a value inherited from the shell, as Claude documents
 * ("Claude Code writes each env entry into the process environment, replacing the
 * value inherited from the shell"), and an empty string is the documented way to
 * override an export that cannot be unset. The original value of each key is
 * recorded so a later apply that no longer defines the key restores the shell's
 * value (or deletes a key the shell never had), so an approved project's env
 * cannot leak into a later session or project that does not define it. The keys a
 * repository must not control are dropped from the project scope before any of
 * this (see sanitizeProjectEnv).
 *
 * Docs: https://code.claude.com/docs/en/settings.md
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { claudeConfigDir } from './internal/config-dir.js'
import { readManagedSettings } from './internal/managed-settings.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { findNearestFile } from './internal/project-root.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `env` object of one settings scope, coerced to string values. A string is kept
 * as-is, a number or boolean becomes its String() form, and anything else (object,
 * array, null) is dropped, matching Claude which only injects string-valued env. */
export function envFromSettings(settings: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(settings) || !isRecord(settings.env)) return out
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
  }
  return out
}

/** Merge the three env scopes with Claude's per-key settings precedence managed >
 * project > user: lower scopes are laid down first and higher ones overlay, so each
 * key takes its highest-precedence value and no scope wipes another's keys. */
export function mergeEnvScopes(managed: Record<string, string>, user: Record<string, string>, project: Record<string, string>): Record<string, string> {
  return { ...user, ...project, ...managed }
}

/** Assign the merged env into `env`. Every settings value applies, replacing a
 * shell-inherited value, as Claude documents; an empty string is the documented
 * override for an export that cannot be unset. `owned` records each key's original
 * value at first ownership, so a later apply that drops the key restores the
 * shell's value (or deletes a key the shell never had) rather than leaking a stale
 * setting into the rest of the process. */
export function applyEnvSettings(merged: Record<string, string>, env: NodeJS.ProcessEnv, owned: Map<string, string | undefined>): void {
  // Restore any key an earlier apply set that the current merge dropped. Iterate a
  // copy since `owned` is mutated.
  for (const [key, original] of Array.from(owned.entries())) {
    if (key in merged) continue
    if (original === undefined) delete env[key]
    else env[key] = original
    owned.delete(key)
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!owned.has(key)) owned.set(key, env[key])
    env[key] = value
  }
}

function readSettingsFile(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (isRecord(parsed)) return parsed
  } catch {
    // missing or invalid file: no env from this scope
  }
  return {}
}

/** The user scope's env: ~/.claude/settings.json (relocated by CLAUDE_CONFIG_DIR). */
function userEnv(home: string): Record<string, string> {
  return envFromSettings(readSettingsFile(path.join(claudeConfigDir(home), 'settings.json')))
}

/** Keys a checked-out repository must not control even once trusted, per Claude's
 * documented drop list: variables that choose where config and files are written
 * (redirecting later home-scope reads and every subprocess), variables that export
 * session content, and variables that change how the agent starts or syncs.
 * PI_CODING_AGENT_DIR is pi's own config-dir analogue of CLAUDE_CONFIG_DIR. */
const REPO_HOSTILE_ENV_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'OTEL_LOG_RAW_API_BODIES',
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
  'CLAUDE_CODE_PROCESS_WRAPPER',
  'CLAUDE_CODE_SYNC_SKILLS',
  'CLAUDE_CODE_SYNC_PLUGINS',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'PI_CODING_AGENT_DIR',
])

/** Drop the keys a repository's settings must not set, warning each, as Claude
 * documents ("Claude Code drops each one and logs a warning"). Set them in the
 * shell, user settings, or managed settings instead. */
export function sanitizeProjectEnv(env: Record<string, string>, warn: (key: string) => void = (key) => console.warn(`pi-code-env: dropping ${key} from project settings env (a checked-out repository must not control it; set it in user or managed settings)`)): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (REPO_HOSTILE_ENV_KEYS.has(key) || key.startsWith('XDG_')) warn(key)
    else kept[key] = value
  }
  return kept
}

/** The project scope's env: .claude/settings.json with settings.local.json overlaid,
 * each the nearest of its name at or above cwd (matching the hooks settings chain). */
function projectEnv(cwd: string): Record<string, string> {
  const base = envFromSettings(readSettingsFile(findNearestFile(cwd, path.join('.claude', 'settings.json')) ?? path.join(cwd, '.claude', 'settings.json')))
  const local = envFromSettings(readSettingsFile(findNearestFile(cwd, path.join('.claude', 'settings.local.json')) ?? path.join(cwd, '.claude', 'settings.local.json')))
  return sanitizeProjectEnv({ ...base, ...local })
}

export default function envSettingsExtension(pi: ExtensionAPI) {
  const owned = new Map<string, string | undefined>()

  const apply = (home: string, project: Record<string, string>): void => {
    applyEnvSettings(mergeEnvScopes(envFromSettings(readManagedSettings()), userEnv(home), project), process.env, owned)
  }

  // Factory time: managed + user only. Approval needs the session ctx, so the project
  // scope waits for session_start; running here means these vars land before the first turn.
  apply(os.homedir(), {})

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    apply(os.homedir(), isProjectApprovedSilently(ctx) ? projectEnv(ctx.cwd) : {})
  })
}
