import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { activeBackgroundRuns, type BackgroundRun, type BackgroundSpawn, backgroundStatusText, cancelBackgroundRun, formatStatus, parseFinalOutputFromJsonl, resumeBackgroundRun, startBackgroundRun } from '../extensions/subagent/background.ts'

describe('background subagent helpers', () => {
  it('parses the final assistant text and turn count from jsonl', () => {
    const jsonl = [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      'not json at all',
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'ignored' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }),
    ].join('\n')
    expect(parseFinalOutputFromJsonl(jsonl)).toEqual({ text: 'final answer', turns: 2 })
  })

  it('returns empty result for garbage input', () => {
    expect(parseFinalOutputFromJsonl('')).toEqual({ text: '', turns: 0 })
  })

  it('formats run status lines', () => {
    const runs: BackgroundRun[] = [
      { id: 'bg-1', agent: 'scout', task: 'find things', state: 'running', turns: 0, sessionId: 'sess', spawn: { command: 'pi', args: [], cwd: '/w' } },
      { id: 'bg-2', agent: 'worker', task: 'do things', state: 'done', exitCode: 0, turns: 3, sessionId: 'sess', spawn: { command: 'pi', args: [], cwd: '/w' } },
    ]
    const text = formatStatus(runs)
    expect(text).toContain('bg-1 scout: running')
    expect(text).toContain('bg-2 worker: done (exit 0, 3 turns)')
    expect(formatStatus([])).toContain('No background runs')
  })
})

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), spawn: spawnMock }))

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

const children: FakeProc[] = []

beforeEach(() => {
  children.length = 0
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => {
    const child = new FakeProc()
    children.push(child)
    return child
  })
})

const spec = (over: Partial<BackgroundSpawn> = {}): BackgroundSpawn => ({ command: 'pi', args: ['--mode', 'json', 'Task: t'], cwd: '/w', ...over })

describe('background run lifecycle', () => {
  it('reports the final text of a stdout stream whose chunks split lines', () => {
    let done: BackgroundRun | undefined
    startBackgroundRun('scout', 'find', spec(), (run) => {
      done = run
    })
    const child = children.at(-1)!
    const l1 = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } })
    const l2 = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } })
    const whole = `${l1}\n${l2}\n`
    child.stdout.emit('data', whole.slice(0, 25))
    child.stdout.emit('data', whole.slice(25))
    child.emit('close', 0)

    expect(done?.state).toBe('done')
    expect(done?.output).toBe('final answer')
    expect(done?.turns).toBe(2)
  })

  it('keeps a bounded stderr tail for a failed child', () => {
    let done: BackgroundRun | undefined
    startBackgroundRun('scout', 'boot', spec(), (run) => {
      done = run
    })
    const child = children.at(-1)!
    child.stderr.emit('data', 'x'.repeat(5000))
    child.stderr.emit('data', 'model id not resolvable')
    child.emit('close', 1)

    expect(done?.state).toBe('failed')
    expect(done?.stderr).toContain('model id not resolvable')
    expect((done?.stderr ?? '').length).toBeLessThanOrEqual(2048)
  })

  it('holds the cap slot for a cancelled child until it dies, then escalates to SIGKILL', () => {
    vi.useFakeTimers()
    try {
      const id = startBackgroundRun('scout', 'hang', spec(), () => {})
      const child = children.at(-1)!
      const before = activeBackgroundRuns()

      expect(cancelBackgroundRun(id!)).toBe('cancelled')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      // The state flipped, but the process is still alive and holds its slot.
      expect(activeBackgroundRuns()).toBe(before)

      vi.advanceTimersByTime(5000)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')

      child.emit('close', 143)
      expect(activeBackgroundRuns()).toBe(before - 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts the oldest finished runs beyond the retention cap', () => {
    for (let i = 0; i < 25; i++) {
      startBackgroundRun('scout', `job ${i}`, spec(), () => {})
      children.at(-1)!.emit('close', 0)
    }
    const finished = backgroundStatusText()
      .split('\n')
      .filter((line) => line.includes('done (exit'))
    expect(finished.length).toBeLessThanOrEqual(20)
  })

  it('refuses to resume while the running cap is full', () => {
    let finished: BackgroundRun | undefined
    startBackgroundRun('scout', 'early', spec(), (run) => {
      finished = run
    })
    children.at(-1)!.emit('close', 0)

    const live: FakeProc[] = []
    for (let i = 0; i < 8; i++) {
      startBackgroundRun('scout', `fill ${i}`, spec(), () => {})
      live.push(children.at(-1)!)
    }
    expect(resumeBackgroundRun(finished!.id, 'again', () => {})).toBe('at-capacity')
    for (const child of live) child.emit('close', 0)
  })

  it('rebuilds the prompt file once and reuses it across resumes', () => {
    const id = startBackgroundRun('scout', 'one', spec({ args: ['--append-system-prompt', '/nonexistent/prompt.md', 'Task: one'], promptBody: 'PERSONA' }), () => {})
    children.at(-1)!.emit('close', 0)

    expect(resumeBackgroundRun(id!, 'two', () => {})).toBe('resumed')
    const firstArgs = spawnMock.mock.calls.at(-1)![1] as string[]
    const promptPath = firstArgs[firstArgs.indexOf('--append-system-prompt') + 1]
    expect(existsSync(promptPath)).toBe(true)
    children.at(-1)!.emit('close', 0)

    expect(resumeBackgroundRun(id!, 'three', () => {})).toBe('resumed')
    const secondArgs = spawnMock.mock.calls.at(-1)![1] as string[]
    expect(secondArgs[secondArgs.indexOf('--append-system-prompt') + 1]).toBe(promptPath)
    children.at(-1)!.emit('close', 0)
    rmSync(dirname(promptPath), { recursive: true, force: true })
  })
})
