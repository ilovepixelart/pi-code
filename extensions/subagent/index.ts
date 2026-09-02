/**
 * Subagent tool: delegate a task to a named agent running in its own `pi` process,
 * so it gets an isolated context window.
 *
 * This file is the entry point only: the tool schema, the dispatch between single,
 * parallel, chain and background, and the session hooks. The work lives beside it,
 * one concern per module:
 *   agents.ts        discovery and frontmatter
 *   child.ts         how a child is configured before it is spawned
 *   run.ts           spawning one child and parsing its JSON event stream
 *   modes.ts         the four ways a request runs, and the project-agent gate
 *   background.ts    detached runs, /tasks state, resume and cancel
 *   params.ts        the tool schema and the types derived from it
 *   registry-text.ts the text /tasks, /agents and completion notices read out
 *   render.ts        transcript formatting shared with the parent
 *   render-result.ts how a call and its results are drawn
 *
 * Names the tests reach for are re-exported below, so the public surface is this file
 * regardless of which module owns them.
 */
import * as os from 'node:os'
import { type ExtensionAPI, getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { setAgentRunner } from '../internal/agent-run.js'
import { isMcpToolAliases, MCP_TOOLS_CHANNEL } from '../internal/mcp-alias.js'
import { isProjectApprovedSilently } from '../internal/project-approval.js'
import { SUBAGENT_CHANNEL } from '../internal/subagent-events.js'
import { skillDirs } from '../skills.js'
import { type AgentConfig, type AgentScope, discoverAgents } from './agents.js'
import { activeBackgroundRuns, allBackgroundRuns, backgroundStatusText, cancelAllBackgroundRuns } from './background.js'
import { buildHookAgent, forkAgent, setKnownMcpAliases } from './child.js'
import { checkProjectAgentGate, type ModeContext, runBackgroundMode, runChainMode, runParallelMode, runSingleMode, wantsBackground } from './modes.js'
import { type SubagentMode, SubagentParams } from './params.js'
import { agentsListText, backgroundCompletionText, cancelResultText, resumeResultText, tasksStatusText } from './registry-text.js'
import { getFinalOutput } from './render.js'
import { renderChainCall, renderChainResult, renderParallelCall, renderParallelResult, renderSingleCall, renderSingleResult } from './render-result.js'
import { runSingleAgent } from './run.js'
import type { SingleResult, SubagentDetails } from './types.js'

export { AGENT_HOOK_SYSTEM, agentMemoryDir, agentMemorySection, buildHookAgent, setKnownMcpAliases, withMemoryTools } from './child.js'
export { mapWithConcurrencyLimit } from './concurrency.js'
export { projectAgentGate } from './modes.js'
export { agentsListText, backgroundCompletionText, cancelResultText, resumeResultText, tasksStatusText } from './registry-text.js'
// Re-exported so the render formatters stay importable from the subagent entry point,
// where the tests and the tool itself have always reached for them.
export { formatTokens, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput } from './render.js'
export { getPiInvocation } from './run.js'

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
