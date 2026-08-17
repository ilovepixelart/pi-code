import { afterEach, describe, expect, it } from 'vitest'

import { callMcpTool, setMcpToolCaller } from '../extensions/internal/mcp-call.ts'

afterEach(() => setMcpToolCaller(undefined))

describe('mcp-call seam', () => {
  it('routes a call to the registered caller', async () => {
    let seen: unknown
    setMcpToolCaller(async (server, tool, input) => {
      seen = { server, tool, input }
      return { text: 'ok', isError: false }
    })
    expect(await callMcpTool('gh', 'search', { q: 'x' })).toEqual({ text: 'ok', isError: false })
    expect(seen).toEqual({ server: 'gh', tool: 'search', input: { q: 'x' } })
  })

  it('throws when no caller is registered (no MCP connected)', async () => {
    await expect(callMcpTool('gh', 'search', {})).rejects.toThrow(/no MCP/i)
  })
})
