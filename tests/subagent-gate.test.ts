import { describe, expect, it } from 'vitest'

import { projectAgentGate } from '../extensions/subagent/index.ts'

describe('projectAgentGate', () => {
  it('allows when no project agents are requested', () => {
    expect(projectAgentGate(0, false, false, true)).toBe('allow')
  })

  it('refuses untrusted project agents in headless mode', () => {
    expect(projectAgentGate(1, false, false, true)).toBe('refuse')
  })

  it('still refuses them headless when the caller declines the prompt: a model parameter cannot grant trust', () => {
    // confirmProjectAgents is model-supplied; the only cell that distinguishes
    // "trusted" from "trusted or the model said not to ask".
    expect(projectAgentGate(1, false, false, false)).toBe('refuse')
  })

  it('confirms untrusted project agents interactively, even if the caller tried to skip the prompt', () => {
    expect(projectAgentGate(1, false, true, true)).toBe('confirm')
    expect(projectAgentGate(1, false, true, false)).toBe('confirm')
  })

  it('runs trusted project agents without a prompt by default', () => {
    expect(projectAgentGate(1, true, false, false)).toBe('allow')
    expect(projectAgentGate(1, true, true, false)).toBe('allow')
  })

  it('still prompts trusted project agents when confirmation is requested and UI exists', () => {
    expect(projectAgentGate(1, true, true, true)).toBe('confirm')
    // headless trusted with the flag cannot prompt, so it allows
    expect(projectAgentGate(1, true, false, true)).toBe('allow')
  })
})
