/**
 * Agent discovery and configuration
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent'

// Claude Code tool names -> pi tool names; unmapped names pass through lowercased
const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  glob: 'find',
  ls: 'ls',
}

function normalizeToolName(tool: string): string {
  const lower = tool.toLowerCase()
  return CLAUDE_TOOL_MAP[lower] ?? lower
}

/**
 * `tools:` may be a comma-separated string (the Claude Code format) or a YAML block
 * list. Anything else returns null: a restriction that failed to parse must not run
 * the agent unrestricted.
 */
function parseToolsField(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined
  let items: unknown[]
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'string') items = raw.split(',')
  else return null
  if (items.some((item) => typeof item !== 'string')) return null
  const tools = (items as string[]).map((item) => normalizeToolName(item.trim())).filter(Boolean)
  return tools.length > 0 ? tools : undefined
}

/**
 * Claude Code model aliases name Anthropic tiers. pi's resolver would partial-match
 * one against an authenticated Anthropic provider, but for every other setup the
 * child exits at boot on an unresolvable --model. Running on the session model
 * (Claude's `inherit`) is the degradation that works everywhere; users who want a
 * tier pinned should name a concrete model id.
 */
const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'inherit'])

function parseModelField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const model = raw.trim()
  return model && !CLAUDE_MODEL_ALIASES.has(model.toLowerCase()) ? model : undefined
}

/** pi's extended thinking levels; Claude's effort values are a subset, so they map 1:1. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function parseEffortField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const effort = raw.trim().toLowerCase()
  return THINKING_LEVELS.has(effort) ? effort : undefined
}

/** Claude's `skills` frontmatter: a comma string or YAML list of skill names. */
function parseSkillsField(raw: unknown): string[] | undefined {
  const names = Array.isArray(raw) ? raw.map((entry) => String(entry)) : typeof raw === 'string' ? raw.split(',') : []
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

function readSkillBody(name: string, skillDirs: string[]): string | undefined {
  if (!SKILL_NAME.test(name) || name === '.' || name === '..') return undefined
  for (const dir of skillDirs) {
    const root = path.resolve(dir)
    for (const candidate of [path.join(dir, name, 'SKILL.md'), path.join(dir, `${name}.md`)]) {
      // Belt and braces against symlinks and platform path quirks: the file actually
      // read must still sit under the skills directory it was resolved from.
      if (!path.resolve(candidate).startsWith(root + path.sep)) continue
      try {
        const content = fs.readFileSync(candidate, 'utf-8')
        const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(content)
        return match ? content.slice(match[0].length) : content
      } catch {
        // try the next shape
      }
    }
  }
  return undefined
}

/** permissionMode has no pi equivalent; 'plan' means a research agent, so translate
 * the intent into a read-only toolset unless the file pins tools itself. */
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

/** Parse one agent markdown file; null when it is not a usable agent definition. */
function parseAgentFile(content: string, source: AgentSource, filePath: string): AgentConfig | null {
  let parsed: { frontmatter: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content)
  } catch {
    return null // malformed YAML must not abort discovery for the whole directory
  }
  const { frontmatter, body } = parsed
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : ''
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
  if (!name || !description) return null
  const tools = parseToolsField(frontmatter.tools)
  if (tools === null) return null
  const disallowedTools = parseToolsField(frontmatter.disallowedTools)
  if (disallowedTools === null) return null
  return {
    name,
    description,
    tools: tools ?? (frontmatter.permissionMode === 'plan' ? [...READ_ONLY_TOOLS] : undefined),
    disallowedTools,
    model: parseModelField(frontmatter.model),
    effort: parseEffortField(frontmatter.effort),
    skills: parseSkillsField(frontmatter.skills),
    systemPrompt: body,
    source,
    filePath,
  }
}

export type AgentScope = 'user' | 'project' | 'both'

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string
  /** Skill names to inline into the child's prompt, per Claude's `skills` field. */
  skills?: string[]
  systemPrompt: string
  source: AgentSource
  filePath: string
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[]
  projectAgentsDir: string | null
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = []

  if (!fs.existsSync(dir)) {
    return agents
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const filePath = path.join(dir, entry.name)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const agent = parseAgentFile(content, source, filePath)
    if (agent) agents.push(agent)
  }

  return agents
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Project root at or above `from`. `.git` is a file in worktrees and submodules. */
const ROOT_MARKERS = ['.git', 'package.json']

function repoRoot(from: string): string | undefined {
  let currentDir = from
  while (true) {
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(currentDir, marker)))) return currentDir
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

/**
 * Nearest `relative` directory at or above `cwd`, stopping at the repository root.
 *
 * Without the boundary the search runs to the filesystem root, so an agent planted in a
 * world-writable ancestor such as /tmp is offered as a project agent for every session
 * beneath it. With no project marker (.git, package.json) the extent is unknown, so only
 * `cwd` is considered.
 */
function findNearestDir(cwd: string, relative: string): string | null {
  const boundary = repoRoot(cwd) ?? cwd
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, relative)
    if (isDirectory(candidate)) return candidate

    if (currentDir === boundary) return null
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
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

export type AgentSource = 'user' | 'project' | 'builtin'

/** Bundled default agents (Explore, Plan, general-purpose), lowest precedence. */
export const BUILTIN_AGENTS_DIR = path.join(import.meta.dirname, 'agents')

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents')
  const claudeUserDir = path.join(os.homedir(), '.claude', 'agents')
  const projectPiDir = findNearestDir(cwd, path.join('.pi', 'agents'))
  const projectClaudeDir = findNearestDir(cwd, path.join('.claude', 'agents'))

  // ~/.claude/agents loads first so ~/.pi/agent/agents wins on name conflicts
  const userAgents = scope === 'project' ? [] : [...loadAgentsFromDir(BUILTIN_AGENTS_DIR, 'builtin'), ...loadAgentsFromDir(claudeUserDir, 'user'), ...loadAgentsFromDir(userDir, 'user')]
  // project .claude/agents loads first so project .pi/agents wins on name conflicts
  const projectAgents = scope === 'user' ? [] : [...(projectClaudeDir ? loadAgentsFromDir(projectClaudeDir, 'project') : []), ...(projectPiDir ? loadAgentsFromDir(projectPiDir, 'project') : [])]

  const agentMap = buildAgentMap(userAgents, projectAgents, scope)
  return { agents: Array.from(agentMap.values()), projectAgentsDir: projectPiDir }
}
