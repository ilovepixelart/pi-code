/**
 * Global test hygiene: the suite must be immune to the host environment.
 *
 * pi-code's own dev loop runs the tests inside Claude Code and inside pi
 * subagents, so the host env carries the very variables the source reads
 * (CLAUDECODE, PI_CODE_SUBAGENT, CLAUDE_CONFIG_DIR, the MCP timeout family).
 * They are deleted at module load, before any test file imports source that
 * could read them at import time, and again before each test so a leaky
 * earlier test cannot reintroduce them.
 *
 * Each test also runs against a snapshot of process.env: whatever a test sets
 * and forgets to restore is rolled back afterwards. The global afterEach is
 * registered first, so vitest runs it after every file-local afterEach.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

const HOST_LEAK_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CONFIG_DIR',
  'PI_CODE_SUBAGENT',
  'PI_CODE_AGENT_HOOKS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP',
  'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
  'WT_SESSION',
  'KITTY_WINDOW_ID',
  'PI_CODE_SETTINGS_WATCH_INTERVAL_MS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_GOAL_CHECKIN_MINUTES',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING',
  'CLAUDE_CODE_DISABLE_POLICY_SKILLS',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'MCP_OAUTH_CALLBACK_PORT',
]

function quarantine(): void {
  for (const name of HOST_LEAK_VARS) delete process.env[name]
}

quarantine()

// Every temp fixture in the suite goes through os.tmpdir(), which resolves from
// TMPDIR (TEMP/TMP on Windows). Pointing it at a per-file root at setup load,
// before any test module runs, funnels every mkdtempSync in the file under one
// directory that afterAll removes wholesale, so no fixture can outlive its file
// regardless of whether the test cleans up.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-tests-'))
process.env.TMPDIR = tmpRoot
process.env.TEMP = tmpRoot
process.env.TMP = tmpRoot
// pi's agent directory (memory, checkpoints, mcp.json, trust decisions, OAuth tokens)
// resolves through the SDK's getAgentDir(), which a node:os mock in a test file does
// not reach. Pointed at the per-file root unconditionally, so no suite can write into
// the developer's real ~/.pi/agent whichever home it fakes.
process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'pi-agent')

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

let snapshot: NodeJS.ProcessEnv

beforeEach(() => {
  quarantine()
  snapshot = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (process.env[key] !== value) process.env[key] = value
  }
})
