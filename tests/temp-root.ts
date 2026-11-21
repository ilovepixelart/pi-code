import * as fs from 'node:fs'

/** Removes a test file's temp root and everything under it.
 *
 * On Windows a native process that still has its working directory or an open file under
 * the root makes the removal fail (EPERM on Node 24, EBUSY on Node 22) until it exits. A
 * process a test started can outlive the file by a moment, so the removal retries with a
 * linear backoff totalling about six seconds, inside the ten-second hook timeout: a process
 * that holds the root past that still fails the file. */
export function removeTempRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
