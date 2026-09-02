import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { matchingCommands, resetMatcherCache } from '../extensions/hooks/index.ts'
import { substituteArgs } from '../extensions/internal/command-file.ts'
import { globToRegExpSource, matchesPathRules } from '../extensions/internal/path-rules.ts'
import { interpolateEnv } from '../extensions/mcp/config.ts'

// Property-based pins for the parser-shaped modules: each property is a stated
// invariant from the module's contract, explored across generated inputs and
// shrunk to a minimal counterexample on failure. Seeds are fast-check's own
// (reported on failure for replay), runs are bounded for suite speed.
const RUNS = { numRuns: 200 }

describe('substituteArgs properties', () => {
  // A single whitespace/quote-free token: $0 must return it byte-for-byte. The
  // replacer-function form guarantees $&-style metacharacters in the ARGUMENT
  // are never interpreted as replacement patterns (a real past defect class).
  const token = fc.stringMatching(/^[!#-&(-~]{1,20}$/).filter((s) => !s.includes("'") && !s.includes('"'))

  it('returns an argument byte-for-byte through $0, metacharacters included', () => {
    void fc.assert(
      fc.property(token, (arg) => {
        expect(substituteArgs('$0', arg)).toBe(arg)
      }),
      RUNS,
    )
  })

  it('never re-expands placeholder text arriving inside an argument (one pass)', () => {
    void fc.assert(
      fc.property(token, (arg) => {
        const carrying = `${arg}$ARGUMENTS`
        expect(substituteArgs('$ARGUMENTS', carrying)).toBe(carrying)
      }),
      RUNS,
    )
  })
})

describe('path-rules properties', () => {
  const anchors = { cwd: '/proj/sub', projectRoot: '/proj', home: '/home/u' }
  const seg = fc.stringMatching(/^[a-z0-9]{1,6}$/)

  it('brace expansion is equivalent to the union of its alternatives', () => {
    void fc.assert(
      fc.property(seg, seg, seg, seg, (x, y, pre, post) => {
        const target = `${pre}${x}${post}.md`
        const braced = matchesPathRules(target, [`${pre}{${x},${y}}${post}.md`], anchors)
        const union = matchesPathRules(target, [`${pre}${x}${post}.md`], anchors) || matchesPathRules(target, [`${pre}${y}${post}.md`], anchors)
        expect(braced).toBe(union)
      }),
      RUNS,
    )
  })

  it('compiles any printable pattern without throwing, to a constructible regex', () => {
    void fc.assert(
      fc.property(fc.stringMatching(/^[ -~]{0,30}$/), (pattern) => {
        const source = globToRegExpSource(pattern)
        expect(() => new RegExp(source)).not.toThrow()
      }),
      RUNS,
    )
  })
})

describe('interpolateEnv properties', () => {
  // Any printable value, including ones that look like ${OTHER} or carry $&:
  // the function-form replace must never rescan or reinterpret them.
  const value = fc.stringMatching(/^[ -~]{0,25}$/)

  it('returns the environment value verbatim, whatever it contains', () => {
    void fc.assert(
      fc.property(value, (v) => {
        expect(interpolateEnv('${X}', { X: v })).toBe(v)
      }),
      RUNS,
    )
  })

  it('honors the shell :- contract: unset OR empty falls back to the default', () => {
    void fc.assert(
      fc.property(fc.stringMatching(/^[ -|~]{0,20}$/), (fallback) => {
        expect(interpolateEnv(`\${X:-${fallback}}`, {})).toBe(fallback)
        expect(interpolateEnv(`\${X:-${fallback}}`, { X: '' })).toBe(fallback)
      }),
      RUNS,
    )
  })
})

describe('hook matcher properties', () => {
  const name = fc.stringMatching(/^[A-Za-z][\w-]{0,10}$/)
  const fold = (value: string): string => value.toLowerCase().replaceAll('-', '_')

  it('an exact list matches exactly its members, case- and dash-folded, cache or not', () => {
    void fc.assert(
      fc.property(fc.array(name, { minLength: 1, maxLength: 5 }), name, fc.constantFrom(', ', '|'), (members, candidate, sep) => {
        const matcher = members.join(sep)
        const config = [{ matcher, hooks: [{ command: 'x' }] }]
        const naive = members.some((member) => fold(member) === fold(candidate))
        expect(matchingCommands(config, candidate).length > 0).toBe(naive)
        // The discriminating fold case, derived rather than hoped for from the
        // generator: every member must match its own case-flipped, dash-to-
        // underscore variant (random draws almost never produce near-miss pairs,
        // which let a fold mutant survive the differential alone).
        const variant = members[0]
          .replaceAll('-', '_')
          .split('')
          .map((ch, i) => (i % 2 ? ch.toUpperCase() : ch.toLowerCase()))
          .join('')
        expect(matchingCommands(config, variant).length > 0).toBe(true)
        // Cache transparency: a cold cache answers identically.
        resetMatcherCache()
        expect(matchingCommands(config, candidate).length > 0).toBe(naive)
      }),
      RUNS,
    )
  })
})
