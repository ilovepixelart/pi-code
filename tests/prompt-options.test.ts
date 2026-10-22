import { describe, expect, it } from 'vitest'

import { addPromptSection, replaceDefaultInstructions } from '../extensions/internal/prompt-options.ts'
import { addMcpServersSection, MCP_SERVERS_TEXT, runPromptChain } from './prompt-chain.ts'

/** An event shaped like a pi that hands over a fixed prompt string. */
const fixedEvent = (options: { sections?: Record<string, string>; customPrompt?: string }) => ({ systemPrompt: 'FIXED', systemPromptOptions: options })

describe('addPromptSection', () => {
  it('renders the section with the sections later handlers add', async () => {
    const prompt = await runPromptChain([(event) => void addPromptSection(event as never, 'notes', 'NOTE BODY'), addMcpServersSection])

    expect(prompt).toContain('<notes>\nNOTE BODY\n</notes>')
    expect(prompt).toContain(MCP_SERVERS_TEXT)
  })

  it('reports false and leaves the options as found when the prompt does not re-render', () => {
    const sections = { notes: 'EARLIER' }
    const event = fixedEvent({ sections })

    expect(addPromptSection(event, 'notes', 'NEW')).toBe(false)
    expect(addPromptSection(event, 'other', 'NEW')).toBe(false)
    expect(sections).toEqual({ notes: 'EARLIER' })
  })

  it('reports false on a pi without prompt sections', () => {
    expect(addPromptSection({ systemPrompt: 'FIXED' }, 'notes', 'NEW')).toBe(false)
    expect(addPromptSection(fixedEvent({}), 'notes', 'NEW')).toBe(false)
  })

  it('reports false after an earlier handler forced the prompt', async () => {
    const results: boolean[] = []
    await runPromptChain([() => ({ systemPrompt: 'FORCED' }), (event) => void results.push(addPromptSection(event as never, 'notes', 'NEW'))])

    expect(results).toEqual([false])
  })
})

describe('replaceDefaultInstructions', () => {
  it("replaces pi's default instructions and keeps the sections after them", async () => {
    const prompt = await runPromptChain([(event) => void replaceDefaultInstructions(event as never, 'STYLE BODY'), addMcpServersSection])

    expect(prompt.startsWith('STYLE BODY')).toBe(true)
    expect(prompt).not.toContain('<tools>')
    expect(prompt).toContain('<cwd>')
    expect(prompt).toContain(MCP_SERVERS_TEXT)
  })

  it('reports false and leaves a custom prompt alone', () => {
    const options = { sections: {}, customPrompt: 'CUSTOM' }

    expect(replaceDefaultInstructions(fixedEvent(options), 'STYLE BODY')).toBe(false)
    expect(options.customPrompt).toBe('CUSTOM')
  })

  it('reports false and leaves no custom prompt when the prompt does not re-render', () => {
    const options: { sections: Record<string, string>; customPrompt?: string } = { sections: {} }

    expect(replaceDefaultInstructions(fixedEvent(options), 'STYLE BODY')).toBe(false)
    expect(options).toEqual({ sections: {} })
  })
})
