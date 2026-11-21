import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, it } from 'vitest'

const attempt = (dir: string): string => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return fs.existsSync(dir) ? 'no-throw-but-exists' : 'ok'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
}

const child = async (script: string, cwd: string) => {
  const proc = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve) => proc.stdout.once('data', () => resolve()))
  return proc
}

it.runIf(process.platform === 'win32')(
  'PROBE: which holders block removing a directory',
  async () => {
    const out: string[] = []
    for (let i = 0; i < 5; i++) {
      const a = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-a-'))
      const pa = await child('console.log("up"); setTimeout(() => {}, 3000)', a)
      out.push(`cwd-held ${i}: ${attempt(a)}`)
      pa.kill()

      const b = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-b-'))
      const pb = await child('const fs = require("fs"); fs.openSync("held.txt", "w"); console.log("up"); setTimeout(() => {}, 3000)', b)
      out.push(`child-open-file ${i}: ${attempt(b)}`)
      pb.kill()

      const c = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-c-'))
      const stream = fs.createWriteStream(path.join(c, 'log.txt'))
      stream.write('x')
      await new Promise((r) => stream.once('open', r))
      out.push(`own-open-stream ${i}: ${attempt(c)}`)
      stream.end()
      await new Promise((r) => setTimeout(r, 200))
    }
    await new Promise((r) => setTimeout(r, 500))
    console.log(`PROBE RESULTS\n${out.join('\n')}`)
    expect(out).toHaveLength(15)
  },
  120_000,
)
