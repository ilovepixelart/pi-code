/**
 * Memory Extension
 *
 * Claude Code style persistent memory, per project. Memories live as markdown
 * files under ~/.pi/agent/memory/<project-slug>/ with a MEMORY.md index whose
 * content is injected into the system prompt each session. The agent manages
 * memories through the memory tool (save / read / delete / list).
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { capForContext } from './internal/output-guard.js'

const INDEX_FILE = 'MEMORY.md'

export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-').replace(/^-+/, '-')
}

export function memoryDir(cwd: string): string {
  return path.join(os.homedir(), '.pi', 'agent', 'memory', projectSlug(cwd))
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

/** Add or replace this memory's line in the index, keyed by its markdown link target. */
export function upsertIndexLine(index: string, name: string, description: string): string {
  const line = `- [${name}](${name}.md): ${description}`
  const lines = index.split('\n').filter((l) => l.trim().length > 0 && !l.includes(`](${name}.md)`))
  if (lines.length === 0 || !lines[0].startsWith('#')) lines.unshift('# Memory index')
  lines.push(line)
  return `${lines.join('\n')}\n`
}

export function removeIndexLine(index: string, name: string): string {
  const lines = index.split('\n').filter((l) => l.trim().length > 0 && !l.includes(`](${name}.md)`))
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
      systemPrompt: `${event.systemPrompt}\n\n## Memory\n\nPersistent memories from earlier sessions (index):\n\n${index}\nUse the memory tool with action "read" to load a memory's full content when relevant.`,
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
