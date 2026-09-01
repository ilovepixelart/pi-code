import { describe, expect, it } from 'vitest'

import { expandMcpToolPatterns } from '../extensions/subagent/agents.ts'

// Claude: "Both fields accept MCP server-level patterns in addition to exact tool
// names: mcp__<server> or mcp__<server>__* grants or removes every tool from the
// named server. In disallowedTools, mcp__* also removes every MCP tool from any
// server." pi registers MCP tools as <server>_<tool>, so the parent's alias list
// is the translation table.
const aliases = [
  { pi: 'github_search', claude: 'mcp__github__search' },
  { pi: 'github_create', claude: 'mcp__github__create' },
  { pi: 'jira_lookup', claude: 'mcp__jira__lookup' },
]

describe('expandMcpToolPatterns', () => {
  it('expands a server-level pattern to every tool of that server, keeping other entries', () => {
    expect(expandMcpToolPatterns(['read', 'mcp__github'], aliases)).toEqual(['read', 'github_search', 'github_create'])
    expect(expandMcpToolPatterns(['mcp__github__*'], aliases)).toEqual(['github_search', 'github_create'])
  })

  it('expands mcp__* to every MCP tool from any server', () => {
    expect(expandMcpToolPatterns(['mcp__*'], aliases)).toEqual(['github_search', 'github_create', 'jira_lookup'])
  })

  it('folds case and dashes when matching the server name, like hook matchers do', () => {
    const dashy = [{ pi: 'my_server_t', claude: 'mcp__my-server__t' }]
    expect(expandMcpToolPatterns(['mcp__My_Server'], dashy)).toEqual(['my_server_t'])
  })

  it('keeps a pattern that matches nothing, so an unconnected server is not silently dropped', () => {
    expect(expandMcpToolPatterns(['mcp__unknown'], aliases)).toEqual(['mcp__unknown'])
  })

  it('leaves exact tool names and built-ins alone', () => {
    expect(expandMcpToolPatterns(['read', 'github_search'], aliases)).toEqual(['read', 'github_search'])
  })
})
