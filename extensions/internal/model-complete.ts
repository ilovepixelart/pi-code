/**
 * One-off, in-process model completions for extensions.
 *
 * pi exposes ModelRuntime.completeSimple(model, context, options), so an extension
 * can run a single tool-less prompt through a model without spawning a subprocess
 * (the way the subagent does) or standing up its own HTTP client. A caller with a
 * session passes its ctx.modelRegistry, which completes on the session's own runtime;
 * without one, a standalone runtime reading the same credential store is created once
 * and cached. This is the shared foundation for model-backed features that
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
/** A test backend wins over a passed registry, so tests keep intercepting every call. */
let backendOverridden = false

async function realBackend(): Promise<CompleteFn> {
  // allowModelNetwork stays false (the default): a completion must not stall on a
  // catalog refresh. The runtime reads the same auth/models files as the session.
  const runtime = await ModelRuntime.create()
  return (model, context, options) => runtime.completeSimple(model, context, options)
}

/** Replace the completion backend, or reset to the real runtime with null. Tests only. */
export function setCompleteBackend(fn: CompleteFn | null): void {
  backend = fn ? Promise.resolve(fn) : null
  backendOverridden = fn !== null
}

/** The text of an assistant message, thinking and tool calls dropped. */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

/** The session's model registry (ctx.modelRegistry), narrowed to the one call used here. */
export interface CompletionRegistry {
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): { result(): Promise<AssistantMessage> }
}

export interface CompleteOptions {
  /** System prompt for the one-off turn. */
  system?: string
  /** The session's registry. Only the session's runtime holds extension-registered
   * providers, virtual models and a `--api-key` key; a fresh ModelRuntime.create()
   * fails with `Unknown provider` for the first and lacks the others. Without it, a
   * standalone runtime is the fallback. */
  registry?: CompletionRegistry
  /** Output cap; a summary/decision does not need the model's full budget. */
  maxTokens?: number
  signal?: AbortSignal
}

function standaloneBackend(): Promise<CompleteFn> {
  // A rejected creation must not stay cached: ModelRuntime.create can fail on a
  // transient (a credential store read), and caching that promise made every later
  // call rethrow the same stale error for the life of the process.
  backend ??= realBackend().catch((error: unknown) => {
    backend = null
    throw error
  })
  return backend
}

/**
 * Run `prompt` through `model` as a single user turn and return the reply text plus
 * the call's usage. A tool that makes a nested LLM call must return that usage on
 * its tool result, or the call's tokens and cost vanish from pi's session totals.
 * Throws on any failure so the caller can fall back; never returns a partial or a
 * tool call, only assistant text.
 */
export async function completeText(model: Model<Api>, prompt: string, options: CompleteOptions = {}): Promise<{ text: string; usage: Usage }> {
  const context: Context = {
    systemPrompt: options.system,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  }
  const streamOptions = { maxTokens: options.maxTokens ?? 1024, signal: options.signal }
  const message = options.registry && !backendOverridden ? await options.registry.streamSimple(model, context, streamOptions).result() : await (await standaloneBackend())(model, context, streamOptions)
  // pi-ai reports a provider failure or a fired signal by resolving, never rejecting: the
  // message then has no text, and returned as an answer it is indistinguishable from one.
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `completion ${message.stopReason}`)
  return { text: assistantText(message), usage: message.usage }
}
