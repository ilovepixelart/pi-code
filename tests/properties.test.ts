import { spawnSync } from 'node:child_process'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { matchingCommands, resetMatcherCache } from '../extensions/hooks/index.ts'
import { substituteArgs } from '../extensions/internal/command-file.ts'
import { globToRegExpSource, matchesPathRules } from '../extensions/internal/path-rules.ts'
import { shellWords } from '../extensions/internal/shell-split.ts'
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

// bash itself is the oracle: eval "set -- <input>" performs exactly the word splitting and
// quote removal shellWords models. The alphabet holds only what bash splits on or unquotes
// (no $, backtick, glob, tilde, separator or newline), so eval expands and runs nothing.
// Skipped on Windows, where the bash on PATH may be WSL's rather than Git's.
describe.skipIf(process.platform === 'win32')('shellWords properties', () => {
  // Character soup explores unbalanced quoting; balanced pieces reach the escape rules
  // inside quotes, which soup almost never closes around.
  const soup = fc.array(fc.constantFrom('a', 'b', '-', "'", '"', '\\', ' ', '\t'), { minLength: 1, maxLength: 14 }).map((chars) => chars.join(''))
  const join = (parts: string[]): string => parts.join('')
  const escaped = fc.constantFrom('a', '-', "'", '"', '\\', ' ').map((ch) => `\\${ch}`)
  const singleQuoted = fc.array(fc.constantFrom('a', '-', '"', '\\', ' '), { maxLength: 4 }).map((chars) => `'${join(chars)}'`)
  const doubleQuoted = fc.array(fc.oneof(fc.constantFrom('a', '-', "'", ' '), escaped), { maxLength: 4 }).map((chars) => `"${join(chars)}"`)
  const pieces = fc.array(fc.oneof(fc.constantFrom('a', '-', ' ', '\t'), escaped, singleQuoted, doubleQuoted), { minLength: 1, maxLength: 6 }).map(join)
  const input = fc.oneof(soup, pieces)
  const bashWords = (command: string): string[] | undefined => {
    const run = spawnSync('bash', ['-c', 'eval "set -- $1" 2>/dev/null || exit 3; printf "%s\\0" "$#" "$@"', 'probe', command], { encoding: 'utf8' })
    // The count goes first: printf with no arguments still prints one empty field.
    return run.status === 0 ? run.stdout.slice(0, -1).split('\0').slice(1) : undefined
  }

  it('splits and unquotes exactly as bash does, wherever bash accepts the quoting', () => {
    void fc.assert(
      fc.property(input, (command) => {
        const expected = bashWords(command)
        fc.pre(expected !== undefined)
        expect(shellWords(command)).toEqual(expected)
      }),
      RUNS,
    )
  })
})
