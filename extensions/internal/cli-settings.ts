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
 * project, local". Claude exits 1 on each before anything runs; here the extensions
 * loaded earlier have already begun their session start when settings-flags reports
 * the refusal and ends the session, so a refusal fails closed: no file source loads
 * in that window.
 *
 * The resolution is memoized process-wide by the raw flag values: pi loads fresh
 * extension instances on /new and /reload and hands them the same values, and a
 * fresh instance must reuse the copy rather than read the original again.
 *
 * `--mcp-config` and `--strict-mcp-config` travel the same way (docs/mcp.md): each
 * `--mcp-config` value is a JSON file or an inline JSON object holding `mcpServers`,
 * read once, merged in order (a later value wins a shared name) and handed to a child as
 * one private copy. The refusals follow Claude Code 2.1.295 as measured, and either flag
 * is refused while a parseable managed-mcp.json is deployed, as Claude's managed-mcp
 * page documents. A refusal fails closed to the strict empty set until the session ends.
 *
 * The resolved value travels through a process-wide slot (see shared-slot): pi exposes
 * a flag's value only to the extension that registered it, and every extension holds
 * its own copy of this module.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { managedMcpPath, managedSettingsFile } from './managed-settings.ts'
import { sharedSlot } from './shared-slot.ts'
import { errorMessage, isRecord } from './values.ts'

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
  /** The `--mcp-config` servers, raw as configured, and whether `--strict-mcp-config`
   * drops every other MCP scope; undefined when neither flag was given. */
  mcp?: CliMcpConfig
}

export interface CliMcpConfig {
  servers: Record<string, unknown>
  strict: boolean
}

/** The flags as pi hands them over (a string when given with a value, true when given
 * bare, undefined when absent); `mcpConfig` lists every `--mcp-config` value in order. */
export interface CliFlags {
  settings?: unknown
  settingSources?: unknown
  mcpConfig?: readonly string[]
  strictMcpConfig?: unknown
}

function noFlags(): CliSettings {
  return { settingsFile: undefined, sources: new Set(SETTING_SOURCES), forwardArgs: [], errors: [] }
}

/** The sources a `--setting-sources` value names. Whitespace and repeats are
 * tolerated; an unknown name refuses the whole flag, and nothing loads. */
export function parseSettingSources(raw: string | undefined): { sources: Set<SettingSource>; error?: string } {
  if (raw === undefined) return { sources: new Set(SETTING_SOURCES) }
  const sources = new Set<SettingSource>()
  for (const token of raw.split(',')) {
    const name = token.trim()
    if (name === '') continue
    if (!(SETTING_SOURCES as readonly string[]).includes(name)) {
      return { sources: new Set(), error: `Invalid setting source: ${name}. Valid options are: ${SETTING_SOURCES.join(', ')}` }
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

const MCP_REFUSAL = 'Invalid MCP configuration:\n'

/** Zod's name for the received value's type, as Claude's schema error spells it. */
function receivedKind(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

/** One `--mcp-config` value's servers, or Claude's refusal. A value that is not a JSON
 * object is a path, resolved against cwd (measured: `'{bad'` is "file not found"). */
export function resolveMcpConfigValue(raw: string, cwd: string): { servers: Record<string, unknown> } | { error: string } {
  let text = raw
  if (!isInlineObject(raw)) {
    const file = path.resolve(cwd, raw)
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch {
      return { error: `${MCP_REFUSAL}MCP config file not found: ${file}` }
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: `${MCP_REFUSAL}MCP config is not a valid JSON` }
  }
  const servers = isRecord(parsed) ? parsed.mcpServers : undefined
  if (!isRecord(servers)) return { error: `${MCP_REFUSAL}mcpServers: Invalid input: expected record, received ${receivedKind(servers)}` }
  return { servers }
}

/** Whether a managed-mcp.json Claude could read and parse is deployed. */
function managedMcpDeployed(managedFile: string): boolean {
  try {
    JSON.parse(fs.readFileSync(managedMcpPath(managedFile), 'utf-8'))
    return true
  } catch {
    return false
  }
}

/** Both MCP flags merged into one server set, the args a child needs, and any refusal. */
function resolveMcpFlags(flags: CliFlags, cwd: string, managedFile: string): { mcp?: CliMcpConfig; forwardArgs: string[]; errors: string[] } {
  const values = flags.mcpConfig ?? []
  const strict = flags.strictMcpConfig === true
  if (values.length === 0 && !strict) return { forwardArgs: [], errors: [] }
  if (managedMcpDeployed(managedFile)) return { forwardArgs: [], errors: ['You cannot dynamically configure MCP servers when an enterprise MCP config is present'] }
  const servers: Record<string, unknown> = {}
  for (const value of values) {
    const resolved = resolveMcpConfigValue(value, cwd)
    if ('error' in resolved) return { forwardArgs: [], errors: [resolved.error] }
    Object.assign(servers, resolved.servers)
  }
  const forwardArgs = values.length > 0 ? ['--mcp-config', privateCopy(JSON.stringify({ mcpServers: servers }))] : []
  // The `=` form: pi's parser takes the token after a bare flag as its value, which
  // would swallow the child's task.
  if (strict) forwardArgs.push('--strict-mcp-config=true')
  return { mcp: { servers, strict }, forwardArgs, errors: [] }
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

/** Every flag as pi hands it over. Any refusal fails closed: no file source, no
 * snapshot, nothing forwarded, no MCP server once an MCP flag was given, only the errors. */
export function resolveCliSettings(flags: CliFlags, cwd: string, managedFile: string = managedSettingsFile()): CliSettings {
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
  const mcp = resolveMcpFlags(flags, cwd, managedFile)
  result.errors.push(...mcp.errors)
  const mcpGiven = (flags.mcpConfig ?? []).length > 0 || flags.strictMcpConfig === true
  if (result.errors.length > 0) return { ...noFlags(), sources: new Set(), errors: result.errors, ...(mcpGiven ? { mcp: { servers: {}, strict: true } } : {}) }
  result.forwardArgs.push(...mcp.forwardArgs)
  return mcp.mcp === undefined ? result : { ...result, mcp: mcp.mcp }
}

// One resolution per raw pair for the whole process, whichever extension instance
// asks: a fresh instance after /new or /reload gets the same copy, not a re-read.
const resolvedSlot = sharedSlot<Map<string, CliSettings>>('cli-settings-resolved')

/** resolveCliSettings, memoized process-wide by the raw flag values. */
export function resolveCliSettingsOnce(flags: CliFlags, cwd: string): CliSettings {
  let memo = resolvedSlot.get()
  if (memo === undefined) {
    memo = new Map()
    resolvedSlot.set(memo)
  }
  const key = JSON.stringify([flags.settings, flags.settingSources, flags.mcpConfig, flags.strictMcpConfig])
  let resolved = memo.get(key)
  if (resolved === undefined) {
    resolved = resolveCliSettings(flags, cwd)
    memo.set(key, resolved)
  }
  return resolved
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
