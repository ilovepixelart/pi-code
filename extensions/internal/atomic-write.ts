/**
 * Replace a file through a temp file and a rename, so a crash mid-write cannot leave the
 * target truncated. Used wherever pi-code rewrites a file the user owns and would have to
 * repair by hand: settings and the memory index.
 */

import * as fs from 'node:fs'

/** The permission bits of `filePath`, or undefined when it does not exist yet. */
function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777
  } catch {
    return undefined
  }
}

/** The tmp name carries the pid so concurrent processes do not collide. A rename replaces
 * the file's inode, so the replacement is created with the mode of the file it replaces:
 * settings.local.json can hold env secrets, and a fresh temp file is 0644 under the usual
 * umask. Created with that mode, the temp file is never more permissive than the target;
 * the chmod then makes it exact where the umask took bits away. */
export function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`
  const mode = existingMode(filePath)
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, filePath)
}
