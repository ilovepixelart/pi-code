import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * S5 (register, now fixed): confirms, on a real Linux host rather than trusting
 * the textbook constant, that a single argv element over MAX_ARG_STRLEN (128KiB, a
 * PER-ARGUMENT limit distinct from the much larger total ARG_MAX) fails execve
 * with E2BIG. This is what justifies capping the assembled task string in
 * subagent/child.ts's `taskWithStartContext`, and what surfaced that spawn()
 * itself needed a try/catch in subagent/run.ts (`spawnChild`): on this Linux/Node
 * combination it throws synchronously for E2BIG rather than only emitting the
 * async 'error' event.
 *
 * Spawns a real child (no shell, exactly like run.ts's
 * `spawn(invocation.command, invocation.args, { shell: false, ... })`) with one
 * oversized argument. Linux-gated because the limit, and its value, is a Linux
 * kernel property; macOS and Windows have different (and in macOS's case, much
 * larger) argument-length rules.
 */
describe.skipIf(process.platform !== 'linux')('a single argv element near the Linux MAX_ARG_STRLEN boundary', () => {
  // node -e 'process.exit(0)' is the same shape run.ts spawns: no shell, a fixed
  // command, extra positional args the child ignores. spawn() itself needs a
  // try/catch here too: this run confirmed spawn() throws SYNCHRONOUSLY for
  // E2BIG on this Linux/Node combination (posix_spawn detects it before
  // returning), rather than only emitting the async 'error' event below, which
  // production code had the same gap and is now fixed to catch (subagent/run.ts,
  // spawnChild).
  const run = (argLength: number): Promise<{ code: number | null; error: NodeJS.ErrnoException | null }> =>
    new Promise((resolve) => {
      const oversized = 'x'.repeat(argLength)
      let proc: ReturnType<typeof spawn>
      try {
        proc = spawn(process.execPath, ['-e', 'process.exit(0)', oversized], { shell: false, stdio: 'ignore' })
      } catch (error) {
        resolve({ code: null, error: error as NodeJS.ErrnoException })
        return
      }
      let settled = false
      proc.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        resolve({ code: null, error })
      })
      proc.on('close', (code) => {
        if (settled) return
        settled = true
        resolve({ code, error: null })
      })
    })

  it('fails with E2BIG at 200KiB, comfortably over the 128KiB limit', async () => {
    const result = await run(200 * 1024)
    expect(result.error?.code).toBe('E2BIG')
  })

  it('succeeds at 64KiB, comfortably under the limit', async () => {
    const result = await run(64 * 1024)
    expect(result.error).toBeNull()
    expect(result.code).toBe(0)
  })
})
