/**
 * Agent discovery and configuration
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAgentDir, parseFrontmatter, stripFrontmatter } from '@earendil-works/pi-coding-agent'
// The same mapping a command's `allowed-tools` gets: an agent's `tools:` is the same
// Claude field, and `--tools` is an exact-name allowlist, so a name pi has no tool for
// is not merely ignored, it narrows the child's registry.
import { parseToolGrants } from '../internal/command-file.js'
import { claudeConfigDir } from '../internal/config-dir.js'
import { findModel } from '../internal/model-lookup.js'
import { installedPlugins, pluginComponentPath } from '../internal/plugins.js'
import { ancestorDirs, findNearestDir } from '../internal/project-root.js'
import { errorMessage } from '../internal/values.js'

/**
 * `tools:` may be a comma-separated string (the Claude Code format) or a YAML block
 * list. Anything else returns null: a restriction that failed to parse must not run
 * the agent unrestricted.
 *
 * An argument-scoped grant (`Bash(git log:*)`) cannot be expressed in the child's
 * --tools allowlist, and the parent cannot reach into the child process to enforce
 * it at call time the way commands.ts does, so on the granting side it is rejected
 * like any other unexpressable restriction. A scoped *disallow* only denies more
 * than the file asked for, which is the safe direction, so it stands.
 */
function parseToolsField(raw: unknown, granting: boolean): string[] | undefined | null {
  if (raw === undefined) return undefined
  // Shares the command parser's splitting, so a comma inside an argument scope stays
  // inside it here too: split naively, `Bash(mv, write, cp)` grants the child pi's real `write`.
  if (raw !== null && !Array.isArray(raw) && typeof raw !== 'string') return null
  if (Array.isArray(raw) && raw.some((item) => typeof item !== 'string')) return null
  const grants = parseToolGrants(raw)
  if (!grants) return null
  if (granting && grants.scopedEntries.length > 0) return null
  return grants.tools.length > 0 ? grants.tools : undefined
}

/**
 * Claude Code model aliases name Anthropic tiers. pi's resolver would partial-match
 * one against an authenticated Anthropic provider, but for every other setup the
 * child exits at boot on an unresolvable --model. Running on the session model
 * (Claude's `inherit`) is the degradation that works everywhere; users who want a
 * tier pinned should name a concrete model id.
 */
const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit'])

function parseModelField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const model = raw.trim()
  return model && !CLAUDE_MODEL_ALIASES.has(model.toLowerCase()) ? model : undefined
}

/** The tier alias an agent asked for, kept so it can be resolved against the models
 * this user is actually authenticated for. `inherit` is not a tier: it means the
 * session model, which is also the fallback when a tier is unavailable. */
function parseModelAlias(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const alias = raw.trim().toLowerCase()
  return alias !== 'inherit' && CLAUDE_MODEL_ALIASES.has(alias) ? alias : undefined
}

/** Resolve a Claude tier alias to a concrete model id the user can actually run.
 * Returning undefined leaves the child on the session model, which is what the
 * unresolvable case degraded to before and still does. */
export function resolveModelAlias(alias: string | undefined, available: ReadonlyArray<{ id: string; name?: string; provider?: string }>): string | undefined {
  if (!alias || alias === 'inherit') return undefined
  return findModel(alias, available)?.id
}

/** pi's extended thinking levels; Claude's effort values are a subset, so they map 1:1. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function parseEffortField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const effort = raw.trim().toLowerCase()
  return THINKING_LEVELS.has(effort) ? effort : undefined
}

/** Claude's agent `memory:` scopes: a persistent per-agent store for cross-session
 * learning, separate from the parent conversation's auto memory. */
export type AgentMemoryScope = 'user' | 'project' | 'local'

const MEMORY_SCOPES: ReadonlySet<string> = new Set(['user', 'project', 'local'])

/** Anything other than the three scopes is ignored, so the agent still runs, just
 * without memory; a typo in an optional enhancement should not drop the agent. */
function parseMemoryField(raw: unknown): AgentMemoryScope | undefined {
  if (typeof raw !== 'string') return undefined
  const scope = raw.trim().toLowerCase()
  return MEMORY_SCOPES.has(scope) ? (scope as AgentMemoryScope) : undefined
}

/** Claude's `skills` frontmatter: a comma string or YAML list of skill names. */
function parseSkillsField(raw: unknown): string[] | undefined {
  let names: string[] = []
  if (Array.isArray(raw)) names = raw.map(String)
  else if (typeof raw === 'string') names = raw.split(',')
  const cleaned = names.map((name) => name.trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : undefined
}

/** Inline the named skills into an agent's prompt. Claude preloads a subagent's
 * `skills` at startup rather than letting it discover them, and a child pi process
 * does not inherit the parent's skill discovery, so the bodies travel in the prompt.
 * A name that resolves to nothing is reported rather than dropped: a silently missing
 * instruction is worse than a visible gap. */
export function withPreloadedSkills(prompt: string, skills: string[] | undefined, skillDirs: string[]): string {
  if (!skills || skills.length === 0) return prompt
  const sections: string[] = []
  for (const name of skills) {
    const body = readSkillBody(name, skillDirs)
    sections.push(body === undefined ? `<skill name="${name}">(skill not found)</skill>` : `<skill name="${name}">\n${body.trim()}\n</skill>`)
  }
  return `${prompt}\n\n## Preloaded skills\n\n${sections.join('\n\n')}`
}

/** A skill name is a single directory or file stem, never a path. The name comes from
 * agent frontmatter, which a repository can control, and the body is inlined into the
 * prompt sent to the model, so a traversal would be an arbitrary-file read. */
const SKILL_NAME = /^[A-Za-z0-9_.-]+$/

/** Read one candidate file, but only if it really sits under `root` once symlinks
 * are resolved. Both sides are canonicalised: on macOS /var is itself a symlink, so
 * comparing a resolved path against an unresolved root rejects every valid read. */
function readConfined(candidate: string, root: string): string | undefined {
  try {
    const real = fs.realpathSync(candidate)
    if (real !== root && !real.startsWith(root + path.sep)) return undefined
    return stripFrontmatter(fs.readFileSync(real, 'utf-8'))
  } catch {
    return undefined
  }
}

function readSkillBody(name: string, skillDirs: string[]): string | undefined {
  if (!SKILL_NAME.test(name) || name === '.' || name === '..') return undefined
  for (const dir of skillDirs) {
    let root: string
    try {
      root = fs.realpathSync(dir)
    } catch {
      continue // a skills directory that does not exist simply contributes nothing
    }
    for (const candidate of [path.join(dir, name, 'SKILL.md'), path.join(dir, `${name}.md`)]) {
      const body = readConfined(candidate, root)
      if (body !== undefined) return body
    }
  }
  return undefined
}

/** permissionMode has no pi equivalent; 'plan' means a research agent, so translate
 * the intent into a read-only toolset unless the file pins tools itself. */
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

/** The agent's name per Claude's naming rules: a plugin agent registers under the
 * scoped id `<plugin>:<name>` with the filename standing in for a missing name;
 * elsewhere the frontmatter name is required and `:` is reserved for plugin ids,
 * so a file carrying one is not loaded. */
function agentName(frontmatter: Record<string, unknown>, filePath: string, pluginName?: string): string | null {
  const declared = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  if (pluginName !== undefined) return `${pluginName}:${declared || path.basename(filePath, '.md')}`
  if (!declared) return null
  if (declared.includes(':')) {
    console.warn(`pi-code-subagent: ignoring agent ${filePath}: names cannot contain ":", which is reserved for plugin-scoped identifiers`)
    return null
  }
  return declared
}

/** Parse one agent markdown file; null when it is not a usable agent definition. */
function parseAgentFile(content: string, source: AgentSource, filePath: string, pluginName?: string): AgentConfig | null {
  let parsed: { frontmatter: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content)
  } catch (error) {
    // Malformed YAML must not abort discovery for the whole directory, but a silent drop
    // reads as "that agent does not exist", so it is named like the other rejections here.
    console.warn(`pi-code-subagent: ignoring agent ${filePath}: its frontmatter could not be parsed (${errorMessage(error)})`)
    return null
  }
  const { frontmatter, body } = parsed
  const name = agentName(frontmatter, filePath, pluginName)
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
  if (!name || !description) return null
  const tools = parseToolsField(frontmatter.tools, true)
  if (tools === null) {
    // A silent drop reads as "agent does not exist"; say why, since an
    // argument-scoped grant is a shape Claude's own docs recommend but pi cannot
    // enforce on a child process.
    console.warn(`pi-code-subagent: ignoring agent ${filePath}: its tools: grant could not be applied (an argument scope like Bash(git log:*) cannot be enforced on a subagent; grant the whole tool or drop it)`)
    return null
  }
  const disallowedTools = parseToolsField(frontmatter.disallowedTools, false)
  if (disallowedTools === null) return null
  const isolation = parseIsolationField(frontmatter.isolation)
  if (isolation === null) {
    // isolation is a declared safety boundary: an unrecognized value must reject
    // the definition rather than run the agent against the real checkout.
    console.warn(`pi-code-subagent: ignoring agent ${filePath}: isolation value ${JSON.stringify(frontmatter.isolation)} is not supported (only "worktree" is)`)
    return null
  }
  return {
    name,
    description,
    tools: tools ?? (frontmatter.permissionMode === 'plan' ? [...READ_ONLY_TOOLS] : undefined),
    disallowedTools,
    model: parseModelField(frontmatter.model),
    effort: parseEffortField(frontmatter.effort),
    modelAlias: parseModelAlias(frontmatter.model),
    skills: parseSkillsField(frontmatter.skills),
    memory: parseMemoryField(frontmatter.memory),
    maxTurns: parseMaxTurns(frontmatter.maxTurns),
    isolation,
    hooks: frontmatter.hooks !== null && typeof frontmatter.hooks === 'object' && !Array.isArray(frontmatter.hooks) ? (frontmatter.hooks as Record<string, unknown>) : undefined,
    background: frontmatter.background === true ? true : undefined,
    systemPrompt: body,
    source,
    filePath,
  }
}

/** Claude's `isolation:` field: `worktree` (case-insensitive) runs the child in a
 * temporary git worktree. Absent is fine (undefined); any other value is null so
 * the caller rejects the definition instead of silently dropping the boundary. */
function parseIsolationField(raw: unknown): 'worktree' | undefined | null {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'worktree') return 'worktree'
  return null
}

/** Claude's MCP server-level patterns in agent `tools`/`disallowedTools`:
 * `mcp__<server>` or `mcp__<server>__*` covers every tool of that server, and
 * `mcp__*` every MCP tool from any server. pi registers MCP tools under its own
 * `<server>_<tool>` names, so the parent's alias list is the translation table;
 * matching folds case and dashes like hook matchers do. A pattern that matches
 * nothing is kept verbatim (harmless to pi's exact-name filter), so a server that
 * failed to connect is not silently dropped from a deny list. */
export function expandMcpToolPatterns(entries: string[], aliases: ReadonlyArray<{ pi: string; claude: string }>): string[] {
  const fold = (name: string): string => name.toLowerCase().replaceAll('-', '_')
  const expanded: string[] = []
  for (const entry of entries) {
    const folded = fold(entry)
    if (!folded.startsWith('mcp__')) {
      expanded.push(entry)
      continue
    }
    const server = folded === 'mcp__*' ? undefined : folded.replace(/__\*$/, '')
    const matches = aliases.filter((alias) => (server === undefined ? true : fold(alias.claude).startsWith(`${server}__`))).map((alias) => alias.pi)
    if (matches.length === 0) expanded.push(entry)
    else expanded.push(...matches)
  }
  return [...new Set(expanded)]
}

/** Claude's `maxTurns`: a positive integer cap on the subagent's agentic turns.
 * Anything else (0, negative, non-number) is ignored, so the run is uncapped. */
function parseMaxTurns(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined
}

export type AgentScope = 'user' | 'project' | 'both'

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string
  /** Claude tier alias (`sonnet`/`opus`/`haiku`) when the file named one. */
  modelAlias?: string
  /** Skill names to inline into the child's prompt, per Claude's `skills` field. */
  skills?: string[]
  /** Persistent per-agent memory scope, per Claude's `memory:` field. */
  memory?: AgentMemoryScope
  /** Cap on the child's agentic turns, enforced by killing at the turn boundary. */
  maxTurns?: number
  /** Claude's `isolation: worktree`: run the child in a temporary git worktree. */
  isolation?: 'worktree'
  /** Claude's frontmatter `hooks`, scoped to this subagent: passed to the child
   * via env, with Stop converted to SubagentStop (see agentHooksEnv). */
  hooks?: Record<string, unknown>
  /** Claude's `background: true`: keep this agent in the background even when
   * asked to run it in the foreground. */
  background?: boolean
  systemPrompt: string
  source: AgentSource
  filePath: string
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[]
  projectAgentsDir: string | null
}

/** Claude scans .claude/agents recursively so agents can be organized into
 * subfolders (agents/review/, agents/research/); the walk mirrors that. */
function loadAgentsFromDir(dir: string, source: AgentSource, pluginName?: string): AgentConfig[] {
  const agents: AgentConfig[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return agents // a missing or unreadable directory contributes nothing
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      agents.push(...loadAgentsFromDir(filePath, source, pluginName))
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const agent = parseAgentFile(content, source, filePath, pluginName)
    if (agent) agents.push(agent)
  }

  return agents
}

function buildAgentMap(userAgents: AgentConfig[], projectAgents: AgentConfig[], scope: AgentScope): Map<string, AgentConfig> {
  const agentMap = new Map<string, AgentConfig>()
  const register = (agents: AgentConfig[]): void => {
    for (const agent of agents) agentMap.set(agent.name, agent)
  }
  // user agents first so project agents win on name conflicts
  if (scope !== 'project') register(userAgents)
  if (scope !== 'user') register(projectAgents)
  return agentMap
}

export type AgentSource = 'user' | 'project' | 'builtin' | 'plugin'

/** Bundled default agents (Explore, Plan, general-purpose), lowest precedence. */
const BUILTIN_AGENTS_DIR = path.join(import.meta.dirname, 'agents')

/** Agent directories of every enabled plugin, each with its plugin name (Claude
 * scopes plugin agent ids as `<plugin>:<name>`): `agents/` unless the manifest
 * points elsewhere. Plugins are user-installed, so user scope only decides. */
function pluginAgentDirs(home: string): Array<{ dir: string; pluginName: string }> {
  return installedPlugins(home).flatMap((plugin) => {
    const declared = plugin.manifest.agents
    const dirs = Array.isArray(declared) ? declared : [typeof declared === 'string' ? declared : 'agents']
    return dirs
      .map((dir) => pluginComponentPath(plugin, String(dir)))
      .filter((dir): dir is string => dir !== undefined)
      .map((dir) => ({ dir, pluginName: plugin.name }))
  })
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents')
  const claudeUserDir = path.join(claudeConfigDir(os.homedir()), 'agents')
  const projectPiDir = findNearestDir(cwd, path.join('.pi', 'agents'))
  // Claude scans every .claude/agents between cwd and the repository root, the
  // definition closest to cwd winning a name clash; root-first load order makes
  // the nearer directory's entry overwrite in the map below.
  const projectClaudeDirs = ancestorDirs(cwd, path.join('.claude', 'agents')).reverse()

  // Plugins load after builtins and before the user's own dirs, so a user agent
  // wins a name clash with a plugin's, and ~/.pi/agent/agents wins over ~/.claude.
  const userAgents = scope === 'project' ? [] : [...loadAgentsFromDir(BUILTIN_AGENTS_DIR, 'builtin'), ...pluginAgentDirs(os.homedir()).flatMap((entry) => loadAgentsFromDir(entry.dir, 'plugin', entry.pluginName)), ...loadAgentsFromDir(claudeUserDir, 'user'), ...loadAgentsFromDir(userDir, 'user')]
  // project .claude/agents loads first so project .pi/agents wins on name conflicts
  const projectAgents = scope === 'user' ? [] : [...projectClaudeDirs.flatMap((dir) => loadAgentsFromDir(dir, 'project')), ...(projectPiDir ? loadAgentsFromDir(projectPiDir, 'project') : [])]

  const agentMap = buildAgentMap(userAgents, projectAgents, scope)
  return { agents: Array.from(agentMap.values()), projectAgentsDir: projectPiDir }
}
