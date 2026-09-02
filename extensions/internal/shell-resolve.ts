/**
 * Which shell runs a command string, per Claude's contract. hooks.md: a shell-form
 * command is "passed to a shell: `sh -c` on macOS and Linux, Git Bash on Windows, or
 * PowerShell when Git Bash isn't installed", and a hook's `shell: "powershell"` runs it
 * via PowerShell (pwsh, then Windows PowerShell 5.1). statusline.md applies the same
 * Git Bash-then-PowerShell rule to statusLine commands. troubleshoot-install.md: when
 * CLAUDE_CODE_GIT_BASH_PATH is unset, Git Bash is looked for in `C:\Program Files\Git`
 * and `C:\Program Files (x86)\Git`, then through the `git` on PATH (the `bin\bash.exe`
 * of that installation), skipping a git in the launch directory or below it under
 * node_modules or a virtual environment. env-vars.md: the override is ignored unless
 * the file exists and is named bash.exe, sh.exe, bash, or sh.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ResolvedShell {
  kind: 'bash' | 'powershell'
  file: string
  /** The argv that runs `command` through this shell. */
  argsFor: (command: string) => string[]
}

const GIT_BASH_NAMES = new Set(['bash.exe', 'sh.exe', 'bash', 'sh'])
const DEFAULT_GIT_ROOTS = [String.raw`C:\Program Files\Git`, String.raw`C:\Program Files (x86)\Git`]
const PROJECT_TOOLING_DIRS = new Set(['node_modules', '.venv', 'venv'])

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The PowerShell names worth trying: pwsh everywhere it installs, plus the
 * Windows spellings on win32, where powershell.exe ships with the OS. */
const powershellCandidates = (platform: string): string[] => (platform === 'win32' ? ['pwsh', 'pwsh.exe', 'powershell.exe'] : ['pwsh'])

/** First PowerShell binary found on PATH, or undefined when none is installed. */
export function resolvePowershellBinary(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const candidate of powershellCandidates(platform)) {
    for (const dir of dirs) {
      const full = path.join(dir, candidate)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        if (fs.statSync(full).isFile()) return full
      } catch {
        // not here; keep looking
      }
    }
  }
  return undefined
}

/** A git in the launch directory itself, or below it under node_modules or a virtual
 * environment, is a project's own tooling rather than the user's Git installation. */
function isProjectTooling(dir: string, cwd: string): boolean {
  const relative = path.relative(cwd, dir)
  if (relative === '') return true
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return relative.split(path.sep).some((segment) => PROJECT_TOOLING_DIRS.has(segment))
}

/** Git Bash in Claude's documented order, or undefined when none is installed. */
export function resolveGitBash(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string | undefined {
  const override = env.CLAUDE_CODE_GIT_BASH_PATH
  if (override && GIT_BASH_NAMES.has(path.basename(override).toLowerCase()) && isFile(override)) return override
  for (const root of DEFAULT_GIT_ROOTS) {
    const bash = path.join(root, 'bin', 'bash.exe')
    if (isFile(bash)) return bash
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    if (!isFile(path.join(dir, 'git.exe')) || isProjectTooling(dir, cwd)) continue
    // Git for Windows puts git.exe in cmd\ (or bin\); bash.exe lives in bin\ of the same install.
    const bash = path.join(path.dirname(dir), 'bin', 'bash.exe')
    if (isFile(bash)) return bash
  }
  return undefined
}

/** Claude rewrites these three placeholders in a PowerShell shell-form command to
 * PowerShell's `${env:NAME}` form; the bare `$NAME` spelling is left alone (PowerShell
 * reads it as an undefined variable, which Claude only warns about). */
export const toPowershellPlaceholders = (command: string): string => command.replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g, (_match, name: string) => `\${env:${name}}`)

/** The bash for an injected command span: /bin/sh off Windows, Git Bash on Windows
 * (undefined when it is not installed). */
export function bashBinary(platform: string = process.platform, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string | undefined {
  return platform === 'win32' ? resolveGitBash(env, cwd) : '/bin/sh'
}

const bashShell = (file: string): ResolvedShell => ({ kind: 'bash', file, argsFor: (command) => ['-c', command] })

const powershellShell = (file: string): ResolvedShell => ({
  kind: 'powershell',
  file,
  // -Command swallows a native command's exit code unless it is forwarded; a script
  // that calls `exit` itself never reaches the trailer, so its own code stands.
  argsFor: (command) => ['-NoProfile', '-NonInteractive', '-Command', `${toPowershellPlaceholders(command)}\nexit $LASTEXITCODE`],
})

/**
 * The shell for a command string. `preferred` is a hook's `shell` field: "powershell"
 * runs through PowerShell where one is installed. Otherwise /bin/sh off Windows; on
 * Windows Git Bash, then PowerShell. Undefined means nothing on this machine can run
 * it (Windows with neither Git Bash nor PowerShell installed).
 */
export function resolveShell(preferred: string | undefined, platform: string = process.platform, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): ResolvedShell | undefined {
  if (preferred === 'powershell') {
    const powershell = resolvePowershellBinary(platform, env)
    if (powershell) return powershellShell(powershell)
  }
  const bash = bashBinary(platform, env, cwd)
  if (bash) return bashShell(bash)
  const powershell = resolvePowershellBinary(platform, env)
  return powershell ? powershellShell(powershell) : undefined
}
