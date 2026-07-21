import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { formatToolName, interpolateEnv, loadConfigFrom, mapContent, normalizeSchema, projectConfigPaths, userConfigPaths } from '../extensions/mcp.ts'

describe('mcp adapter helpers', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title documents the ${VAR} syntax interpolateEnv parses
  it('interpolates ${VAR} from the environment', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${} syntax is exactly what interpolateEnv parses
    expect(interpolateEnv('Bearer ${TOKEN}', { TOKEN: 'abc' } as NodeJS.ProcessEnv)).toBe('Bearer abc')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${MISSING}', {} as NodeJS.ProcessEnv)).toBe('')
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the title documents the ${VAR:-default} syntax Claude's .mcp.json supports
  it('expands ${VAR:-default} to the fallback when unset or empty, like shell :-', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal syntax under test
    expect(interpolateEnv('${MISSING:-fallback}', {} as NodeJS.ProcessEnv)).toBe('fallback')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${SET:-fallback}', { SET: 'real' } as NodeJS.ProcessEnv)).toBe('real')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${MISSING:-}', {} as NodeJS.ProcessEnv)).toBe('')
    // Shell :- substitutes on unset OR empty, and this syntax borrows shell's.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${EMPTY:-fallback}', { EMPTY: '' } as NodeJS.ProcessEnv)).toBe('fallback')
    // A bare reference to a set-but-empty variable stays empty.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    expect(interpolateEnv('${EMPTY}', { EMPTY: '' } as NodeJS.ProcessEnv)).toBe('')
  })

  it('merges config files with later files winning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
    const global = join(dir, 'global.json')
    const project = join(dir, 'project.json')
    writeFileSync(global, JSON.stringify({ mcpServers: { a: { command: 'one' }, b: { command: 'two' } } }))
    writeFileSync(project, JSON.stringify({ mcpServers: { b: { command: 'override' } } }))
    const merged = loadConfigFrom([global, project])
    expect(Object.keys(merged).sort()).toEqual(['a', 'b'])
    expect((merged.b as { command: string }).command).toBe('override')
  })

  it('skips missing and invalid config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{not json')
    expect(loadConfigFrom([join(dir, 'absent.json'), broken])).toEqual({})
  })

  it('separates always-loaded user config from trust-gated project config', () => {
    expect(userConfigPaths('/home')).toEqual(['/home/.claude.json', '/home/.pi/agent/mcp.json'])
    expect(projectConfigPaths('/proj')).toEqual(['/proj/.mcp.json', '/proj/.pi/mcp.json'])
  })

  it('lets pi config override a Claude server of the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
    const claude = join(dir, '.mcp.json')
    const pi = join(dir, 'pi.json')
    writeFileSync(claude, JSON.stringify({ mcpServers: { db: { command: 'claude-db' } } }))
    writeFileSync(pi, JSON.stringify({ mcpServers: { db: { command: 'pi-db' } } }))
    expect((loadConfigFrom([claude, pi]).db as { command: string }).command).toBe('pi-db')
  })

  it('formats tool names as server_tool with dashes replaced', () => {
    expect(formatToolName('sonar-qube', 'search-issues')).toBe('sonar_qube_search_issues')
  })

  it('normalizes schemas by stripping $schema and additionalProperties', () => {
    const schema = normalizeSchema({ $schema: 'x', additionalProperties: false, type: 'object', properties: { a: { type: 'string' } } })
    expect(schema).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(normalizeSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })

  it('maps text, image, and resource content blocks', () => {
    const mapped = mapContent([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'base64data', mimeType: 'image/jpeg' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'body' } },
    ])
    expect(mapped[0]).toEqual({ type: 'text', text: 'hello' })
    expect(mapped[1]).toEqual({ type: 'image', data: 'base64data', mimeType: 'image/jpeg' })
    expect((mapped[2] as { text: string }).text).toContain('[Resource: file:///x]')
  })

  it('falls back to structuredContent for empty results and truncates huge text', () => {
    expect(mapContent([], { ok: true })).toEqual([{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])
    const big = mapContent([{ type: 'text', text: 'x'.repeat(60_000) }])
    expect((big[0] as { text: string }).text).toContain('[truncated')
  })
})
