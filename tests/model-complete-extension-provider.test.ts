import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai'
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { completeText, setCompleteBackend } from '../extensions/internal/model-complete.ts'

// Real runtime, no mocks: the defect lives in which ModelRuntime instance holds a
// provider registered through pi.registerProvider(), which a stubbed runtime cannot exhibit.
const PROVIDER = 'repro-bridge'
const REPLY = 'answer from the extension provider'

const reply = (model: Model<Api>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: REPLY }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: 0,
})

let runtime: ModelRuntime
let registry: ModelRegistry
let model: Model<Api>
let seenApiKeys: Array<string | undefined> = []

beforeAll(async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', mkdtempSync(join(tmpdir(), 'pi-agent-')))
  vi.stubEnv('PI_OFFLINE', '1')
  setCompleteBackend(null)
  // What pi does for a session: one runtime, wrapped as ctx.modelRegistry, and an
  // extension's pi.registerProvider() landing on that registry.
  runtime = await ModelRuntime.create()
  registry = new ModelRegistry(runtime)
  registry.registerProvider(PROVIDER, {
    api: 'repro-api' as Api,
    apiKey: 'unused',
    baseUrl: 'http://127.0.0.1:9',
    streamSimple: (m, _context, options) => {
      seenApiKeys.push(options?.apiKey)
      const stream = createAssistantMessageEventStream()
      const message = reply(m)
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end(message)
      })
      return stream
    },
    models: [{ id: 'm1', name: 'M1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  })
  const found = registry.find(PROVIDER, 'm1')
  if (!found) throw new Error('registered model not found on the session registry')
  model = found
})

afterAll(() => {
  setCompleteBackend(null)
  vi.unstubAllEnvs()
})

describe('completeText with an extension-registered provider', () => {
  it('the session registry itself can complete through the provider', async () => {
    const message = await registry.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }).result()
    expect(message.stopReason).toBe('stop')
    expect(message.content).toEqual([{ type: 'text', text: REPLY }])
  })

  it('completeText answers for the session model whose provider an extension registered', async () => {
    await expect(completeText(model, 'hi', { registry })).resolves.toMatchObject({ text: REPLY })
  })

  it('completeText authenticates with a key set on the session runtime only (pi --api-key)', async () => {
    await runtime.setRuntimeApiKey(PROVIDER, 'cli-key')
    seenApiKeys = []
    try {
      await completeText(model, 'hi', { registry })
      expect(seenApiKeys).toEqual(['cli-key'])
    } finally {
      await runtime.removeRuntimeApiKey(PROVIDER)
    }
  })
})
