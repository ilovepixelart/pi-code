/**
 * One-off, in-process model completions for extensions.
 *
 * pi exposes ModelRuntime.completeSimple(model, context, options), so an extension
 * can run a single tool-less prompt through a model without spawning a subprocess
 * (the way the subagent does) or standing up its own HTTP client. The runtime
 * resolves auth from the same credential store the session uses, and is created
 * once and cached. This is the shared foundation for model-backed features that
 * Claude has and pi otherwise cannot express: WebFetch's prompt-over-page answer,
 * a hook's `type: prompt` evaluation, and similar.
 *
 * Every consumer must treat a completion as best-effort: it costs a model call and
 * can fail (no credentials, headless with no model, a provider error), so failures
 * throw and the caller falls back to its non-model behavior.
 */

import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

/** The completion backend: model + context -> assistant message. Overridable for tests. */
export type CompleteFn = (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => Promise<AssistantMessage>

let backend: Promise<CompleteFn> | null = null

async function realBackend(): Promise<CompleteFn> {
  // allowModelNetwork stays false (the default): a completion must not stall on a
  // catalog refresh. The runtime reads the same auth/models files as the session.
  const runtime = await ModelRuntime.create()
  return (model, context, options) => runtime.completeSimple(model, context, options)
}

/** Replace the completion backend, or reset to the real runtime with null. Tests only. */
export function setCompleteBackend(fn: CompleteFn | null): void {
  backend = fn ? Promise.resolve(fn) : null
}

/** The text of an assistant message, thinking and tool calls dropped. */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

export interface CompleteOptions {
  /** System prompt for the one-off turn. */
  system?: string
  /** Output cap; a summary/decision does not need the model's full budget. */
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Run `prompt` through `model` as a single user turn and return the reply text plus
 * the call's usage. A tool that makes a nested LLM call must return that usage on
 * its tool result, or the call's tokens and cost vanish from pi's session totals.
 * Throws on any failure so the caller can fall back; never returns a partial or a
 * tool call, only assistant text.
 */
export async function completeText(model: Model<Api>, prompt: string, options: CompleteOptions = {}): Promise<{ text: string; usage: Usage }> {
  // A rejected creation must not stay cached: ModelRuntime.create can fail on a
  // transient (a credential store read), and caching that promise made every later
  // call rethrow the same stale error for the life of the process.
  backend ??= realBackend().catch((error: unknown) => {
    backend = null
    throw error
  })
  const complete = await backend
  const context: Context = {
    systemPrompt: options.system,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  }
  const message = await complete(model, context, { maxTokens: options.maxTokens ?? 1024, signal: options.signal })
  return { text: assistantText(message), usage: message.usage }
}
