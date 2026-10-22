/**
 * pi's before_agent_start chain (core/extensions/runner.js emitBeforeAgentStart), rendered by
 * pi's own buildSystemPrompt: every handler sees the prompt rendered from one shared options
 * object, and a returned systemPrompt becomes forceSystemPrompt, the fixed text later
 * handlers' option edits no longer reach.
 */

import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js'

type Handler = (event: unknown, ctx: unknown) => unknown

/** The final prompt after the handlers ran in order. */
export async function runPromptChain(handlers: Handler[], ctx: unknown = {}): Promise<string> {
  const options = normalizeBuildSystemPromptOptions({ cwd: '/repo' })
  for (const handler of handlers) {
    const event = {
      get systemPrompt(): string {
        return buildSystemPrompt(options)
      },
      systemPromptOptions: options,
    }
    const result = (await handler(event, ctx)) as { systemPrompt?: string } | undefined
    if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt
  }
  return buildSystemPrompt(options)
}

/** pi's MCP extension, which loads after pi-code and lists the servers as a section. */
export const MCP_SERVERS_TEXT = 'MCP SERVER LIST'
export const addMcpServersSection: Handler = (event) => {
  ;(event as { systemPromptOptions: { sections: Record<string, string> } }).systemPromptOptions.sections.mcp_servers = MCP_SERVERS_TEXT
}
