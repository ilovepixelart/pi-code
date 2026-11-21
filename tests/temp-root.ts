import * as fs from 'node:fs'

/** Removes a test file's temp root and everything under it. */
export function removeTempRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}
