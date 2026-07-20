import { describe, expect, it } from 'vitest'

import { memoryDir, projectSlug, removeIndexLine, slugifyName, upsertIndexLine } from '../extensions/memory.ts'

describe('memory helpers', () => {
  it('slugs project paths into directory names', () => {
    expect(projectSlug('/Users/alex/Documents/pi-code')).toBe('-Users-alex-Documents-pi-code')
    expect(memoryDir('/tmp/x')).toContain('.pi/agent/memory/-tmp-x')
  })

  it('slugifies memory names', () => {
    expect(slugifyName('User prefers TABS!')).toBe('user-prefers-tabs')
    expect(slugifyName('///')).toBe('memory')
  })

  it('upserts index lines and creates a header', () => {
    const first = upsertIndexLine('', 'no-dashes', 'never use em dashes')
    expect(first).toContain('# Memory index')
    expect(first).toContain('- [no-dashes](no-dashes.md): never use em dashes')

    const replaced = upsertIndexLine(first, 'no-dashes', 'updated description')
    expect(replaced).toContain('updated description')
    expect(replaced.match(/no-dashes\.md/g)).toHaveLength(1)
  })

  it('removes index lines and empties the index when last one goes', () => {
    const index = upsertIndexLine(upsertIndexLine('', 'a', 'first'), 'b', 'second')
    const removed = removeIndexLine(index, 'a')
    expect(removed).not.toContain('](a.md)')
    expect(removed).toContain('](b.md)')
    const emptied = removeIndexLine(removeIndexLine(index, 'a'), 'b')
    expect(emptied).toBe('# Memory index\n')
  })
})
