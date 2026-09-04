/**
 * The four ways the subagent tool runs a request: single, chain, parallel and
 * background, plus the project-agent gate every one of them passes first.
 *
 * Each returns a finished tool result; the extension entry point only picks which.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { capForContext } from '../internal/output-guard.js'
import { isProjectApproved } from '../internal/project-approval.js'
import { SUBAGENT_CHANNEL } from '../internal/subagent-events.js'
import { runSubagentStartHooks } from '../internal/subagent-hooks.js'
import { type AgentConfig, resolveModelAlias } from './agents.js'
import { activeBackgroundRuns, MAX_BACKGROUND_RUNS, startBackgroundRun } from './background.js'
import { agentHooksEnv, agentInvocationArgs, agentMemoryPromptSection, childPromptBody, taskWithStartContext, unresolvedToolsError, withMemoryTools } from './child.js'
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, mapWithConcurrencyLimit } from './concurrency.js'
import type { ChainStepParam, MakeDetails, SubagentMode, SubagentParamsStatic, TaskItemParam, ToolResult } from './params.js'
import { backgroundCompletionText } from './registry-text.js'
import { getFinalOutput } from './render.js'
import { getPiInvocation, type OnUpdateCallback, runSingleAgent, type SubagentPhaseSink, writePromptToTempFile } from './run.js'
import type { SingleResult } from './types.js'
import { type AgentWorktree, cleanupAgentWorktree, createAgentWorktree } from './worktree.js'

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

/** Everything a mode handler needs from the surrounding execute() call. */
export interface ModeContext {
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

export async function checkProjectAgentGate(params: SubagentParamsStatic, agents: AgentConfig[], ctx: ExtensionContext, projectAgentsDir: string | null, gateMode: SubagentMode, makeDetails: MakeDetails): Promise<ToolResult | null> {
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
export function wantsBackground(params: { background?: boolean; agent?: string }, agents: AgentConfig[]): boolean {
  if (params.background) return true
  return params.agent !== undefined && agents.find((a) => a.name === params.agent)?.background === true
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
export interface BackgroundContext {
  agents: AgentConfig[]
  defaultCwd: string
  pi: ExtensionAPI
  makeDetails: MakeDetails
  skillRoots: string[]
  availableModels: ReadonlyArray<{ id: string }>
  projectApproved: boolean
}

export async function runBackgroundMode(params: SubagentParamsStatic, context: BackgroundContext): Promise<ToolResult> {
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
  // The same isolation boundary as the foreground path: no worktree, no run. Created
  // after the temp prompt, so a prompt write that throws has nothing to leak; the cap
  // refusal below removes it again.
  let worktree: AgentWorktree | undefined
  if (agent.isolation === 'worktree') {
    const created = await createAgentWorktree(runCwd, agent.name)
    if ('error' in created) {
      removeTmpPrompt(tmpPrompt)
      return {
        content: [{ type: 'text', text: `isolation: worktree could not be created for ${agent.name}: ${created.error}` }],
        details: makeDetails('single')([]),
      }
    }
    worktree = created
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
    // Lost the cap race to a parallel batch: the atomic check inside startBackgroundRun
    // refused. A pristine worktree is removed by the same cleanup a finished run uses.
    removeTmpPrompt(tmpPrompt)
    if (worktree) await cleanupAgentWorktree(runCwd, worktree).catch(() => {})
    return backgroundCapResult(makeDetails)
  }
  pi.events.emit(SUBAGENT_CHANNEL, { phase: 'start', agentType: agent.name, agentId: id })
  return {
    content: [{ type: 'text', text: `Started background run ${id} (${agent.name}). A notification will arrive on completion; check progress with {status: true}.` }],
    details: makeDetails('single')([]),
  }
}

export async function runChainMode(chain: ChainStepParam[], mode: ModeContext): Promise<ToolResult> {
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

export async function runParallelMode(tasks: TaskItemParam[], mode: ModeContext): Promise<ToolResult> {
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

export async function runSingleMode(agentName: string, task: string, cwd: string | undefined, mode: ModeContext): Promise<ToolResult> {
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
