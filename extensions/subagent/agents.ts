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

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content)

    if (!frontmatter.name || !frontmatter.description) {
      continue
    }

    const tools = frontmatter.tools
      ?.split(',')
      .map((t: string) => normalizeToolName(t.trim()))
      .filter(Boolean)

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
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

function findNearestDir(cwd: string, relative: string): string | null {
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, relative)
    if (isDirectory(candidate)) return candidate

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

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
  if (agents.length === 0) return { text: 'none', remaining: 0 }
  const listed = agents.slice(0, maxItems)
  const remaining = agents.length - listed.length
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join('; '),
    remaining,
  }
}
