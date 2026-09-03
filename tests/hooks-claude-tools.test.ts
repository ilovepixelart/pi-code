import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { claudeToolInput, claudeToolName, claudeToolResponse, piToolInput, piToolOutput } from '../extensions/hooks/claude-tools.ts'
import { normalizeToolName } from '../extensions/internal/command-file.ts'

describe('claudeToolName', () => {
  it('maps the documented built-ins and leaves unknown tools untranslated', () => {
    expect(claudeToolName('bash')).toBe('Bash')
    expect(claudeToolName('edit')).toBe('Edit')
    expect(claudeToolName('write')).toBe('Write')
    expect(claudeToolName('read')).toBe('Read')
    expect(claudeToolName('grep')).toBe('Grep')
    expect(claudeToolName('find')).toBe('Glob')
    expect(claudeToolName('ls')).toBeUndefined()
  })
})

describe('claudeToolInput', () => {
  it('converts bash timeout from pi seconds to Claude milliseconds', () => {
    expect(claudeToolInput('bash', { command: 'ls', timeout: 30 }, '/proj')).toEqual({ command: 'ls', timeout: 30000 })
  })

  it('makes file paths absolute, expanding ~, as Claude documents', () => {
    expect(claudeToolInput('write', { path: 'src/a.ts', content: 'x' }, '/proj')).toEqual({ file_path: path.resolve('/proj', 'src/a.ts'), content: 'x' })
    expect(claudeToolInput('read', { path: '~/notes.md' }, '/proj')).toEqual({ file_path: path.join(os.homedir(), 'notes.md') })
  })

  it('maps a single pi edit to the documented Edit fields', () => {
    expect(claudeToolInput('edit', { path: '/p/a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, '/proj')).toEqual({ file_path: path.resolve('/p/a.ts'), old_string: 'x', new_string: 'y', replace_all: false })
  })

  it('carries a multi-entry edits array alongside the first documented fields', () => {
    const edits = [
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: 'd' },
    ]
    expect(claudeToolInput('edit', { path: '/p/a.ts', edits }, '/proj')).toEqual({ file_path: path.resolve('/p/a.ts'), old_string: 'a', new_string: 'b', replace_all: false, edits })
  })

  it('maps grep ignoreCase to the documented -i flag', () => {
    expect(claudeToolInput('grep', { pattern: 'todo', ignoreCase: true }, '/proj')).toEqual({ pattern: 'todo', '-i': true })
  })

  it('maps pi find input to the documented Glob fields, resolving the path', () => {
    expect(claudeToolInput('find', { pattern: '*.ts', path: 'src' }, '/proj')).toEqual({ pattern: '*.ts', path: path.resolve('/proj', 'src') })
    expect(claudeToolInput('find', { pattern: '*.ts' }, '/proj')).toEqual({ pattern: '*.ts' })
  })
})

describe('piToolInput', () => {
  it('converts a Claude rewrite back to the pi shape', () => {
    expect(piToolInput('bash', { command: 'ls', timeout: 30000 })).toEqual({ command: 'ls', timeout: 30 })
    expect(piToolInput('edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'z' })).toEqual({ path: '/p/a.ts', edits: [{ oldText: 'x', newText: 'z' }] })
    expect(piToolInput('write', { file_path: '/p/a.ts', content: 'c' })).toEqual({ path: '/p/a.ts', content: 'c' })
  })

  it('returns undefined for a rewrite missing the tool required fields, so the original survives', () => {
    expect(piToolInput('bash', { description: 'no command' })).toBeUndefined()
    expect(piToolInput('edit', { file_path: '/p/a.ts' })).toBeUndefined()
    expect(piToolInput('write', { file_path: '/p/a.ts' })).toBeUndefined()
  })

  it('converts read, grep and glob rewrites, which had no executions at all', () => {
    expect(piToolInput('read', { file_path: '/p/a.ts', offset: 5, limit: 10 })).toEqual({ path: '/p/a.ts', offset: 5, limit: 10 })
    expect(piToolInput('read', { offset: 5 })).toBeUndefined()
    expect(piToolInput('grep', { pattern: 'todo', path: '/p', '-i': true })).toEqual({ pattern: 'todo', path: '/p', ignoreCase: true })
    expect(piToolInput('grep', { path: '/p' })).toBeUndefined()
    expect(piToolInput('find', { pattern: '*.ts', path: '/p' })).toEqual({ pattern: '*.ts', path: '/p' })
    expect(piToolInput('find', { path: '/p' })).toBeUndefined()
  })
})

describe('claudeToolResponse', () => {
  it('reports the documented Bash and Write shapes and leaves other tools untranslated', () => {
    expect(claudeToolResponse('bash', { command: 'ls' }, 'out', false, '/proj')).toEqual({ stdout: 'out', stderr: '', interrupted: false, isImage: false })
    expect(claudeToolResponse('write', { path: 'a.ts', content: 'x' }, '', false, '/proj')).toEqual({ filePath: path.resolve('/proj', 'a.ts'), success: true })
    expect(claudeToolResponse('read', { path: 'a.ts' }, 'text', false, '/proj')).toBeUndefined()
  })
})

describe('piToolOutput', () => {
  it('accepts a schema-valid Bash replacement and rejects a mismatched one', () => {
    // Claude: "a value that doesn't match the tool's output schema is ignored".
    expect(piToolOutput('bash', { stdout: 'clean', stderr: '', interrupted: false, isImage: false }, false)).toBe('clean')
    expect(piToolOutput('bash', { stdout: 'clean', stderr: 'warn' }, false)).toBe('clean\nwarn')
    expect(piToolOutput('bash', 'just a string', false)).toBeUndefined()
  })

  it('passes MCP replacements through unvalidated', () => {
    expect(piToolOutput('srv_tool', 'text', true)).toBe('text')
    expect(piToolOutput('srv_tool', { any: 'shape' }, true)).toBe('{"any":"shape"}')
  })

  it('accepts a plain string for other built-ins whose pi output is text', () => {
    expect(piToolOutput('read', 'replaced', false)).toBe('replaced')
    expect(piToolOutput('read', { structured: true }, false)).toBeUndefined()
  })
})

describe('claudeToolName covers every pi tool with a Claude counterpart', () => {
  // Canonical spellings from the tools reference table. A matcher written in Claude's
  // vocabulary never fired for these, because the payload carried only the pi name.
  it.each([
    ['web_fetch', 'WebFetch'],
    ['web_search', 'WebSearch'],
    ['subagent', 'Agent'],
    ['question', 'AskUserQuestion'],
    ['plan_mode_complete', 'ExitPlanMode'],
    ['slash_command', 'Skill'],
    ['todo', 'TodoWrite'],
  ])('translates %s to %s', (piName, claudeName) => {
    expect(claudeToolName(piName)).toBe(claudeName)
  })

  it('leaves a pi tool with no Claude counterpart untranslated', () => {
    // The tools reference has no Ls tool, so there is no name to report.
    expect(claudeToolName('ls')).toBeUndefined()
    expect(claudeToolName('memory')).toBeUndefined()
  })
})

describe('todo tool aliases', () => {
  it.each(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])('resolves %s to pi todo', (name) => {
    // Claude now prefers TaskCreate/TaskGet/TaskList/TaskUpdate over TodoWrite/TodoRead.
    // pi has one todo tool serving all of them, so every spelling has to reach it or an
    // allowed-tools entry naming the current tools silently grants nothing.
    expect(normalizeToolName(name)).toBe('todo')
  })
})
