/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import { StringEnum } from '@earendil-works/pi-ai'
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { type Static, Type } from 'typebox'
import { setAgentRunner } from '../internal/agent-run.js'
import { isMcpToolAliases, MCP_TOOLS_CHANNEL } from '../internal/mcp-alias.js'
import { capForContext } from '../internal/output-guard.js'
import { isProjectApproved, isProjectApprovedSilently } from '../internal/project-approval.js'
import { SUBAGENT_CHANNEL } from '../internal/subagent-events.js'
import { runSubagentStartHooks } from '../internal/subagent-hooks.js'
import { skillDirs } from '../skills.js'
import { type AgentConfig, type AgentScope, type AgentSource, discoverAgents, resolveModelAlias } from './agents.js'
import { activeBackgroundRuns, allBackgroundRuns, type BackgroundRun, backgroundRun, backgroundStatusText, cancelAllBackgroundRuns, cancelBackgroundRun, MAX_BACKGROUND_RUNS, resumeBackgroundRun, startBackgroundRun } from './background.js'
import { agentHooksEnv, agentInvocationArgs, agentMemoryPromptSection, buildHookAgent, childPromptBody, forkAgent, setKnownMcpAliases, unresolvedToolsError, withMemoryTools } from './child.js'
import { getFinalOutput } from './render.js'
import { renderChainCall, renderChainResult, renderParallelCall, renderParallelResult, renderSingleCall, renderSingleResult } from './render-result.js'
import type { SingleResult, SubagentDetails } from './types.js'
import { type AgentWorktree, cleanupAgentWorktree, createAgentWorktree } from './worktree.js'

export { AGENT_HOOK_SYSTEM, agentMemoryDir, agentMemorySection, buildHookAgent, setKnownMcpAliases, withMemoryTools } from './child.js'
// Re-exported so the render formatters stay importable from the subagent entry point,
// where the tests and the tool itself have always reached for them.
export { formatTokens, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput } from './render.js'

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4

export async function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: TOut[] = new Array(items.length)
  let nextIndex = 0
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++
      if (current >= items.length) return
      results[current] = await fn(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'))
  const safeName = agentName.replace(/[^\w.-]+/g, '_')
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`)
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 })
  })
  return { dir: tmpDir, filePath }
}

/** Exported as a test seam: the fallbacks only fire in packaged distributions
 * (bun single-file, compiled binary), which no CI run reaches naturally. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void

type AssistantMessage = Extract<Message, { role: 'assistant' }>

function accumulateAssistantMessage(result: SingleResult, msg: AssistantMessage): void {
  result.usage.turns++
  const usage = msg.usage
  if (usage) {
    result.usage.input += usage.input || 0
    result.usage.output += usage.output || 0
    result.usage.cacheRead += usage.cacheRead || 0
    result.usage.cacheWrite += usage.cacheWrite || 0
    result.usage.cost += usage.cost?.total || 0
    result.usage.contextTokens = usage.totalTokens || 0
  }
  if (!result.model && msg.model) result.model = msg.model
  if (msg.stopReason) result.stopReason = msg.stopReason
  if (msg.errorMessage) result.errorMessage = msg.errorMessage
}

interface RunAgentOptions {
  defaultCwd: string
  agents: AgentConfig[]
  agentName: string
  task: string
  cwd?: string
  step?: number
  signal?: AbortSignal
  onUpdate?: OnUpdateCallback
  makeDetails: (results: SingleResult[]) => SubagentDetails
  onPhase?: SubagentPhaseSink
  /** The child's run id, set by the wrapper so the spawn env can carry it. */
  agentId?: string
  /** SubagentStart hook context, injected ahead of the child's first prompt. */
  startContexts?: string[]
  /** Skill directories to preload from, resolved where project trust is known. */
  skillRoots?: string[]
  /** Models this user can actually run, for resolving a tier alias. */
  availableModels?: ReadonlyArray<{ id: string }>
  /** Whether repo-controlled config (a project/local agent memory store) may be read. */
  projectApproved?: boolean
}

/** Publishes a child run's start/stop for the hooks extension's SubagentStart/Stop.
 * The stop carries the run's final assistant text, which Claude's SubagentStop
 * delivers as last_assistant_message. */
type SubagentPhaseSink = (phase: 'start' | 'stop', agentType: string, agentId: string, lastAssistantMessage?: string) => void

/** Append a note to the final assistant message so it rides the run's normal
 * output; stderr when there is none. */
function appendResultNote(result: SingleResult, note: string): void {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const msg = result.messages[i]
    if (msg.role === 'assistant') {
      msg.content.push({ type: 'text', text: note })
      return
    }
  }
  result.stderr = result.stderr ? `${result.stderr}\n${note}` : note
}

/** Tell the parent where a kept worktree lives. */
function appendWorktreeNote(result: SingleResult, worktree: AgentWorktree): void {
  appendResultNote(result, `[isolation: worktree kept at ${worktree.dir} (branch ${worktree.branch}); the agent's changes live there]`)
}

/** Claude marks a maxTurns-capped run's output as partial; the note rides the
 * final assistant message like the worktree note, so the parent model sees it
 * with the output. A no-op for uncapped runs. */
function appendPartialNote(result: SingleResult): void {
  if (result.partial) appendResultNote(result, '[Output is partial: the subagent stopped at its maxTurns limit.]')
}

async function runSingleAgent(options: RunAgentOptions): Promise<SingleResult> {
  const agent = options.agents.find((a) => a.name === options.agentName)
  if (!agent) return runSingleAgentInner(options)
  // A refused launch (Claude's zero-tools error) never starts, so no
  // SubagentStart/Stop pair fires for it.
  const toolsError = unresolvedToolsError(agent)
  if (toolsError) {
    return {
      agent: agent.name,
      agentSource: agent.source,
      task: options.task,
      exitCode: 1,
      messages: [],
      stderr: toolsError,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step: options.step,
    }
  }
  const agentId = `fg-${randomUUID().slice(0, 8)}`
  // SubagentStart hooks run pre-spawn through the seam so their additionalContext
  // reaches the child before its first prompt.
  const startContexts = await runSubagentStartHooks(agent.name, agentId)
  options.onPhase?.('start', agent.name, agentId)
  let result: SingleResult | undefined
  try {
    result = await runSingleAgentInner({ ...options, agentId, startContexts })
    return result
  } finally {
    options.onPhase?.('stop', agent.name, agentId, result ? getFinalOutput(result.messages) || undefined : undefined)
  }
}

async function runSingleAgentInner(options: RunAgentOptions): Promise<SingleResult> {
  const { defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails } = options
  const agent = agents.find((a) => a.name === agentName)

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none'
    return {
      agent: agentName,
      agentSource: 'unknown',
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    }
  }

  const runCwd = cwd ?? defaultCwd
  // Claude's isolation: worktree gives the child an isolated copy of the repository.
  // A boundary that cannot be created fails the run: running against the real
  // checkout would silently drop the isolation the agent declared.
  let worktree: AgentWorktree | undefined
  if (agent.isolation === 'worktree') {
    const created = await createAgentWorktree(runCwd, agent.name)
    if ('error' in created) {
      return {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: 1,
        messages: [],
        stderr: `isolation: worktree could not be created: ${created.error}`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        step,
      }
    }
    worktree = created
  }
  // Project/local memory is anchored at the SESSION project (defaultCwd), not the
  // model-supplied runCwd: projectApproved gates the session's repo, so anchoring the
  // store on a different (possibly unapproved) cwd would inject that repo's memory as
  // trusted. User-scope memory ignores cwd, so this is safe for it too.
  const memorySection = agentMemoryPromptSection(agent, defaultCwd, options.projectApproved ?? false)
  // A memory-enabled child must be able to manage its store files even when the
  // agent pins a tools allowlist.
  const invocationAgent = memorySection ? { ...agent, tools: withMemoryTools(agent.tools) } : agent
  const args = agentInvocationArgs(invocationAgent, resolveModelAlias(agent.modelAlias, options.availableModels ?? []))

  let tmpPromptDir: string | null = null
  let tmpPromptPath: string | null = null

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  }

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: getFinalOutput(currentResult.messages) || '(running...)' }],
        details: makeDetails([currentResult]),
      })
    }
  }

  try {
    const promptBody = childPromptBody(agent, options.skillRoots ?? [], memorySection)
    if (promptBody.trim()) {
      const tmp = await writePromptToTempFile(agent.name, promptBody)
      tmpPromptDir = tmp.dir
      tmpPromptPath = tmp.filePath
      // Claude: the agent body IS the subagent's system prompt, replacing the
      // default, not an addition to it (--system-prompt reads a file path too).
      args.push('--system-prompt', tmpPromptPath)
    }

    args.push(taskWithStartContext(task, options.startContexts ?? []))
    let wasAborted = false

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args)
      const proc = spawn(invocation.command, invocation.args, {
        cwd: worktree?.dir ?? runCwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own group, so an abort reaches grandchildren too: killing only the
        // direct child orphans a build or dev server the agent started.
        detached: true,
        // The marker lets the child's subagent tool refuse to nest further.
        env: { ...process.env, PI_CODE_SUBAGENT: '1', ...agentHooksEnv(agent, options.agentId ?? '') },
      })
      let buffer = ''
      let assistantTurns = 0

      const processLine = (line: string) => {
        if (!line.trim()) return
        let event: { type?: string; message?: unknown }
        try {
          event = JSON.parse(line)
        } catch {
          return
        }

        if (!event.message) return

        if (event.type === 'message_end') {
          const msg = event.message as Message
          currentResult.messages.push(msg)
          if (msg.role === 'assistant') {
            accumulateAssistantMessage(currentResult, msg)
            assistantTurns++
            // Claude's maxTurns cap: end the child at the turn boundary once it has
            // produced its Nth turn, so the collected output is kept and no turn is
            // cut; the returned output is marked partial, as Claude documents.
            if (agent.maxTurns && assistantTurns >= agent.maxTurns) {
              currentResult.partial = true
              killGroup('SIGTERM')
            }
          }
          emitUpdate()
        } else if (event.type === 'tool_result_end') {
          currentResult.messages.push(event.message as Message)
          emitUpdate()
        }
      }

      let killTimer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer)
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      }

      proc.stdout.on('data', (data) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) processLine(line)
      })
      proc.stdout.on('error', () => {})

      proc.stderr.on('data', (data) => {
        currentResult.stderr += data.toString()
      })
      proc.stderr.on('error', () => {})

      proc.on('close', (code) => {
        cleanup()
        if (buffer.trim()) processLine(buffer)
        resolve(code ?? 0)
      })

      proc.on('error', (error: Error) => {
        cleanup()
        // A child that never started leaves no stdout and no stderr, so this message is the
        // only diagnostic; without it the failure reads as "(no output)".
        if (!currentResult.stderr) currentResult.stderr = error.message
        resolve(1)
      })

      const killGroup = (sig: NodeJS.Signals): void => {
        try {
          // A child that never spawned has no pid and no group; the direct kill is all there is.
          if (proc.pid) process.kill(-proc.pid, sig)
          else proc.kill(sig)
        } catch {
          try {
            proc.kill(sig)
          } catch {
            /* already gone */
          }
        }
      }
      if (signal) {
        onAbort = () => {
          wasAborted = true
          killGroup('SIGTERM')
          // proc.killed only reports that the signal was sent, not that the child died. Escalate
          // on a timer that the 'close' handler clears once the child has actually exited.
          killTimer = setTimeout(() => killGroup('SIGKILL'), 5000)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    currentResult.exitCode = exitCode
    if (wasAborted) throw new Error('Subagent was aborted')
    appendPartialNote(currentResult)
    return currentResult
  } finally {
    // Cleanup runs on abort too: it only removes a pristine worktree, so an
    // interrupted agent's changes always survive.
    if (worktree && (await cleanupAgentWorktree(runCwd, worktree)) === 'kept') {
      appendWorktreeNote(currentResult, worktree)
    }
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath)
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir)
      } catch {
        /* ignore */
      }
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
})

const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
})

const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: 'user',
})

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: 'Name of the agent to invoke (for single mode)' })),
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' })),
  chain: Type.Optional(Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: 'Prompt before running project-local agents. Default: true.', default: true })),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process (single mode)' })),
  background: Type.Optional(Type.Boolean({ description: 'Run the single-mode task in the background: returns a run id immediately and a notification arrives when it completes.' })),
  status: Type.Optional(Type.Boolean({ description: 'Set true (alone, no other params) to list background runs instead of running anything.' })),
  cancel: Type.Optional(Type.String({ description: 'Background run id to cancel (from the id returned when it started, or from status).' })),
  resume: Type.Optional(Type.String({ description: 'Finished background run id to continue with a follow-up task; the child keeps everything it already saw. Pass task with it.' })),
})

/**
 * Decide how to gate project-scoped agents, whose system prompt and tools are
 * repo-controlled. Untrusted projects require interactive confirmation, and are
 * refused when headless; trusted projects run unless confirmProjectAgents asks
 * for a prompt anyway.
 */
export function projectAgentGate(projectAgentCount: number, trusted: boolean, hasUI: boolean, confirmProjectAgents: boolean): 'allow' | 'confirm' | 'refuse' {
  if (projectAgentCount === 0) return 'allow'
  if (trusted && !confirmProjectAgents) return 'allow'
  if (hasUI) return 'confirm'
  return trusted ? 'allow' : 'refuse'
}

/**
 * pi only sets a tool result's error flag when execute() throws; a returned isError is
 * ignored (docs/extensions.md, "Signaling errors"). Throwing here would be worse: the
 * agent loop replaces the result with createErrorToolResult(message), discarding the
 * details renderResult needs to show the failed agent's transcript. The failure is
 * carried in the content text instead, which is what reaches the model.
 */
type ToolResult = AgentToolResult<SubagentDetails>
type SubagentMode = 'single' | 'parallel' | 'chain'
type MakeDetails = (mode: SubagentMode) => (results: SingleResult[]) => SubagentDetails
type SubagentParamsStatic = Static<typeof SubagentParams>
type ChainStepParam = Static<typeof ChainItem>
type TaskItemParam = Static<typeof TaskItem>

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

/** Everything a mode handler needs from the surrounding execute() call. */
interface ModeContext {
  agents: AgentConfig[]
  defaultCwd: string
  signal: AbortSignal | undefined
  onUpdate: OnUpdateCallback | undefined
  makeDetails: MakeDetails
  onPhase?: SubagentPhaseSink
  skillRoots: string[]
  availableModels: ReadonlyArray<{ id: string }>
  projectApproved: boolean
}

async function checkProjectAgentGate(params: SubagentParamsStatic, agents: AgentConfig[], ctx: ExtensionContext, projectAgentsDir: string | null, gateMode: SubagentMode, makeDetails: MakeDetails): Promise<ToolResult | null> {
  const requestedAgentNames = new Set<string>()
  if (params.agent) requestedAgentNames.add(params.agent)
  for (const step of params.chain ?? []) requestedAgentNames.add(step.agent)
  for (const t of params.tasks ?? []) requestedAgentNames.add(t.agent)
  const requestedProjectAgents = [...requestedAgentNames].map((name) => agents.find((a) => a.name === name)).filter((a): a is AgentConfig => a?.source === 'project')

  // No project agents means nothing repo-controlled to gate; skip the approval check so a
  // user-scope run never prompts or persists a trust decision it does not need.
  if (requestedProjectAgents.length === 0) return null

  // isProjectTrusted alone is true for a repo pi never asked about; see project-approval.
  const approved = await isProjectApproved(ctx)
  const gate = projectAgentGate(requestedProjectAgents.length, approved, ctx.hasUI, params.confirmProjectAgents ?? true)
  // Agent names come from repo-controlled frontmatter; a newline in one would otherwise
  // let it write its own "Source:" line into the prompt body.
  const names = requestedProjectAgents.map((a) => a.name.replace(/\s+/g, ' ').trim()).join(', ')
  if (gate === 'refuse') {
    return { content: [{ type: 'text', text: `Project-local agents (${names}) require a trusted project; refusing in non-interactive mode.` }], details: makeDetails(gateMode)([]) }
  }
  if (gate === 'confirm') {
    // Each agent knows where it was loaded from; projectAgentsDir only ever held .pi/agents.
    const dirs = [...new Set(requestedProjectAgents.map((a) => path.dirname(a.filePath)))]
    const dir = dirs.join(', ') || projectAgentsDir || '(unknown)'
    const ok = await ctx.ui.confirm('Run project-local agents?', `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`)
    if (!ok) return { content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }], details: makeDetails(gateMode)([]) }
  }
  return null
}

/** Whether a run belongs in the background: the caller asked, or Claude's
 * `background: true` frontmatter keeps the agent there even on a foreground ask
 * (single mode). */
function wantsBackground(params: { background?: boolean; agent?: string }, agents: AgentConfig[]): boolean {
  if (params.background) return true
  return params.agent !== undefined && agents.find((a) => a.name === params.agent)?.background === true
}

/** The task argument with any SubagentStart hook context ahead of it, per Claude:
 * "added to the subagent's context at the start of its conversation, before its
 * first prompt". */
function taskWithStartContext(task: string, contexts: string[]): string {
  const context = contexts.filter(Boolean).join('\n')
  return context ? `${context}\n\nTask: ${task}` : `Task: ${task}`
}

function backgroundCapResult(makeDetails: MakeDetails): ToolResult {
  return {
    content: [{ type: 'text', text: `Too many background runs (max ${MAX_BACKGROUND_RUNS} running). Wait for one to finish; check progress with {status: true}.` }],
    details: makeDetails('single')([]),
  }
}

function removeTmpPrompt(tmpPrompt: { dir: string; filePath: string } | undefined): void {
  if (!tmpPrompt) return
  try {
    fs.unlinkSync(tmpPrompt.filePath)
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(tmpPrompt.dir)
  } catch {
    /* ignore */
  }
}

/** Everything runBackgroundMode needs from the surrounding execute() call, grouped so
 * the parameter list stays in bounds. */
interface BackgroundContext {
  agents: AgentConfig[]
  defaultCwd: string
  pi: ExtensionAPI
  makeDetails: MakeDetails
  skillRoots: string[]
  availableModels: ReadonlyArray<{ id: string }>
  projectApproved: boolean
}

async function runBackgroundMode(params: SubagentParamsStatic, context: BackgroundContext): Promise<ToolResult> {
  const { agents, defaultCwd, pi, makeDetails, skillRoots, availableModels, projectApproved } = context
  const task = params.task
  const agentName = params.agent
  if (!task || !agentName) {
    return {
      content: [{ type: 'text', text: 'background: true requires single mode (agent + task).' }],
      details: makeDetails('single')([]),
    }
  }
  const agent = agents.find((a) => a.name === agentName)
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none'
    return {
      content: [{ type: 'text', text: `Unknown agent: "${agentName}". Available agents: ${available}.` }],
      details: makeDetails('single')([]),
    }
  }
  const toolsError = unresolvedToolsError(agent)
  if (toolsError) {
    return {
      content: [{ type: 'text', text: toolsError }],
      details: makeDetails('single')([]),
    }
  }
  if (activeBackgroundRuns() >= MAX_BACKGROUND_RUNS) {
    return backgroundCapResult(makeDetails)
  }
  const runCwd = params.cwd ?? defaultCwd
  // The same isolation boundary as the foreground path: no worktree, no run.
  let worktree: AgentWorktree | undefined
  if (agent.isolation === 'worktree') {
    const created = await createAgentWorktree(runCwd, agent.name)
    if ('error' in created) {
      return {
        content: [{ type: 'text', text: `isolation: worktree could not be created for ${agent.name}: ${created.error}` }],
        details: makeDetails('single')([]),
      }
    }
    worktree = created
  }
  // Anchor project/local memory at the session project (defaultCwd), which is the one
  // projectApproved gated; see the foreground path for why runCwd must not be used.
  const memorySection = agentMemoryPromptSection(agent, defaultCwd, projectApproved)
  const args = agentInvocationArgs(memorySection ? { ...agent, tools: withMemoryTools(agent.tools) } : agent, resolveModelAlias(agent.modelAlias, availableModels))
  let tmpPrompt: { dir: string; filePath: string } | undefined
  const promptBody = childPromptBody(agent, skillRoots, memorySection)
  if (promptBody.trim()) {
    tmpPrompt = await writePromptToTempFile(agent.name, promptBody)
    // Claude: the agent body replaces the default system prompt (see the
    // foreground path).
    args.push('--system-prompt', tmpPrompt.filePath)
  }
  // The id is preset so SubagentStart hooks run pre-spawn with the id the run
  // will actually carry, and their context lands before the child's first prompt.
  const presetId = `bg-${randomUUID().slice(0, 8)}`
  const startContexts = await runSubagentStartHooks(agent.name, presetId)
  args.push(taskWithStartContext(task, startContexts))
  const invocation = getPiInvocation(args)
  const id = startBackgroundRun(
    agent.name,
    task,
    { command: invocation.command, args: invocation.args, cwd: worktree?.dir ?? runCwd, env: agentHooksEnv(agent, presetId), promptBody: tmpPrompt ? promptBody : undefined, maxTurns: agent.maxTurns },
    (run) => {
      removeTmpPrompt(tmpPrompt)
      const finish = (): void => {
        // Both calls throw once the session that started the run is disposed. driveRun's
        // catch covers the synchronous path, but the worktree branch reaches here from an
        // async continuation outside it, so the guard must live in finish itself.
        try {
          pi.events.emit(SUBAGENT_CHANNEL, { phase: 'stop', agentType: run.agent, agentId: run.id, ...(run.output?.trim() ? { lastAssistantMessage: run.output.trim() } : {}) })
          pi.sendMessage({ customType: 'subagent-background', content: backgroundCompletionText(run), display: true }, { triggerTurn: true })
        } catch {
          // Session disposed after the run outlived it; nothing to notify.
        }
      }
      if (!worktree) {
        finish()
        return
      }
      // Cleanup only removes a pristine worktree; a kept one is reported in the
      // completion text so the parent knows where the changes live.
      const keptWorktree = worktree
      void cleanupAgentWorktree(runCwd, keptWorktree)
        .then((outcome) => {
          if (outcome === 'kept') run.output = `${run.output ?? ''}\n[isolation: worktree kept at ${keptWorktree.dir} (branch ${keptWorktree.branch}); the agent's changes live there]`.trim()
        })
        .catch(() => {})
        .finally(finish)
    },
    presetId,
  )
  if (id === null) {
    // Lost the cap race to a parallel batch: the atomic check inside startBackgroundRun refused.
    removeTmpPrompt(tmpPrompt)
    return backgroundCapResult(makeDetails)
  }
  pi.events.emit(SUBAGENT_CHANNEL, { phase: 'start', agentType: agent.name, agentId: id })
  return {
    content: [{ type: 'text', text: `Started background run ${id} (${agent.name}). A notification will arrive on completion; check progress with {status: true}.` }],
    details: makeDetails('single')([]),
  }
}

async function runChainMode(chain: ChainStepParam[], mode: ModeContext): Promise<ToolResult> {
  const { agents, defaultCwd, signal, onUpdate, makeDetails } = mode
  const results: SingleResult[] = []
  let previousOutput = ''

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]
    // Function replacement: a string here would interpret $-patterns in the output.
    const taskWithContext = step.task.replaceAll('{previous}', () => previousOutput)

    // Create update callback that includes all previous results
    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          // Combine completed results with current streaming result
          const currentResult = partial.details?.results[0]
          if (currentResult) {
            const allResults = [...results, currentResult]
            onUpdate({
              content: partial.content,
              details: makeDetails('chain')(allResults),
            })
          }
        }
      : undefined

    const result = await runSingleAgent({
      defaultCwd,
      agents,
      agentName: step.agent,
      task: taskWithContext,
      cwd: step.cwd,
      step: i + 1,
      signal,
      onUpdate: chainUpdate,
      makeDetails: makeDetails('chain'),
      onPhase: mode.onPhase,
      skillRoots: mode.skillRoots,
      availableModels: mode.availableModels,
      projectApproved: mode.projectApproved,
    })
    results.push(result)

    const isError = result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted'
    if (isError) {
      const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)'
      return {
        content: [{ type: 'text', text: capForContext(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`) }],
        details: makeDetails('chain')(results),
      }
    }
    previousOutput = capForContext(getFinalOutput(result.messages))
  }
  return {
    content: [{ type: 'text', text: capForContext(getFinalOutput(results.at(-1)?.messages ?? [])) || '(no output)' }],
    details: makeDetails('chain')(results),
  }
}

async function runParallelMode(tasks: TaskItemParam[], mode: ModeContext): Promise<ToolResult> {
  const { agents, defaultCwd, signal, onUpdate, makeDetails } = mode
  if (tasks.length > MAX_PARALLEL_TASKS)
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: makeDetails('parallel')([]),
    }

  // Track all results for streaming updates
  const allResults: SingleResult[] = new Array(tasks.length)

  // Initialize placeholder results
  for (let i = 0; i < tasks.length; i++) {
    allResults[i] = {
      agent: tasks[i].agent,
      agentSource: 'unknown',
      task: tasks[i].task,
      exitCode: -1, // -1 = still running
      messages: [],
      stderr: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    }
  }

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length
      const done = allResults.filter((r) => r.exitCode !== -1).length
      onUpdate({
        content: [{ type: 'text', text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
        details: makeDetails('parallel')([...allResults]),
      })
    }
  }

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent({
      defaultCwd,
      agents,
      agentName: t.agent,
      task: t.task,
      cwd: t.cwd,
      signal,
      onPhase: mode.onPhase,
      // Same context single and chain mode pass: without these, an agent's skills
      // preload and its model tier alias silently do nothing in parallel mode only.
      skillRoots: mode.skillRoots,
      availableModels: mode.availableModels,
      projectApproved: mode.projectApproved,
      // Per-task update callback
      onUpdate: (partial) => {
        const live = partial.details?.results[0]
        if (live) {
          // Keep the running sentinel until the child closes: the streamed result carries
          // exitCode 0 mid-run, which would otherwise count and render the task as done.
          allResults[index] = { ...live, exitCode: -1 }
          emitParallelUpdate()
        }
      },
      makeDetails: makeDetails('parallel'),
    })
    allResults[index] = result
    emitParallelUpdate()
    return result
  })

  const successCount = results.filter((r) => r.exitCode === 0).length
  const summaries = results.map((r) => {
    const output = getFinalOutput(r.messages)
    const status = r.exitCode === 0 ? 'completed' : 'failed'
    return `[${r.agent}] ${status}: ${output || '(no output)'}`
  })
  return {
    content: [
      {
        type: 'text',
        // Full reports, so a fan-out can be synthesized from; capped at pi's tool-output budget.
        text: capForContext(`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n')}`),
      },
    ],
    details: makeDetails('parallel')(results),
  }
}

async function runSingleMode(agentName: string, task: string, cwd: string | undefined, mode: ModeContext): Promise<ToolResult> {
  const { agents, defaultCwd, signal, onUpdate, makeDetails } = mode
  const result = await runSingleAgent({
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    signal,
    onUpdate,
    makeDetails: makeDetails('single'),
    onPhase: mode.onPhase,
    skillRoots: mode.skillRoots,
    availableModels: mode.availableModels,
    projectApproved: mode.projectApproved,
  })
  const isError = result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted'
  if (isError) {
    const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)'
    return {
      content: [{ type: 'text', text: capForContext(`Agent ${result.stopReason || 'failed'}: ${errorMsg}`) }],
      details: makeDetails('single')([result]),
    }
  }
  return {
    content: [{ type: 'text', text: capForContext(getFinalOutput(result.messages)) || '(no output)' }],
    details: makeDetails('single')([result]),
  }
}

export default function subagentExtension(pi: ExtensionAPI) {
  // Claude's mcp__<server> tool patterns translate against the parent's MCP roster,
  // published by the mcp extension on the shared bus. Optional-chained so a minimal
  // test stub without an event bus can still register the extension.
  pi.events?.on(MCP_TOOLS_CHANNEL, (data) => {
    if (isMcpToolAliases(data)) setKnownMcpAliases(data)
  })

  const notifyBackgroundCompletion = (run: { id: string; agent: string; state: string; turns: number; output?: string; stderr?: string }): void => {
    // Runs through driveRun's guard, same as the background-mode callback above.
    // The stop event fires here too, so SubagentStop hooks see resumed runs end.
    pi.events.emit(SUBAGENT_CHANNEL, { phase: 'stop', agentType: run.agent, agentId: run.id })
    pi.sendMessage({ customType: 'subagent-background', content: backgroundCompletionText(run), display: true }, { triggerTurn: true })
  }

  // Claude's experimental `type: "agent"` hooks spawn a read-only subagent to verify a
  // condition. The hooks extension reaches it through the agent-run seam; register a
  // runner that reuses the same single-run machinery as the subagent tool. cwd and the
  // available model list are captured per session so a hook run lands in the right repo.
  let hookCwd = process.cwd()
  let hookModels: ReadonlyArray<{ id: string }> = []
  // Captured per session like cwd: a named agent resolved for a fork skill or an agent
  // hook must respect project trust the way the tool path does, or an unapproved repo's
  // .claude/agents entry (which wins a name clash) would run on its own say-so.
  let hookAgentScope: AgentScope = 'user'

  // Discovery walks the plugin cache, the builtin dir, and every agent dir, parsing
  // each file: dozens of fs ops per call. The roster injection below runs every turn
  // for a list that almost never changes mid-session, so it reuses one discovery per
  // (cwd, scope), dropped on session_start. The tool's execute() keeps rediscovering
  // per invocation, so a just-added agent is still runnable without a restart.
  let rosterCache: { key: string; agents: AgentConfig[] } | null = null

  pi.on('session_start', async (_event, ctx) => {
    rosterCache = null
    hookCwd = ctx.cwd
    hookAgentScope = isProjectApprovedSilently(ctx) ? 'both' : 'user'
    try {
      hookModels = ctx.modelRegistry?.getAvailable?.() ?? []
    } catch {
      hookModels = []
    }
    setAgentRunner(async (request) => {
      // A subagent session must not spawn further agents; agent hooks inside one are
      // skipped (the seam rejection is non-blocking in runAgentHook).
      if (process.env.PI_CODE_SUBAGENT) throw new Error('agent hooks do not run inside a subagent')
      // A context: fork skill names its agent, or runs with the full toolset;
      // agent hooks keep the read-only hook shape.
      const named = request.agent ? discoverAgents(hookCwd, hookAgentScope).agents.find((a) => a.name === request.agent) : undefined
      const agent = named ?? (request.fullTools ? forkAgent(request) : buildHookAgent(request))
      const result = await runSingleAgent({
        defaultCwd: hookCwd,
        agents: [agent],
        agentName: agent.name,
        task: request.prompt,
        signal: request.signal,
        makeDetails: (results): SubagentDetails => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }),
        availableModels: hookModels,
      })
      return getFinalOutput(result.messages)
    })
  })

  pi.on('session_shutdown', (event, ctx) => {
    // On quit pi is exiting, so a detached background child would keep running (and
    // spending tokens) with its completion swallowed: SIGTERM every live run, killing the
    // process group the way a cancel does. On a same-process session switch
    // (new/resume/fork) the children keep running under the new session, so leave them be
    // and warn once that they are still spending; /tasks inspects them. reload re-imports
    // this module (losing the registry), so it neither kills nor warns.
    if (event.reason === 'quit') {
      cancelAllBackgroundRuns()
      return
    }
    if (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork') {
      const active = activeBackgroundRuns()
      if (active > 0) ctx.ui?.notify(`${active} background run${active === 1 ? '' : 's'} still active; /tasks to inspect`, 'warning')
    }
  })

  // Claude surfaces each agent's description so the model can pick one autonomously.
  // Served from the session-level cache above (keyed on cwd and scope, so an approval
  // granted mid-session still widens it); project agents are included only when the
  // project is already approved, read without prompting, since a trust dialog must
  // not appear mid-turn and their descriptions are project text.
  pi.on('before_agent_start', async (event, ctx) => {
    const scope: AgentScope = isProjectApprovedSilently(ctx) ? 'both' : 'user'
    const key = `${scope}\n${ctx.cwd}`
    if (rosterCache?.key !== key) rosterCache = { key, agents: discoverAgents(ctx.cwd, scope).agents }
    const { agents } = rosterCache
    if (agents.length === 0) return
    const line = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200)
    const roster = agents.map((agent) => `- ${agent.name} (${agent.source}): ${line(agent.description)}`).join('\n')
    return { systemPrompt: `${event.systemPrompt}\n\n## Subagents\n\nDelegate isolated tasks with the subagent tool ({agent, task}). Available agents:\n${roster}` }
  })

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate tasks to specialized subagents with isolated context.',
      'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
      'Single mode also supports background: true for long tasks; a notification arrives on completion and {status: true} lists runs.',
      'Agents come from ~/.claude/agents and ~/.pi/agent/agents, plus project .claude/agents and .pi/agents once the project is trusted.',
      'agentScope: "user" or "project" narrows to one source.',
    ].join(' '),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Claude merges project agents into the default roster (project wins on a name
      // clash), and the roster above advertises them under the same approval check,
      // so a default call can reach every agent it lists. An explicit agentScope
      // still narrows or widens; the invocation gate below applies either way.
      const agentScope: AgentScope = params.agentScope ?? (isProjectApprovedSilently(ctx) ? 'both' : 'user')
      // Children carry PI_CODE_SUBAGENT; without this check they could spawn
      // grandchildren without limit.
      if (process.env.PI_CODE_SUBAGENT) {
        return {
          content: [{ type: 'text', text: 'Nested subagent runs are not allowed: this session is already a subagent.' }],
          details: { mode: 'single', agentScope, projectAgentsDir: null, results: [] },
        }
      }
      const discovery = discoverAgents(ctx.cwd, agentScope)
      const agents = discovery.agents

      const hasChain = (params.chain?.length ?? 0) > 0
      const hasTasks = (params.tasks?.length ?? 0) > 0
      const hasSingle = Boolean(params.agent && params.task)
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle)

      const makeDetails =
        (mode: 'single' | 'parallel' | 'chain') =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        })

      if (params.resume) {
        const onResumed = (run: { id: string; agent: string }): void => {
          pi.events.emit(SUBAGENT_CHANNEL, { phase: 'start', agentType: run.agent, agentId: run.id })
        }
        return { content: [{ type: 'text', text: resumeResultText(params.resume, params.task, notifyBackgroundCompletion, onResumed) }], details: makeDetails('single')([]) }
      }

      if (params.cancel) {
        return { content: [{ type: 'text', text: cancelResultText(params.cancel) }], details: makeDetails('single')([]) }
      }

      if (params.status) {
        return { content: [{ type: 'text', text: backgroundStatusText() }], details: makeDetails('single')([]) }
      }

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none'
        return {
          content: [
            {
              type: 'text',
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails('single')([]),
        }
      }

      // Gate repo-controlled project agents before any run (background included).
      let gateMode: SubagentMode = 'single'
      if (hasChain) gateMode = 'chain'
      else if (hasTasks) gateMode = 'parallel'
      const gateResult = await checkProjectAgentGate(params, agents, ctx, discovery.projectAgentsDir, gateMode, makeDetails)
      if (gateResult) return gateResult

      // Project skills only preload and project/local agent memory stores only load
      // once the project is approved, matching the gate the skills extension applies
      // to discovery itself. Read after the project-agent gate above so an approval
      // the user just granted there counts.
      const projectApproved = isProjectApprovedSilently(ctx)
      const skillRoots = skillDirs(ctx.cwd, os.homedir(), projectApproved)
      // Tier aliases resolve against what this user is authenticated for; an
      // unavailable tier still falls back to the session model.
      const availableModels = ctx.modelRegistry?.getAvailable?.() ?? []

      if (wantsBackground(params, agents)) return runBackgroundMode(params, { agents, defaultCwd: ctx.cwd, pi, makeDetails, skillRoots, availableModels, projectApproved })

      const mode: ModeContext = {
        agents,
        defaultCwd: ctx.cwd,
        signal,
        onUpdate,
        makeDetails,
        skillRoots,
        availableModels,
        projectApproved,
        onPhase: (phase, agentType, agentId, lastAssistantMessage) => pi.events.emit(SUBAGENT_CHANNEL, { phase, agentType, agentId, ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }) }),
      }

      if (params.chain?.length) return runChainMode(params.chain, mode)
      if (params.tasks?.length) return runParallelMode(params.tasks, mode)
      if (params.agent && params.task) return runSingleMode(params.agent, params.task, params.cwd, mode)

      const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none'
      return {
        content: [{ type: 'text', text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails('single')([]),
      }
    },

    renderCall(args, theme, _context) {
      // No tag when the call left the scope to the contextual default: the label
      // cannot know here whether that resolved to user or both.
      const scope = args.agentScope
      if (args.chain && args.chain.length > 0) return renderChainCall(args.chain, scope, theme)
      if (args.tasks && args.tasks.length > 0) return renderParallelCall(args.tasks, scope, theme)
      return renderSingleCall(args.agent, args.task, scope, theme)
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined
      if (!details || details.results.length === 0) {
        const text = result.content[0]
        return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
      }

      const mdTheme = getMarkdownTheme()

      if (details.mode === 'single' && details.results.length === 1) return renderSingleResult(details.results[0], expanded, theme, mdTheme)
      if (details.mode === 'chain') return renderChainResult(details.results, expanded, theme, mdTheme)
      if (details.mode === 'parallel') return renderParallelResult(details.results, expanded, theme, mdTheme)

      const text = result.content[0]
      return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
    },
  })

  // Claude's /tasks: background-run status at a glance, returning immediately without
  // interrupting the agent; the only other way to see these is to ask the model.
  pi.registerCommand('tasks', {
    description: 'Show background subagent runs',
    handler: async (_args, ctx) => {
      ctx.ui.notify(tasksStatusText(allBackgroundRuns()), 'info')
    },
  })

  // Claude's /agents: the discovered roster with sources and paths. Approval is read
  // silently, like the roster above: project agents list only once the project is trusted.
  pi.registerCommand('agents', {
    description: 'List discovered subagents and where they come from',
    handler: async (_args, ctx) => {
      const { agents } = discoverAgents(ctx.cwd, isProjectApprovedSilently(ctx) ? 'both' : 'user')
      ctx.ui.notify(agentsListText(agents), 'info')
    },
  })
}
