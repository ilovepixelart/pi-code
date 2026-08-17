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
import { type ExtensionAPI, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { capForContext } from './internal/output-guard.js'
import { isProjectApprovedSilently } from './internal/project-approval.js'
import { findNearestFile, repoRoot } from './internal/project-root.js'

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

/** The project a memory store belongs to: the repository root, so subdirectory
 * sessions share one store, matching Claude ("derived from the git repository, so
 * all worktrees and subdirectories within the same repo share one auto memory
 * directory. Outside a git repo, the project root is used instead."). Falls back
 * to cwd when there is no project marker. */
function memoryProject(cwd: string): string {
  return repoRoot(cwd) ?? cwd
}

export function memoryDir(cwd: string): string {
  return path.join(os.homedir(), '.pi', 'agent', 'memory', projectSlug(memoryProject(cwd)))
}

/** The store location, honoring an `autoMemoryDirectory` override. Claude requires
 * it to be absolute or start with `~/`; a relative value is ignored, falling back
 * to the default per-project directory. */
export function resolveMemoryDir(cwd: string, override?: string): string {
  const trimmed = override?.trim()
  if (trimmed?.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  if (trimmed && path.isAbsolute(trimmed)) return trimmed
  return memoryDir(cwd)
}

/** Whether auto memory runs: on by default, off when `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
 * is `1`/`true` or a settings scope sets `autoMemoryEnabled: false`. */
export function autoMemoryEnabled(setting: unknown, env: NodeJS.ProcessEnv): boolean {
  const disable = (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim().toLowerCase()
  if (disable === '1' || disable === 'true') return false
  return setting !== false
}

/** Set or replace the ISO 8601 `modified:` field inside a memory's YAML frontmatter.
 * Files without frontmatter are returned untouched: Claude never adds frontmatter to
 * a file that has none. */
export function stampModified(content: string, iso: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return content
  const inner = match[1]
  const rest = content.slice(match[0].length)
  const withoutModified = inner
    .split('\n')
    .filter((line) => !/^\s*modified\s*:/.test(line))
    .join('\n')
  const body = withoutModified.length > 0 ? `${withoutModified}\n` : ''
  return `---\n${body}modified: ${iso}\n---${rest}`
}

/** The index content that actually loads: YAML frontmatter and block-level HTML
 * comments are stripped, so they neither show in the prompt nor count toward the
 * 200-line / 25KB read limits, matching Claude Code. */
export function stripNonLoaded(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/<!--[\s\S]*?-->\r?\n?/g, '')
}

/** Move a store written under an older slug to the current one, once. Two earlier
 * formats can orphan a user's memories on upgrade: the released digest-of-cwd slug
 * (before the store was anchored on the repository root, so a subdirectory session
 * resolved to a different dir), and the pre-digest slug. Newest format first. */
export function migrateLegacyStore(cwd: string): void {
  const current = memoryDir(cwd)
  if (fs.existsSync(current)) return
  const base = path.join(os.homedir(), '.pi', 'agent', 'memory')
  // projectSlug(cwd) differs from current only for a subdirectory session (current is
  // keyed on the repo root); for a repo-root session it equals current and is skipped.
  const candidates = [path.join(base, projectSlug(cwd)), path.join(base, legacySlug(cwd))]
  for (const legacy of candidates) {
    if (legacy === current || !fs.existsSync(legacy)) continue
    try {
      fs.renameSync(legacy, current)
    } catch {
      // A failed migration must not take down session start; the store stays put.
    }
    return
  }
}

/** Whether adding this memory would push the index past what a session can load.
 * Claude reports an explicit error instead of silently writing a memory that will
 * never be seen; replacing an existing entry is not growth. */
export function indexWouldOverflow(index: string, name: string, description: string): boolean {
  // Editing an entry that already exists is always allowed: it adds no entry, and
  // refusing it would strand a user whose index is already at the bound with no way
  // to revise their way back under it. An over-long description is bounded anyway,
  // since the injected index is capped at read time.
  const isUpdate = index.split('\n').some((entry) => entry.startsWith(entryPrefix(name)))
  if (isUpdate) return false
  // Only the loaded content counts: frontmatter and comments are stripped first.
  const next = stripNonLoaded(upsertIndexLine(index, name, description))
  return next.split('\n').length > INDEX_MAX_LINES || Buffer.byteLength(next, 'utf-8') > INDEX_MAX_BYTES
}

type MemoryToolResult = { content: Array<{ type: 'text'; text: string }>; details: Record<string, never> }

/** Write a memory and its index line, or say why it cannot be written. The whole
 * read-modify-write holds the index's mutation queue: tool calls run in parallel, so
 * two unqueued saves both read the same index and the second silently drops the first's
 * line. The queue keys ONLY on the index, the shared file every save touches, and never
 * also on the memory file: a second nested queue self-deadlocks when a memory name
 * canonicalizes to the same key as the index (e.g. `memory.md` and `MEMORY.md` under a
 * case-insensitive filesystem, since the queue keys on realpath). */
export async function saveMemory(dir: string, indexPath: string, name: string | undefined, description: string | undefined, content: string | undefined, now: string = new Date().toISOString()): Promise<MemoryToolResult> {
  if (!name || !description || !content) {
    return { content: [{ type: 'text', text: 'save requires name, description, and content.' }], details: {} }
  }
  return withFileMutationQueue(indexPath, async (): Promise<MemoryToolResult> => {
    const index = readIndex(dir)
    // Claude reports an explicit error rather than writing a memory the next session
    // would never load, and says what to do about it.
    if (indexWouldOverflow(index, name, description)) {
      return {
        content: [{ type: 'text', text: `Memory index is full (${INDEX_MAX_LINES} entries or ${INDEX_MAX_BYTES} bytes). Delete or consolidate memories before saving ${name}.` }],
        details: {},
      }
    }
    fs.mkdirSync(dir, { recursive: true })
    // A memory with frontmatter records its write time; one without is left as-is.
    fs.writeFileSync(path.join(dir, `${name}.md`), stampModified(content, now))
    writeIndex(indexPath, upsertIndexLine(index, name, description))
    return { content: [{ type: 'text', text: `Saved memory ${name}.` }], details: {} }
  })
}

/** The read action: a memory's body, capped for context, or a not-found message. */
function readMemory(dir: string, name: string): MemoryToolResult {
  try {
    const body = fs.readFileSync(path.join(dir, `${name}.md`), 'utf-8')
    return { content: [{ type: 'text', text: capForContext(body) }], details: {} }
  } catch {
    return { content: [{ type: 'text', text: `No memory named ${name}.` }], details: {} }
  }
}

/** The delete action: remove a memory file and its index line, queued on the index
 * like save (single key, no deadlock). The index is read before anything is removed,
 * and any failure (a bad index read, or an unreadable store the queue key cannot
 * realpath) leaves both the memory file and the index as they were. */
async function deleteMemory(dir: string, indexPath: string, name: string): Promise<MemoryToolResult> {
  try {
    return await withFileMutationQueue(indexPath, async (): Promise<MemoryToolResult> => {
      const index = readIndex(dir)
      fs.rmSync(path.join(dir, `${name}.md`), { force: true })
      const remaining = removeIndexLine(index, name)
      if (remaining) writeIndex(indexPath, remaining)
      else fs.rmSync(indexPath, { force: true })
      return { content: [{ type: 'text', text: `Deleted memory ${name}.` }], details: {} }
    })
  } catch (error) {
    return { content: [{ type: 'text', text: `Memory delete failed: ${error instanceof Error ? error.message : String(error)}. Nothing was deleted.` }], details: {} }
  }
}

/** The index as injected into the prompt, bounded like Claude's startup load. */
export function capIndexForPrompt(index: string): string {
  const loaded = stripNonLoaded(index)
  const withinLines = loaded.split('\n').slice(0, INDEX_MAX_LINES)
  let dropped = loaded.split('\n').length - withinLines.length
  let text = withinLines.join('\n')
  while (Buffer.byteLength(text, 'utf-8') > INDEX_MAX_BYTES && withinLines.length > 1) {
    withinLines.pop()
    dropped++
    text = withinLines.join('\n')
  }
  if (dropped <= 0) return loaded
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
  } catch (error) {
    // Only a missing file means an empty index. Treating any other failure as empty
    // lets the next read-modify-write clobber every existing entry.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** For display paths, where a transiently unreadable index should not break the
 * session; the mutating paths go through readIndex and refuse instead. */
function readIndexQuietly(dir: string): string {
  try {
    return readIndex(dir)
  } catch {
    return ''
  }
}

/** Replace the index through a rename so a crash mid-write cannot truncate it. */
function writeIndex(indexPath: string, content: string): void {
  const tmp = `${indexPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, indexPath)
}

/** The settings chain that decides `autoMemoryEnabled` and `autoMemoryDirectory`:
 * user settings always, then project settings (nearest at or above cwd) only when
 * approved, since a project's `autoMemoryDirectory` is honored under the same trust
 * rule as hooks in settings files. Later files win. */
export function memorySettingsFiles(cwd: string, home: string, approved: boolean): string[] {
  const files = [path.join(home, '.claude', 'settings.json')]
  if (!approved) return files
  for (const name of ['settings.json', 'settings.local.json']) {
    files.push(findNearestFile(cwd, path.join('.claude', name)) ?? path.join(cwd, '.claude', name))
  }
  return files
}

/** Merge the two memory settings across the chain, later files winning per key. */
export function readMemorySettings(files: string[]): { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown } {
  const merged: { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown } = {}
  for (const file of files) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (settings === null || typeof settings !== 'object') continue
      if ('autoMemoryEnabled' in settings) merged.autoMemoryEnabled = settings.autoMemoryEnabled
      if ('autoMemoryDirectory' in settings) merged.autoMemoryDirectory = settings.autoMemoryDirectory
    } catch {
      // missing or invalid settings file: skip
    }
  }
  return merged
}

export default function memoryExtension(pi: ExtensionAPI) {
  let dir = memoryDir(process.cwd())
  let enabled = true

  // The index is injected every turn but changes only through the tool or an external
  // edit, so a turn costs one stat instead of a full read. The stat token (mtime plus
  // size) catches external edits; save and delete drop the cache outright, since a
  // rename landing within one mtime tick at the same size would slip past the token.
  let indexCache: { token: string; index: string } | null = null

  const indexStatToken = (): string => {
    try {
      const stat = fs.statSync(path.join(dir, INDEX_FILE))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }

  const readIndexCached = (): string => {
    const token = indexStatToken()
    if (indexCache === null || indexCache.token !== token) indexCache = { token, index: readIndexQuietly(dir) }
    return indexCache.index
  }

  // These extensions also load inside spawned subagent processes, which carry the
  // PI_CODE_SUBAGENT marker. Claude does not load the main conversation's auto memory
  // into subagents (they get their own store through the agent `memory:` field), so
  // everything here no-ops there: no index injection, no notify, and the tool never
  // touches the parent store. Read per call so tests can flip the env var.
  const inSubagent = (): boolean => Boolean(process.env.PI_CODE_SUBAGENT)

  pi.on('session_start', async (_event, ctx) => {
    if (inSubagent()) return
    migrateLegacyStore(ctx.cwd)
    const approved = isProjectApprovedSilently(ctx)
    const settings = readMemorySettings(memorySettingsFiles(ctx.cwd, os.homedir(), approved))
    enabled = autoMemoryEnabled(settings.autoMemoryEnabled, process.env)
    const override = typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory : undefined
    dir = enabled ? resolveMemoryDir(ctx.cwd, override) : memoryDir(ctx.cwd)
    indexCache = null
    if (!enabled) return
    const count = readIndexQuietly(dir)
      .split('\n')
      .filter((l) => l.startsWith('- ')).length
    if (count > 0) ctx.ui.notify(`Memory: ${count} memories loaded`, 'info')
  })

  pi.on('before_agent_start', async (event) => {
    if (inSubagent() || !enabled) return
    const index = readIndexCached()
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
      if (inSubagent()) {
        return { content: [{ type: 'text' as const, text: 'The memory tool is unavailable in a subagent; auto memory belongs to the main conversation. Use your agent memory directory instead if one was provided.' }], details: {} }
      }
      if (!enabled) {
        return { content: [{ type: 'text' as const, text: 'Auto memory is disabled (autoMemoryEnabled is false or CLAUDE_CODE_DISABLE_AUTO_MEMORY is set). No memory was read or written.' }], details: {} }
      }
      const name = params.name ? slugifyName(params.name) : undefined
      const indexPath = path.join(dir, INDEX_FILE)

      if (params.action === 'save') {
        try {
          // Awaited here, not returned: the catch must see a queued write's rejection.
          return await saveMemory(dir, indexPath, name, params.description, params.content)
        } catch (error) {
          return { content: [{ type: 'text' as const, text: `Memory save failed: ${error instanceof Error ? error.message : String(error)}. The index was left untouched.` }], details: {} }
        } finally {
          indexCache = null
        }
      }

      if (params.action === 'read') {
        if (!name) return { content: [{ type: 'text' as const, text: 'read requires name.' }], details: {} }
        return readMemory(dir, name)
      }

      if (params.action === 'delete') {
        if (!name) return { content: [{ type: 'text' as const, text: 'delete requires name.' }], details: {} }
        // In a finally like the save path: a delete that throws mid-write must still
        // drop the cache, or the next turn injects a stale index.
        try {
          return await deleteMemory(dir, indexPath, name)
        } finally {
          indexCache = null
        }
      }

      const index = readIndexQuietly(dir)
      return { content: [{ type: 'text' as const, text: index.trim() || 'No memories saved for this project yet.' }], details: {} }
    },
  })
}
