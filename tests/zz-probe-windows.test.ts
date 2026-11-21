import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'

it.runIf(process.platform === 'win32')(
  'PROBE: delete after an aborted Git Bash command settles',
  async () => {
    const ops = createLocalBashOperations()
    const results: string[] = []
    for (let i = 0; i < 10; i++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
      const lifetime = new AbortController()
      const run = ops.exec('sleep 30', dir, { onData: () => {}, signal: lifetime.signal })
      await new Promise((r) => setTimeout(r, 500))
      lifetime.abort()
      await run.catch(() => {})
      const start = Date.now()
      let first = 'ok'
      for (;;) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
          break
        } catch (error) {
          if (first === 'ok') first = (error as NodeJS.ErrnoException).code ?? 'unknown'
          if (Date.now() - start > 8000) {
            first += ' (still held after 8s)'
            break
          }
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      results.push(`${i}: first=${first} released after ${Date.now() - start}ms`)
    }
    console.log(`PROBE RESULTS\n${results.join('\n')}`)
    expect(results).toHaveLength(10)
  },
  120_000,
)
