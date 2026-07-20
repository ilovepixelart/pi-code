/**
 * Context Imports Extension
 *
 * pi loads CLAUDE.md / AGENTS.md context files natively but does not resolve
 * Claude Code's `@path` imports inside them. This fills that one gap: on
 * before_agent_start it reads the already-loaded context files from
 * systemPromptOptions, resolves any `@path` imports (recursive, depth-capped,
 * cycle-safe; ~ expands to home, relative paths resolve against the importing
 * file), and appends ONLY the imported content. pi already injected the base
 * files, so nothing is duplicated. Imports inside fenced code blocks and
 * unreadable paths are ignored.
 *
 * Docs: https://code.claude.com/docs/en/memory.md (imports)
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const MAX_IMPORT_DEPTH = 5

export function expandHome(target: string, home: string): string {
  if (target === '~') return home
  if (target.startsWith('~/')) return path.join(home, target.slice(2))
  return target
}

export interface ImportedFile {
  path: string
  body: string
}

/** Collect the contents of every file transitively imported via `@path`, in discovery order. */
export function collectImports(content: string, fromDir: string, home: string, seen: Set<string>, depth = 0): ImportedFile[] {
  if (depth >= MAX_IMPORT_DEPTH) return []
  const out: ImportedFile[] = []
  let inFence = false
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const match of line.matchAll(/(^|\s)@(\S+)/g)) {
      const resolved = path.resolve(fromDir, expandHome(match[2], home))
      if (seen.has(resolved)) continue
      seen.add(resolved)
      let body: string
      try {
        body = fs.readFileSync(resolved, 'utf-8')
      } catch {
        continue
      }
      out.push({ path: resolved, body: body.trim() })
      out.push(...collectImports(body, path.dirname(resolved), home, seen, depth + 1))
    }
  }
  return out
}

export default function contextImportsExtension(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => {
    const contextFiles = event.systemPromptOptions?.contextFiles ?? []
    if (contextFiles.length === 0) return

    const home = os.homedir()
    // Seed with the loaded context file paths so pi's own files are never re-imported.
    const seen = new Set(contextFiles.map((file: { path: string }) => file.path))
    const imported: ImportedFile[] = []
    for (const file of contextFiles) {
      imported.push(...collectImports(file.content, path.dirname(file.path), home, seen))
    }
    if (imported.length === 0) return

    const section = imported.map((entry) => `### ${entry.path}\n\n${entry.body}`).join('\n\n')
    return { systemPrompt: `${event.systemPrompt}\n\n## Imported context (@)\n\n${section}` }
  })
}
