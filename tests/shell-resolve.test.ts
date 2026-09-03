import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveGitBash, resolvePowershellBinary, resolveShell, toPowershellPlaceholders } from '../extensions/internal/shell-resolve.ts'

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

/**
 * Oracle: the rule Go made its default in 1.19, and the one resolveGitBash already
 * applied. `os/exec` refuses a program resolved through a path entry "relative to the
 * current directory" (ErrDot); Windows exposes NoDefaultCurrentDirectoryInExePath for
 * the same purpose. Node honors neither (nodejs/node#46264), so pi-code enforces it in
 * the one place it resolves its own shells.
 *
 * Written a row per resolver rather than a suite per function, because the defect this
 * pins was not a missing check but two resolvers DISAGREEING about it: Git Bash had the
 * guard, PowerShell did not. A new resolver without a row here is a visible omission.
 * (Visible, not mechanical: making it mechanical would need the module to export a
 * registry of its resolvers, which is more machinery than two functions justify.)
 */
/** Both resolvers take the same shape of PATH entry, `<root>/cmd`: that is where Git for
 * Windows puts git.exe, and it is an ordinary directory for a PowerShell. Each plant
 * writes the binary ITS resolver looks for, so one table drives both. */
const entryIn = (root: string): string => join(root, 'cmd')

const plantGit = (entry: string): void => {
  const root = dirname(entry)
  mkdirSync(entry, { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(entry, 'git.exe'), 'MZ')
  writeFileSync(join(root, 'bin', 'bash.exe'), 'MZ')
}

const plantPowershell = (entry: string): void => {
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'pwsh.exe'), 'MZ', { mode: 0o755 })
}

const RESOLVERS: Array<[name: string, plant: (entry: string) => void, resolve: (env: Record<string, string | undefined>, cwd: string) => string | undefined]> = [
  ['resolveGitBash', plantGit, (env, cwd) => resolveGitBash(env, cwd, [])],
  // win32 so the `.exe` spellings the guard must also cover are the ones exercised; the
  // files are real temp files, so this still runs on any host.
  ['resolvePowershellBinary', plantPowershell, (env, cwd) => resolvePowershellBinary('win32', env, cwd)],
]

describe.each(RESOLVERS)('%s refuses a binary planted in the project', (_name, plant, resolve) => {
  it('skips one on PATH as the launch directory itself', () => {
    const entry = entryIn(tempDir())
    plant(entry)
    expect(resolve({ PATH: entry }, entry)).toBeUndefined()
  })

  it('skips one below the launch directory under node_modules or a virtual environment', () => {
    const cwd = tempDir()
    const local = entryIn(join(cwd, 'node_modules', 'tool'))
    const venv = entryIn(join(cwd, '.venv', 'tool'))
    plant(local)
    plant(venv)
    expect(resolve({ PATH: [local, venv].join(delimiter) }, cwd)).toBeUndefined()
  })

  it('walks past a planted one to a genuine install further along PATH', () => {
    // The planted copy comes FIRST: a resolver that abandoned the lookup on seeing one,
    // rather than skipping that entry, would fail here. The launch directory IS the
    // planted entry, which is the shape the guard recognizes; an ordinary subdirectory
    // of the project is deliberately not covered, since a user may put their own tools
    // there and name it on PATH themselves.
    const planted = entryIn(tempDir())
    const real = tempDir()
    plant(planted)
    plant(entryIn(real))
    expect(resolve({ PATH: [planted, entryIn(real)].join(delimiter) }, planted)).toContain(real)
  })

  it('still resolves an ordinary install outside the project', () => {
    // The guard's other failure mode: refusing everything would also pass the cases above.
    const root = tempDir()
    plant(entryIn(root))
    expect(resolve({ PATH: entryIn(root) }, tempDir())).toContain(root)
  })

  it('reads the Path spelling as well as PATH', () => {
    // Windows env vars are case-insensitive and process.env follows, but an env object a
    // caller or a test builds carries whichever spelling it was built with.
    const root = tempDir()
    plant(entryIn(root))
    expect(resolve({ Path: entryIn(root) }, tempDir())).toContain(root)
  })
})

// The real-host half: the guard above runs everywhere with planted files, but only a
// Windows runner can say whether fs.accessSync(X_OK) admits an ordinary file on a
// filesystem with no execute bit, which is what the resolver's own check relies on.
describe.skipIf(process.platform !== 'win32')('resolvePowershellBinary on a real Windows host', () => {
  it('finds the PowerShell this runner ships', () => {
    expect(resolvePowershellBinary()).toMatch(/(pwsh|powershell)\.exe$/i)
  })

  it('refuses a planted pwsh.exe even though the filesystem has no execute bit', () => {
    const entry = entryIn(tempDir())
    plantPowershell(entry)
    expect(resolvePowershellBinary('win32', { PATH: entry }, entry)).toBeUndefined()
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
