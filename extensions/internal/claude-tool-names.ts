/**
 * The one place pi tool names and Claude tool names are paired.
 *
 * Two independent tables used to encode this: a Claude->pi map for resolving
 * `allowed-tools` entries, and a pi->Claude map for hook payloads and matchers.
 * They disagreed. The second one listed six tools, so a hook matcher written in
 * Claude's vocabulary never fired for `web_fetch`, `subagent`, `question`, `todo`,
 * `slash_command`, `web_search` or `plan_mode_complete`, even though the first table
 * had known those pairings all along. Both directions now derive from this list, so
 * a tool cannot be nameable in one direction and invisible in the other.
 *
 * Canonical names are the tools reference's own spellings. `claude: null` marks a pi
 * tool the reference has no counterpart for: it stays untranslated in payloads, and
 * no Claude name resolves to it beyond its own spelling.
 *
 * Input SHAPES are a separate question and deliberately not driven from here. The
 * hooks reference documents per-tool input tables only for the file and shell tools,
 * so those are the only ones claude-tools.ts translates; for the rest there is no
 * documented Claude shape to conform to and the pi input is passed through.
 */

interface ToolNamePair {
  /** Canonical Claude tool name, or null when the reference has no such tool. */
  claude: string | null
  /** pi's registered tool name. */
  pi: string
  /** Further Claude spellings accepted when reading a grant: renamed tools and
   * secondary tools that share one pi implementation. Never used for payloads. */
  aliases?: string[]
}

const TOOL_NAMES: ToolNamePair[] = [
  { claude: 'Read', pi: 'read' },
  { claude: 'Write', pi: 'write' },
  { claude: 'Edit', pi: 'edit' },
  { claude: 'Bash', pi: 'bash' },
  { claude: 'Grep', pi: 'grep' },
  { claude: 'Glob', pi: 'find' },
  { claude: 'WebFetch', pi: 'web_fetch' },
  { claude: 'WebSearch', pi: 'web_search' },
  // `Task` was renamed `Agent`; both spellings resolve, the payload reports `Agent`.
  { claude: 'Agent', pi: 'subagent', aliases: ['Task'] },
  { claude: 'AskUserQuestion', pi: 'question' },
  { claude: 'ExitPlanMode', pi: 'plan_mode_complete' },
  // Custom commands were folded into skills and the reference no longer lists a
  // SlashCommand tool, so `Skill` is canonical and `SlashCommand` is the legacy name.
  { claude: 'Skill', pi: 'slash_command', aliases: ['SlashCommand'] },
  // pi's single todo tool serves Claude's whole todo/task-list family. Claude now
  // prefers TaskCreate/TaskGet/TaskList/TaskUpdate over TodoWrite/TodoRead; every
  // spelling resolves so an allowed-tools entry naming the current tools still grants
  // something, and TodoWrite stays the name a payload reports.
  { claude: 'TodoWrite', pi: 'todo', aliases: ['TodoRead', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'] },
  // pi tools the tools reference has no entry for.
  { claude: null, pi: 'ls', aliases: ['LS'] },
]

const fold = (name: string): string => name.trim().toLowerCase()

/** Every Claude spelling -> pi tool name, for reading a grant list. Includes each
 * pi name itself so a list written in pi's own vocabulary still resolves. */
export const CLAUDE_TOOL_MAP: Record<string, string> = Object.fromEntries(TOOL_NAMES.flatMap(({ claude, pi, aliases }) => [...(claude === null ? [] : [[fold(claude), pi]]), ...(aliases ?? []).map((alias) => [fold(alias), pi]), [fold(pi), pi]]))

const PI_TO_CLAUDE: Record<string, string> = Object.fromEntries(TOOL_NAMES.filter((pair): pair is ToolNamePair & { claude: string } => pair.claude !== null).map(({ claude, pi }) => [pi, claude]))

/** pi built-in -> canonical Claude tool name for hook payloads and matchers, or
 * undefined for a pi tool the reference has no counterpart for. MCP tools ride the
 * alias bus instead and never reach here. */
export function claudeToolName(piName: string): string | undefined {
  return PI_TO_CLAUDE[piName]
}
