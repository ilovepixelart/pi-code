/**
 * Frontmatter of the markdown files Claude Code defines: agents, commands, skills and
 * output styles.
 *
 * pi's parser is strict YAML. Claude's is not: its own /agents generator and Anthropic's
 * plugins write `description: Use this agent when ... Examples: <example>Context: ...`,
 * and the command reference documents `argument-hint: [pr-number] [priority]`. Strict
 * YAML throws on ": " inside a plain scalar and on a second flow sequence, and a throw
 * costs the whole file, so files that work in Claude Code did not exist here.
 *
 * The strict parse is tried first and kept whenever it succeeds. Only when it throws are
 * the free-text fields quoted and the parse retried. The restriction fields
 * (allowed-tools, tools, model, ...) are never rewritten: a value misread there is a
 * restriction silently not applied, so a file whose restrictions do not parse stays
 * rejected.
 */

import { parseFrontmatter } from '@earendil-works/pi-coding-agent'

/** Top-level keys whose value is prose. `name` is an identifier and stays strict. */
const FREE_TEXT_KEYS = new Set(['description', 'argument-hint', 'when_to_use'])

/** A plain scalar, as opposed to a quoted one or a block scalar indicator. */
const isPlainScalar = (value: string): boolean => value !== '' && !'"\'|>'.includes(value[0])

/** `line` with its free-text plain scalar quoted. A JSON string is a YAML double-quoted
 * scalar, and its escaping keeps a literal backslash literal, as a plain scalar does. */
function quoteFreeText(line: string): string {
  const colon = line.indexOf(':')
  if (colon === -1 || !FREE_TEXT_KEYS.has(line.slice(0, colon))) return line
  const value = line.slice(colon + 1).trim()
  return isPlainScalar(value) ? `${line.slice(0, colon)}: ${JSON.stringify(value)}` : line
}

/** `content` with the free-text fields of its frontmatter block quoted, or undefined
 * when there is no block or nothing in it changed. */
function withQuotedFreeText(content: string): string | undefined {
  if (!content.startsWith('---')) return undefined
  const start = content.indexOf('\n') + 1
  const end = content.indexOf('\n---', start)
  if (start === 0 || end === -1) return undefined
  const block = content.slice(start, end)
  const quoted = block.split('\n').map(quoteFreeText).join('\n')
  return quoted === block ? undefined : content.slice(0, start) + quoted + content.slice(end)
}

export function parseClaudeFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
  try {
    return parseFrontmatter<T>(content)
  } catch (error) {
    const retry = withQuotedFreeText(content)
    if (retry === undefined) throw error
    try {
      return parseFrontmatter<T>(retry)
    } catch {
      throw error
    }
  }
}
