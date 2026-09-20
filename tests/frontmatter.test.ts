import { describe, expect, it } from 'vitest'

import { parseClaudeFrontmatter } from '../extensions/internal/frontmatter.ts'

describe('parseClaudeFrontmatter', () => {
  it('reads the free-text fields Claude writes as plain scalars that strict YAML rejects', () => {
    // Claude Code's /agents generator and Anthropic's own plugins write descriptions like
    // this one, and the command reference documents `argument-hint: [a] [b]`. pi's parser
    // is strict YAML, which throws on ": " inside a plain scalar and on a second flow
    // sequence, and a throw dropped the whole agent or command.
    const content = ['---', 'name: reviewer', 'description: Use this agent when reviewing. Examples: <example>Context: The user asks\\nfor a review</example>', 'argument-hint: [pr-number] [priority]', '---', 'Body: with a colon'].join('\n')
    const { frontmatter, body } = parseClaudeFrontmatter<Record<string, unknown>>(content)
    expect(frontmatter.description).toBe('Use this agent when reviewing. Examples: <example>Context: The user asks\\nfor a review</example>')
    expect(frontmatter['argument-hint']).toBe('[pr-number] [priority]')
    expect(frontmatter.name).toBe('reviewer')
    expect(body.trim()).toBe('Body: with a colon')
  })

  it('leaves a file strict YAML already reads exactly as it was read', () => {
    const content = ['---', 'description: "quoted: fine"', 'argument-hint: [pr]', 'tools:', '  - Read', '---', 'Body'].join('\n')
    expect(parseClaudeFrontmatter<Record<string, unknown>>(content).frontmatter).toEqual({ description: 'quoted: fine', 'argument-hint': ['pr'], tools: ['Read'] })
  })

  it('never rewrites a restriction field: a value it misread would be a restriction not applied', () => {
    expect(() => parseClaudeFrontmatter(['---', 'description: fine', 'allowed-tools: [Read] [Write]', '---', 'Body'].join('\n'))).toThrow()
    expect(() => parseClaudeFrontmatter(['---', 'name: [unclosed', '---', 'Body'].join('\n'))).toThrow()
  })

  it('keeps block scalars and quoted values untouched when another field needs the retry', () => {
    const content = ['---', 'description: |', '  first: line', '  second line', "when_to_use: 'single: quoted'", 'argument-hint: [a] [b]', '---', 'Body'].join('\n')
    const { frontmatter } = parseClaudeFrontmatter<Record<string, unknown>>(content)
    expect(frontmatter.description).toBe('first: line\nsecond line\n')
    expect(frontmatter.when_to_use).toBe('single: quoted')
    expect(frontmatter['argument-hint']).toBe('[a] [b]')
  })
})
