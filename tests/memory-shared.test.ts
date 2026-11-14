import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import memoryExtension, { capIndexForPrompt, claudeMemoryDir, claudeProjectSlug, indexWouldOverflow, readMemorySettings, resolveMemoryDir, upsertIndexLine } from '../extensions/memory.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
type CommandSpec = { handler: (args: string, ctx: unknown) => Promise<void> }

// A Claude-written store: underscored file names, Chinese link titles, an em-dash
// description separator, and section headings the index rewrite must not flatten.
const CLAUDE_INDEX = [
  '# Memory Index',
  '',
  '## 工作规则与引用',
  '',
  '- [跑批须等用户下令](feedback_no_unprompted_bench_runs.md) — 硬约束：真实 LLM 跑批等用户说「跑」',
  '- [小改动不跑 e2e](feedback_e2e_run_cadence.md) — 改完 marker 决定要不要跑 J6/J7 时',
  '',
  '## 开发环境',
  '',
  '- [Next 产物污染](project_nextjs_build_artifacts.md) — dev server 异常、并存跑构建、写启动逻辑',
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
 * every character outside [a-zA-Z0-9] becomes one dash, with no folding and no digest. */
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
    writeFileSync(join(store, 'feedback_no_unprompted_bench_runs.md'), '硬约束正文\n')
    writeFileSync(join(store, 'feedback_e2e_run_cadence.md'), 'e2e 正文\n')
    writeFileSync(join(store, 'project_nextjs_build_artifacts.md'), '构建产物正文\n')
  })

  it('injects the Claude index unchanged, headings included', async () => {
    const { handlers } = wire()
    await start(handlers, cwd)
    const injected = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as {
      systemPrompt: string
    }
    expect(injected.systemPrompt).toContain('## 工作规则与引用')
    expect(injected.systemPrompt).toContain('- [跑批须等用户下令](feedback_no_unprompted_bench_runs.md) — 硬约束：真实 LLM 跑批等用户说「跑」')
  })

  it('reads a memory by its dashed name when the file on disk uses underscores', async () => {
    const t = await toolFor(cwd)
    const read = (await t.execute('1', { action: 'read', name: 'feedback-no-unprompted-bench-runs' })).content[0].text
    expect(read).toBe('硬约束正文\n')
  })

  it('saves over the underscored file and replaces its index line in place, keeping headings and titles', async () => {
    const t = await toolFor(cwd)
    const saved = (await t.execute('1', { action: 'save', name: 'feedback_no_unprompted_bench_runs', description: '新的描述', content: '更新后的正文\n' })).content[0].text
    expect(saved).toContain('Saved memory')

    // The existing file was updated, not duplicated alongside.
    expect(readFileSync(join(store, 'feedback_no_unprompted_bench_runs.md'), 'utf-8')).toBe('更新后的正文\n')
    expect(existsSync(join(store, 'feedback-no-unprompted-bench-runs.md'))).toBe(false)

    const index = readFileSync(join(store, 'MEMORY.md'), 'utf-8')
    expect(index).toContain('## 工作规则与引用')
    expect(index).toContain('## 开发环境')
    // The Chinese title survives the update; only the description is replaced.
    expect(index).toContain('[跑批须等用户下令](feedback_no_unprompted_bench_runs.md) — 新的描述')
    expect(index.match(/feedback_no_unprompted_bench_runs\.md/g)).toHaveLength(1)
    // The other entries are untouched.
    expect(index).toContain('[小改动不跑 e2e](feedback_e2e_run_cadence.md)')
  })

  it('deletes the underscored file and its index line while keeping the rest of the index', async () => {
    const t = await toolFor(cwd)
    const deleted = (await t.execute('1', { action: 'delete', name: 'feedback-no-unprompted-bench-runs' })).content[0].text
    expect(deleted).toContain('Deleted')

    expect(existsSync(join(store, 'feedback_no_unprompted_bench_runs.md'))).toBe(false)
    const index = readFileSync(join(store, 'MEMORY.md'), 'utf-8')
    expect(index).not.toContain('feedback_no_unprompted_bench_runs.md')
    expect(index).toContain('## 工作规则与引用')
    expect(index).toContain('[小改动不跑 e2e](feedback_e2e_run_cadence.md)')
    expect(index).toContain('[Next 产物污染](project_nextjs_build_artifacts.md)')
  })

  it('appends a new memory without reordering the existing index', async () => {
    const t = await toolFor(cwd)
    await t.execute('1', { action: 'save', name: 'new-lesson', description: 'fresh', content: 'body\n' })
    const index = readFileSync(join(store, 'MEMORY.md'), 'utf-8')
    expect(index).toContain('## 工作规则与引用')
    expect(index).toContain('- [new-lesson](new-lesson.md): fresh')
    expect(index.indexOf('feedback_no_unprompted_bench_runs.md')).toBeLessThan(index.indexOf('new-lesson.md'))
  })

  it('counts an existing underscored entry as an edit, not index growth', () => {
    expect(indexWouldOverflow(CLAUDE_INDEX, 'feedback-no-unprompted-bench-runs', 'updated description')).toBe(false)
  })

  it('replaces a matching index line through upsertIndexLine without touching a line that merely mentions it', () => {
    const index = `${CLAUDE_INDEX}- [notes](notes.md): see [跑批须等用户下令](feedback_no_unprompted_bench_runs.md) for context\n`
    const updated = upsertIndexLine(index, 'feedback-no-unprompted-bench-runs', 'rewritten')
    expect(updated).toContain('- [notes](notes.md): see')
    expect(updated.match(/feedback_no_unprompted_bench_runs\.md/g)).toHaveLength(2)
  })

  it('caps a Claude index for the prompt exactly as it caps a pi one', () => {
    const capped = capIndexForPrompt(CLAUDE_INDEX)
    expect(capped).toContain('## 工作规则与引用')
    expect(capped).toContain('跑批须等用户下令')
  })
})
