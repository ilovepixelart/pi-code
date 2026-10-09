/**
 * Claude's --add-dir flag. context-imports registers it; pi answers getFlag only for a flag
 * the asking extension registered (pi dist/core/extensions/loader), and a second
 * registration would list the flag twice in --help, so the value reaches other readers
 * (the status line) through a process-wide slot.
 */

import { sharedSlot } from './shared-slot.ts'

export const ADD_DIR_FLAG = 'add-dir'

export const ADD_DIR_FLAG_OPTIONS = {
  description: 'Additional working directories; with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD set, their CLAUDE.md memory files load too (comma-separated)',
  type: 'string',
} as const

const readerSlot = sharedSlot<() => unknown>('add-dir-flag')

/** Registered by the extension that owns the flag. */
export function setAddDirReader(read: (() => unknown) | undefined): void {
  readerSlot.set(read)
}

/** The raw --add-dir value, or undefined when the flag was not given or no owner is loaded. */
export function addDirFlagValue(): unknown {
  return readerSlot.get()?.()
}
