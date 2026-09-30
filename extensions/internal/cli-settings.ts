/**
 * Claude's `--settings` and `--setting-sources` flags: the command-line level of the
 * settings precedence (docs/specs/settings-flags.md).
 *
 * `--settings` takes a path to a settings JSON file or an inline JSON string, applied
 * above the user, project and local files and below managed settings for one session.
 * It is read once, at startup: Claude's reload covers user, project, local and managed
 * settings and not this flag, and a generated file that concurrent invocations share
 * must not leak from one into another. So the file (or the inline object) is copied to
 * a private 0600 file that the settings chain reads for the rest of the process, and a
 * subagent child is handed that copy rather than the original.
 *
 * `--setting-sources` lists which of user, project and local load; an empty list loads
 * none, as the SDK documents for `settingSources: []`. Managed settings are not a
 * source and always load.
 *
 * Validation follows Claude Code 2.1.285 as measured: a value that does not parse as a
 * JSON object is a path, resolved against cwd; a missing file is "Settings file not
 * found: <path>"; every other refusal is "Cannot use settings file (<reason>): <path>";
 * an unknown source is "Invalid setting source: <name>. Valid options are: user,
 * project, local". Claude exits 1 on each; the settings-flags extension reports them
 * and shuts pi down.
 *
 * The resolved value travels through a process-wide slot (see shared-slot): pi exposes
 * a flag's value only to the extension that registered it, and every extension holds
 * its own copy of this module.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sharedSlot } from './shared-slot.js'
import { errorMessage, isRecord } from './values.js'

export type SettingSource = 'user' | 'project' | 'local'

export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local']

/** Claude: "The file must be a regular file no larger than 2 MiB." */
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024

export interface CliSettings {
  /** The private copy of the `--settings` value; undefined without the flag or when it was refused. */
  settingsFile: string | undefined
  /** The file sources `--setting-sources` allows; all three without the flag or when it was refused. */
  sources: ReadonlySet<SettingSource>
  /** The flags a child pi needs to read the same settings. */
  forwardArgs: string[]
  /** Each refused flag's message, in Claude's wording. */
  errors: string[]
}

function noFlags(): CliSettings {
  return { settingsFile: undefined, sources: new Set(SETTING_SOURCES), forwardArgs: [], errors: [] }
}

/** The sources a `--setting-sources` value names. Whitespace and repeats are
 * tolerated; an unknown name refuses the whole flag, which then loads every source. */
export function parseSettingSources(raw: string | undefined): { sources: Set<SettingSource>; error?: string } {
  if (raw === undefined) return { sources: new Set(SETTING_SOURCES) }
  const sources = new Set<SettingSource>()
  for (const token of raw.split(',')) {
    const name = token.trim()
    if (name === '') continue
    if (!(SETTING_SOURCES as readonly string[]).includes(name)) {
      return { sources: new Set(SETTING_SOURCES), error: `Invalid setting source: ${name}. Valid options are: ${SETTING_SOURCES.join(', ')}` }
    }
    sources.add(name as SettingSource)
  }
  return { sources }
}

/** Whether the value is the inline form: JSON that parses to an object. Anything else
 * is a path, which is how Claude reads `{bad json` (measured: "Settings file not
 * found: <cwd>/{bad json"). */
function isInlineObject(raw: string): boolean {
  try {
    return isRecord(JSON.parse(raw))
  } catch {
    return false
  }
}

function readStrict(file: string): { text: string } | { error: string } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return { error: `Settings file not found: ${file}` }
  }
  if (!stat.isFile()) return { error: `Cannot use settings file (not a regular file): ${file}` }
  if (stat.size > MAX_SETTINGS_BYTES) return { error: `Cannot use settings file (larger than 2 MiB): ${file}` }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    return { error: `Cannot use settings file (${errorMessage(error)}): ${file}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `Cannot use settings file (${errorMessage(error)}): ${file}` }
  }
  if (!isRecord(parsed)) return { error: `Cannot use settings file (not a JSON object): ${file}` }
  return { text }
}

// One removal for every copy the process made, whichever module graph made it: an
// 'exit' listener per copy would trip node's listener-leak warning.
const copiesSlot = sharedSlot<Set<string>>('cli-settings-copies')

/** A private 0600 copy of the settings text, removed when the process exits. */
function privateCopy(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-settings-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, text, { mode: 0o600 })
  let copies = copiesSlot.get()
  if (copies === undefined) {
    const created = new Set<string>()
    copiesSlot.set(created)
    process.once('exit', () => {
      for (const copyDir of created) fs.rmSync(copyDir, { recursive: true, force: true })
    })
    copies = created
  }
  copies.add(dir)
  return file
}

/** The `--settings` value as the file the chain reads, or why it was refused. */
export function resolveSettingsFlag(raw: string, cwd: string): { file: string } | { error: string } {
  if (isInlineObject(raw)) return { file: privateCopy(raw) }
  const file = path.resolve(cwd, raw)
  const read = readStrict(file)
  return 'error' in read ? read : { file: privateCopy(read.text) }
}

/** Both flags as pi hands them over (a string when given with a value, true when
 * given bare, undefined when absent), resolved once for the session. */
export function resolveCliSettings(flags: { settings?: unknown; settingSources?: unknown }, cwd: string): CliSettings {
  const result = noFlags()
  if (typeof flags.settings === 'string') {
    const resolved = resolveSettingsFlag(flags.settings, cwd)
    if ('error' in resolved) result.errors.push(resolved.error)
    else {
      result.settingsFile = resolved.file
      result.forwardArgs.push('--settings', resolved.file)
    }
  }
  if (typeof flags.settingSources === 'string') {
    const parsed = parseSettingSources(flags.settingSources)
    if (parsed.error !== undefined) result.errors.push(parsed.error)
    else {
      result.sources = parsed.sources
      result.forwardArgs.push('--setting-sources', flags.settingSources)
    }
  }
  return result
}

const readerSlot = sharedSlot<() => CliSettings>('cli-settings')

/** Registered by the settings-flags extension, the one that owns the flags. */
export function setCliSettingsReader(read: (() => CliSettings) | undefined): void {
  readerSlot.set(read)
}

/** The session's flags, or the no-flag default when no extension registered a reader
 * (a stub host, or a read before the extension loaded). */
export function cliSettings(): CliSettings {
  return readerSlot.get()?.() ?? noFlags()
}
