/**
 * How a child agent is configured before it is spawned: its system prompt, its own
 * memory store, the tools it resolves to, its CLI arguments and its hook environment.
 *
 * Separate from the runner so the shape of a child can be asserted without spawning
 * one, and from the extension body so the factory keeps only schema and dispatch.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { AgentRunRequest } from '../internal/agent-run.js'
import { claudeConfigDir } from '../internal/config-dir.js'
import { repoRoot } from '../internal/project-root.js'
import { autoMemoryEnabled, capIndexForPrompt, INDEX_MAX_BYTES, INDEX_MAX_LINES, memorySettingsFiles, readMemorySettings } from '../memory.js'
import { type AgentConfig, type AgentMemoryScope, expandMcpToolPatterns, withPreloadedSkills } from './agents.js'
/** The system prompt for Claude's experimental `type: "agent"` hooks: the subagent
 * inspects with read-only tools and returns the same JSON decision a command hook's
 * stdout carries. A hook-supplied `systemPrompt` is appended after it. */
export const AGENT_HOOK_SYSTEM = [
  'You are a Claude Code agent hook verifying whether an action should proceed.',
  'Use the Read, Grep, and Glob tools to inspect files as needed before deciding.',
  'When done, respond with ONLY a JSON object and nothing else:',
  '{"hookSpecificOutput":{"permissionDecision":"allow"|"deny"|"ask","permissionDecisionReason":"<short reason>"}}',
  'Use "allow" to let the action proceed, "deny" to block it, "ask" to require the user to confirm.',
].join('\n')

/** A throwaway agent config for one agent-hook run: read-only inspection tools, the
 * hook's model (a fast default when unset), and the decision-returning system prompt. */
/** The agent a context: fork skill runs as when it names none: full toolset, no
 * extra system prompt (the child keeps pi's default), the skill content as the
 * task. */
export function forkAgent(request: Pick<AgentRunRequest, 'model' | 'systemPrompt'>): AgentConfig {
  return {
    name: 'fork',
    description: 'forked skill run',
    systemPrompt: request.systemPrompt ?? '',
    ...(request.model ? { model: request.model } : {}),
    source: 'builtin',
    filePath: '',
  }
}

export function buildHookAgent(request: Pick<AgentRunRequest, 'model' | 'systemPrompt'>): AgentConfig {
  return {
    name: 'agent-hook',
    description: 'Verifies a hook condition using read-only inspection tools.',
    tools: ['read', 'grep', 'find'],
    model: request.model,
    systemPrompt: request.systemPrompt ? `${AGENT_HOOK_SYSTEM}\n\n${request.systemPrompt}` : AGENT_HOOK_SYSTEM,
    source: 'builtin',
    filePath: '',
  }
}

/** The file-management tools a memory-enabled child needs for its store. */
const MEMORY_TOOLS = ['read', 'write', 'edit']

/** Where an agent's own persistent memory lives, per its `memory:` scope (Claude:
 * user -> ~/.claude/agent-memory/<name>, project -> <root>/.claude/agent-memory/<name>,
 * local -> <root>/.claude/agent-memory-local/<name>). The name comes from frontmatter
 * a repository can control, so it is sanitized before becoming a path segment. */
export function agentMemoryDir(scope: AgentMemoryScope, name: string, cwd: string, home: string): string {
  const sanitized = name.replace(/[^\w.-]+/g, '_')
  // A name of only dots ('.', '..') survives the character filter but still traverses.
  const segment = /^\.+$/.test(sanitized) ? '_' : sanitized
  if (scope === 'user') return path.join(claudeConfigDir(home), 'agent-memory', segment)
  const root = repoRoot(cwd) ?? cwd
  return path.join(root, '.claude', scope === 'project' ? 'agent-memory' : 'agent-memory-local', segment)
}

/** The prompt section giving a memory-enabled child its own persistent store: the
 * directory, read/write/curation instructions, and its MEMORY.md capped like the
 * parent's index load (first 200 lines or 25KB, whichever comes first). */
export function agentMemorySection(dir: string, memoryMd: string): string {
  const indexPath = path.join(dir, 'MEMORY.md')
  const capped = capIndexForPrompt(memoryMd)
  const current = capped.trim() ? `Current ${indexPath}:\n\n${capped}` : `${indexPath} does not exist yet; create it once you have something worth keeping.`
  return [
    '## Agent memory',
    '',
    `You have a persistent memory directory at ${dir} that survives across sessions.`,
    'Use the read, write, and edit tools to record durable insights, project patterns, and lessons learned there, and consult them when relevant.',
    `Only the first ${INDEX_MAX_LINES} lines or ${INDEX_MAX_BYTES} bytes of ${indexPath} are loaded at startup, so keep it a concise, curated index and move details into separate files in the directory.`,
    '',
    current,
  ].join('\n')
}

/** The memory section for one run, or undefined when the agent declares no memory,
 * auto memory is off, or a repo-scoped store is not approved. Subagent memory is part
 * of auto memory, so the same settings chain and env kill switch gate it. */
export function agentMemoryPromptSection(agent: Pick<AgentConfig, 'memory' | 'name'>, cwd: string, projectApproved: boolean): string | undefined {
  if (!agent.memory) return undefined
  // project and local stores live under the repository's .claude, a repo-controlled
  // path; like rules, they are only read once the project is approved.
  if (agent.memory !== 'user' && !projectApproved) return undefined
  const settings = readMemorySettings(memorySettingsFiles(cwd, os.homedir(), projectApproved))
  if (!autoMemoryEnabled(settings.autoMemoryEnabled, process.env)) return undefined
  const dir = agentMemoryDir(agent.memory, agent.name, cwd, os.homedir())
  let memoryMd = ''
  try {
    memoryMd = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8')
  } catch {
    // no store yet: the section still tells the child where to create one
  }
  return agentMemorySection(dir, memoryMd)
}

/** Widen a restricted agent's allowlist so it can manage its memory files. An
 * unrestricted agent (no allowlist) already has every tool. */
export function withMemoryTools(tools: string[] | undefined): string[] | undefined {
  if (!tools || tools.length === 0) return tools
  return [...tools, ...MEMORY_TOOLS.filter((tool) => !tools.includes(tool))]
}

/** The child's --append-system-prompt body: the skills-preloaded prompt plus the
 * agent memory section, without a stray separator when either part is empty. */
export function childPromptBody(agent: AgentConfig, skillRoots: string[], memorySection: string | undefined): string {
  const prompt = withPreloadedSkills(agent.systemPrompt, agent.skills, skillRoots)
  if (!memorySection) return prompt
  return [prompt, memorySection].filter((part) => part.trim()).join('\n\n')
}

/** The parent's MCP tool aliases, published by the mcp extension on the shared bus;
 * the module-level seam matches setMcpToolCaller's. Children read the same MCP config
 * files, so the parent's roster is the translation table for server-level patterns. */
let knownMcpAliases: ReadonlyArray<{ pi: string; claude: string }> = []

export function setKnownMcpAliases(aliases: ReadonlyArray<{ pi: string; claude: string }>): void {
  knownMcpAliases = aliases
}

/** pi's built-in ToolName union (core/tools/index.d.ts; the package's export map
 * does not expose allToolNames, so this mirrors it) plus the tools pi-code's own
 * extensions register in a child. Claude's capitalized spellings fold onto these. */
const CHILD_TOOL_NAMES = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_fetch', 'web_search', 'list_mcp_resources', 'read_mcp_resource', 'todo', 'question', 'memory', 'slash_command', 'plan_mode_complete'])

/** Claude: when no entry in a `tools` list resolves to a tool, the subagent fails
 * to launch with an error naming the entries, instead of running tool-less. */
export function unresolvedToolsError(agent: AgentConfig): string | undefined {
  if (!agent.tools || agent.tools.length === 0) return undefined
  const fold = (name: string): string => name.toLowerCase().replaceAll('-', '_')
  const known = new Set(knownMcpAliases.map((alias) => fold(alias.pi)))
  const resolves = expandMcpToolPatterns(agent.tools, knownMcpAliases).some((entry) => CHILD_TOOL_NAMES.has(fold(entry)) || known.has(fold(entry)))
  if (resolves) return undefined
  return `Agent "${agent.name}" would launch with zero tools: no entry in [${agent.tools.join(', ')}] resolves to a tool.`
}

/** CLI args shared by foreground and background children, from the agent's config. */
export function agentInvocationArgs(agent: AgentConfig, aliasModel?: string): string[] {
  const args: string[] = ['--mode', 'json', '-p', '--no-session']
  // A concrete model wins; otherwise a Claude tier alias resolved against the models
  // this user can actually run; then CLAUDE_CODE_SUBAGENT_MODEL, per Claude's model
  // order (invocation model, frontmatter model, this variable, the session model).
  // pi reads a thinking level from the model pattern's :suffix when a model is
  // pinned, and from --thinking otherwise.
  // Claude exempts the two built-ins from the environment variable: "Setting
  // CLAUDE_CODE_SUBAGENT_MODEL by itself doesn't change the model the built-in Explore and
  // Plan subagents run on." A model they name themselves, or one the invocation names,
  // still applies.
  const exemptFromEnvModel = agent.source === 'builtin' && (agent.name === 'Explore' || agent.name === 'Plan')
  const model = agent.model ?? aliasModel ?? (exemptFromEnvModel ? undefined : process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  if (model) args.push('--model', agent.effort ? `${model}:${agent.effort}` : model)
  else if (agent.effort) args.push('--thinking', agent.effort)
  // Claude's mcp__<server> / mcp__* patterns expand against the parent's MCP roster;
  // without this a server-level deny removed nothing (fail open) and a server-level
  // grant granted nothing.
  if (agent.tools && agent.tools.length > 0) args.push('--tools', expandMcpToolPatterns(agent.tools, knownMcpAliases).join(','))
  if (agent.disallowedTools && agent.disallowedTools.length > 0) args.push('--exclude-tools', expandMcpToolPatterns(agent.disallowedTools, knownMcpAliases).join(','))
  // Claude: "Explore and Plan are the only subagents that omit CLAUDE.md" (and no
  // field or setting changes which agents skip them), to keep research fast.
  if (agent.source === 'builtin' && (agent.name === 'Explore' || agent.name === 'Plan')) args.push('--no-context-files')
  return args
}

/** Claude's agent-frontmatter hooks ride to the child as env; the child's hooks
 * extension merges them for the run only (they die with the process, matching
 * "only while that subagent is running"). Stop converts to SubagentStop, the
 * event the child fires when it completes, as Claude documents. */
export function agentHooksEnv(agent: AgentConfig, agentId: string): Record<string, string> {
  if (!agent.hooks) return {}
  const hooks: Record<string, unknown> = { ...agent.hooks }
  const stop = hooks.Stop
  delete hooks.Stop
  if (Array.isArray(stop)) hooks.SubagentStop = [...(Array.isArray(hooks.SubagentStop) ? (hooks.SubagentStop as unknown[]) : []), ...stop]
  return { PI_CODE_AGENT_HOOKS: JSON.stringify({ agent: agent.name, id: agentId, hooks }) }
}
