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
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
  if (items === null || items.some((item) => typeof item !== 'string')) return null
  const tools = (items as string[]).map((item) => normalizeToolName(item.trim())).filter(Boolean)
  return tools.length > 0 ? tools : undefined
}

export type AgentScope = 'user' | 'project' | 'both'

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  model?: string
  systemPrompt: string
  source: 'user' | 'project'
  filePath: string
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[]
  projectAgentsDir: string | null
}

function loadAgentsFromDir(dir: string, source: 'user' | 'project'): AgentConfig[] {
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

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content)

    const name = typeof frontmatter.name === 'string' ? frontmatter.name : ''
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
    if (!name || !description) {
      continue
    }

    const tools = parseToolsField(frontmatter.tools)
    if (tools === null) {
      continue
    }

    agents.push({
      name,
      description,
      tools,
      model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    })
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

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents')
  const claudeUserDir = path.join(os.homedir(), '.claude', 'agents')
  const projectPiDir = findNearestDir(cwd, path.join('.pi', 'agents'))
  const projectClaudeDir = findNearestDir(cwd, path.join('.claude', 'agents'))

  // ~/.claude/agents loads first so ~/.pi/agent/agents wins on name conflicts
  const userAgents = scope === 'project' ? [] : [...loadAgentsFromDir(claudeUserDir, 'user'), ...loadAgentsFromDir(userDir, 'user')]
  // project .claude/agents loads first so project .pi/agents wins on name conflicts
  const projectAgents = scope === 'user' ? [] : [...(projectClaudeDir ? loadAgentsFromDir(projectClaudeDir, 'project') : []), ...(projectPiDir ? loadAgentsFromDir(projectPiDir, 'project') : [])]

  const agentMap = buildAgentMap(userAgents, projectAgents, scope)
  return { agents: Array.from(agentMap.values()), projectAgentsDir: projectPiDir }
}
