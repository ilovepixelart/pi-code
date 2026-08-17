/**
 * Channel and payload for instruction-file loads published on pi's shared extension
 * event bus. Producers are claude-rules (a scoped rule lazily attaching on a matching
 * file touch, load_reason `path_glob_match`) and context-imports (resolved `@imports`,
 * load_reason `include`, and CLAUDE.local.md loads, load_reason `session_start`).
 * Hooks bridge them to Claude's InstructionsLoaded event, which is strictly
 * observational. pi loads extensions without a shared module cache, so state rides
 * the bus, mirroring subagent-events.
 */

import * as path from 'node:path'

export const INSTRUCTIONS_CHANNEL = 'pi-code:instructions'

/** Claude's memory_type vocabulary for InstructionsLoaded payloads. */
export type InstructionMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

const MEMORY_TYPES: readonly string[] = ['User', 'Project', 'Local', 'Managed']

export interface InstructionLoadEvent {
  /** Absolute path of the instruction file that entered context. */
  file_path: string
  memory_type: InstructionMemoryType
  /** What caused the load; InstructionsLoaded matchers run against this. */
  load_reason: string
  /** The rule's `paths:` globs; present only for path_glob_match. */
  globs?: string[]
  /** The file whose access triggered a lazy load. */
  trigger_file_path?: string
  /** The importing file, for include loads. */
  parent_file_path?: string
}

export function isInstructionLoadEvent(data: unknown): data is InstructionLoadEvent {
  const event = data as InstructionLoadEvent | null
  if (event === null || typeof event !== 'object') return false
  if (typeof event.file_path !== 'string' || typeof event.load_reason !== 'string') return false
  if (!MEMORY_TYPES.includes(event.memory_type)) return false
  if (event.globs !== undefined && !(Array.isArray(event.globs) && event.globs.every((glob) => typeof glob === 'string'))) return false
  if (event.trigger_file_path !== undefined && typeof event.trigger_file_path !== 'string') return false
  if (event.parent_file_path !== undefined && typeof event.parent_file_path !== 'string') return false
  return true
}

/** Claude's memory_type from a file's location: CLAUDE.local.md is Local wherever it
 * sits; a file under home but outside the project is User; everything else, the
 * project itself included (which commonly lives under home), is Project. */
export function memoryTypeForPath(filePath: string, home: string, projectRoot: string): InstructionMemoryType {
  if (path.basename(filePath) === 'CLAUDE.local.md') return 'Local'
  const isUnder = (root: string): boolean => root.length > 0 && (filePath === root || filePath.startsWith(root + path.sep))
  if (isUnder(projectRoot)) return 'Project'
  // Monorepo: repoRoot stops at the nearest .git OR package.json, so a git-root
  // CLAUDE.md can sit above the projectRoot a subpackage session reports. A file
  // whose directory is a strict ancestor of the project root is still project
  // memory. The home directory itself stays User: a home-level context file is
  // user config even when the project lives under home.
  const dir = path.dirname(filePath)
  if (dir !== home && (projectRoot === dir || projectRoot.startsWith(dir + path.sep))) return 'Project'
  if (isUnder(home)) return 'User'
  return 'Project'
}

/** The emit half of pi's EventBus; producers may run under stub hosts without one. */
export interface InstructionBus {
  emit(channel: string, data: unknown): void
}

export function publishInstructionLoad(events: InstructionBus | undefined, event: InstructionLoadEvent): void {
  events?.emit(INSTRUCTIONS_CHANNEL, event)
}
