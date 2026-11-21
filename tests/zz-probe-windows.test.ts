import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'

const probe = async (label: string, abortWhen: (started: Promise<void>) => Promise<void>): Promise<string> => {
  const ops = createLocalBashOperations()
  const results: string[] = []
  for (let i = 0; i < 10; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
    const lifetime = new AbortController()
    let markStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const run = ops.exec('echo started; sleep 10; echo late', dir, { onData: () => markStarted(), signal: lifetime.signal })
    await abortWhen(started)
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
        if (Date.now() - start > 12_000) {
          first += ' (still held after 12s)'
          break
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    results.push(`${label} ${i}: first=${first} released after ${Date.now() - start}ms`)
  }
  return results.join('\n')
}

it.runIf(process.platform === 'win32')(
  'PROBE: delete after an aborted Git Bash command settles',
  async () => {
    const early = await probe('abort@100ms', () => new Promise((r) => setTimeout(r, 100)))
    const afterOutput = await probe('abort@output', (started) => started)
    console.log(`PROBE RESULTS\n${early}\n${afterOutput}`)
    expect(early).toBeTruthy()
  },
  300_000,
)
