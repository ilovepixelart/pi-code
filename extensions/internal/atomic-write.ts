/**
 * Replace a file through a temp file and a rename, so a crash mid-write cannot leave the
 * target truncated. Used wherever pi-code rewrites a file the user owns and would have to
 * repair by hand: settings and the memory index.
 */

import * as fs from 'node:fs'

/** The tmp name carries the pid so concurrent processes do not collide. */
export function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}
