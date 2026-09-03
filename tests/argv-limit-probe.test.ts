import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * S5 (register): the subagent task travels to the child pi process as one argv
 * element (run.ts's `args.push(taskWithStartContext(task, ...))`). A chain step's
 * `{previous}` substitution is capped at 50KB (capForContext / DEFAULT_MAX_BYTES),
 * but the model's own task text for that step is not, and Linux enforces
 * MAX_ARG_STRLEN, a PER-ARGUMENT limit of 128KiB distinct from the much larger
 * total ARG_MAX — a single argv string over that limit fails execve with E2BIG,
 * whatever the combined length of every other argument.
 *
 * This is a probe, not a fix: it spawns a real child (no shell, exactly like
 * run.ts's `spawn(invocation.command, invocation.args, { shell: false, ... })`)
 * with one oversized argument and observes what actually happens on the host
 * running it, rather than trusting the textbook constant. Linux-gated because the
 * limit, and its value, is a Linux kernel property; macOS and Windows have
 * different (and in macOS's case, much larger) argument-length rules.
 */
describe.skipIf(process.platform !== 'linux')('a single argv element near the Linux MAX_ARG_STRLEN boundary', () => {
  // node -e 'process.exit(0)' is the same shape run.ts spawns: no shell, a fixed
  // command, extra positional args the child ignores.
  const run = (argLength: number): Promise<{ code: number | null; error: NodeJS.ErrnoException | null }> =>
    new Promise((resolve) => {
      const oversized = 'x'.repeat(argLength)
      const proc = spawn(process.execPath, ['-e', 'process.exit(0)', oversized], { shell: false, stdio: 'ignore' })
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
