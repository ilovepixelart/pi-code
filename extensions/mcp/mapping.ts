/**
 * MCP name and content mapping: the pi tool/prompt-command name formatting, prompt
 * argument mapping, input-schema normalization, and the tool/prompt/resource content
 * blocks mapped into pi's output budget.
 */

import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
import { splitArgs } from '../internal/command-file.js'
import { capForContext } from '../internal/output-guard.js'

export function formatToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replaceAll('-', '_')
}

/** Claude exposes server prompts as /mcp__<server>__<prompt> slash commands. Both
 * names normalize like formatToolName, extended to spaces: dashes and spaces each
 * become an underscore. */
export function formatPromptCommandName(server: string, prompt: string): string {
  const normalize = (name: string): string => name.replace(/[\s-]/g, '_')
  return `mcp__${normalize(server)}__${normalize(prompt)}`
}

export interface McpPromptArgumentInfo {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: McpPromptArgumentInfo[]
}

/** Claude passes prompt arguments space-separated after the command. Tokens map
 * positionally onto the declared arguments, split the way slash-command args are
 * (quoted runs stay together); the last declared argument absorbs any trailing
 * tokens so free text at the end is not silently dropped. Declared arguments with
 * no token are omitted, and the server enforces its own `required`. */
export function mapPromptArguments(declared: ReadonlyArray<{ name: string }> | undefined, args: string): Record<string, string> {
  const tokens = splitArgs(args)
  const names = (declared ?? []).map((argument) => argument.name)
  const mapped: Record<string, string> = {}
  for (let index = 0; index < names.length && index < tokens.length; index++) {
    mapped[names[index]] = index === names.length - 1 ? tokens.slice(index).join(' ') : tokens[index]
  }
  return mapped
}

/** The content blocks a getPrompt result injects. Each message carries one content
 * block; the blocks ride the same mapContent budget as tool output, and image blocks
 * are carried through rather than dropped, since sendUserMessage accepts them and a
 * vision prompt is worthless flattened to text. An empty message list yields no
 * blocks, and messages that carry only empty text yield none either, so the caller
 * can skip the turn rather than drive it on an empty or sentinel message. */
export function promptMessageContent(messages: ReadonlyArray<{ content: unknown }>): ToolContent[] {
  if (messages.length === 0) return []
  return mapContent(messages.map((message) => message.content as McpContentBlock)).filter((block) => block.type !== 'text' || block.text.trim() !== '')
}

/** Merge the `properties` (and, for allOf, the `required`) of a root-level combinator's
 * branches into one flat object schema. Without this a tool whose input schema is a bare
 * anyOf/oneOf/allOf (no top-level `type`) would present no properties at all, so the model
 * would be forced to call it with no arguments. */
function mergeCombinatorBranches(branches: unknown[]): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const branch of branches) {
    if (!branch || typeof branch !== 'object') continue
    const b = branch as Record<string, unknown>
    if (b.properties && typeof b.properties === 'object') Object.assign(properties, b.properties as Record<string, unknown>)
    if (Array.isArray(b.required)) for (const name of b.required) if (typeof name === 'string') required.add(name)
  }
  return { properties, required: [...required] }
}

export function normalizeSchema(schema: unknown): object {
  const base = (schema as Record<string, unknown>) ?? {}
  const { $schema: _dropSchema, additionalProperties: _dropAdditional, ...rest } = base
  if (rest.type) return rest
  // A root-level combinator carries the real parameters in its branches; flatten them
  // into one object schema rather than emptying it. allOf means every branch applies, so
  // its required union is kept; anyOf/oneOf branches are alternatives, so required is left
  // open (the server still enforces its own).
  const allOf = Array.isArray(rest.allOf) ? rest.allOf : undefined
  let branches = allOf
  if (!branches && Array.isArray(rest.anyOf)) branches = rest.anyOf
  if (!branches && Array.isArray(rest.oneOf)) branches = rest.oneOf
  if (!branches) return { type: 'object', properties: {} }
  const { properties, required } = mergeCombinatorBranches(branches)
  const merged: Record<string, unknown> = { type: 'object', properties }
  if (typeof rest.description === 'string') merged.description = rest.description
  if (allOf && required.length > 0) merged.required = required
  return merged
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri?: string; text?: string }
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export function mapContent(content: McpContentBlock[] | undefined, structured?: unknown): ToolContent[] {
  // capForContext every text output, whatever its source: a server can blow the tool-output
  // budget through a resource block, a JSON-stringified block, or the structured fallback,
  // not only a text block. The per-block cap alone is not a budget, though: a server
  // answering with one block per file multiplies it by the block count, so the blocks
  // are capped again as a whole below.
  const text = (value: string): ToolContent => ({ type: 'text', text: capForContext(value) })
  if (!content || content.length === 0) {
    return [text(structured !== undefined ? JSON.stringify(structured, null, 2) : '(empty result)')]
  }
  const mapped: ToolContent[] = content.map((block): ToolContent => {
    if (block.type === 'text') {
      return text(block.text ?? '')
    }
    if (block.type === 'image' && block.data) {
      return { type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' }
    }
    if (block.type === 'resource' && block.resource) {
      return text(`[Resource: ${block.resource.uri ?? 'unknown'}]\n${block.resource.text ?? ''}`)
    }
    return text(JSON.stringify(block))
  })
  return capTotal(mapped)
}

/**
 * Bound a result's text as a whole, not each block. The per-block cap multiplies by
 * the block count, so a server answering with one block per file still injects
 * megabytes.
 *
 * Blocks are kept whole. Each has already been capped on its own, so keeping the one
 * that crosses the budget bounds the text at roughly a single cap rather than at the
 * block count times it, and it preserves that block's own truncation notice, which
 * states how much of it was dropped. Blocks after it are omitted rather than skipped
 * over, so what reaches the model is a prefix of what the server sent, and the number
 * omitted is stated so a truncated set is distinguishable from a complete one.
 *
 * Images pass through uncut and do not spend the budget: base64 cut short is a broken
 * image rather than a smaller one, so nothing here can bound them, and charging the
 * budget for one would only delete the caption that accompanies a screenshot.
 */
export function capTotal(blocks: ToolContent[]): ToolContent[] {
  const kept: ToolContent[] = []
  let spent = 0
  let full = false
  let dropped = 0
  for (const block of blocks) {
    if (block.type !== 'text') {
      kept.push(block)
      continue
    }
    const size = Buffer.byteLength(block.text, 'utf-8')
    // The first text block always goes through: a lone oversized one is better read
    // truncated, with its own notice, than replaced by a marker saying it existed.
    if (full || (spent > 0 && spent + size > DEFAULT_MAX_BYTES)) {
      full = true
      dropped++
      continue
    }
    kept.push(block)
    spent += size
  }
  if (dropped > 0) {
    kept.push({ type: 'text', text: `[${dropped} further content block${dropped === 1 ? '' : 's'} omitted: tool output budget spent]` })
  }
  return kept
}
