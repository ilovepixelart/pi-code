import { describe, expect, it } from 'vitest'

import { hasSubstitution, splitSegments } from '../extensions/internal/shell-split.ts'

describe('splitSegments', () => {
  it('splits on each documented separator', () => {
    expect(splitSegments('a && b')).toEqual(['a', 'b'])
    expect(splitSegments('a || b')).toEqual(['a', 'b'])
    expect(splitSegments('a; b')).toEqual(['a', 'b'])
    expect(splitSegments('a | b')).toEqual(['a', 'b'])
    expect(splitSegments('a |& b')).toEqual(['a', 'b'])
    expect(splitSegments('a & b')).toEqual(['a', 'b'])
    expect(splitSegments('a\nb')).toEqual(['a', 'b'])
  })

  it("keeps a redirection's ampersand inside its segment", () => {
    // 2>&1 and &>file are redirections, not a background separator: cut at the &, the
    // command lost its redirect and a bare "1" became a second command.
    expect(splitSegments('ls x 2>&1')).toEqual(['ls x 2>&1'])
    expect(splitSegments('ls x >&2')).toEqual(['ls x >&2'])
    expect(splitSegments('ls x &>/dev/null')).toEqual(['ls x &>/dev/null'])
    expect(splitSegments('ls x 2>&1 | head')).toEqual(['ls x 2>&1', 'head'])
    expect(splitSegments('ls & pwd')).toEqual(['ls', 'pwd'])
  })

  it('keeps an escaped separator inside its segment', () => {
    // find's \; is an argument, not a command boundary.
    expect(splitSegments(String.raw`find . -exec rm {} \;`)).toEqual([String.raw`find . -exec rm {} \;`])
  })

  it('keeps quoted separators inside their segment', () => {
    expect(splitSegments("grep 'a|b' f")).toEqual(["grep 'a|b' f"])
    expect(splitSegments('echo "x && y"')).toEqual(['echo "x && y"'])
  })

  it('returns nothing on an unbalanced quote, failing the caller closed', () => {
    expect(splitSegments("echo 'oops")).toEqual([])
  })

  it('drops empty segments left by doubled or trailing separators', () => {
    expect(splitSegments('a &&  && b; ')).toEqual(['a', 'b'])
  })
})

describe('hasSubstitution', () => {
  it('flags every construct that can hide a command', () => {
    expect(hasSubstitution('echo $(id)')).toBe(true)
    expect(hasSubstitution('echo `id`')).toBe(true)
    expect(hasSubstitution('diff <(id) x')).toBe(true)
    expect(hasSubstitution('tee >(id)')).toBe(true)
  })

  it('passes ordinary commands, including plain variables', () => {
    expect(hasSubstitution('echo $HOME')).toBe(false)
    expect(hasSubstitution('git status')).toBe(false)
  })
})

// Worked from bash's quoting rules: inside "..." a backslash escapes the next character,
// '...' has no escapes at all, and $'...' (ANSI-C quoting) escapes everything.
describe('splitSegments follows bash escapes inside quotes', () => {
  it('keeps an escaped double quote inside the string, so a separator after the string still splits', () => {
    expect(splitSegments('echo "\\"" ; touch X ; echo \\"')).toEqual(['echo "\\""', 'touch X', 'echo \\"'])
  })

  it('keeps an escaped single quote inside an ANSI-C string', () => {
    expect(splitSegments("echo $'\\'' ; touch X ; echo \\'")).toEqual(["echo $'\\''", 'touch X', "echo \\'"])
  })

  it('ends an ANSI-C string after an escaped backslash', () => {
    expect(splitSegments("echo $'a\\\\' ; touch X")).toEqual(["echo $'a\\\\'", 'touch X'])
  })

  it('treats a backslash inside single quotes as literal, so the next quote closes the string', () => {
    expect(splitSegments("echo 'a\\' ; touch X")).toEqual(["echo 'a\\'", 'touch X'])
  })

  it('keeps a separator after a non-special escape inside double quotes', () => {
    expect(splitSegments('grep "a\\|b;c" f')).toEqual(['grep "a\\|b;c" f'])
  })

  it('reads an escaped dollar before a quote as a plain single-quoted string', () => {
    expect(splitSegments("echo \\$'a ; b'")).toEqual(["echo \\$'a ; b'"])
  })
})
