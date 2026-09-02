import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// homedir cannot be spied on an ESM namespace, so the module is mocked instead.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home || actual.homedir() }
})

// Records every readFileSync path (so the index-cache test can count index reads) and
// every renameSync (so the atomic-write tests can assert a temp file was renamed onto
// the target). The builtin namespace is not spyable either, so the module is wrapped like os.
const fsHoisted = vi.hoisted(() => ({ reads: [] as string[], renames: [] as Array<[string, string]>, renameError: undefined as string | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    fsHoisted.reads.push(String(args[0]))
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  const renameSync = ((...args: Parameters<typeof actual.renameSync>) => {
    fsHoisted.renames.push([String(args[0]), String(args[1])])
    // A store move can fail for reasons no fixture reproduces portably (a cross-device
    // rename, a permission problem), so the failure is injected here.
    if (fsHoisted.renameError) throw new Error(fsHoisted.renameError)
    return actual.renameSync(...args)
  }) as typeof actual.renameSync
  return { ...actual, readFileSync, renameSync }
})

import memoryExtension, {
  autoMemoryEnabled,
  capIndexForPrompt,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  indexWouldOverflow,
  memoryDir,
  migrateLegacyStore,
  projectSlug,
  readMemorySettings,
  removeIndexLine,
  resolveMemoryDir,
  setAutoMemoryEnabledSetting,
  slugifyName,
  stampModified,
  stripNonLoaded,
  upsertIndexLine,
} from '../extensions/memory.ts'

describe('memory helpers', () => {
  it('slugs project paths into directory names', () => {
    // Readable dashed path plus a short digest that keeps distinct paths distinct.
    expect(projectSlug('/Users/alex/Documents/pi-code')).toMatch(/^-Users-alex-Documents-pi-code-[0-9a-f]{8}$/)
    expect(projectSlug('C:\\Users\\alex\\Documents\\pi-code')).toMatch(/^C-Users-alex-Documents-pi-code-[0-9a-f]{8}$/)
    expect(memoryDir('/tmp/x')).toContain(path.join('.pi', 'agent', 'memory', projectSlug('/tmp/x')))
  })

  it('keys the store on the repository root so subdirectory sessions share it', () => {
    // Claude derives the memory dir from the git repo; a subdir session must reach
    // the same store, not a separate one keyed on the subdirectory.
    const repo = mkdtempSync(join(tmpdir(), 'mem-repo-'))
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    expect(memoryDir(sub)).toBe(memoryDir(repo))
    rmSync(repo, { recursive: true, force: true })
  })

  it('distinguishes paths that collapse to the same dashed slug', () => {
    // Every separator becomes a dash, so /a/b, /a-b and \\a\\b used to share one store.
    const slashed = projectSlug('/a/b')
    expect(slashed).not.toBe(projectSlug('/a-b'))
    expect(projectSlug('/a/b')).toBe(slashed)
  })

  it('treats a windows drive letter case-insensitively', () => {
    // C: and c: name the same location on Windows; two stores would split the index.
    expect(projectSlug('C:\\Users\\alex\\code')).toBe(projectSlug('c:\\Users\\alex\\code'))
  })

  it('caps the injected index by lines and bytes, reporting what was dropped', () => {
    const small = '# Memory index\n- [a](a.md): first\n'
    expect(capIndexForPrompt(small)).toBe(small)

    const many = ['# Memory index', ...Array.from({ length: INDEX_MAX_LINES + 20 }, (_, i) => `- [m${i}](m${i}.md): entry ${i}`)].join('\n')
    const cappedLines = capIndexForPrompt(many)
    expect(cappedLines.split('\n').length).toBeLessThanOrEqual(INDEX_MAX_LINES + 2)
    expect(cappedLines).toContain('memories not shown')

    const fat = `# Memory index\n- [big](big.md): ${'x'.repeat(INDEX_MAX_BYTES * 2)}`
    expect(Buffer.byteLength(capIndexForPrompt(fat), 'utf-8')).toBeLessThanOrEqual(INDEX_MAX_BYTES + 200)
  })

  it('strips frontmatter and comments from the injected index', () => {
    const idx = '---\nmodified: z\n---\n<!-- hi -->\n# Memory index\n- [a](a.md): first\n'
    const out = capIndexForPrompt(idx)
    expect(out).not.toContain('modified: z')
    expect(out).not.toContain('hi')
    expect(out).toContain('- [a](a.md): first')
  })

  it('slugifies memory names', () => {
    expect(slugifyName('User prefers TABS!')).toBe('user-prefers-tabs')
    expect(slugifyName('///')).toBe('memory')
  })

  it('upserts index lines and creates a header', () => {
    const first = upsertIndexLine('', 'no-dashes', 'never use em dashes')
    expect(first).toContain('# Memory index')
    expect(first).toContain('- [no-dashes](no-dashes.md): never use em dashes')

    const replaced = upsertIndexLine(first, 'no-dashes', 'updated description')
    expect(replaced).toContain('updated description')
    expect(replaced.match(/no-dashes\.md/g)).toHaveLength(1)
  })

  it('removes index lines and empties the index when last one goes', () => {
    const index = upsertIndexLine(upsertIndexLine('', 'a', 'first'), 'b', 'second')
    const removed = removeIndexLine(index, 'a')
    expect(removed).not.toContain('](a.md)')
    expect(removed).toContain('](b.md)')
    const emptied = removeIndexLine(removeIndexLine(index, 'a'), 'b')
    expect(emptied).toBe('# Memory index\n')
  })

  it('saving a memory does not delete an entry that merely mentions it', () => {
    const index = '# Memory index\n- [notes](notes.md): see [build](build.md): for context\n- [build](build.md): old steps\n'
    const updated = upsertIndexLine(index, 'build', 'new steps')
    expect(updated).toContain('- [notes](notes.md):')
    expect(updated).toContain('- [build](build.md): new steps')
    expect(updated.split('\n').filter((l) => l.startsWith('- [build](build.md)'))).toHaveLength(1)
  })

  it('removing a memory keeps an entry that merely mentions it', () => {
    const index = '# Memory index\n- [notes](notes.md): see [build](build.md): for context\n- [build](build.md): steps\n'
    const remaining = removeIndexLine(index, 'build')
    expect(remaining).toContain('- [notes](notes.md):')
    expect(remaining).not.toContain('- [build](build.md)')
  })

  it('flattens a multi-line description into one index line', () => {
    // A newline in the description would break every later line-based match.
    expect(upsertIndexLine('', 'a', 'line one\nline two')).toBe('# Memory index\n- [a](a.md): line one line two\n')
  })
})

describe('stampModified', () => {
  const iso = '2026-08-16T12:00:00.000Z'

  it('adds a modified timestamp inside existing frontmatter', () => {
    const out = stampModified('---\nname: x\n---\nbody', iso)
    expect(out).toContain(`modified: ${iso}`)
    expect(out).toContain('name: x')
    expect(out.endsWith('body')).toBe(true)
  })

  it('replaces an existing modified field rather than duplicating it', () => {
    const out = stampModified('---\nmodified: 2020-01-01T00:00:00.000Z\nname: x\n---\nbody', iso)
    expect(out).toContain(`modified: ${iso}`)
    expect(out).not.toContain('2020-01-01')
    expect(out.match(/modified:/g)).toHaveLength(1)
  })

  it('never adds frontmatter to a file that has none', () => {
    expect(stampModified('plain body, no frontmatter', iso)).toBe('plain body, no frontmatter')
  })
})

describe('stripNonLoaded', () => {
  it('strips leading frontmatter and block HTML comments, keeping the index body', () => {
    const idx = '---\nmodified: z\n---\n<!-- a maintainer note -->\n# Memory index\n- [a](a.md): first\n'
    const stripped = stripNonLoaded(idx)
    expect(stripped).not.toContain('modified: z')
    expect(stripped).not.toContain('maintainer note')
    expect(stripped).toContain('# Memory index')
    expect(stripped).toContain('- [a](a.md): first')
  })

  it('cannot reassemble a comment from a comment nested inside another', () => {
    // A single regex pass removes the inner comment and leaves <!--- y --> behind.
    const stripped = stripNonLoaded('<!-<!-- x -->-- zzz -->\n# Memory index\n')
    expect(stripped).not.toContain('<!--')
    expect(stripped).not.toContain('zzz')
    expect(stripped).toBe('# Memory index\n')
  })

  it('keeps an unterminated comment opener as text', () => {
    expect(stripNonLoaded('# Memory index\n<!-- open')).toBe('# Memory index\n<!-- open')
  })
})

describe('autoMemoryEnabled', () => {
  it('forces auto memory on when the variable is set to 0', () => {
    // env-vars: "Set to 0 to force auto memory on even when --bare mode or
    // autoMemoryEnabled: false would otherwise disable it." Only 1 disables.
    expect(autoMemoryEnabled(false, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' })).toBe(true)
    expect(autoMemoryEnabled(undefined, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' })).toBe(true)
    expect(autoMemoryEnabled(true, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })).toBe(false)
  })

  it('defaults to enabled and disables on a false setting or the env var', () => {
    expect(autoMemoryEnabled(undefined, {} as NodeJS.ProcessEnv)).toBe(true)
    expect(autoMemoryEnabled(true, {} as NodeJS.ProcessEnv)).toBe(true)
    expect(autoMemoryEnabled(false, {} as NodeJS.ProcessEnv)).toBe(false)
    expect(autoMemoryEnabled(undefined, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(autoMemoryEnabled(true, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    // A falsey-looking value ('0') still means the variable is set, matching Claude's =1 gate off/on being presence-based only for 1/true.
    expect(autoMemoryEnabled(undefined, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('resolveMemoryDir', () => {
  it('honors an absolute or ~/ override and ignores a relative one', () => {
    hoisted.home = '/home/u'
    expect(resolveMemoryDir('/proj', '/custom/mem')).toBe('/custom/mem')
    expect(resolveMemoryDir('/proj', '~/mem')).toBe(join('/home/u', 'mem'))
    expect(resolveMemoryDir('/proj', 'relative/mem')).toBe(memoryDir('/proj'))
    expect(resolveMemoryDir('/proj', undefined)).toBe(memoryDir('/proj'))
    hoisted.home = ''
  })
})

describe('indexWouldOverflow', () => {
  it('reports when a new entry would push the index past the startup bound', () => {
    const roomy = '# Memory index\n- [a](a.md): first\n'
    expect(indexWouldOverflow(roomy, 'b', 'second')).toBe(false)

    const atLineLimit = ['# Memory index', ...Array.from({ length: INDEX_MAX_LINES }, (_, i) => `- [m${i}](m${i}.md): entry`)].join('\n')
    expect(indexWouldOverflow(atLineLimit, 'extra', 'one more')).toBe(true)

    const atByteLimit = `# Memory index\n- [big](big.md): ${'x'.repeat(INDEX_MAX_BYTES)}`
    expect(indexWouldOverflow(atByteLimit, 'extra', 'one more')).toBe(true)
  })

  it('does not count replacing an existing entry as growth', () => {
    const atLineLimit = ['# Memory index', ...Array.from({ length: INDEX_MAX_LINES }, (_, i) => `- [m${i}](m${i}.md): entry`)].join('\n')
    expect(indexWouldOverflow(atLineLimit, 'm0', 'updated description')).toBe(false)
  })

  it('does not count a block HTML comment toward the byte bound', () => {
    // A huge comment blows the raw byte budget but is stripped before the index loads.
    const commented = `# Memory index\n<!-- ${'y'.repeat(INDEX_MAX_BYTES)} -->\n- [a](a.md): first\n`
    expect(indexWouldOverflow(commented, 'b', 'second')).toBe(false)
  })
})

describe('setAutoMemoryEnabledSetting', () => {
  it('writes the user settings atomically via a temp file, preserving other keys', () => {
    const home = mkdtempSync(join(tmpdir(), 'mem-atomic-'))
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      const file = join(home, '.claude', 'settings.json')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(file, JSON.stringify({ theme: 'dark' }))
      fsHoisted.renames.length = 0

      const result = setAutoMemoryEnabledSetting(home, false)
      expect(result).toEqual({ ok: true })

      // The final content is correct and unrelated keys survive.
      const parsed = JSON.parse(readFileSync(file, 'utf-8'))
      expect(parsed.autoMemoryEnabled).toBe(false)
      expect(parsed.theme).toBe('dark')

      // Like writeIndex, the write lands through a temp file renamed onto the target, so a
      // crash mid-write cannot truncate the user's hooks/env/permissions config.
      expect(fsHoisted.renames.some(([from, to]) => to === file && from.includes('.tmp'))).toBe(true)
    } finally {
      if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('memory extension', () => {
  let savedAgentDir: string | undefined
  let savedDisable: string | undefined
  let savedSubagent: string | undefined
  beforeEach(() => {
    hoisted.home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'mem-agent-'))
    savedDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    savedSubagent = process.env.PI_CODE_SUBAGENT
    delete process.env.PI_CODE_SUBAGENT
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
    if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedDisable
    if (savedSubagent === undefined) delete process.env.PI_CODE_SUBAGENT
    else process.env.PI_CODE_SUBAGENT = savedSubagent
    hoisted.home = ''
  })

  interface Tool {
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>
  }
  const wire = () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    let tool: Tool | undefined
    memoryExtension({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      registerTool: (t: Tool) => {
        tool = t
      },
      registerCommand: () => {},
    } as never)
    return { handlers, getTool: (): Tool => tool as Tool }
  }

  const userSettings = (settings: Record<string, unknown>): void => {
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify(settings))
  }

  const cwdDir = (): string => mkdtempSync(join(tmpdir(), 'mem-cwd-'))
  const ctxFor = (cwd: string) => ({ cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify: () => {} } })

  it('injects the index by default and honors the disable env var', async () => {
    const cwd = cwdDir()
    const dir = memoryDir(cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [a](a.md): first\n')

    const on = wire()
    await on.handlers.get('session_start')?.({}, ctxFor(cwd))
    const injected = (await on.handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(injected.systemPrompt).toContain('- [a](a.md): first')

    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    const off = wire()
    await off.handlers.get('session_start')?.({}, ctxFor(cwd))
    expect(await off.handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})).toBeUndefined()
  })

  it('does not inject and the tool reports disabled when autoMemoryEnabled is false', async () => {
    const cwd = cwdDir()
    userSettings({ autoMemoryEnabled: false })
    const dir = memoryDir(cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [a](a.md): first\n')

    const { handlers, getTool } = wire()
    await handlers.get('session_start')?.({}, ctxFor(cwd))
    expect(await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})).toBeUndefined()

    const res = await getTool().execute('id', { action: 'save', name: 'x', description: 'd', content: 'c' })
    expect(res.content[0].text).toMatch(/disabled/i)
    // The save was refused, so no new file landed.
    expect(existsSync(join(dir, 'x.md'))).toBe(false)
  })

  it('no-ops inside a subagent: no injection, no notify, and the tool refuses', async () => {
    // Claude does not load the main conversation's auto memory into subagents; the
    // extensions also load inside spawned children, so the marker must gate everything.
    const savedMarker = process.env.PI_CODE_SUBAGENT
    process.env.PI_CODE_SUBAGENT = '1'
    try {
      const cwd = cwdDir()
      const dir = memoryDir(cwd)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [a](a.md): first\n')

      const notify = vi.fn()
      const { handlers, getTool } = wire()
      await handlers.get('session_start')?.({}, { cwd, isProjectTrusted: () => false, hasUI: false, ui: { notify } })
      expect(notify).not.toHaveBeenCalled()
      // The parent's index exists on disk, but the child must not receive it.
      expect(await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})).toBeUndefined()

      const res = await getTool().execute('id', { action: 'save', name: 'x', description: 'd', content: 'c' })
      expect(res.content[0].text).toMatch(/subagent/i)
      // Nothing touched the parent store.
      expect(existsSync(join(dir, 'x.md'))).toBe(false)
    } finally {
      if (savedMarker === undefined) delete process.env.PI_CODE_SUBAGENT
      else process.env.PI_CODE_SUBAGENT = savedMarker
    }
  })

  it('reads the index once across turns, re-reading only after a change', async () => {
    const cwd = cwdDir()
    const dir = memoryDir(cwd)
    mkdirSync(dir, { recursive: true })
    const indexPath = join(dir, 'MEMORY.md')
    writeFileSync(indexPath, '# Memory index\n- [a](a.md): first\n')

    const { handlers, getTool } = wire()
    await handlers.get('session_start')?.({}, ctxFor(cwd))

    const indexReads = () => fsHoisted.reads.filter((p) => p === indexPath).length
    const mark = indexReads()
    for (let i = 0; i < 3; i++) {
      const injected = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
      expect(injected.systemPrompt).toContain('- [a](a.md): first')
    }
    // One read for the first turn; the later turns revalidate with a stat only.
    expect(indexReads()).toBe(mark + 1)

    // A save invalidates the cache, so the next turn carries the new entry.
    await getTool().execute('id', { action: 'save', name: 'b', description: 'second', content: 'body' })
    const afterSave = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(afterSave.systemPrompt).toContain('- [b](b.md): second')

    // An external rewrite (different size) is caught by the stat gate.
    writeFileSync(indexPath, '# Memory index\n- [c](c.md): replaced externally\n')
    const afterEdit = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(afterEdit.systemPrompt).toContain('- [c](c.md): replaced externally')
    expect(afterEdit.systemPrompt).not.toContain('- [b](b.md)')

    // The delete invalidates too: the next turn no longer lists the removed entry.
    await getTool().execute('id', { action: 'delete', name: 'c' })
    const afterDelete = (await handlers.get('before_agent_start')?.({ systemPrompt: 'BASE' }, {})) as { systemPrompt: string }
    expect(afterDelete.systemPrompt).not.toContain('- [c](c.md)')
  })

  it('stamps a modified timestamp when saving a memory that has frontmatter', async () => {
    const cwd = cwdDir()
    const { handlers, getTool } = wire()
    await handlers.get('session_start')?.({}, ctxFor(cwd))

    await getTool().execute('id', { action: 'save', name: 'note', description: 'a note', content: '---\nname: note\n---\nbody' })
    const saved = readFileSync(join(memoryDir(cwd), 'note.md'), 'utf-8')
    expect(saved).toMatch(/modified: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/)
    expect(saved).toContain('name: note')
  })

  it('honors autoMemoryDirectory from user settings for storage', async () => {
    const cwd = cwdDir()
    const custom = mkdtempSync(join(tmpdir(), 'mem-custom-'))
    userSettings({ autoMemoryDirectory: custom })
    const { handlers, getTool } = wire()
    await handlers.get('session_start')?.({}, ctxFor(cwd))

    await getTool().execute('id', { action: 'save', name: 'note', description: 'a note', content: 'body' })
    expect(existsSync(join(custom, 'note.md'))).toBe(true)
    expect(existsSync(join(custom, 'MEMORY.md'))).toBe(true)
    // The default location was not used.
    expect(existsSync(join(memoryDir(cwd), 'note.md'))).toBe(false)
  })
})

describe('migrateLegacyStore', () => {
  it('reports a store it could not migrate rather than starting empty in silence', () => {
    // The session then has no memories while they sit under the old slug, which reads as
    // having lost them.
    const home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    hoisted.home = home
    const cwd = '/proj/blocked'
    const legacy = join(home, '.pi', 'agent', 'memory', '-proj-blocked')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'MEMORY.md'), '- [a](a.md): kept\n')
    fsHoisted.renameError = 'EXDEV: cross-device link not permitted'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      migrateLegacyStore(cwd)

      expect(existsSync(legacy)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(legacy))
    } finally {
      fsHoisted.renameError = undefined
      warn.mockRestore()
    }
  })

  it('renames a pre-digest store to the current slug, once, without clobbering', () => {
    const home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    hoisted.home = home
    const cwd = '/proj/app'
    const legacy = join(home, '.pi', 'agent', 'memory', '-proj-app')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'MEMORY.md'), '- [a](a.md): kept\n')

    migrateLegacyStore(cwd)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(memoryDir(cwd), 'MEMORY.md'), 'utf-8')).toContain('kept')

    // A second run with a fresh legacy dir must not overwrite the migrated store.
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'MEMORY.md'), '- [b](b.md): newer\n')
    migrateLegacyStore(cwd)
    expect(readFileSync(join(memoryDir(cwd), 'MEMORY.md'), 'utf-8')).toContain('kept')
    rmSync(home, { recursive: true, force: true })
    hoisted.home = ''
  })

  it('migrates a released digest-of-cwd store to the repo-root slug for a subdir session', () => {
    const home = mkdtempSync(join(tmpdir(), 'mem-home-'))
    hoisted.home = home
    // A released version keyed the store on the raw subdirectory cwd; the current one
    // keys on the repository root, so the subdir session would otherwise orphan it.
    const repo = mkdtempSync(join(tmpdir(), 'mem-repo-'))
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'src')
    mkdirSync(sub)
    const oldDir = join(home, '.pi', 'agent', 'memory', projectSlug(sub))
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'MEMORY.md'), '- [a](a.md): kept\n')
    expect(memoryDir(sub)).not.toBe(oldDir)

    migrateLegacyStore(sub)

    expect(existsSync(oldDir)).toBe(false)
    expect(readFileSync(join(memoryDir(sub), 'MEMORY.md'), 'utf-8')).toContain('kept')
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    hoisted.home = ''
  })
})

describe('managed autoMemory settings', () => {
  it('lets managed policy settings override the settings-chain autoMemory values', () => {
    // Claude's settings precedence: managed policy settings win over user and
    // project files.
    const dir = mkdtempSync(join(tmpdir(), 'mem-managed-'))
    const user = join(dir, 'settings.json')
    writeFileSync(user, JSON.stringify({ autoMemoryEnabled: true }))
    const merged = readMemorySettings([user], { autoMemoryEnabled: false, autoMemoryDirectory: '/managed/dir' })
    expect(merged.autoMemoryEnabled).toBe(false)
    expect(merged.autoMemoryDirectory).toBe('/managed/dir')
  })
})
