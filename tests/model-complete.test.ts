import { afterEach, describe, expect, it } from 'vitest'

import { assistantText, completeText, setCompleteBackend } from '../extensions/internal/model-complete.ts'

const msg = (parts: Array<{ type: string; text?: string }>, usage: unknown = {}) => ({ role: 'assistant', content: parts, api: 'x', provider: 'x', model: 'm', usage, stopReason: 'stop', timestamp: 0 }) as never

afterEach(() => setCompleteBackend(null))

describe('assistantText', () => {
  it('joins text parts and drops thinking and tool calls', () => {
    expect(assistantText(msg([{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Hello' }, { type: 'tool_call' }, { type: 'text', text: ' world' }]))).toBe('Hello world')
  })

  it('returns empty when there is no text part', () => {
    expect(assistantText(msg([{ type: 'tool_call' }]))).toBe('')
  })
})

describe('completeText', () => {
  it('sends the prompt as a user turn with the system prompt and returns the reply', async () => {
    let seen: { system?: string; user?: unknown; maxTokens?: number } = {}
    setCompleteBackend(async (_model, context, options) => {
      seen = { system: context.systemPrompt, user: context.messages[0]?.content, maxTokens: options.maxTokens }
      return msg([{ type: 'text', text: 'the answer' }])
    })
    const out = await completeText({} as never, 'the question', { system: 'be brief', maxTokens: 256 })
    expect(out.text).toBe('the answer')
    expect(seen).toEqual({ system: 'be brief', user: 'the question', maxTokens: 256 })
  })

  it('returns the assistant usage so a tool result can account for the nested call', async () => {
    const usage = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } }
    setCompleteBackend(async () => msg([{ type: 'text', text: 'ok' }], usage))
    const out = await completeText({} as never, 'q')
    expect(out.usage).toEqual(usage)
  })

  it('propagates a backend failure so the caller can fall back', async () => {
    setCompleteBackend(async () => {
      throw new Error('no credentials')
    })
    await expect(completeText({} as never, 'q')).rejects.toThrow(/no credentials/)
  })
})
