/**
 * The three shapes every extension here needed its own copy of: an error's message, a
 * plain object check, and whether a path is a directory. Each was written three to five
 * times with the same body, and the error one appeared in seventeen files.
 */

import * as fs from 'node:fs'

/** The message of a thrown value, whatever was thrown. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A JSON object, as opposed to null, an array, or a primitive. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether the path is a directory today. A missing or unreadable path is not one. */
export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}
