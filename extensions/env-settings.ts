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
 * Precedence is per key, managed > user > project, matching Claude's merge: a scope
 * only supplies keys it names and never wipes another scope's keys. Values must be
 * strings; a number or boolean is coerced via String, anything else is skipped.
 *
 * A variable already present in the real environment that this module did not set is
 * left untouched for the user and project scopes: a shell `export` outranks them. The
 * managed scope is the exception: an org policy env must win over an ambient export, so
 * a managed key overwrites a preexisting shell value. The keys this module sets are
 * recorded so a later refresh can update them without clobbering unrelated env, and a
 * key an earlier apply set that the current merge no longer defines is unset (deleted
 * from process.env), so an approved project's env cannot leak into a later session or
 * project that does not define it. A managed overwrite of a shell var is owned like any
 * other set key; its original shell value cannot be restored, so on unset it is deleted.
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

/** Merge the three env scopes with Claude's per-key precedence managed > user >
 * project: lower scopes are laid down first and higher ones overlay, so each key
 * takes its highest-precedence value and no scope wipes another's keys. */
export function mergeEnvScopes(managed: Record<string, string>, user: Record<string, string>, project: Record<string, string>): Record<string, string> {
  return { ...project, ...user, ...managed }
}

/** Assign the merged env into `env`, recording each key set into `owned`. A key already
 * present that this module did not set (a shell export) is left untouched for user and
 * project keys; a `managedKeys` entry overwrites it (an org policy outranks the shell).
 * A key this module set before is updated. A previously-owned key that the current
 * `merged` no longer defines is unset (deleted from `env` and `owned`), so an approved
 * project's env cannot leak into a later apply that does not define it. */
export function applyEnvSettings(merged: Record<string, string>, env: NodeJS.ProcessEnv, owned: Set<string>, managedKeys: ReadonlySet<string> = new Set()): void {
  // Unset any key an earlier apply set that the current merge dropped. Iterate a copy
  // since `owned` is mutated. A shell export this module never owned is left in place.
  for (const key of Array.from(owned)) {
    if (!(key in merged)) {
      delete env[key]
      owned.delete(key)
    }
  }
  for (const [key, value] of Object.entries(merged)) {
    // A shell export outranks user/project (skip), but a managed key outranks even the
    // shell. Once owned, updates always apply. A managed overwrite is owned like any
    // set key: its shell value is gone and cannot be restored, so on unset it is deleted.
    if (key in env && !owned.has(key) && !managedKeys.has(key)) continue
    env[key] = value
    owned.add(key)
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
  const owned = new Set<string>()

  const apply = (home: string, project: Record<string, string>): void => {
    const managed = envFromSettings(readManagedSettings())
    applyEnvSettings(mergeEnvScopes(managed, userEnv(home), project), process.env, owned, new Set(Object.keys(managed)))
  }

  // Factory time: managed + user only. Approval needs the session ctx, so the project
  // scope waits for session_start; running here means these vars land before the first turn.
  apply(os.homedir(), {})

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    apply(os.homedir(), isProjectApprovedSilently(ctx) ? projectEnv(ctx.cwd) : {})
  })
}
