import { describe, expect, it } from 'vitest'

import { matchesPathRules } from '../extensions/internal/path-rules.ts'

const anchors = { cwd: '/repo/app', projectRoot: '/repo', home: '/home/alex' }

describe('matchesPathRules', () => {
  it('matches a bare filename at any depth under cwd, per gitignore semantics', () => {
    expect(matchesPathRules('.env', ['.env'], anchors)).toBe(true)
    expect(matchesPathRules('deep/nested/.env', ['.env'], anchors)).toBe(true)
    expect(matchesPathRules('/repo/other/.env', ['.env'], anchors)).toBe(false)
    expect(matchesPathRules('config.ts', ['*.env'], anchors)).toBe(false)
  })

  it('anchors a single-segment directory pattern at cwd, as allow rules do', () => {
    expect(matchesPathRules('src/app.ts', ['src/**'], anchors)).toBe(true)
    expect(matchesPathRules('vendor/pkg/src/lib.js', ['src/**'], anchors)).toBe(false)
    expect(matchesPathRules('vendor/pkg/src/lib.js', ['**/src/**'], anchors)).toBe(true)
  })

  it('resolves the four anchor forms', () => {
    expect(matchesPathRules('/repo/src/a.ts', ['/src/**'], anchors)).toBe(true)
    expect(matchesPathRules('/repo/app/src/a.ts', ['/src/**'], anchors)).toBe(false)
    expect(matchesPathRules('/home/alex/notes.pdf', ['~/*.pdf'], anchors)).toBe(true)
    expect(matchesPathRules('/tmp/scratch.txt', ['//tmp/scratch.txt'], anchors)).toBe(true)
    expect(matchesPathRules('docs/a.md', ['./docs/**'], anchors)).toBe(true)
  })

  it('keeps * within one segment and lets ** cross directories', () => {
    expect(matchesPathRules('docs/api/readme.md', ['docs/*/readme.md'], anchors)).toBe(true)
    expect(matchesPathRules('docs/api/v2/readme.md', ['docs/*/readme.md'], anchors)).toBe(false)
    expect(matchesPathRules('docs/api/v2/readme.md', ['docs/**/readme.md'], anchors)).toBe(true)
  })

  it('resolves the checked path against cwd and fails closed on no match', () => {
    // A rule matches only under its anchor: ../ leaves cwd, so a cwd-anchored rule
    // cannot reach it; an absolute rule can.
    expect(matchesPathRules('../secrets.txt', ['**'], anchors)).toBe(false)
    expect(matchesPathRules('../secrets.txt', ['//repo/**'], anchors)).toBe(true)
    expect(matchesPathRules('a.ts', [], anchors)).toBe(false)
  })
})
