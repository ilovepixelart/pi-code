/**
 * Replace a file through a temp file and a rename, so a crash mid-write cannot leave the
 * target truncated. Used wherever pi-code rewrites a file the user owns and would have to
 * repair by hand: settings and the memory index.
 */

import * as fs from 'node:fs'

/** The file a path leads to. A rename onto a symlink replaces the link itself: a settings
 * file a dotfiles setup links into a repository would silently become a regular file while
 * the real one kept the old content. The write goes to the real file, in its own directory
 * so the rename stays on one filesystem. A link that leads nowhere yet is written as is. */
function throughLinks(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return filePath
  }
}

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
  const target = throughLinks(filePath)
  const tmp = `${target}.${process.pid}.tmp`
  const mode = existingMode(target)
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, target)
}
