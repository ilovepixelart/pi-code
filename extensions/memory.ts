/**
 * Memory Extension
 *
 * Claude Code style persistent memory, per project. Memories live as markdown
 * files in a per-project store with a MEMORY.md index whose content is injected
 * into the system prompt each session. The default store is pi's own, under
 * ~/.pi/agent/memory/<project-slug>/; `autoMemoryStorage: "claude"` selects the
 * store Claude Code itself keeps at <claude config>/projects/<project>/memory/,
 * read and written in place so both tools share one set of memories. The agent
 * manages memories through the memory tool (save / read / delete / list).
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir, SettingsManager, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { atomicWriteFile } from './internal/atomic-write.ts'
import { claudeConfigDir } from './internal/config-dir.ts'
import { readManagedSettings } from './internal/managed-settings.ts'
import { capForContext } from './internal/output-guard.ts'
import { isProjectApprovedSilently } from './internal/project-approval.ts'
import { repoRoot } from './internal/project-root.ts'
import { addPromptSection } from './internal/prompt-options.ts'
import { claudeSettingsChain, readSettingsChain } from './internal/settings-chain.ts'
import { statToken } from './internal/stat-token.ts'
import { errorMessage } from './internal/values.ts'

export const INDEX_FILE = 'MEMORY.md'

/** Claude loads the first 200 lines or 25KB of the memory index at startup. */
export const INDEX_MAX_LINES = 200

/** The index's lines, without their line break (LF or CRLF): the text after a final
 * newline is not a line of its own, and the index is always written with one. */
function indexLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** The line break an index is rewritten with: the one it already uses. */
function lineEnding(index: string): string {
  return index.includes('\r\n') ? '\r\n' : '\n'
}
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
  return path.join(getAgentDir(), 'memory', projectSlug(memoryProject(cwd)))
}

/** Which per-project store auto memory uses: pi's own, or the one Claude Code
 * keeps. The claude store is read and written in place, so both tools share one
 * set of memories. */
export type MemoryStorage = 'pi' | 'claude'

/** Claude Code cuts a project directory name at this length and appends a hash. */
const CLAUDE_SLUG_MAX = 200

/** Claude Code's string hash: 31 * hash + code unit, wrapped to 32 bits. */
function claudePathHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return hash
}

/** The directory name Claude Code gives a project: every character outside the
 * ASCII alphanumerics becomes one dash, so /home/dev/code/ai-gk is
 * -home-dev-code-ai-gk and a CJK segment such as 26宁波事业考点强化 becomes
 * 26-------- (verified against directories Claude Code itself creates). A name
 * longer than 200 characters is cut there and gets a base-36 hash of the path. */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= CLAUDE_SLUG_MAX) return slug
  return `${slug.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(claudePathHash(cwd)).toString(36)}`
}

/** `CLAUDE_CODE_PROJECT_DIR_NAME`, which replaces the project slug. Claude Code reads
 * it only when `CLAUDE_CONFIG_DIR` is set, and only as one plain segment that is not
 * a Windows device name. */
function claudeProjectDirName(): string | undefined {
  const name = process.env.CLAUDE_CODE_PROJECT_DIR_NAME
  if (!process.env.CLAUDE_CONFIG_DIR || !name) return undefined
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) && !/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? name : undefined
}

/** The Claude Code memory store for the project rooted at `cwd`: <claude
 * config>/projects/<project slug>/memory, keyed on the repository root like
 * pi's own store, so subdirectory sessions and every worktree share one
 * directory, as Claude's docs state they do. `CLAUDE_CODE_REMOTE_MEMORY_DIR`
 * replaces the config directory as the root. Claude normalises the project path
 * and the result to NFC. */
export function claudeMemoryDir(cwd: string, home: string = os.homedir()): string {
  const config = claudeConfigDir(home)
  const root = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR || config
  const slug = claudeProjectSlug(memoryProject(cwd).normalize('NFC'))
  const project = root === config ? (claudeProjectDirName() ?? slug) : slug
  return path.join(root, 'projects', project, 'memory').normalize('NFC')
}

/** The `autoMemoryStorage` setting: 'claude' selects Claude Code's per-project
 * store; anything else, absent or mistyped, keeps pi's own, so a typo cannot
 * silently strand an existing store. */
function memoryStorageSetting(setting: unknown): MemoryStorage {
  return typeof setting === 'string' && setting.trim().toLowerCase() === 'claude' ? 'claude' : 'pi'
}

/** The store location, honoring an `autoMemoryDirectory` override. Claude requires
 * it to be absolute or start with `~/`; a relative value is ignored, falling back
 * to the per-project directory the storage mode selects. */
export function resolveMemoryDir(cwd: string, override?: string, storage: MemoryStorage = 'pi'): string {
  const trimmed = override?.trim()
  if (trimmed?.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  if (trimmed && path.isAbsolute(trimmed)) return trimmed
  return storage === 'claude' ? claudeMemoryDir(cwd) : memoryDir(cwd)
}

/** Whether auto memory runs: on by default, off when `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
 * is `1`/`true` or a settings scope sets `autoMemoryEnabled: false`. */
export function autoMemoryEnabled(setting: unknown, env: NodeJS.ProcessEnv): boolean {
  const disable = (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim().toLowerCase()
  if (disable === '1' || disable === 'true') return false
  // Claude: "Set to 0 to force auto memory on even when --bare mode or
  // autoMemoryEnabled: false would otherwise disable it."
  if (disable === '0' || disable === 'false') return true
  return setting !== false
}

/** The frontmatter lines with the `modified:` field set. An existing field is
 * replaced where it stands, top-level or nested, so the key that holds it is never
 * left empty; a new one goes inside the `metadata:` block Claude Code keeps it in
 * when the file has one, else at the top level. */
function stampedLines(lines: string[], iso: string): string[] {
  const existing = /^(\s*)modified\s*:.*$/
  if (lines.some((line) => existing.test(line))) return lines.map((line) => line.replace(existing, (_match, indent: string) => `${indent}modified: ${iso}`))
  const metadata = lines.findIndex((line) => /^metadata:\s*(#.*)?$/.test(line))
  if (metadata === -1) return [...lines, `modified: ${iso}`]
  let end = metadata + 1
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++
  const indent = /^\s+/.exec(lines[metadata + 1] ?? '')?.[0] ?? '  '
  return [...lines.slice(0, end), `${indent}modified: ${iso}`, ...lines.slice(end)]
}

type Frontmatter = { lines: string[]; eol: string; rest: string }

/** A memory's YAML frontmatter block as lines, the line break it uses, and the
 * text after the block; undefined when the content has no block. */
function frontmatterOf(content: string): Frontmatter | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return undefined
  return { lines: match[1] === '' ? [] : match[1].split(/\r?\n/), eol: lineEnding(match[0]), rest: content.slice(match[0].length) }
}

function withFrontmatter({ lines, eol, rest }: Frontmatter): string {
  return `---${eol}${lines.join(eol)}${eol}---${rest}`
}

/** Set or replace the ISO 8601 `modified:` field inside a memory's YAML frontmatter.
 * Files without frontmatter are returned untouched: Claude never adds frontmatter to
 * a file that has none. */
export function stampModified(content: string, iso: string): string {
  const block = frontmatterOf(content)
  return block ? withFrontmatter({ ...block, lines: stampedLines(block.lines, iso) }) : content
}

/** Collapse text to one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** `content` with the frontmatter Claude Code's recall reads: `name`, `description`
 * (Claude flags a memory without one as unreliable), and the type nested under
 * `metadata`, where Claude keeps it. A field the content already has is kept. The
 * description is written as a JSON string, which is a YAML double-quoted scalar, so
 * a colon or a hash in it cannot break the block. */
function claudeFrontmatter(content: string, name: string, description: string): string {
  const block = frontmatterOf(content) ?? { lines: [], eol: '\n', rest: `\n\n${content}` }
  const has = (key: string): boolean => block.lines.some((line) => line.startsWith(`${key}:`))
  const added = [has('name') ? [] : `name: ${name}`, has('description') ? [] : `description: ${JSON.stringify(oneLine(description))}`].flat()
  const lines = has('metadata') ? block.lines : block.lines.flatMap((line) => (line.startsWith('type:') ? ['metadata:', `  ${line}`] : line))
  return withFrontmatter({ ...block, lines: [...added, ...lines] })
}

/** Length of the line break `text` starts with: CRLF, LF, or none. */
function leadingLineBreak(text: string): number {
  if (text.startsWith('\r\n')) return 2
  return text.startsWith('\n') ? 1 : 0
}

/** Drop every `<!-- ... -->` (and the line break after it) in one pass. A regex strip
 * can rebuild a comment from one nested in another: `<!-<!-- x -->-- y -->` loses the
 * inner comment and becomes `<!--- y -->`. After a removal the scan resumes three
 * characters back, so a comment assembled across the cut is removed too; an opener
 * that never closes stays as text. */
function removeComments(text: string): string {
  let out = text
  let cursor = 0
  while (cursor < out.length) {
    const open = out.indexOf('<!--', cursor)
    const close = open === -1 ? -1 : out.indexOf('-->', open + 4)
    if (close === -1) return out
    const tail = out.slice(close + 3)
    out = out.slice(0, open) + tail.slice(leadingLineBreak(tail))
    cursor = Math.max(0, open - 3)
  }
  return out
}

/** The index content that actually loads: YAML frontmatter and block-level HTML
 * comments are stripped, so they neither show in the prompt nor count toward the
 * 200-line / 25KB read limits, matching Claude Code. */
export function stripNonLoaded(text: string): string {
  return removeComments(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))
}

/** Move a store written under an older slug to the current one, once. Two earlier
 * formats can orphan a user's memories on upgrade: the released digest-of-cwd slug
 * (before the store was anchored on the repository root, so a subdirectory session
 * resolved to a different dir), and the pre-digest slug. Newest format first. */
export function migrateLegacyStore(cwd: string): void {
  const current = memoryDir(cwd)
  if (fs.existsSync(current)) return
  const base = path.join(getAgentDir(), 'memory')
  // projectSlug(cwd) differs from current only for a subdirectory session (current is
  // keyed on the repo root); for a repo-root session it equals current and is skipped.
  const candidates = [path.join(base, projectSlug(cwd)), path.join(base, legacySlug(cwd))]
  for (const legacy of candidates) {
    if (legacy === current || !fs.existsSync(legacy)) continue
    try {
      fs.renameSync(legacy, current)
    } catch (error) {
      // A failed migration must not take down session start, but the session then has no
      // memories while they sit under the old slug, which reads as having lost them.
      console.warn(`pi-code-memory: could not move ${legacy} to ${current}: ${errorMessage(error)}; this session starts without those memories`)
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
  const isUpdate = indexedStem(index, name) !== undefined
  if (isUpdate) return false
  // Only the loaded content counts: frontmatter and comments are stripped first.
  const next = stripNonLoaded(upsertIndexLine(index, name, description))
  return indexLines(next).length > INDEX_MAX_LINES || Buffer.byteLength(next, 'utf-8') > INDEX_MAX_BYTES
}

/** Where the index stands against the read limits, measured on the loaded content
 * (frontmatter and comments stripped): 'over' past either bound, 'near' within
 * 10% of one, else 'ok'. Claude reminds near a limit and errors over it. */
function indexReadState(index: string): 'ok' | 'near' | 'over' {
  const loaded = stripNonLoaded(index)
  const lines = indexLines(loaded).length
  const bytes = Buffer.byteLength(loaded, 'utf-8')
  if (lines > INDEX_MAX_LINES || bytes > INDEX_MAX_BYTES) return 'over'
  if (lines > INDEX_MAX_LINES * 0.9 || bytes > INDEX_MAX_BYTES * 0.9) return 'near'
  return 'ok'
}

type MemoryToolResult = { content: Array<{ type: 'text'; text: string }>; details: Record<string, never> }

/** Write a memory and its index line, or say why it cannot be written. The whole
 * read-modify-write holds the index's mutation queue: tool calls run in parallel, so
 * two unqueued saves both read the same index and the second silently drops the first's
 * line. The queue keys ONLY on the index, the shared file every save touches, and never
 * also on the memory file: a second nested queue self-deadlocks when a memory name
 * canonicalizes to the same key as the index (e.g. `memory.md` and `MEMORY.md` under a
 * case-insensitive filesystem, since the queue keys on realpath). */
async function saveMemory(dir: string, indexPath: string, storage: MemoryStorage, name: string | undefined, description: string | undefined, content: string | undefined, now: string = new Date().toISOString()): Promise<MemoryToolResult> {
  if (!name || !description || !content) {
    return { content: [{ type: 'text', text: 'save requires name, description, and content.' }], details: {} }
  }
  return withFileMutationQueue(indexPath, async (): Promise<MemoryToolResult> => /* NOSONAR typescript:S7503 - withFileMutationQueue takes a Promise-returning function */ {
    const index = readIndex(dir)
    const stem = memoryStem(dir, index, name)
    fs.mkdirSync(dir, { recursive: true })
    // A memory with frontmatter records its write time; one without is left as-is
    // in pi's own store and given Claude's frontmatter in Claude's.
    const file = storage === 'claude' ? claudeFrontmatter(content, name, description) : content
    fs.writeFileSync(path.join(dir, `${stem}.md`), stampModified(file, now))
    const nextIndex = upsertIndexLine(index, name, description, storage, stem)
    writeIndex(indexPath, nextIndex)
    // Claude measures the index after the write: over a read limit the write still
    // succeeds, but an error tells Claude to rewrite the index (everything past
    // the limit is dropped on the next load); near a limit, a reminder to shorten.
    const state = indexReadState(nextIndex)
    if (state === 'over') {
      return {
        content: [
          {
            type: 'text',
            text: `Saved memory ${name}, but the memory index is over its read limit (${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} bytes): rewrite MEMORY.md now. Keep one line per entry, move detail into topic files, and merge or drop stale entries; everything past the limit is dropped on the next load.`,
          },
        ],
        details: {},
      }
    }
    if (state === 'near') {
      return { content: [{ type: 'text', text: `Saved memory ${name}. The memory index is near its read limit; shorten it: keep one line per entry, move detail into topic files, and merge or drop stale entries.` }], details: {} }
    }
    return { content: [{ type: 'text', text: `Saved memory ${name}.` }], details: {} }
  })
}

/** The read action: a memory's body, capped for context, or a not-found message. */
function readMemory(dir: string, name: string): MemoryToolResult {
  try {
    const body = fs.readFileSync(path.join(dir, `${memoryStem(dir, readIndexQuietly(dir), name)}.md`), 'utf-8')
    return { content: [{ type: 'text', text: capForContext(body) }], details: {} }
  } catch (error) {
    // Only a missing file is "no such memory"; anything else (a directory in its place, a
    // permission problem) sends the model hunting for a name that is actually there.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { content: [{ type: 'text', text: `Memory ${name} could not be read: ${errorMessage(error)}` }], details: {} }
    }
    return { content: [{ type: 'text', text: `No memory named ${name}.` }], details: {} }
  }
}

/** The delete action: remove a memory's index line and then its file, queued on the index
 * like save (single key, no deadlock). The index moves first because it is what the prompt
 * and /memory show: a failure before it is written leaves both the file and the index as
 * they were, and a failure after it leaves an orphan file rather than an index line
 * pointing at a file that is gone. Each outcome is reported as what actually happened. */
async function deleteMemory(dir: string, indexPath: string, name: string): Promise<MemoryToolResult> {
  try {
    return await withFileMutationQueue(indexPath, async (): Promise<MemoryToolResult> => /* NOSONAR typescript:S7503 - withFileMutationQueue takes a Promise-returning function */ {
      const index = readIndex(dir)
      const stem = memoryStem(dir, index, name)
      const remaining = removeIndexLine(index, name, stem)
      if (remaining) writeIndex(indexPath, remaining)
      else fs.rmSync(indexPath, { force: true })
      try {
        fs.rmSync(path.join(dir, `${stem}.md`), { force: true })
      } catch (error) {
        // Out of the index, so it is gone from every surface the user sees; saying the
        // delete failed would be false, and silence would leave the stray file unexplained.
        return { content: [{ type: 'text', text: `Deleted memory ${name} from the index, but its file could not be removed: ${errorMessage(error)}.` }], details: {} }
      }
      return { content: [{ type: 'text', text: `Deleted memory ${name}.` }], details: {} }
    })
  } catch (error) {
    return { content: [{ type: 'text', text: `Memory delete failed: ${errorMessage(error)}. Nothing was deleted.` }], details: {} }
  }
}

/** The index as injected into the prompt, bounded like Claude's startup load. */
export function capIndexForPrompt(index: string): string {
  const loaded = stripNonLoaded(index)
  const all = indexLines(loaded)
  const withinLines = all.slice(0, INDEX_MAX_LINES)
  let dropped = all.length - withinLines.length
  let text = withinLines.join('\n')
  while (Buffer.byteLength(text, 'utf-8') > INDEX_MAX_BYTES && withinLines.length > 1) {
    withinLines.pop()
    dropped++
    text = withinLines.join('\n')
  }
  if (dropped <= 0) return loaded
  return `${text}\n(${dropped} more memories not shown; use the memory tool with action "list")`
}

/** A memory's file name. Letters and digits of any script survive: an ASCII-only slug
 * reduced every non-Latin name to one fallback, so distinct memories overwrote each
 * other. `memory` is never produced, because on a case-insensitive filesystem memory.md
 * is the MEMORY.md index, and writing one destroys the other. Cut by code point, so a
 * character outside the basic plane is never split. */
export function slugifyName(name: string): string {
  const slug = [
    ...name
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
      .replaceAll(/^-|-$/g, ''),
  ]
    .slice(0, 64)
    .join('')
  if (slug === '') return 'untitled'
  return slug === 'memory' ? 'memory-note' : slug
}

/** One index entry line: the link it starts with names the memory, so only that
 * link identifies the entry. A link appearing later in a description is a
 * mention, not the entry. The title may hold bracket pairs but may not span a
 * `](`, which ends the first link. */
const ENTRY_LINE = /^(\s*-\s*\[(?:[^[\]]|\[[^[\]]*\])*\]\(([^()\s]+)\.md\))(.*)$/

/** What a new entry puts between its link and its description: each store's own
 * format, so a pi save leaves a Claude index in the shape Claude Code writes. */
const NEW_ENTRY_SEPARATOR: Record<MemoryStorage, string> = { pi: ': ', claude: ' — ' }

/** The separator an existing entry already has (a colon or any dash), kept verbatim
 * when the line is rewritten. */
const ENTRY_SEPARATOR = /^\s*[\p{Pd}:]+[ \t]*/u

/** The entry one index line holds, or undefined when the line is not one. */
function entryOf(line: string): { link: string; target: string; separator: string | undefined } | undefined {
  const match = ENTRY_LINE.exec(line)
  if (!match) return undefined
  return { link: match[1], target: match[2], separator: ENTRY_SEPARATOR.exec(match[3])?.[0] }
}

/** Dashes and underscores are one character in a memory name: Claude Code has
 * written memory files both ways, and a name always reaches the tool dashed. */
function stemKey(stem: string): string {
  return stem.replaceAll('_', '-')
}

/** The one of `stems` that `name` refers to: its exact spelling when present, else
 * the first that differs from it only in dashes and underscores. */
function matchStem(stems: string[], name: string): string | undefined {
  if (stems.includes(name)) return name
  const key = stemKey(name)
  return stems.find((stem) => stemKey(stem) === key)
}

/** The memory file the index links for `name`, when it links one. */
function indexedStem(index: string, name: string): string | undefined {
  const targets = indexLines(index).flatMap((line) => entryOf(line)?.target ?? [])
  return matchStem(targets, name)
}

/** The memory files in the store, by name without the extension. */
function storedStems(dir: string): string[] {
  try {
    return fs.readdirSync(dir).flatMap((file) => (file.endsWith('.md') ? file.slice(0, -3) : []))
  } catch {
    return []
  }
}

/** The single memory file `name` refers to, the same one for read, save and delete:
 * an exactly named file, indexed or stored, wins; another spelling is used only when
 * that one does not exist. A name is a slug (letters, digits, dashes) and a match
 * differs from it only by underscores, so an index link such as ../../x is never
 * followed out of the store. */
function memoryStem(dir: string, index: string, name: string): string {
  const stored = storedStems(dir)
  if (stored.includes(name)) return name
  return indexedStem(index, name) ?? matchStem(stored, name) ?? name
}

/** Add or replace this memory's line in the index, keyed by the memory file the
 * line links, so an existing entry keeps its title, its link target and its
 * separator while only its description is replaced. Blank lines and headings are
 * left exactly where they are. Only pi's own index gets a heading: Claude Code
 * writes its index without one. */
export function upsertIndexLine(index: string, name: string, description: string, storage: MemoryStorage = 'pi', stem: string = indexedStem(index, name) ?? name): string {
  // One line per memory: a newline in the description would break every later line-based match.
  const flat = oneLine(description)
  const eol = lineEnding(index)
  const lines = indexLines(index)
  for (let i = 0; i < lines.length; i++) {
    const entry = entryOf(lines[i])
    if (entry?.target === stem) {
      lines[i] = `${entry.link}${entry.separator ?? NEW_ENTRY_SEPARATOR[storage]}${flat}`
      return `${lines.join(eol)}${eol}`
    }
  }
  if (storage === 'pi' && !lines.find((line) => line.trim() !== '')?.startsWith('#')) lines.unshift('# Memory index')
  lines.push(`- [${stem}](${stem}.md)${NEW_ENTRY_SEPARATOR[storage]}${flat}`)
  return `${lines.join(eol)}${eol}`
}

export function removeIndexLine(index: string, name: string, stem: string = indexedStem(index, name) ?? name): string {
  const lines = indexLines(index).filter((line) => entryOf(line)?.target !== stem)
  const eol = lineEnding(index)
  return lines.length > 0 ? `${lines.join(eol)}${eol}` : ''
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
  atomicWriteFile(indexPath, content)
}

/** The settings chain that decides `autoMemoryEnabled` and `autoMemoryDirectory`:
 * user settings always, then project settings (nearest at or above cwd) only when
 * approved, since a project's `autoMemoryDirectory` is honored under the same trust
 * rule as hooks in settings files. Later files win. */
export function memorySettingsFiles(cwd: string, home: string, approved: boolean): string[] {
  return claudeSettingsChain(cwd, home, approved)
}

/** Merge the memory settings across the chain, later files winning per key;
 * managed policy settings win over every file, per Claude's settings precedence. */
export function readMemorySettings(files: string[], managed: Record<string, unknown> = readManagedSettings()): { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown; autoMemoryStorage?: unknown } {
  const merged: { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown; autoMemoryStorage?: unknown } = {}
  for (const settings of readSettingsChain(files)) {
    if ('autoMemoryEnabled' in settings) merged.autoMemoryEnabled = settings.autoMemoryEnabled
    if ('autoMemoryDirectory' in settings) merged.autoMemoryDirectory = settings.autoMemoryDirectory
    if ('autoMemoryStorage' in settings) merged.autoMemoryStorage = settings.autoMemoryStorage
  }
  if ('autoMemoryEnabled' in managed) merged.autoMemoryEnabled = managed.autoMemoryEnabled
  if ('autoMemoryDirectory' in managed) merged.autoMemoryDirectory = managed.autoMemoryDirectory
  if ('autoMemoryStorage' in managed) merged.autoMemoryStorage = managed.autoMemoryStorage
  return merged
}

/** Write `autoMemoryEnabled` into the user settings file, preserving every other key
 * and creating the file and its config directory when absent. Claude's /memory toggle
 * writes to the user scope (relocated by CLAUDE_CONFIG_DIR); the value takes effect from
 * the next session start, which is where autoMemoryEnabled is read.
 *
 * An absent file starts from an empty object so the toggle still lands. A file that is
 * PRESENT but unparseable is refused, not overwritten: clobbering it would destroy the
 * user's hooks, env and permissions config. The caller surfaces the returned failure. */
export function setAutoMemoryEnabledSetting(home: string, value: boolean): { ok: true } | { ok: false; error: string } {
  const dir = claudeConfigDir(home)
  const file = path.join(dir, 'settings.json')
  let current: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    // Only a missing file means start fresh; any other read failure propagates.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') current = parsed as Record<string, unknown>
    } catch {
      // Present but unparseable: refuse rather than overwrite the user's config.
      return { ok: false, error: 'settings.json is not valid JSON; not modified' }
    }
  }
  current.autoMemoryEnabled = value
  fs.mkdirSync(dir, { recursive: true })
  // Atomic like writeIndex: a crash mid-write must not truncate the user's settings, which
  // also hold their hooks, env and permissions config.
  atomicWriteFile(file, `${JSON.stringify(current, null, 2)}\n`)
  return { ok: true }
}

export default function memoryExtension(pi: ExtensionAPI): void {
  let dir = memoryDir(process.cwd())
  let storage: MemoryStorage = 'pi'
  let enabled = true

  // The index is injected every turn but changes only through the tool or an external
  // edit, so a turn costs one stat instead of a full read. The stat token (mtime plus
  // size) catches external edits; save and delete drop the cache outright, since a
  // rename landing within one mtime tick at the same size would slip past the token.
  let indexCache: { token: string; index: string } | null = null

  const indexStatToken = (): string => {
    try {
      return statToken(path.join(dir, INDEX_FILE))
    } catch {
      return 'missing'
    }
  }

  const readIndexCached = (): string => {
    const token = indexStatToken()
    if (indexCache?.token !== token) indexCache = { token, index: readIndexQuietly(dir) }
    return indexCache.index
  }

  // These extensions also load inside spawned subagent processes, which carry the
  // PI_CODE_SUBAGENT marker. Claude does not load the main conversation's auto memory
  // into subagents (they get their own store through the agent `memory:` field), so
  // everything here no-ops there: no index injection, no notify, and the tool never
  // touches the parent store. Read per call so tests can flip the env var.
  const inSubagent = (): boolean => Boolean(process.env.PI_CODE_SUBAGENT)

  pi.on('session_start', (_event, ctx) => {
    if (inSubagent()) return
    const approved = isProjectApprovedSilently(ctx)
    const settings = readMemorySettings(memorySettingsFiles(ctx.cwd, os.homedir(), approved))
    enabled = autoMemoryEnabled(settings.autoMemoryEnabled, process.env)
    const override = typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory : undefined
    storage = memoryStorageSetting(settings.autoMemoryStorage)
    // Pi-store housekeeping only: in the claude storage mode the pi store is unused.
    if (storage === 'pi') migrateLegacyStore(ctx.cwd)
    dir = enabled ? resolveMemoryDir(ctx.cwd, override, storage) : memoryDir(ctx.cwd)
    indexCache = null
    if (!enabled) return
    const count = readIndexQuietly(dir)
      .split('\n')
      .filter((l) => l.startsWith('- ')).length
    if (count > 0) ctx.ui.notify(`Memory: ${count} memories loaded`, 'info')
  })

  pi.on('before_agent_start', (event) => {
    if (inSubagent() || !enabled) return
    const index = readIndexCached()
    if (!index.trim()) return
    const text = `Persistent memories from earlier sessions (index):\n\n${capIndexForPrompt(index)}\nUse the memory tool with action "read" to load a memory's full content when relevant.`
    if (addPromptSection(event, 'memory', text)) return
    return { systemPrompt: `${event.systemPrompt}\n\n## Memory\n\n${text}` }
  })

  const memoryToolUnavailable = () => {
    if (inSubagent()) {
      return { content: [{ type: 'text' as const, text: 'The memory tool is unavailable in a subagent; auto memory belongs to the main conversation. Use your agent memory directory instead if one was provided.' }], details: {} }
    }
    if (!enabled) {
      return { content: [{ type: 'text' as const, text: 'Auto memory is disabled (autoMemoryEnabled is false or CLAUDE_CODE_DISABLE_AUTO_MEMORY is set). No memory was read or written.' }], details: {} }
    }
    return undefined
  }

  async function saveAction(indexPath: string, name: string | undefined, description: string | undefined, content: string | undefined) {
    try {
      // Awaited here, not returned: the catch must see a queued write's rejection.
      return await saveMemory(dir, indexPath, storage, name, description, content)
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Memory save failed: ${errorMessage(error)}. The index was left untouched.` }], details: {} }
    } finally {
      indexCache = null
    }
  }

  async function deleteAction(indexPath: string, name: string | undefined) {
    if (!name) return { content: [{ type: 'text' as const, text: 'delete requires name.' }], details: {} }
    // In a finally like the save path: a delete that throws mid-write must still
    // drop the cache, or the next turn injects a stale index.
    try {
      return await deleteMemory(dir, indexPath, name)
    } finally {
      indexCache = null
    }
  }

  pi.registerTool({
    name: 'memory',
    label: 'Memory',
    description:
      'Persistent memory across sessions. Save durable facts, user preferences, corrections, and project decisions that are not derivable from the code. Give each saved memory `type` frontmatter from the documented vocabulary: user (who the user is), feedback (guidance on how to work), project (ongoing work and constraints), or reference (pointers to external resources). Actions: save (name + description + content), read (name), delete (name), list.',
    parameters: MemoryParams,
    async execute(_id, params) {
      const unavailable = memoryToolUnavailable()
      if (unavailable) return unavailable
      const name = params.name ? slugifyName(params.name) : undefined
      const indexPath = path.join(dir, INDEX_FILE)

      if (params.action === 'save') return saveAction(indexPath, name, params.description, params.content)

      if (params.action === 'read') {
        if (!name) return { content: [{ type: 'text' as const, text: 'read requires name.' }], details: {} }
        return readMemory(dir, name)
      }

      if (params.action === 'delete') return deleteAction(indexPath, name)

      const index = readIndexQuietly(dir)
      return { content: [{ type: 'text' as const, text: index.trim() || 'No memories saved for this project yet.' }], details: {} }
    },
  })

  // Claude's /memory lists the memory locations, opens one in the user's editor and toggles
  // auto memory. The listing reads the settings chain live so it reflects a toggle written
  // in the same session.
  pi.registerCommand('memory', {
    description: 'Show memory file locations, open one in your editor, or toggle auto memory (/memory [edit|on|off])',
    handler: async (args, ctx) => /* NOSONAR typescript:S7503 - pi types a command handler as returning Promise<void> */ {
      const home = os.homedir()
      const arg = args.trim().toLowerCase()

      if (arg === 'on' || arg === 'off') return toggleAutoMemory(ctx, home, arg === 'on')

      if (arg === 'edit') return editMemoryFile(ctx, home)

      if (arg.length > 0) {
        ctx.ui.notify('Usage: /memory [edit|on|off]', 'error')
        return
      }

      showMemoryLocations(ctx, home)
    },
  })
}

/** /memory on|off: write autoMemoryEnabled to the user settings file. */
function toggleAutoMemory(ctx: ExtensionCommandContext, home: string, next: boolean): void {
  let result: { ok: true } | { ok: false; error: string }
  try {
    result = setAutoMemoryEnabledSetting(home, next)
  } catch (error) {
    ctx.ui.notify(`Could not update auto memory: ${errorMessage(error)}`, 'error')
    return
  }
  if (!result.ok) {
    ctx.ui.notify(result.error, 'error')
    return
  }
  ctx.ui.notify(`Auto memory ${next ? 'enabled' : 'disabled'} in ${path.join(claudeConfigDir(home), 'settings.json')} (applies next session).`, 'info')
}

/** /memory with no argument: the memory locations and whether auto memory is on. */
function showMemoryLocations(ctx: ExtensionCommandContext, home: string): void {
  const approved = isProjectApprovedSilently(ctx)
  const settings = readMemorySettings(memorySettingsFiles(ctx.cwd, home, approved))
  const isEnabled = autoMemoryEnabled(settings.autoMemoryEnabled, process.env)
  const override = typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory : undefined
  const store = resolveMemoryDir(ctx.cwd, override, memoryStorageSetting(settings.autoMemoryStorage))
  const lines = ['Memory', `  Auto memory: ${isEnabled ? 'on' : 'off'}`, `  Store:       ${store}`, `  Index:       ${path.join(store, INDEX_FILE)}`, ...memoryFiles(ctx.cwd, home).map(({ label, file }) => `  ${label}: ${file}`), 'Edit one with /memory edit. Toggle with /memory on or /memory off.']
  ctx.ui.notify(lines.join('\n'), 'info')
}

/**
 * The CLAUDE.md locations /memory lists and edits. Claude's /memory lists every documented
 * location, including files that do not exist yet. The user file is read from the
 * configured directory, so CLAUDE_CONFIG_DIR moves it.
 */
function memoryFiles(cwd: string, home: string): Array<{ label: string; file: string }> {
  return [
    { label: 'User memory (CLAUDE.md)', file: path.join(claudeConfigDir(home), 'CLAUDE.md') },
    { label: 'Project memory (CLAUDE.md)', file: path.join(cwd, 'CLAUDE.md') },
    { label: 'Project memory (CLAUDE.local.md)', file: path.join(cwd, 'CLAUDE.local.md') },
    { label: 'Project memory (alternate)', file: path.join(cwd, '.claude', 'CLAUDE.md') },
  ]
}

/** A picker entry. A symlink also names its real target: that is the file the editor writes,
 * and a cloned repository could point its CLAUDE.md anywhere. */
function pickerEntry({ label, file }: { label: string; file: string }): string {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return `${label}: ${file} -> ${fs.realpathSync(file)}`
  } catch {
    // Missing or unreadable: listed by its own path.
  }
  return `${label}: ${file}`
}

/**
 * /memory edit: open a memory file in the user's editor, as Claude does. The editor gets the
 * terminal (pi's TUI stopped and restarted around it, as pi's own external editor does) and
 * writes the file itself. pi-code never reads or rewrites the bytes: pi's in-TUI editor
 * normalises CRLF and tabs and trims, and a read-then-write would overwrite a change made
 * meanwhile. The command is pi's own choice: its externalEditor setting, then VISUAL, EDITOR.
 */
async function editMemoryFile(ctx: ExtensionCommandContext, home: string): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('/memory edit needs the interactive UI', 'error')
    return
  }
  const files = memoryFiles(ctx.cwd, home)
  const options = files.map(pickerEntry)
  const choice = await ctx.ui.select('Edit which memory file?', options)
  const picked = files[options.indexOf(choice ?? '')]
  if (!picked) return
  const command = SettingsManager.create(ctx.cwd, getAgentDir()).getExternalEditorCommand()
  try {
    fs.mkdirSync(path.dirname(picked.file), { recursive: true })
  } catch (error) {
    ctx.ui.notify(`Could not create ${path.dirname(picked.file)}: ${errorMessage(error)}`, 'error')
    return
  }
  const code = await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
    tui.stop()
    let finished = false
    const finish = (exit: number | null): void => {
      if (finished) return
      finished = true
      tui.start()
      tui.requestRender(true)
      done(exit)
    }
    const [editor, ...editorArgs] = command.split(' ')
    const child = spawn(editor, [...editorArgs, picked.file], { stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', () => finish(null))
    child.on('close', (exit) => finish(exit))
    return { render: () => [], invalidate: () => {} }
  })
  if (code === 0) return
  ctx.ui.notify(code === null ? `Could not start the editor (${command})` : `The editor (${command}) exited with code ${code}`, 'error')
}
