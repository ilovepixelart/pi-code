import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveGitBash, resolveShell, toPowershellPlaceholders } from '../extensions/internal/shell-resolve.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-resolve-'))
  dirs.push(dir)
  return dir
}

/** A Git for Windows layout: `<root>/cmd/git.exe` is what PATH carries, `<root>/bin/bash.exe` is Git Bash. Returns the PATH entry. */
const gitInstall = (root: string): string => {
  mkdirSync(join(root, 'cmd'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'cmd', 'git.exe'), 'MZ')
  writeFileSync(join(root, 'bin', 'bash.exe'), 'MZ')
  return join(root, 'cmd')
}

const powershellAt = (dir: string, name: string): string => {
  const file = join(dir, name)
  writeFileSync(file, 'MZ', { mode: 0o755 })
  return file
}

// Oracle: Claude's documented lookup (troubleshoot-install.md, env-vars.md): the override
// only when it exists and is named bash.exe/sh.exe/bash/sh, then the default install
// dirs, then bin\bash.exe beside the git on PATH, skipping a git in the launch dir or
// below it under node_modules or a virtual environment.
describe('resolveGitBash', () => {
  it('honors CLAUDE_CODE_GIT_BASH_PATH when it names an existing bash.exe', () => {
    const bash = join(tempDir(), 'bash.exe')
    writeFileSync(bash, 'MZ')
    expect(resolveGitBash({ CLAUDE_CODE_GIT_BASH_PATH: bash, PATH: '' }, tempDir(), [])).toBe(bash)
  })

  it('ignores an override that is missing or not named bash.exe, sh.exe, bash, or sh', () => {
    const dir = tempDir()
    const gitBashLauncher = join(dir, 'git-bash.exe')
    writeFileSync(gitBashLauncher, 'MZ')
    expect(resolveGitBash({ CLAUDE_CODE_GIT_BASH_PATH: gitBashLauncher, PATH: '' }, tempDir(), [])).toBeUndefined()
    expect(resolveGitBash({ CLAUDE_CODE_GIT_BASH_PATH: join(dir, 'bash.exe'), PATH: '' }, tempDir(), [])).toBeUndefined()
  })

  it('finds bin\\bash.exe beside the git on PATH', () => {
    const root = tempDir()
    const onPath = gitInstall(root)
    expect(resolveGitBash({ PATH: onPath }, tempDir(), [])).toBe(join(root, 'bin', 'bash.exe'))
  })

  it('skips a git below the launch directory under node_modules or a virtual environment', () => {
    const cwd = tempDir()
    const local = gitInstall(join(cwd, 'node_modules', 'git'))
    const venv = gitInstall(join(cwd, '.venv', 'git'))
    const real = tempDir()
    const realOnPath = gitInstall(real)
    expect(resolveGitBash({ PATH: [local, venv, realOnPath].join(delimiter) }, cwd, [])).toBe(join(real, 'bin', 'bash.exe'))
    expect(resolveGitBash({ PATH: [local, venv].join(delimiter) }, cwd, [])).toBeUndefined()
  })

  it('skips a git sitting in the launch directory itself', () => {
    const root = tempDir()
    const cwd = gitInstall(root)
    expect(resolveGitBash({ PATH: cwd }, cwd, [])).toBeUndefined()
  })

  // The Windows half of the default-install rule, whose POSIX half is the injected-roots
  // test above: this asserts the real lookup on a host that actually has Git for Windows,
  // which the runners do.
  it.skipIf(process.platform !== 'win32')('finds Git for Windows in its default install directory on this host', () => {
    expect(resolveGitBash({ PATH: '' }, tempDir())).toMatch(/\\Git\\bin\\bash\.exe$/)
  })

  it('returns undefined when no git is on PATH', () => {
    expect(resolveGitBash({ PATH: tempDir() }, tempDir(), [])).toBeUndefined()
  })
})

// Oracle: hooks.md ("sh -c on macOS and Linux, Git Bash on Windows, or PowerShell when
// Git Bash isn't installed"; `shell: "powershell"` runs via PowerShell; the ${CLAUDE_*}
// placeholders are rewritten to ${env:NAME} for PowerShell, the bare $NAME is not).
describe('resolveShell', () => {
  it('runs through /bin/sh -c off Windows', () => {
    const shell = resolveShell(undefined, 'darwin', { PATH: '' })
    expect(shell?.file).toBe('/bin/sh')
    expect(shell?.argsFor('echo hi')).toEqual(['-c', 'echo hi'])
  })

  it('prefers Git Bash on Windows', () => {
    const root = tempDir()
    const shell = resolveShell(undefined, 'win32', { PATH: gitInstall(root) }, tempDir(), [])
    expect(shell?.kind).toBe('bash')
    expect(shell?.file).toBe(join(root, 'bin', 'bash.exe'))
    expect(shell?.argsFor('echo hi')).toEqual(['-c', 'echo hi'])
  })

  it('falls back to PowerShell on Windows without Git Bash and rewrites the documented placeholders', () => {
    const dir = tempDir()
    const powershell = powershellAt(dir, 'powershell.exe')
    const shell = resolveShell(undefined, 'win32', { PATH: dir }, tempDir(), [])
    expect(shell?.kind).toBe('powershell')
    expect(shell?.file).toBe(powershell)
    expect(shell?.argsFor('echo ${CLAUDE_PROJECT_DIR} $CLAUDE_PROJECT_DIR')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'echo ${env:CLAUDE_PROJECT_DIR} $CLAUDE_PROJECT_DIR\nexit $LASTEXITCODE'])
  })

  it('runs shell: powershell through pwsh wherever one is installed', () => {
    const dir = tempDir()
    const pwsh = powershellAt(dir, 'pwsh')
    expect(resolveShell('powershell', 'darwin', { PATH: dir })?.file).toBe(pwsh)
  })

  it('keeps shell: powershell on /bin/sh off Windows when no PowerShell is installed', () => {
    expect(resolveShell('powershell', 'darwin', { PATH: tempDir() })?.file).toBe('/bin/sh')
  })

  it('resolves nothing on Windows with neither Git Bash nor PowerShell', () => {
    expect(resolveShell(undefined, 'win32', { PATH: tempDir() }, tempDir(), [])).toBeUndefined()
  })
})

describe('toPowershellPlaceholders', () => {
  it('rewrites the three documented placeholders and nothing else', () => {
    expect(toPowershellPlaceholders('${CLAUDE_PROJECT_DIR} ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA} ${OTHER} $CLAUDE_PROJECT_DIR')).toBe('${env:CLAUDE_PROJECT_DIR} ${env:CLAUDE_PLUGIN_ROOT} ${env:CLAUDE_PLUGIN_DATA} ${OTHER} $CLAUDE_PROJECT_DIR')
  })
})
