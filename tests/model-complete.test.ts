import { afterEach, describe, expect, it, vi } from 'vitest'

// The real completion backend is ModelRuntime.create().completeSimple(...). Stub the runtime
// with a recorder so a break in that production wiring is caught, rather than every test
// overriding the backend and leaving realBackend() itself unexercised.
const runtimeMock = vi.hoisted(() => ({
  createCalls: 0,
  completeCalls: [] as Array<{ model: unknown; context: { systemPrompt?: string; messages: Array<{ content: unknown }> }; options: { maxTokens?: number; signal?: AbortSignal } }>,
  reply: { role: 'assistant', content: [{ type: 'text', text: 'real answer' }], api: 'x', provider: 'x', model: 'm', usage: { input: 3, output: 5, totalTokens: 8 }, stopReason: 'stop', timestamp: 0 },
}))
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()
  return {
    ...actual,
    ModelRuntime: {
      create: async () => {
        runtimeMock.createCalls += 1
        return {
          completeSimple: async (model: unknown, context: unknown, options: unknown) => {
            runtimeMock.completeCalls.push({ model, context, options } as never)
            return runtimeMock.reply
          },
        }
      },
    },
  }
})

const { assistantText, completeText, setCompleteBackend } = await import('../extensions/internal/model-complete.ts')

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

describe('completeText realBackend wiring', () => {
  it('creates the ModelRuntime once, caches it, and forwards model, message and options', async () => {
    runtimeMock.createCalls = 0
    runtimeMock.completeCalls.length = 0
    // Reset to the real backend so realBackend() actually runs ModelRuntime.create(); restore
    // in finally so the cached mock runtime never leaks into a later test.
    setCompleteBackend(null)
    try {
      const model = { id: 'test-model' } as never
      const signal = new AbortController().signal
      const first = await completeText(model, 'the question', { maxTokens: 321, signal })
      const second = await completeText(model, 'again', { maxTokens: 50 })

      // Created once and cached: both completions share the one runtime.
      expect(runtimeMock.createCalls).toBe(1)
      expect(runtimeMock.completeCalls).toHaveLength(2)
      // {text, usage} flows back out of completeSimple.
      expect(first).toEqual({ text: 'real answer', usage: runtimeMock.reply.usage })
      expect(second.text).toBe('real answer')
      // completeSimple received the model, the user message, and the resolved options.
      const call = runtimeMock.completeCalls[0]
      expect(call.model).toBe(model)
      expect(call.context.messages[0]?.content).toBe('the question')
      expect(call.options.maxTokens).toBe(321)
      expect(call.options.signal).toBe(signal)
    } finally {
      setCompleteBackend(null)
    }
  })
})
