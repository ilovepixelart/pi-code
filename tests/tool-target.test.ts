import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { fileToolTarget } from '../extensions/internal/tool-target.ts'

describe('fileToolTarget', () => {
  const target = (input: Record<string, unknown>, toolName = 'read') => fileToolTarget({ toolName, input })

  it('reads path and its file_path alias, for file tools only', () => {
    expect(target({ path: 'src/a.ts' })).toBe('src/a.ts')
    expect(target({ file_path: 'src/a.ts' }, 'edit')).toBe('src/a.ts')
    expect(target({ path: 'src/a.ts' }, 'bash')).toBeUndefined()
    expect(fileToolTarget({ toolName: 'read', input: { path: 'src/a.ts' }, isError: true })).toBeUndefined()
  })

  it('names the file pi will open: @ stripped, ~ expanded, file:// decoded, unicode spaces folded', () => {
    // pi resolves a tool path through resolveToCwd (dist/core/tools/path-utils), which the
    // package does not export. A reader that skips it judges a different file than pi opens.
    expect(target({ path: '@src/a.ts' })).toBe('src/a.ts')
    expect(target({ path: '~/work/a.ts' })).toBe(path.join(os.homedir(), 'work/a.ts'))
    expect(target({ path: '~' })).toBe(os.homedir())
    // Built from a real absolute path: a file URL without a drive letter is not valid on Windows.
    const spaced = path.join(os.tmpdir(), 'a b.ts')
    expect(target({ path: pathToFileURL(spaced).href })).toBe(spaced)
    expect(target({ path: 'my\u00A0file.ts' })).toBe('my file.ts')
    expect(target({ path: '~user/a.ts' })).toBe('~user/a.ts')
  })
})
