import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import initExtension, { buildInitPrompt, CONTEXT_FILE_CANDIDATES, findExistingContextFile } from '../extensions/init.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'init-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('buildInitPrompt', () => {
  it('targets AGENTS.md and asks to create it when no context file exists', () => {
    const prompt = buildInitPrompt({})
    expect(prompt).toContain('AGENTS.md')
    expect(prompt.toLowerCase()).toContain('create')
    expect(prompt.toLowerCase()).not.toContain('propose improvements')
  })

  it('asks for build, test, and lint commands, conventions, architecture, layout, and brevity', () => {
    const prompt = buildInitPrompt({}).toLowerCase()
    for (const needle of ['build', 'test', 'lint', 'convention', 'architecture', 'layout', '200 lines']) {
      expect(prompt).toContain(needle)
    }
  })

  it('notes that Claude Code can read AGENTS.md via import or symlink when creating', () => {
    const prompt = buildInitPrompt({})
    expect(prompt).toContain('Claude Code')
    expect(prompt.toLowerCase()).toMatch(/import|symlink/)
  })

  it('proposes improvements to an existing file by name instead of overwriting it', () => {
    const prompt = buildInitPrompt({ existingContextFile: 'CLAUDE.md' })
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt.toLowerCase()).toContain('propose improvements')
    expect(prompt.toLowerCase()).toContain('do not overwrite')
  })

  it('mentions ingesting cursor rules only when they exist', () => {
    expect(buildInitPrompt({})).not.toContain('.cursorrules')
    const prompt = buildInitPrompt({ cursorRules: true })
    expect(prompt).toContain('.cursor/rules')
    expect(prompt).toContain('.cursorrules')
  })

  it('mentions ingesting copilot instructions only when they exist', () => {
    expect(buildInitPrompt({})).not.toContain('copilot-instructions')
    expect(buildInitPrompt({ copilotRules: true })).toContain('.github/copilot-instructions.md')
  })
})

describe('findExistingContextFile', () => {
  it('returns the first hit in pi candidate order, or undefined when none exist', () => {
    expect(CONTEXT_FILE_CANDIDATES[0]).toBe('AGENTS.override.md')
    const root = tempDir()
    expect(findExistingContextFile(root)).toBeUndefined()
    writeFileSync(join(root, 'CLAUDE.md'), 'x')
    expect(findExistingContextFile(root)).toBe('CLAUDE.md')
    writeFileSync(join(root, 'AGENTS.md'), 'x')
    expect(findExistingContextFile(root)).toBe('AGENTS.md')
    writeFileSync(join(root, 'AGENTS.override.md'), 'x')
    expect(findExistingContextFile(root)).toBe('AGENTS.override.md')
  })
})

const setup = () => {
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  const sent: string[] = []
  const sentOptions: unknown[] = []
  const pi = {
    on: () => {},
    registerCommand: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec),
    sendUserMessage: (text: string, options?: unknown) => {
      sent.push(text)
      sentOptions.push(options)
    },
  }
  initExtension(pi as never)
  return { commands, sent, sentOptions }
}
const ctxFor = (cwd: string, idle = true) => ({ cwd, hasUI: true, isIdle: () => idle, ui: { notify: () => {} } })

describe('init extension', () => {
  it('registers /init and sends one create prompt for a project with no context file', async () => {
    const cwd = tempDir()
    const s = setup()
    expect([...s.commands.keys()]).toEqual(['init'])
    await s.commands.get('init')?.handler('', ctxFor(cwd))
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('AGENTS.md')
    expect(s.sent[0].toLowerCase()).toContain('create')
    expect(s.sent[0].toLowerCase()).not.toContain('propose improvements')
    expect(s.sent[0]).not.toContain('.cursorrules')
    expect(s.sent[0]).not.toContain('copilot-instructions')
  })

  it('sends an improve prompt naming the existing AGENTS.md instead of overwriting', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'AGENTS.md'), '# existing')
    const s = setup()
    await s.commands.get('init')?.handler('', ctxFor(cwd))
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('AGENTS.md')
    expect(s.sent[0].toLowerCase()).toContain('propose improvements')
    expect(s.sent[0].toLowerCase()).toContain('do not overwrite')
  })

  it('detects the context file and rule files at the repository root from a subdirectory', async () => {
    const repo = tempDir()
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, 'CLAUDE.md'), '# existing')
    writeFileSync(join(repo, '.cursorrules'), 'rules')
    mkdirSync(join(repo, '.github'), { recursive: true })
    writeFileSync(join(repo, '.github', 'copilot-instructions.md'), 'rules')
    const sub = join(repo, 'src')
    mkdirSync(sub)
    const s = setup()
    await s.commands.get('init')?.handler('', ctxFor(sub))
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('CLAUDE.md')
    expect(s.sent[0].toLowerCase()).toContain('propose improvements')
    expect(s.sent[0]).toContain('.cursorrules')
    expect(s.sent[0]).toContain('.github/copilot-instructions.md')
  })

  it('sends bare while idle but queues as a followUp while the agent is streaming', async () => {
    const cwd = tempDir()
    const s = setup()
    await s.commands.get('init')?.handler('', ctxFor(cwd))
    await s.commands.get('init')?.handler('', ctxFor(cwd, false))
    expect(s.sentOptions).toEqual([{}, { deliverAs: 'followUp' }])
  })

  it('detects a .cursor/rules directory as cursor rules', async () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true })
    const s = setup()
    await s.commands.get('init')?.handler('', ctxFor(cwd))
    expect(s.sent[0]).toContain('.cursor/rules')
  })
})
