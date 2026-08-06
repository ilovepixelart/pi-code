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
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, type Theme, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import { type Static, Type } from 'typebox'
import { capForContext } from '../internal/output-guard.js'
import { isProjectApproved, isProjectApprovedSilently } from '../internal/project-approval.js'
import { SUBAGENT_CHANNEL } from '../internal/subagent-events.js'
import { type AgentConfig, type AgentScope, discoverAgents } from './agents.js'
import { activeBackgroundRuns, backgroundStatusText, MAX_BACKGROUND_RUNS, startBackgroundRun } from './background.js'

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
const COLLAPSED_ITEM_COUNT = 10

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

export function formatUsageStats(
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    contextTokens?: number
    turns?: number
  },
  model?: string,
): string {
  const parts: string[] = []
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
  }
  if (model) parts.push(model)
  return parts.join(' ')
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: Theme['fg']): string {
  const shortenPath = (p: string) => {
    const home = os.homedir()
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p
  }

  switch (toolName) {
    case 'bash': {
      const command = (args.command as string) || '...'
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview)
    }
    case 'read': {
      const rawPath = (args.file_path || args.path || '...') as string
      const filePath = shortenPath(rawPath)
      const offset = args.offset as number | undefined
      const limit = args.limit as number | undefined
      let text = themeFg('accent', filePath)
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1
        const endLine = limit !== undefined ? startLine + limit - 1 : ''
        const rangeSuffix = endLine ? `-${endLine}` : ''
        text += themeFg('warning', `:${startLine}${rangeSuffix}`)
      }
      return themeFg('muted', 'read ') + text
    }
    case 'write': {
      const rawPath = (args.file_path || args.path || '...') as string
      const filePath = shortenPath(rawPath)
      const content = (args.content || '') as string
      const lines = content.split('\n').length
      let text = themeFg('muted', 'write ') + themeFg('accent', filePath)
      if (lines > 1) text += themeFg('dim', ` (${lines} lines)`)
      return text
    }
    case 'edit': {
      const rawPath = (args.file_path || args.path || '...') as string
      return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath))
    }
    case 'ls': {
      const rawPath = (args.path || '.') as string
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath))
    }
    case 'find': {
      const pattern = (args.pattern || '*') as string
      const rawPath = (args.path || '.') as string
      return themeFg('muted', 'find ') + themeFg('accent', pattern) + themeFg('dim', ` in ${shortenPath(rawPath)}`)
    }
    case 'grep': {
      const pattern = (args.pattern || '') as string
      const rawPath = (args.path || '.') as string
      return themeFg('muted', 'grep ') + themeFg('accent', `/${pattern}/`) + themeFg('dim', ` in ${shortenPath(rawPath)}`)
    }
    default: {
      const argsStr = JSON.stringify(args)
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`)
    }
  }
}

interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

interface SingleResult {
  agent: string
  agentSource: 'user' | 'project' | 'builtin' | 'unknown'
  task: string
  exitCode: number
  messages: Message[]
  stderr: string
  usage: UsageStats
  model?: string
  stopReason?: string
  errorMessage?: string
  step?: number
}

interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain'
  agentScope: AgentScope
  projectAgentsDir: string | null
  results: SingleResult[]
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant') {
      // The complete text of the last assistant message: a message can carry more than one
      // text part, and taking only the first diverged from the background parser.
      const parts = msg.content.filter((part) => part.type === 'text').map((part) => part.text)
      if (parts.length > 0) return parts.join('\n')
    }
  }
  return ''
}

type DisplayItem = { type: 'text'; text: string } | { type: 'toolCall'; name: string; args: Record<string, unknown> }

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') items.push({ type: 'text', text: part.text })
        else if (part.type === 'toolCall') items.push({ type: 'toolCall', name: part.name, args: part.arguments })
      }
    }
  }
  return items
}

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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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
}

/** Publishes a child run's start/stop for the hooks extension's SubagentStart/Stop. */
type SubagentPhaseSink = (phase: 'start' | 'stop', agentType: string, agentId: string) => void

async function runSingleAgent(options: RunAgentOptions): Promise<SingleResult> {
  const agent = options.agents.find((a) => a.name === options.agentName)
  if (!agent) return runSingleAgentInner(options)
  const agentId = `fg-${randomUUID().slice(0, 8)}`
  options.onPhase?.('start', agent.name, agentId)
  try {
    return await runSingleAgentInner(options)
  } finally {
    options.onPhase?.('stop', agent.name, agentId)
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

  const args = agentInvocationArgs(agent)

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
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt)
      tmpPromptDir = tmp.dir
      tmpPromptPath = tmp.filePath
      args.push('--append-system-prompt', tmpPromptPath)
    }

    args.push(`Task: ${task}`)
    let wasAborted = false

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args)
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The marker lets the child's subagent tool refuse to nest further.
        env: { ...process.env, PI_CODE_SUBAGENT: '1' },
      })
      let buffer = ''

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
          if (msg.role === 'assistant') accumulateAssistantMessage(currentResult, msg)
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

      proc.on('error', () => {
        cleanup()
        resolve(1)
      })

      if (signal) {
        onAbort = () => {
          wasAborted = true
          proc.kill('SIGTERM')
          // proc.killed only reports that the signal was sent, not that the child died. Escalate
          // on a timer that the 'close' handler clears once the child has actually exited.
          killTimer = setTimeout(() => {
            try {
              proc.kill('SIGKILL')
            } catch {
              /* already gone */
            }
          }, 5000)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    currentResult.exitCode = exitCode
    if (wasAborted) throw new Error('Subagent was aborted')
    return currentResult
  } finally {
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

/** Everything a mode handler needs from the surrounding execute() call. */
interface ModeContext {
  agents: AgentConfig[]
  defaultCwd: string
  signal: AbortSignal | undefined
  onUpdate: OnUpdateCallback | undefined
  makeDetails: MakeDetails
  onPhase?: SubagentPhaseSink
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

/** CLI args shared by foreground and background children, from the agent's config. */
function agentInvocationArgs(agent: AgentConfig): string[] {
  const args: string[] = ['--mode', 'json', '-p', '--no-session']
  // pi reads a thinking level from the model pattern's :suffix, so Claude's effort
  // has a seam only when the agent pins a concrete model.
  if (agent.model) args.push('--model', agent.effort ? `${agent.model}:${agent.effort}` : agent.model)
  if (agent.tools && agent.tools.length > 0) args.push('--tools', agent.tools.join(','))
  if (agent.disallowedTools && agent.disallowedTools.length > 0) args.push('--exclude-tools', agent.disallowedTools.join(','))
  return args
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

async function runBackgroundMode(params: SubagentParamsStatic, agents: AgentConfig[], defaultCwd: string, pi: ExtensionAPI, makeDetails: MakeDetails): Promise<ToolResult> {
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
  if (activeBackgroundRuns() >= MAX_BACKGROUND_RUNS) {
    return backgroundCapResult(makeDetails)
  }
  const args = agentInvocationArgs(agent)
  let tmpPrompt: { dir: string; filePath: string } | undefined
  if (agent.systemPrompt.trim()) {
    tmpPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt)
    args.push('--append-system-prompt', tmpPrompt.filePath)
  }
  args.push(`Task: ${task}`)
  const invocation = getPiInvocation(args)
  const id = startBackgroundRun(agent.name, task, { command: invocation.command, args: invocation.args, cwd: params.cwd ?? defaultCwd }, (run) => {
    removeTmpPrompt(tmpPrompt)
    pi.events.emit(SUBAGENT_CHANNEL, { phase: 'stop', agentType: run.agent, agentId: run.id })
    const output = capForContext(run.output ?? '') || '(no output)'
    pi.sendMessage(
      {
        customType: 'subagent-background',
        content: `Background subagent run ${run.id} (${run.agent}) ${run.state} after ${run.turns} turns.\n\n${output}`,
        display: true,
      },
      { triggerTurn: true },
    )
  })
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

interface CallItem {
  agent: string
  task: string
}

function renderChainCall(chain: CallItem[], scope: AgentScope, theme: Theme): Text {
  let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', `chain (${chain.length} steps)`) + theme.fg('muted', ` [${scope}]`)
  for (let i = 0; i < Math.min(chain.length, 3); i++) {
    const step = chain[i]
    // Clean up {previous} placeholder for display
    const cleanTask = step.task.replaceAll('{previous}', '').trim()
    const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask
    const stepNumber = theme.fg('muted', `${i + 1}.`)
    const stepLabel = theme.fg('accent', step.agent) + theme.fg('dim', ` ${preview}`)
    text += `\n  ${stepNumber} ${stepLabel}`
  }
  if (chain.length > 3) {
    const more = theme.fg('muted', `... +${chain.length - 3} more`)
    text += `\n  ${more}`
  }
  return new Text(text, 0, 0)
}

function renderParallelCall(tasks: CallItem[], scope: AgentScope, theme: Theme): Text {
  let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', `parallel (${tasks.length} tasks)`) + theme.fg('muted', ` [${scope}]`)
  for (const t of tasks.slice(0, 3)) {
    const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task
    const taskLabel = theme.fg('accent', t.agent) + theme.fg('dim', ` ${preview}`)
    text += `\n  ${taskLabel}`
  }
  if (tasks.length > 3) {
    const more = theme.fg('muted', `... +${tasks.length - 3} more`)
    text += `\n  ${more}`
  }
  return new Text(text, 0, 0)
}

function renderSingleCall(agent: string | undefined, task: string | undefined, scope: AgentScope, theme: Theme): Text {
  const agentName = agent || '...'
  let preview = '...'
  if (task) preview = task.length > 60 ? `${task.slice(0, 60)}...` : task
  let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', agentName) + theme.fg('muted', ` [${scope}]`)
  text += `\n  ${theme.fg('dim', preview)}`
  return new Text(text, 0, 0)
}

type MarkdownTheme = ReturnType<typeof getMarkdownTheme>

function aggregateUsage(results: SingleResult[]) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
  for (const r of results) {
    total.input += r.usage.input
    total.output += r.usage.output
    total.cacheRead += r.usage.cacheRead
    total.cacheWrite += r.usage.cacheWrite
    total.cost += r.usage.cost
    total.turns += r.usage.turns
  }
  return total
}

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme, limit?: number): string {
  const toShow = limit ? items.slice(-limit) : items
  const skipped = limit && items.length > limit ? items.length - limit : 0
  let text = ''
  if (skipped > 0) text += theme.fg('muted', `... ${skipped} earlier items\n`)
  for (const item of toShow) {
    if (item.type === 'text') {
      const preview = expanded ? item.text : item.text.split('\n').slice(0, 3).join('\n')
      text += `${theme.fg('toolOutput', preview)}\n`
    } else {
      text += `${theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`
    }
  }
  return text.trimEnd()
}

function addToolCallNodes(container: Container, items: DisplayItem[], theme: Theme): void {
  for (const item of items) {
    if (item.type === 'toolCall') {
      container.addChild(new Text(theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0))
    }
  }
}

function addTotalUsage(container: Container, results: SingleResult[], theme: Theme): void {
  const usageStr = formatUsageStats(aggregateUsage(results))
  if (usageStr) {
    container.addChild(new Spacer(1))
    const totalLine = theme.fg('dim', `Total: ${usageStr}`)
    container.addChild(new Text(totalLine, 0, 0))
  }
}

function renderSingleExpanded(r: SingleResult, isError: boolean, icon: string, theme: Theme, mdTheme: MarkdownTheme): Container {
  const container = new Container()
  const source = theme.fg('muted', ` (${r.agentSource})`)
  let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${source}`
  if (isError && r.stopReason) {
    const reason = theme.fg('error', `[${r.stopReason}]`)
    header += ` ${reason}`
  }
  container.addChild(new Text(header, 0, 0))
  if (isError && r.errorMessage) container.addChild(new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0))
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0))
  container.addChild(new Text(theme.fg('dim', r.task), 0, 0))
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0))

  const displayItems = getDisplayItems(r.messages)
  const finalOutput = getFinalOutput(r.messages)
  if (displayItems.length === 0 && !finalOutput) {
    container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
  } else {
    addToolCallNodes(container, displayItems, theme)
    if (finalOutput) {
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
    }
  }

  const usageStr = formatUsageStats(r.usage, r.model)
  if (usageStr) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim', usageStr), 0, 0))
  }
  return container
}

function renderSingleCollapsed(r: SingleResult, isError: boolean, icon: string, theme: Theme, expanded: boolean): Text {
  const displayItems = getDisplayItems(r.messages)
  const source = theme.fg('muted', ` (${r.agentSource})`)
  let text = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${source}`
  if (isError && r.stopReason) {
    const reason = theme.fg('error', `[${r.stopReason}]`)
    text += ` ${reason}`
  }
  if (isError && r.errorMessage) {
    const errorLine = theme.fg('error', `Error: ${r.errorMessage}`)
    text += `\n${errorLine}`
  } else if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`
  else {
    text += `\n${renderDisplayItems(displayItems, expanded, theme, COLLAPSED_ITEM_COUNT)}`
    if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
  }
  const usageStr = formatUsageStats(r.usage, r.model)
  if (usageStr) text += `\n${theme.fg('dim', usageStr)}`
  return new Text(text, 0, 0)
}

function renderSingleResult(r: SingleResult, expanded: boolean, theme: Theme, mdTheme: MarkdownTheme): Container | Text {
  const isError = r.exitCode !== 0 || r.stopReason === 'error' || r.stopReason === 'aborted'
  const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
  if (expanded) return renderSingleExpanded(r, isError, icon, theme, mdTheme)
  return renderSingleCollapsed(r, isError, icon, theme, expanded)
}

function renderChainExpanded(results: SingleResult[], successCount: number, icon: string, theme: Theme, mdTheme: MarkdownTheme): Container {
  const container = new Container()
  const summary = theme.fg('accent', `${successCount}/${results.length} steps`)
  container.addChild(new Text(`${icon} ${theme.fg('toolTitle', theme.bold('chain '))}${summary}`, 0, 0))

  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const displayItems = getDisplayItems(r.messages)
    const finalOutput = getFinalOutput(r.messages)

    container.addChild(new Spacer(1))
    const stepLabel = theme.fg('muted', `─── Step ${r.step}: `) + theme.fg('accent', r.agent)
    container.addChild(new Text(`${stepLabel} ${rIcon}`, 0, 0))
    container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0))

    addToolCallNodes(container, displayItems, theme)

    if (finalOutput) {
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
    }

    const stepUsage = formatUsageStats(r.usage, r.model)
    if (stepUsage) container.addChild(new Text(theme.fg('dim', stepUsage), 0, 0))
  }

  addTotalUsage(container, results, theme)
  return container
}

function renderChainCollapsed(results: SingleResult[], successCount: number, icon: string, theme: Theme, expanded: boolean): Text {
  const summary = theme.fg('accent', `${successCount}/${results.length} steps`)
  let text = `${icon} ${theme.fg('toolTitle', theme.bold('chain '))}${summary}`
  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const displayItems = getDisplayItems(r.messages)
    const stepLabel = theme.fg('muted', `─── Step ${r.step}: `)
    text += `\n\n${stepLabel}${theme.fg('accent', r.agent)} ${rIcon}`
    if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`
    else text += `\n${renderDisplayItems(displayItems, expanded, theme, 5)}`
  }
  const usageStr = formatUsageStats(aggregateUsage(results))
  if (usageStr) {
    const totalLine = theme.fg('dim', `Total: ${usageStr}`)
    text += `\n\n${totalLine}`
  }
  text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
  return new Text(text, 0, 0)
}

function renderChainResult(results: SingleResult[], expanded: boolean, theme: Theme, mdTheme: MarkdownTheme): Container | Text {
  const successCount = results.filter((r) => r.exitCode === 0).length
  const icon = successCount === results.length ? theme.fg('success', '✓') : theme.fg('error', '✗')
  if (expanded) return renderChainExpanded(results, successCount, icon, theme, mdTheme)
  return renderChainCollapsed(results, successCount, icon, theme, expanded)
}

function renderParallelExpanded(results: SingleResult[], icon: string, status: string, theme: Theme, mdTheme: MarkdownTheme): Container {
  const container = new Container()
  const summary = theme.fg('accent', status)
  container.addChild(new Text(`${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${summary}`, 0, 0))

  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const displayItems = getDisplayItems(r.messages)
    const finalOutput = getFinalOutput(r.messages)

    container.addChild(new Spacer(1))
    const agentLabel = theme.fg('muted', '─── ') + theme.fg('accent', r.agent)
    container.addChild(new Text(`${agentLabel} ${rIcon}`, 0, 0))
    container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0))

    addToolCallNodes(container, displayItems, theme)

    if (finalOutput) {
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
    }

    const taskUsage = formatUsageStats(r.usage, r.model)
    if (taskUsage) container.addChild(new Text(theme.fg('dim', taskUsage), 0, 0))
  }

  addTotalUsage(container, results, theme)
  return container
}

function renderParallelCollapsed(results: SingleResult[], icon: string, status: string, theme: Theme, expanded: boolean, isRunning: boolean): Text {
  const summary = theme.fg('accent', status)
  let text = `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${summary}`
  for (const r of results) {
    let rIcon = theme.fg('error', '✗')
    if (r.exitCode === -1) rIcon = theme.fg('warning', '⏳')
    else if (r.exitCode === 0) rIcon = theme.fg('success', '✓')
    const displayItems = getDisplayItems(r.messages)
    text += `\n\n${theme.fg('muted', '─── ')}${theme.fg('accent', r.agent)} ${rIcon}`
    if (displayItems.length === 0) {
      const placeholder = r.exitCode === -1 ? '(running...)' : '(no output)'
      text += `\n${theme.fg('muted', placeholder)}`
    } else text += `\n${renderDisplayItems(displayItems, expanded, theme, 5)}`
  }
  if (!isRunning) {
    const usageStr = formatUsageStats(aggregateUsage(results))
    if (usageStr) {
      const totalLine = theme.fg('dim', `Total: ${usageStr}`)
      text += `\n\n${totalLine}`
    }
  }
  if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
  return new Text(text, 0, 0)
}

function renderParallelResult(results: SingleResult[], expanded: boolean, theme: Theme, mdTheme: MarkdownTheme): Container | Text {
  const running = results.filter((r) => r.exitCode === -1).length
  const successCount = results.filter((r) => r.exitCode === 0).length
  const failCount = results.filter((r) => r.exitCode > 0).length
  const isRunning = running > 0

  let icon = theme.fg('success', '✓')
  if (isRunning) icon = theme.fg('warning', '⏳')
  else if (failCount > 0) icon = theme.fg('warning', '◐')

  let status = `${successCount}/${results.length} tasks`
  if (isRunning) status = `${successCount + failCount}/${results.length} done, ${running} running`

  if (expanded && !isRunning) return renderParallelExpanded(results, icon, status, theme, mdTheme)
  return renderParallelCollapsed(results, icon, status, theme, expanded, isRunning)
}

export default function subagentExtension(pi: ExtensionAPI) {
  // Claude surfaces each agent's description so the model can pick one autonomously.
  // Rebuilt per turn (agents are rediscovered per invocation too); project agents are
  // included only when the project is already approved, read without prompting, since
  // a trust dialog must not appear mid-turn and their descriptions are project text.
  pi.on('before_agent_start', async (event, ctx) => {
    const scope = isProjectApprovedSilently(ctx) ? 'both' : 'user'
    const { agents } = discoverAgents(ctx.cwd, scope)
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
      'Default agent scope is "user" (from ~/.claude/agents and ~/.pi/agent/agents).',
      'To enable project-local agents in .claude/agents or .pi/agents, set agentScope: "both" (or "project").',
    ].join(' '),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? 'user'
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

      if (params.background) return runBackgroundMode(params, agents, ctx.cwd, pi, makeDetails)

      const mode: ModeContext = { agents, defaultCwd: ctx.cwd, signal, onUpdate, makeDetails, onPhase: (phase, agentType, agentId) => pi.events.emit(SUBAGENT_CHANNEL, { phase, agentType, agentId }) }

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
      const scope: AgentScope = args.agentScope ?? 'user'
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
}
