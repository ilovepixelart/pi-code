/**
 * The shapes every extension here needed its own copy of: an error's message, a plain
 * object check, whether a path is a directory, and the text of a message content. Each
 * was written three to five times with the same body, and the error one appeared in
 * seventeen files.
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

/** The text of a message or tool-result content, dropping thinking and tool parts. A
 * plain-string content is already the text. The separator is the caller's: Claude's
 * last_assistant_message concatenates, a hook payload joins with newlines, a title or a
 * prompt snippet with spaces. */
export function contentText(content: unknown, separator = ''): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(separator)
}
