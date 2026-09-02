/**
 * Running one child agent: spawn a `pi` process, parse its JSON event stream back
 * into messages and usage, and tear the child down on abort or a maxTurns cap.
 *
 * The only place in the subagent extension that owns a process, a temp file or a
 * worktree; everything about how the child was configured lives in child.ts.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'

import { runSubagentStartHooks } from '../internal/subagent-hooks.js'
import { type AgentConfig, resolveModelAlias } from './agents.js'
import { agentHooksEnv, agentInvocationArgs, agentMemoryPromptSection, childPromptBody, taskWithStartContext, unresolvedToolsError, withMemoryTools } from './child.js'
import { getFinalOutput } from './render.js'
import type { SingleResult, SubagentDetails } from './types.js'
import { type AgentWorktree, cleanupAgentWorktree, createAgentWorktree } from './worktree.js'
export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
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

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void

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

export interface RunAgentOptions {
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
export type SubagentPhaseSink = (phase: 'start' | 'stop', agentType: string, agentId: string, lastAssistantMessage?: string) => void

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

export async function runSingleAgent(options: RunAgentOptions): Promise<SingleResult> {
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
