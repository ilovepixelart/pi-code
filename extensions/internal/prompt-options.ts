/**
 * Prompt additions made through the options pi builds the system prompt from. A
 * before_agent_start handler that returns `systemPrompt` fixes the text for the rest of the
 * chain, so a section a later handler adds, such as pi's own `mcp_servers` listing, never
 * reaches the model. An option edit is re-rendered with everything after it.
 */

interface PromptOptions {
  customPrompt?: string
  sections?: Record<string, string>
}

interface PromptEvent {
  systemPrompt: string
  systemPromptOptions?: PromptOptions
}

/** Apply `edit` (which returns its own undo) to the prompt options and say whether it reached
 * the prompt. pi re-renders event.systemPrompt from the options, so there it did. On a pi
 * without sections, or after an earlier handler forced a prompt, the edit is undone (an older
 * pi reuses the options object next turn) and the caller returns a systemPrompt instead. */
function editOptions(event: PromptEvent, edit: (options: PromptOptions & { sections: Record<string, string> }) => () => void): boolean {
  const options = event.systemPromptOptions
  if (options?.sections === undefined) return false
  const before = event.systemPrompt
  const undo = edit(options as PromptOptions & { sections: Record<string, string> })
  if (event.systemPrompt !== before) return true
  undo()
  return false
}

/** Add `content` as the prompt section `name` (rendered as `<name>…</name>`). */
export function addPromptSection(event: PromptEvent, name: string, content: string): boolean {
  return editOptions(event, (options) => {
    const previous = options.sections[name]
    options.sections[name] = content
    return () => {
      if (previous === undefined) delete options.sections[name]
      else options.sections[name] = previous
    }
  })
}

/** Replace pi's default instructions (the preamble, tools, rules and docs sections) with
 * `content`, keeping every section after them. A prompt already custom is left alone. */
export function replaceDefaultInstructions(event: PromptEvent, content: string): boolean {
  if (event.systemPromptOptions?.customPrompt) return false
  return editOptions(event, (options) => {
    options.customPrompt = content
    return () => {
      delete options.customPrompt
    }
  })
}
