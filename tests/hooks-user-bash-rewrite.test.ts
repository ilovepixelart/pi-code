import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import hooksExtension from '../extensions/hooks/index.ts'

// No doubles: a real hook command rewrites the input, and whatever the user_bash handler
// hands back is run through pi's own executor, the one pi uses for a `!` command when an
// extension returns nothing (pi dist/core/agent-session executeBash).
type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>

const REWRITE = `node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'echo rewritten'}}}))"`

async function userBashWithRewritingHook(command: string, project: { shellPath?: string; trusted?: boolean } = {}) {
  const config = mkdtempSync(join(tmpdir(), 'ub-config-'))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: REWRITE }] }] } }))
  process.env.CLAUDE_CONFIG_DIR = config
  const handlers = new Map<string, Handler>()
  hooksExtension({ on: (name: string, fn: Handler) => handlers.set(name, fn), events: { on: () => {}, emit: () => {} }, sendMessage: () => {}, registerCommand: () => {} } as never)
  const cwd = mkdtempSync(join(tmpdir(), 'ub-cwd-'))
  if (project.shellPath !== undefined) {
    mkdirSync(join(cwd, '.pi'))
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ shellPath: project.shellPath }))
  }
  const notes: string[] = []
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => project.trusted === true, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getSessionId: () => 's', getSessionFile: () => undefined } }
  await handlers.get('session_start')?.({ reason: 'startup' }, ctx)
  const result = (await handlers.get('user_bash')?.({ type: 'user_bash', command, excludeFromContext: false, cwd }, ctx)) as { operations?: { exec: typeof run } } | undefined
  return { result, cwd, notes }
}

const run = createLocalBashOperations().exec

async function execute(operations: { exec: typeof run } | undefined, command: string, cwd: string): Promise<string> {
  let output = ''
  await (operations?.exec ?? run)(command, cwd, { onData: (data) => (output += data.toString()) })
  return output.trim()
}

describe('a PreToolUse rewrite of a direct ! command', () => {
  it('runs the rewritten command, not the one the user typed', async () => {
    const { result, cwd } = await userBashWithRewritingHook('echo original')
    expect(await execute(result?.operations, 'echo original', cwd)).toBe('rewritten')
  })

  it('keeps the shell command prefix pi prepends', async () => {
    // pi hands custom operations `<shellCommandPrefix>\n<command>`.
    const { result, cwd } = await userBashWithRewritingHook('echo original')
    expect(await execute(result?.operations, 'echo prefix\necho original', cwd)).toBe('prefix\nrewritten')
  })

  it('tells the user the command was rewritten, since the transcript shows the typed one', async () => {
    const { notes } = await userBashWithRewritingHook('echo original')
    expect(notes.some((note) => note.includes('echo rewritten'))).toBe(true)
  })
  it("ignores an untrusted project's shell setting when it runs the rewrite", async () => {
    // pi reads a project's .pi/settings.json only for a trusted project; a repository must
    // not pick the binary a rewritten command runs under.
    const { result, cwd } = await userBashWithRewritingHook('echo original', { shellPath: '/nonexistent/repo-shell' })
    expect(await execute(result?.operations, 'echo original', cwd)).toBe('rewritten')
  })
})
