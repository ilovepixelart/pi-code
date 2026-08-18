/**
 * MCP listing: the paginated tool and prompt listers, and the resource/template
 * collectors that back the global list_mcp_resources tool.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpPromptInfo } from './mapping.js'
import { callRequestOptions, withTimeout } from './transport.js'

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools({ cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

export async function listAllPrompts(client: Client): Promise<McpPromptInfo[]> {
  const prompts: McpPromptInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.listPrompts({ cursor })
    prompts.push(...page.prompts)
    cursor = page.nextCursor
  } while (cursor)
  return prompts
}

/** One resource's flat record for the list_mcp_resources output, dropping the optional
 * description/mimeType when the server omits them. */
function resourceEntry(server: string, resource: { uri: string; name: string; description?: string; mimeType?: string }): Record<string, unknown> {
  return { server, uri: resource.uri, name: resource.name, ...(resource.description ? { description: resource.description } : {}), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) }
}

/** One resource template's flat record, likewise dropping absent optional fields. */
function resourceTemplateEntry(server: string, template: { uriTemplate: string; name: string; description?: string; mimeType?: string }): Record<string, unknown> {
  return { server, uriTemplate: template.uriTemplate, name: template.name, ...(template.description ? { description: template.description } : {}), ...(template.mimeType ? { mimeType: template.mimeType } : {}) }
}

/** Page a server's resources to exhaustion under the call budget, appending each as a
 * flat record. Pushed into the caller's array incrementally so a mid-pagination failure
 * still leaves the earlier pages in place. */
async function collectResources(entries: Array<Record<string, unknown>>, name: string, client: Client, budget: number): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await withTimeout(client.listResources({ cursor }, callRequestOptions(budget)), budget, `list resources ${name}`)
    for (const resource of page.resources) entries.push(resourceEntry(name, resource))
    cursor = page.nextCursor
  } while (cursor)
}

/** Page a server's resource templates to exhaustion under the call budget. */
async function collectResourceTemplates(entries: Array<Record<string, unknown>>, name: string, client: Client, budget: number): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await withTimeout(client.listResourceTemplates({ cursor }, callRequestOptions(budget)), budget, `list resource templates ${name}`)
    for (const template of page.resourceTemplates) entries.push(resourceTemplateEntry(name, template))
    cursor = page.nextCursor
  } while (cursor)
}

/** Append every resource and template one server exposes. A resource-listing failure
 * surfaces inline as an error record, so one server cannot empty the whole listing; a
 * template-listing failure is silent, templates being optional (a server with the
 * resources capability but no templates answers method-not-found). */
export async function collectServerResourceEntries(entries: Array<Record<string, unknown>>, name: string, client: Client, budget: number): Promise<void> {
  try {
    await collectResources(entries, name, client, budget)
  } catch (error) {
    entries.push({ server: name, error: error instanceof Error ? error.message : String(error) })
  }
  try {
    await collectResourceTemplates(entries, name, client, budget)
  } catch {
    // Templates are optional: a method-not-found here is not worth reporting.
  }
}

/** The optional server-name filter for list_mcp_resources: a non-empty string, else undefined. */
export function resourceServerFilter(params: unknown): string | undefined {
  const server = (params as { server?: unknown }).server
  return typeof server === 'string' && server.length > 0 ? server : undefined
}
