/**
 * The small shared shapes: an error's message, a plain-object check, whether a path
 * is a directory, the text of a message content, a regex escape, a numeric env
 * value. One copy each; a private copy in an extension is the drift to look for.
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

/** Escape a string for literal use inside a RegExp. One copy: five private ones had
 * the same body and would have drifted the first time one of them was fixed. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/** A numeric environment value, or undefined when blank or not a number. Accepts the
 * spellings docs/mcp.md promises (`2e3`, `64_000`); the caller decides the range and
 * whether fractions are meaningful, so no flooring here. */
export function parseNumericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const cleaned = raw.replaceAll('_', '')
  if (cleaned.trim() === '') return undefined
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}
