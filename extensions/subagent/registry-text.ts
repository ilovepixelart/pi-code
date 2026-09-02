/**
 * The text the subagent surfaces read out: a finished background run's notification,
 * the /tasks table and the /agents roster. No process state, no rendering widgets, so
 * each is a pure string function the tests can pin directly.
 */

import { capForContext } from '../internal/output-guard.js'
import type { AgentConfig, AgentSource } from './agents.js'
import { type BackgroundRun, backgroundRun, backgroundStatusText, cancelBackgroundRun, MAX_BACKGROUND_RUNS, resumeBackgroundRun } from './background.js'

/** The completion notice a background run sends when it finishes. */
export function backgroundCompletionText(run: { id: string; agent: string; state: string; turns: number; output?: string; stderr?: string; partial?: boolean }): string {
  const output = capForContext(run.output ?? '') || '(no output)'
  // A child that dies at boot writes its reason only to stderr; without this the
  // notice reads "failed after 0 turns ... (no output)" with nothing to act on.
  const diagnostics = run.state === 'failed' && run.stderr ? `\n\nstderr tail:\n${capForContext(run.stderr)}` : ''
  // Claude marks maxTurns-capped output as partial and notes the run can be
  // resumed to continue from where it stopped.
  const partialNote = run.partial ? `\n\n[Output is partial: the run stopped at its maxTurns limit. Resume it with {resume: "${run.id}", task: "..."} to continue.]` : ''
  return `Background subagent run ${run.id} (${run.agent}) ${run.state} after ${run.turns} turns.\n\n${output}${diagnostics}${partialNote}`
}

/** What to tell the model about a resume request. */
export function resumeResultText(id: string, task: string | undefined, onComplete: (run: { id: string; agent: string; state: string; turns: number; output?: string; stderr?: string }) => void, onResumed?: (run: { id: string; agent: string }) => void): string {
  if (!task) return 'Pass task with resume: the follow-up needs an instruction.'
  const outcome = resumeBackgroundRun(id, task, onComplete)
  if (outcome === 'resumed') {
    const run = backgroundRun(id)
    if (run) onResumed?.({ id: run.id, agent: run.agent })
    return `Resumed background run ${id} with the follow-up task; a notification will arrive on completion.`
  }
  if (outcome === 'still-running') return `Background run ${id} is still running; wait for it or cancel it first.`
  if (outcome === 'at-capacity') return `Background run cap reached (${MAX_BACKGROUND_RUNS} concurrent); wait for a run to finish before resuming ${id}.`
  if (outcome === 'cwd-gone') return `Background run ${id} ran in a working directory that no longer exists (an isolation worktree is cleaned up after an unchanged run); start a new run instead.`
  return `Unknown background run: ${id}.\n\n${backgroundStatusText()}`
}

/** What to tell the model about a cancel request. */
export function cancelResultText(id: string): string {
  const outcome = cancelBackgroundRun(id)
  if (outcome === 'cancelled') return `Cancelled background run ${id}.`
  if (outcome === 'not-running') return `Background run ${id} already finished; nothing to cancel.`
  return `Unknown background run: ${id}.\n\n${backgroundStatusText()}`
}

/** The registry fields the /tasks listing prints. */
type BackgroundRunView = Pick<BackgroundRun, 'id' | 'agent' | 'task' | 'state' | 'turns' | 'output' | 'stderr'>

const TASK_PREVIEW_CHARS = 60
const TAIL_PREVIEW_CHARS = 200

/** Truncate to at most `max` codepoints, iterating by codepoint so a multi-byte
 * character on the boundary is never cut into a lone surrogate. Returns the whole
 * string when it already fits, so a caller can tell it did not clip. */
function clipCodepoints(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('') : text
}

/** A one-line tail of what a run last said: the stderr tail for a failure (the only
 * diagnostics a boot failure leaves), the latest assistant text otherwise. */
function runOutputTail(run: BackgroundRunView): string | undefined {
  const stderrTail = run.state === 'failed' ? run.stderr?.trim() : undefined
  const raw = (stderrTail || run.output)?.trim()
  if (!raw) return undefined
  const last = raw.split('\n').at(-1)?.trim() ?? ''
  const shortened = clipCodepoints(last, TAIL_PREVIEW_CHARS)
  const clipped = shortened === last ? last : `${shortened}...`
  return stderrTail ? `stderr: ${clipped}` : clipped
}

/** The /tasks listing: one line per background run, plus the short output tail the
 * registry's own status lines omit. A pure formatter so it tests against a plain list. */
export function tasksStatusText(runs: ReadonlyArray<BackgroundRunView>): string {
  if (runs.length === 0) return 'No background subagent runs.'
  return runs
    .map((run) => {
      const plural = run.turns === 1 ? '' : 's'
      const label = run.state === 'running' ? 'running' : `${run.state} (${run.turns} turn${plural})`
      const head = `${run.id} ${run.agent}: ${label} - ${clipCodepoints(run.task, TASK_PREVIEW_CHARS)}`
      const tail = runOutputTail(run)
      return tail ? `${head}\n  ${tail}` : head
    })
    .join('\n')
}

/** Listing order for /agents: lowest to highest precedence, matching how discovery
 * lets a later source win a name clash. */
const AGENT_SOURCE_ORDER: ReadonlyArray<AgentSource> = ['builtin', 'plugin', 'user', 'project']

const AGENTS_DIR_HINT = 'Add agents as markdown files under ~/.claude/agents (user) or .claude/agents (project).'

/** The /agents listing: the discovered roster grouped by source, with file paths.
 * A pure formatter so it tests against a sample roster. */
export function agentsListText(agents: ReadonlyArray<Pick<AgentConfig, 'name' | 'source' | 'filePath'>>): string {
  if (agents.length === 0) return `No agents discovered.\n${AGENTS_DIR_HINT}`
  const sections: string[] = []
  for (const source of AGENT_SOURCE_ORDER) {
    const group = agents.filter((agent) => agent.source === source)
    if (group.length === 0) continue
    const lines = group.map((agent) => `  ${agent.name} - ${agent.filePath}`).join('\n')
    sections.push(`${source}:\n${lines}`)
  }
  return `${sections.join('\n')}\n\n${AGENTS_DIR_HINT}`
}
