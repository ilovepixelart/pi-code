/**
 * Kill a detached child and everything it spawned. `sh -c 'a; b'` forks, and so does
 * a child pi running a build, so signalling the direct child alone leaves a grandchild
 * alive holding stdout/stderr. One copy for hooks and both subagent runners: the three
 * private copies had drifted, and only the hooks one handled Windows, so a subagent
 * cancel there killed the direct child only.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as path from 'node:path'

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    // Windows has no process groups: taskkill /T ends the whole tree, and it has no
    // graceful signal, so SIGTERM and SIGKILL both force. By absolute path, so a
    // writable PATH entry cannot stand in for it. If taskkill itself cannot start,
    // the direct kill is all that is left.
    const taskkill = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'taskkill.exe')
    if (child.pid) spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'))
    else child.kill('SIGKILL')
    return
  }
  try {
    // Negative pid targets the whole process group, which `detached` gave the child.
    // A child that never spawned has no pid and no group; the direct kill is all there is.
    if (child.pid) {
      process.kill(-child.pid, signal)
      return
    }
  } catch {
    // Group already reaped, or the platform refused it; fall through to the direct kill.
  }
  try {
    child.kill(signal)
  } catch {
    // already gone
  }
}
