/**
 * Memory Extension
 *
 * Claude Code style persistent memory, per project. Memories live as markdown
 * files under ~/.pi/agent/memory/<project-slug>/ with a MEMORY.md index whose
 * content is injected into the system prompt each session. The agent manages
 * memories through the memory tool (save / read / delete / list).
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { capForContext } from './internal/output-guard.js'

const INDEX_FILE = 'MEMORY.md'

/** Claude loads the first 200 lines or 25KB of the memory index at startup. */
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25_000

/** Windows drive letters are case-insensitive, so C:\x and c:\x are one project. */
function normalizeCwd(cwd: string): string {
  return cwd.replace(/^([A-Za-z]):(?=[/\\])/, (_match, letter: string) => letter.toUpperCase())
}

/** Readable dashed path plus a short digest of the real path. The digest is what makes
 * the slug injective: every separator becomes a dash, so /a/b, /a-b and \a\b share a
 * dashed form and would otherwise share one store. */
export function projectSlug(cwd: string): string {
  const normalized = normalizeCwd(cwd)
  const readable = normalized.replace(/[/\\]/g, '-').replace(/^-+/, '-')
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  return `${readable}-${digest}`
}

/** The pre-digest slug, kept only to migrate an existing store to the new name. */
function legacySlug(cwd: string): string {
  return cwd
    .replace(/^([A-Za-z]):(?=[/\\])/, '$1')
    .replace(/[/\\]/g, '-')
    .replace(/^-+/, '-')
}

export function memoryDir(cwd: string): string {
  return path.join(os.homedir(), '.pi', 'agent', 'memory', projectSlug(cwd))
}

/** Move a store written under the pre-digest slug to the current one, once. Without
 * this the slug change would silently orphan every memory a user already has. */
export function migrateLegacyStore(cwd: string): void {
  const current = memoryDir(cwd)
  if (fs.existsSync(current)) return
  const legacy = path.join(os.homedir(), '.pi', 'agent', 'memory', legacySlug(cwd))
  if (!fs.existsSync(legacy)) return
  try {
    fs.renameSync(legacy, current)
  } catch {
    // A failed migration must not take down session start; the store stays legacy.
  }
}

/** The index as injected into the prompt, bounded like Claude's startup load. */
export function capIndexForPrompt(index: string): string {
  const withinLines = index.split('\n').slice(0, INDEX_MAX_LINES)
  let dropped = index.split('\n').length - withinLines.length
  let text = withinLines.join('\n')
  while (Buffer.byteLength(text, 'utf-8') > INDEX_MAX_BYTES && withinLines.length > 1) {
    withinLines.pop()
    dropped++
    text = withinLines.join('\n')
  }
  if (dropped <= 0) return index
  return `${text}\n(${dropped} more memories not shown; use the memory tool with action "list")`
}

export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '')
      .slice(0, 64) || 'memory'
  )
}

/** The exact key prefix of a memory's index line; matching on a substring would also
 * hit another entry whose description merely mentions this memory. */
const entryPrefix = (name: string): string => `- [${name}](${name}.md):`

/** Add or replace this memory's line in the index, keyed by its markdown link target. */
export function upsertIndexLine(index: string, name: string, description: string): string {
  // One line per memory: a newline in the description would break line-based matching.
  const line = `${entryPrefix(name)} ${description.replace(/\s+/g, ' ').trim()}`
  const lines = index.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith(entryPrefix(name)))
  if (lines.length === 0 || !lines[0].startsWith('#')) lines.unshift('# Memory index')
  lines.push(line)
  return `${lines.join('\n')}\n`
}

export function removeIndexLine(index: string, name: string): string {
  const lines = index.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith(entryPrefix(name)))
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

const MemoryParams = Type.Object({
  action: StringEnum(['save', 'read', 'delete', 'list'] as const, { description: 'What to do' }),
  name: Type.Optional(Type.String({ description: 'Short kebab-case memory name (save/read/delete)' })),
  description: Type.Optional(Type.String({ description: 'One-line summary shown in the always-loaded index (save)' })),
  content: Type.Optional(Type.String({ description: 'Full memory content in markdown (save)' })),
})

function readIndex(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, INDEX_FILE), 'utf-8')
  } catch {
    return ''
  }
}

export default function memoryExtension(pi: ExtensionAPI) {
  let dir = memoryDir(process.cwd())

  pi.on('session_start', async (_event, ctx) => {
    migrateLegacyStore(ctx.cwd)
    dir = memoryDir(ctx.cwd)
    const count = readIndex(dir)
      .split('\n')
      .filter((l) => l.startsWith('- ')).length
    if (count > 0) ctx.ui.notify(`Memory: ${count} memories loaded`, 'info')
  })

  pi.on('before_agent_start', async (event) => {
    const index = readIndex(dir)
    if (!index.trim()) return
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Memory\n\nPersistent memories from earlier sessions (index):\n\n${capIndexForPrompt(index)}\nUse the memory tool with action "read" to load a memory's full content when relevant.`,
    }
  })

  pi.registerTool({
    name: 'memory',
    label: 'Memory',
    description: 'Persistent memory across sessions. Save durable facts, user preferences, corrections, and project decisions that are not derivable from the code. Actions: save (name + description + content), read (name), delete (name), list.',
    parameters: MemoryParams,
    async execute(_id, params) {
      const name = params.name ? slugifyName(params.name) : undefined
      const indexPath = path.join(dir, INDEX_FILE)

      if (params.action === 'save') {
        if (!name || !params.description || !params.content) {
          return { content: [{ type: 'text' as const, text: 'save requires name, description, and content.' }], details: {} }
        }
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `${name}.md`), params.content)
        fs.writeFileSync(indexPath, upsertIndexLine(readIndex(dir), name, params.description))
        return { content: [{ type: 'text' as const, text: `Saved memory ${name}.` }], details: {} }
      }

      if (params.action === 'read') {
        if (!name) return { content: [{ type: 'text' as const, text: 'read requires name.' }], details: {} }
        try {
          const body = fs.readFileSync(path.join(dir, `${name}.md`), 'utf-8')
          return { content: [{ type: 'text' as const, text: capForContext(body) }], details: {} }
        } catch {
          return { content: [{ type: 'text' as const, text: `No memory named ${name}.` }], details: {} }
        }
      }

      if (params.action === 'delete') {
        if (!name) return { content: [{ type: 'text' as const, text: 'delete requires name.' }], details: {} }
        fs.rmSync(path.join(dir, `${name}.md`), { force: true })
        const remaining = removeIndexLine(readIndex(dir), name)
        if (remaining) fs.writeFileSync(indexPath, remaining)
        else fs.rmSync(indexPath, { force: true })
        return { content: [{ type: 'text' as const, text: `Deleted memory ${name}.` }], details: {} }
      }

      const index = readIndex(dir)
      return { content: [{ type: 'text' as const, text: index.trim() || 'No memories saved for this project yet.' }], details: {} }
    },
  })
}
