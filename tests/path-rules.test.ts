import { describe, expect, it } from 'vitest'

import { compileGlobs, globCompileStats, globToRegExpSource, matchesCompiledGlobs, matchesPathRules } from '../extensions/internal/path-rules.ts'

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

describe('brace expansion', () => {
  it('expands {ts,tsx} so one rule covers both extensions', () => {
    const rules = ['src/**/*.{ts,tsx}']
    expect(matchesPathRules('src/a.ts', rules, anchors)).toBe(true)
    expect(matchesPathRules('src/b.tsx', rules, anchors)).toBe(true)
    expect(matchesPathRules('src/nested/deep/b.tsx', rules, anchors)).toBe(true)
    expect(matchesPathRules('src/c.js', rules, anchors)).toBe(false)
  })

  it('takes the Cartesian product across groups and expands nested groups', () => {
    const cartesian = ['{a,b}/{c,d}.ts']
    expect(matchesPathRules('a/c.ts', cartesian, anchors)).toBe(true)
    expect(matchesPathRules('a/d.ts', cartesian, anchors)).toBe(true)
    expect(matchesPathRules('b/c.ts', cartesian, anchors)).toBe(true)
    expect(matchesPathRules('b/d.ts', cartesian, anchors)).toBe(true)
    expect(matchesPathRules('a/e.ts', cartesian, anchors)).toBe(false)
    const nested = ['src/{a,{b,c}}.ts']
    expect(matchesPathRules('src/a.ts', nested, anchors)).toBe(true)
    expect(matchesPathRules('src/b.ts', nested, anchors)).toBe(true)
    expect(matchesPathRules('src/c.ts', nested, anchors)).toBe(true)
    expect(matchesPathRules('src/d.ts', nested, anchors)).toBe(false)
  })

  it('allows an empty alternative', () => {
    const rules = ['file.{ts,}']
    expect(matchesPathRules('file.ts', rules, anchors)).toBe(true)
    expect(matchesPathRules('file.', rules, anchors)).toBe(true)
    expect(matchesPathRules('file.tsx', rules, anchors)).toBe(false)
  })

  it('keeps a comma-less group, an unmatched brace, and a bare comma literal', () => {
    expect(matchesPathRules('a{b}c.ts', ['a{b}c.ts'], anchors)).toBe(true)
    expect(matchesPathRules('abc.ts', ['a{b}c.ts'], anchors)).toBe(false)
    expect(matchesPathRules('weird{name.ts', ['weird{name.ts'], anchors)).toBe(true)
    expect(matchesPathRules('a,b.ts', ['a,b.ts'], anchors)).toBe(true)
  })

  it('falls back to the unexpanded pattern past the expansion budget', () => {
    const group = '{a,b,c,d,e,f,g,h,i,j}'
    const over = `${group.repeat(4)}.ts` // 10^4 alternatives, over the 1000 budget
    const overRegExp = new RegExp(`^${globToRegExpSource(over)}$`)
    expect(overRegExp.test(`${group.repeat(4)}.ts`)).toBe(true)
    expect(overRegExp.test('abcd.ts')).toBe(false)
    const atLimit = `${group.repeat(3)}.ts` // exactly 1000, still expands
    expect(new RegExp(`^${globToRegExpSource(atLimit)}$`).test('adg.ts')).toBe(true)
  })
})

describe('compileGlobs', () => {
  it('compiles each glob once; matching compiled globs performs no further compilation', () => {
    const before = globCompileStats().compiled
    const compiled = compileGlobs(['db/**', '*.sql', 'docs/'])
    expect(globCompileStats().compiled - before).toBe(3)
    expect(matchesCompiledGlobs('db/schema.sql', compiled)).toBe(true)
    expect(matchesCompiledGlobs('lib/deep/x.sql', compiled)).toBe(true)
    expect(matchesCompiledGlobs('docs/api/v1.md', compiled)).toBe(true)
    expect(matchesCompiledGlobs('src/app.ts', compiled)).toBe(false)
    expect(globCompileStats().compiled - before).toBe(3)
  })

  it('matches like pathMatchesGlobs: anchors stripped, blank globs dropped, no globs match nothing', () => {
    expect(matchesCompiledGlobs('src/app.ts', compileGlobs(['./src/**']))).toBe(true)
    expect(matchesCompiledGlobs('src/app.ts', compileGlobs(['/src/**']))).toBe(true)
    expect(compileGlobs(['', '   '])).toEqual([])
    expect(matchesCompiledGlobs('anything', [])).toBe(false)
  })
})

const { pathMatchesGlobs } = await import('../extensions/claude-rules.ts')

describe('bracket expressions', () => {
  // Claude: "Glob syntax treats [ as the start of a bracket expression such as
  // [abc]. A pattern with a [ that can't be read as a bracket expression ... is
  // invalid: it matches nothing ... To match a literal [ ... escape it."
  it('matches a character class against real files, not the literal bracket text', () => {
    expect(pathMatchesGlobs('src/a.ts', ['src/*.[jt]s'])).toBe(true)
    expect(pathMatchesGlobs('src/a.js', ['src/*.[jt]s'])).toBe(true)
    expect(pathMatchesGlobs('src/a.cs', ['src/*.[jt]s'])).toBe(false)
    expect(pathMatchesGlobs('src/a.[jt]s', ['src/*.[jt]s'])).toBe(false)
  })

  it('supports ranges and negation', () => {
    expect(pathMatchesGlobs('v1.txt', ['v[0-9].txt'])).toBe(true)
    expect(pathMatchesGlobs('vX.txt', ['v[0-9].txt'])).toBe(false)
    expect(pathMatchesGlobs('vX.txt', ['v[!0-9].txt'])).toBe(true)
  })

  it('treats an unclosable bracket as an invalid pattern that matches nothing', () => {
    expect(pathMatchesGlobs('photos [2024/x.png', ['photos [2024/**'])).toBe(false)
    expect(pathMatchesGlobs('anything', ['photos [2024/**'])).toBe(false)
  })

  it('matches a literal bracket through the documented escape', () => {
    expect(pathMatchesGlobs('photos [2024/x.png', ['photos \\[2024/**'])).toBe(true)
  })
})
