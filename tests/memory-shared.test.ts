import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import memoryExtension, { capIndexForPrompt, claudeMemoryDir, claudeProjectSlug, indexWouldOverflow, readMemorySettings, resolveMemoryDir, upsertIndexLine } from '../extensions/memory.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
type CommandSpec = { handler: (args: string, ctx: unknown) => Promise<void> }

// A store as Claude Code writes it: no top heading, dashed file names (one older
// underscored one), free-form titles, Claude's separator before each hook, and a
// section heading the index rewrite must not flatten.
const CLAUDE_INDEX = [
  '- [跑批须等用户下令](feedback-no-unprompted-bench-runs.md) — 硬约束：真实 LLM 跑批等用户说「跑」',
  '- [小改动不跑 e2e](feedback_e2e_run_cadence.md) — 改完 marker 决定要不要跑 J6/J7 时',
  '',
  '## 开发环境',
  '',
  '- [Next 产物污染](project-nextjs-build-artifacts.md) — dev server 异常、并存跑构建、写启动逻辑',
  '',
].join('\n')

let home: string

// tests/setup.ts rolls process.env back after every test.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home // os.homedir() reads USERPROFILE on Windows
})

const userSettings = (settings: Record<string, unknown>): void => {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings))
}

const claudeStore = (cwd: string): string => join(home, '.claude', 'projects', claudeProjectSlug(cwd), 'memory')

function wire() {
  const handlers = new Map<string, Handler>()
  let tool: Tool | undefined
  memoryExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerTool: (t: Tool) => {
      tool = t
    },
    registerCommand: () => {},
  } as never)
  if (!tool) throw new Error('memory tool not registered')
  return { handlers, tool }
}

const start = async (handlers: Map<string, Handler>, cwd: string) => handlers.get('session_start')?.({}, { cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } })

const toolFor = async (cwd: string): Promise<Tool> => {
  const wired = wire()
  await start(wired.handlers, cwd)
  return wired.tool
}

/** The Claude project slug, verified against directories Claude Code itself creates:
 * every character outside [a-zA-Z0-9] becomes one dash. */
describe('claudeProjectSlug', () => {
  it('encodes an ordinary path as its dashed form', () => {
    expect(claudeProjectSlug('/Users/tttinkl/code/ai-gk')).toBe('-Users-tttinkl-code-ai-gk')
  })

  it('replaces every non-alphanumeric character with one dash each', () => {
    // A CJK path segment observed on disk: 26 survives, each of the eight CJK
    // characters becomes its own dash.
    expect(claudeProjectSlug('/Users/tttinkl/Documents/hey/26宁波事业考点强化')).toBe('-Users-tttinkl-Documents-hey-26--------')
    // Spaces and underscores become dashes too, as paths such as "my projects/demo_app" show.
    expect(claudeProjectSlug('/tmp/my projects/demo_app')).toBe('-tmp-my-projects-demo-app')
  })

  it('cuts a slug longer than 200 characters and appends a hash of the path', () => {
    // Expected values come from running the slug and hash functions as they appear in
    // the Claude Code 2.1.325 bundle on these paths.
    const ascii = `/srv/${'deep-directory/'.repeat(14)}project`
    expect(claudeProjectSlug(ascii)).toBe(`-srv-${'deep-directory-'.repeat(13)}-w3jbji`)
    // The hash covers the path, not its dashed form: the characters the slug drops still count.
    const wide = `/srv/${'深い/'.repeat(80)}café`
    expect(claudeProjectSlug(wide)).toBe(`-srv${'-'.repeat(196)}-m5guxk`)
    expect(claudeProjectSlug(`/${'a'.repeat(199)}`)).toBe(`-${'a'.repeat(199)}`)
  })
})

describe('claude memory storage', () => {
  it('places the store under the Claude projects directory, keyed on the repository root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mem-repo-'))
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    expect(claudeMemoryDir(repo)).toBe(claudeStore(repo))
    // Subdirectory sessions share the repository store, as Claude's docs state.
    expect(claudeMemoryDir(sub)).toBe(claudeMemoryDir(repo))
  })

  it('normalises the project path to NFC before deriving the slug', () => {
    const composed = claudeMemoryDir('/srv/caf\u00e9')
    expect(composed).toBe(join(home, '.claude', 'projects', '-srv-caf-', 'memory'))
    expect(claudeMemoryDir('/srv/cafe\u0301')).toBe(composed)
  })

  it('roots the store at CLAUDE_CODE_REMOTE_MEMORY_DIR when it is set', () => {
    const remote = mkdtempSync(join(tmpdir(), 'mem-remote-'))
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = remote
    process.env.CLAUDE_CONFIG_DIR = join(home, 'config')
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'shared'
    expect(claudeMemoryDir('/srv/app')).toBe(join(remote, 'projects', '-srv-app', 'memory'))
  })

  it('uses CLAUDE_CODE_PROJECT_DIR_NAME as the project directory only next to CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'shared'
    expect(claudeMemoryDir('/srv/app')).toBe(join(home, '.claude', 'projects', '-srv-app', 'memory'))

    const config = join(home, 'config')
    process.env.CLAUDE_CONFIG_DIR = config
    expect(claudeMemoryDir('/srv/app')).toBe(join(config, 'projects', 'shared', 'memory'))

    // Claude accepts one plain segment of at most 64 characters that is not a Windows device name.
    for (const refused of ['../up', 'a/b', 'CON', 'lpt1', 'x'.repeat(65)]) {
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = refused
      expect(claudeMemoryDir('/srv/app')).toBe(join(config, 'projects', '-srv-app', 'memory'))
    }
  })

  it('merges autoMemoryStorage through the settings chain like the other memory settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-managed-'))
    const user = join(dir, 'settings.json')
    writeFileSync(user, JSON.stringify({ autoMemoryStorage: 'claude' }))
    const merged = readMemorySettings([user], {})
    expect(merged.autoMemoryStorage).toBe('claude')
  })

  it('resolves the claude store for the claude storage mode, and keeps an explicit directory above it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    expect(resolveMemoryDir(cwd, undefined, 'claude')).toBe(claudeStore(cwd))
    expect(resolveMemoryDir(cwd, undefined, 'pi')).toBe(resolveMemoryDir(cwd))
    expect(resolveMemoryDir(cwd, '/explicit/dir', 'claude')).toBe('/explicit/dir')
  })

  it('stores and injects through the Claude directory when the storage mode is claude', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    userSettings({ autoMemoryStorage: 'claude' })
    const store = claudeStore(cwd)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'MEMORY.md'), '# Memory index\n- [a](a.md): first\n')

    const { handlers, tool } = wire()
    await start(handlers, cwd)
    const injected = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as {
      systemPrompt: string
    }
    expect(injected.systemPrompt).toContain('- [a](a.md): first')

    await tool.execute('1', { action: 'save', name: 'note', description: 'a note', content: 'body' })
    expect(existsSync(join(store, 'note.md'))).toBe(true)
    expect(existsSync(join(store, 'MEMORY.md'))).toBe(true)
  })

  it('leaves the pi store untouched while the claude storage mode is active', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    userSettings({ autoMemoryStorage: 'claude' })
    const piStore = resolveMemoryDir(cwd)

    const { handlers, tool } = wire()
    await start(handlers, cwd)
    await tool.execute('1', { action: 'save', name: 'note', description: 'a note', content: 'body' })

    expect(existsSync(piStore)).toBe(false)
  })

  it('lists the Claude store in /memory when the storage mode is claude', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    userSettings({ autoMemoryStorage: 'claude' })
    const commands = new Map<string, CommandSpec>()
    memoryExtension({
      on: () => {},
      registerTool: () => {},
      registerCommand: (name: string, spec: CommandSpec) => commands.set(name, spec),
    } as never)
    const notify = vi.fn()
    await commands.get('memory')?.handler('', { cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify } })
    const text = notify.mock.calls[0][0] as string
    expect(text).toContain(claudeStore(cwd))
  })
})

describe('reading and writing a Claude-written store', () => {
  let cwd: string
  let store: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    userSettings({ autoMemoryStorage: 'claude' })
    store = claudeStore(cwd)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'MEMORY.md'), CLAUDE_INDEX)
    writeFileSync(join(store, 'feedback-no-unprompted-bench-runs.md'), '硬约束正文\n')
    writeFileSync(join(store, 'feedback_e2e_run_cadence.md'), 'e2e 正文\n')
    writeFileSync(join(store, 'project-nextjs-build-artifacts.md'), '构建产物正文\n')
  })

  const index = (): string => readFileSync(join(store, 'MEMORY.md'), 'utf-8')

  it('injects the Claude index unchanged, headings included', async () => {
    const { handlers } = wire()
    await start(handlers, cwd)
    const injected = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as {
      systemPrompt: string
    }
    expect(injected.systemPrompt).toContain(CLAUDE_INDEX)
  })

  it('reads a memory by its dashed name when the file on disk uses underscores', async () => {
    const t = await toolFor(cwd)
    const read = (await t.execute('1', { action: 'read', name: 'feedback-e2e-run-cadence' })).content[0].text
    expect(read).toBe('e2e 正文\n')
  })

  it('replaces only the description of an existing entry, in place', async () => {
    const t = await toolFor(cwd)
    const saved = (await t.execute('1', { action: 'save', name: 'feedback-e2e-run-cadence', description: '新的描述', content: '更新后的正文\n' })).content[0].text
    expect(saved).toContain('Saved memory')

    // The existing file was updated, not duplicated alongside.
    expect(readFileSync(join(store, 'feedback_e2e_run_cadence.md'), 'utf-8')).toContain('更新后的正文\n')
    expect(existsSync(join(store, 'feedback-e2e-run-cadence.md'))).toBe(false)
    expect(index()).toBe(CLAUDE_INDEX.replace('改完 marker 决定要不要跑 J6/J7 时', '新的描述'))
  })

  it('keeps whatever separator an existing entry uses', () => {
    expect(upsertIndexLine('- [Deploy steps](deploy.md) - old\n', 'deploy', 'new', 'claude')).toBe('- [Deploy steps](deploy.md) - new\n')
    expect(upsertIndexLine('- [Deploy steps](deploy.md): old\n', 'deploy', 'new', 'claude')).toBe('- [Deploy steps](deploy.md): new\n')
    expect(upsertIndexLine('- [Deploy steps](deploy.md) — old\n', 'deploy', 'new', 'pi')).toBe('- [Deploy steps](deploy.md) — new\n')
  })

  it('deletes a memory and its index line while keeping the rest of the index', async () => {
    const t = await toolFor(cwd)
    const deleted = (await t.execute('1', { action: 'delete', name: 'feedback-e2e-run-cadence' })).content[0].text
    expect(deleted).toContain('Deleted')

    expect(existsSync(join(store, 'feedback_e2e_run_cadence.md'))).toBe(false)
    expect(index()).toBe(CLAUDE_INDEX.replace(/^.*feedback_e2e_run_cadence.*\n/m, ''))
  })

  it('appends a new memory in the entry format Claude writes, adding no heading', async () => {
    const t = await toolFor(cwd)
    await t.execute('1', { action: 'save', name: 'new-lesson', description: 'fresh', content: 'body\n' })
    expect(index()).toBe(`${CLAUDE_INDEX}- [new-lesson](new-lesson.md) — fresh\n`)
  })

  it('starts a new Claude index without a heading', async () => {
    rmSync(join(store, 'MEMORY.md'))
    const t = await toolFor(cwd)
    await t.execute('1', { action: 'save', name: 'first', description: 'the first one', content: 'body\n' })
    expect(index()).toBe('- [first](first.md) — the first one\n')
  })

  it('writes the name and description frontmatter Claude relies on', async () => {
    const t = await toolFor(cwd)
    await t.execute('1', { action: 'save', name: 'new-lesson', description: 'fresh: keep it\nshort', content: 'body\n' })
    expect(readFileSync(join(store, 'new-lesson.md'), 'utf-8')).toMatch(/^---\nname: new-lesson\ndescription: "fresh: keep it short"\nmodified: \S+\n---\n\nbody\n$/)
  })

  it('nests a given type under metadata and keeps the fields the content already has', async () => {
    const t = await toolFor(cwd)
    await t.execute('1', { action: 'save', name: 'typed', description: 'from the tool', content: '---\ntype: feedback\n---\nbody\n' })
    expect(readFileSync(join(store, 'typed.md'), 'utf-8')).toMatch(/^---\nname: typed\ndescription: "from the tool"\nmetadata:\n {2}type: feedback\n {2}modified: \S+\n---\nbody\n$/)

    const complete = '---\nname: complete\ndescription: its own\nmetadata:\n  type: project\n---\nbody\n'
    await t.execute('2', { action: 'save', name: 'complete', description: 'from the tool', content: complete })
    expect(readFileSync(join(store, 'complete.md'), 'utf-8')).toMatch(/^---\nname: complete\ndescription: its own\nmetadata:\n {2}type: project\n {2}modified: \S+\n---\nbody\n$/)
  })

  it('counts an existing underscored entry as an edit, not index growth', () => {
    expect(indexWouldOverflow(CLAUDE_INDEX, 'feedback-e2e-run-cadence', 'updated description')).toBe(false)
  })

  it('replaces a matching index line through upsertIndexLine without touching a line that merely mentions it', () => {
    const mention = '- [notes](notes.md): see [小改动不跑 e2e](feedback_e2e_run_cadence.md) for context\n'
    const updated = upsertIndexLine(`${CLAUDE_INDEX}${mention}`, 'feedback-e2e-run-cadence', 'rewritten')
    expect(updated).toContain(mention)
    expect(updated).toContain('- [小改动不跑 e2e](feedback_e2e_run_cadence.md) — rewritten\n')
  })

  it('caps a Claude index for the prompt exactly as it caps a pi one', () => {
    expect(capIndexForPrompt(CLAUDE_INDEX)).toBe(CLAUDE_INDEX)
  })
})

describe('resolving a name to one memory file', () => {
  let cwd: string
  let store: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mem-proj-'))
    store = resolveMemoryDir(cwd)
    mkdirSync(store, { recursive: true })
  })

  const seed = (stems: string[]): void => {
    writeFileSync(join(store, 'MEMORY.md'), stems.map((stem) => `- [${stem}](${stem}.md): about ${stem}\n`).join(''))
    for (const stem of stems) writeFileSync(join(store, `${stem}.md`), `${stem} body\n`)
  }
  const index = (): string => readFileSync(join(store, 'MEMORY.md'), 'utf-8')

  it('reads, saves and deletes the exactly named file when a dash and an underscore twin both exist', async () => {
    seed(['build_notes', 'build-notes'])
    const t = await toolFor(cwd)

    expect((await t.execute('1', { action: 'read', name: 'build-notes' })).content[0].text).toBe('build-notes body\n')

    await t.execute('2', { action: 'save', name: 'build-notes', description: 'updated', content: 'new body\n' })
    expect(readFileSync(join(store, 'build-notes.md'), 'utf-8')).toBe('new body\n')
    expect(readFileSync(join(store, 'build_notes.md'), 'utf-8')).toBe('build_notes body\n')
    expect(index()).toBe('- [build_notes](build_notes.md): about build_notes\n- [build-notes](build-notes.md): updated\n')

    await t.execute('3', { action: 'delete', name: 'build-notes' })
    expect(existsSync(join(store, 'build-notes.md'))).toBe(false)
    expect(readFileSync(join(store, 'build_notes.md'), 'utf-8')).toBe('build_notes body\n')
    expect(index()).toBe('- [build_notes](build_notes.md): about build_notes\n')
  })

  it('falls back to the other spelling only when the exact file does not exist', async () => {
    seed(['build_notes'])
    const t = await toolFor(cwd)
    expect((await t.execute('1', { action: 'read', name: 'build-notes' })).content[0].text).toBe('build_notes body\n')
    await t.execute('2', { action: 'delete', name: 'build-notes' })
    expect(existsSync(join(store, 'build_notes.md'))).toBe(false)
    expect(existsSync(join(store, 'MEMORY.md'))).toBe(false)
  })

  it('reaches a file whose name mixes dashes and underscores', async () => {
    seed(['foo-bar_baz'])
    const t = await toolFor(cwd)
    expect((await t.execute('1', { action: 'read', name: 'foo-bar-baz' })).content[0].text).toBe('foo-bar_baz body\n')

    await t.execute('2', { action: 'save', name: 'foo-bar-baz', description: 'updated', content: 'new body\n' })
    expect(readFileSync(join(store, 'foo-bar_baz.md'), 'utf-8')).toBe('new body\n')
    expect(existsSync(join(store, 'foo-bar-baz.md'))).toBe(false)
    expect(index()).toBe('- [foo-bar_baz](foo-bar_baz.md): updated\n')

    await t.execute('3', { action: 'delete', name: 'foo-bar-baz' })
    expect(existsSync(join(store, 'foo-bar_baz.md'))).toBe(false)
  })

  it('adds no frontmatter in the pi store', async () => {
    const t = await toolFor(cwd)
    await t.execute('1', { action: 'save', name: 'plain', description: 'a note', content: 'body\n' })
    expect(readFileSync(join(store, 'plain.md'), 'utf-8')).toBe('body\n')
  })

  it('reads a stored file the index does not list', async () => {
    writeFileSync(join(store, 'loose_note.md'), 'loose body\n')
    const t = await toolFor(cwd)
    expect((await t.execute('1', { action: 'read', name: 'loose-note' })).content[0].text).toBe('loose body\n')
  })

  it('never follows an index link out of the store', async () => {
    const outside = join(store, '..', 'outside.md')
    writeFileSync(outside, 'outside body\n')
    writeFileSync(join(store, 'MEMORY.md'), '- [escape](../outside.md): points out of the store\n')
    const t = await toolFor(cwd)

    expect((await t.execute('1', { action: 'read', name: '../outside' })).content[0].text).toBe('No memory named outside.')
    await t.execute('2', { action: 'save', name: '../outside', description: 'kept inside', content: 'inside body\n' })
    expect(readFileSync(outside, 'utf-8')).toBe('outside body\n')
    expect(readFileSync(join(store, 'outside.md'), 'utf-8')).toBe('inside body\n')

    await t.execute('3', { action: 'delete', name: '../outside' })
    expect(readFileSync(outside, 'utf-8')).toBe('outside body\n')
    expect(existsSync(join(store, 'outside.md'))).toBe(false)
    expect(index()).toContain('- [escape](../outside.md): points out of the store\n')
    expect(index()).not.toContain('kept inside')
  })
})
