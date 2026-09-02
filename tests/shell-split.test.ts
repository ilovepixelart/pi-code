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
