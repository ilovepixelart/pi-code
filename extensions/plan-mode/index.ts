/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { Key } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { PLAN_MODE_CHANNEL } from '../internal/plan-mode-state.js'
import { extractTodoItems, isSafeCommand, markCompletedSteps, planToTodos, type TodoItem } from './utils.js'

// Tools
const PLAN_MODE_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'question', 'plan_mode_complete']

/** Agent runs in execution mode with no [DONE:n] progress before execution ends on
 * its own. Kept small: each stalled run re-injects the stale plan into the turn. */
const STALLED_RUN_LIMIT = 2

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === 'assistant' && Array.isArray(m.content)
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

// Last element matching the predicate (the lib target predates Array.prototype.findLast)
function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i])) return items[i]
  }
  return undefined
}

// Index of the last plan-mode-execute entry, or -1 when the current run never started one
function findLastExecuteIndex(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { customType?: string }
    if (entry.customType === 'plan-mode-execute') return i
  }
  return -1
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false
  let executionMode = false
  let todoItems: TodoItem[] = []
  let planFromTool = false
  let savedTools: string[] = []
  let stalledRuns = 0
  let runProgress = false

  function enterPlanTools(): void {
    savedTools = pi.getActiveTools()
    pi.setActiveTools(PLAN_MODE_TOOLS.filter((t) => savedTools.includes(t)))
  }

  function restoreTools(): void {
    if (savedTools.length > 0) {
      pi.setActiveTools(savedTools)
    }
  }

  /** Hooks report Claude's permission_mode from this bus state. */
  function publishPlanState(): void {
    pi.events.emit(PLAN_MODE_CHANNEL, { active: planModeEnabled })
  }

  pi.registerFlag('plan', {
    description: 'Start in plan mode (read-only exploration)',
    type: 'boolean',
    default: false,
  })

  function updateStatus(ctx: ExtensionContext): void {
    // Footer status
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length
      ctx.ui.setStatus('plan-mode', ctx.ui.theme.fg('accent', `📋 ${completed}/${todoItems.length}`))
    } else if (planModeEnabled) {
      ctx.ui.setStatus('plan-mode', ctx.ui.theme.fg('warning', '⏸ plan'))
    } else {
      ctx.ui.setStatus('plan-mode', undefined)
    }

    // Widget showing todo list
    if (executionMode && todoItems.length > 0) {
      const lines = todoItems.map((item) => {
        if (item.completed) {
          return ctx.ui.theme.fg('success', '☑ ') + ctx.ui.theme.fg('muted', ctx.ui.theme.strikethrough(item.text))
        }
        return `${ctx.ui.theme.fg('muted', '☐ ')}${item.text}`
      })
      ctx.ui.setWidget('plan-todos', lines)
    } else {
      ctx.ui.setWidget('plan-todos', undefined)
    }
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled
    executionMode = false
    todoItems = []
    planFromTool = false
    stalledRuns = 0
    runProgress = false

    if (planModeEnabled) {
      enterPlanTools()
      ctx.ui.notify(`Plan mode enabled. Tools: ${pi.getActiveTools().join(', ')}`)
    } else {
      restoreTools()
      ctx.ui.notify('Plan mode disabled. Full access restored.')
    }
    // Persist the toggle so a resume does not restore a state the user left.
    persistState()
    publishPlanState()
    updateStatus(ctx)
  }

  function persistState(): void {
    pi.appendEntry('plan-mode', {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
      // The pre-plan tool set has to survive with the state that caused it to shrink.
      // /reload rebuilds this extension with an empty snapshot while pi carries the
      // restricted tools into the new runtime, so a restore has no way to work out
      // what was active before plan mode unless it was written down here.
      savedTools,
    })
  }

  function endExecution(ctx: ExtensionContext, content: string): void {
    pi.sendMessage({ customType: 'plan-complete', content, display: true }, { triggerTurn: false })
    executionMode = false
    todoItems = []
    restoreTools()
    updateStatus(ctx)
    persistState() // Save cleared state so resume doesn't restore old execution mode
  }

  // Announce completion and reset once every step is done
  function finalizeCompletedExecution(ctx: ExtensionContext): void {
    if (!todoItems.every((t) => t.completed)) return
    const completedList = todoItems.map((t) => `~~${t.text}~~`).join('\n')
    endExecution(ctx, `**Plan Complete!** ✓\n\n${completedList}`)
  }

  /** Models regularly drop or renumber a [DONE:n] marker; without a bounded exit the
   * stale plan would be injected into every later turn until the user finds /plan. */
  function endStalledExecution(ctx: ExtensionContext): void {
    const remaining = todoItems
      .filter((t) => !t.completed)
      .map((t) => `${t.step}. ${t.text}`)
      .join('\n')
    endExecution(ctx, `**Plan execution ended** after ${STALLED_RUN_LIMIT} turns without step progress. Unfinished steps:\n\n${remaining}`)
  }

  // Fall back to extracting a plan from the last assistant message's prose
  function deriveTodosFromProse(messages: AgentMessage[]): void {
    const lastAssistant = [...messages].reverse().find(isAssistantMessage)
    if (!lastAssistant) return
    const extracted = extractTodoItems(getTextContent(lastAssistant))
    if (extracted.length > 0) {
      todoItems = extracted
    }
  }

  // Ask the user how to proceed after a plan is ready
  async function promptPlanNextAction(ctx: ExtensionContext): Promise<void> {
    const choice = await ctx.ui.select('Plan mode - what next?', [todoItems.length > 0 ? 'Execute the plan (track progress)' : 'Execute the plan', 'Stay in plan mode', 'Refine the plan'])

    if (choice?.startsWith('Execute')) {
      planModeEnabled = false
      executionMode = todoItems.length > 0
      planFromTool = false
      stalledRuns = 0
      runProgress = false
      restoreTools()
      publishPlanState()
      updateStatus(ctx)

      // Persist before the turn: a crash before the first turn_end must resume into
      // execution, not back into plan mode.
      persistState()
      const execMessage = todoItems.length > 0 ? `Execute the plan. Start with: ${todoItems[0].text}` : 'Execute the plan you just created.'
      pi.sendMessage({ customType: 'plan-mode-execute', content: execMessage, display: true }, { triggerTurn: true })
    } else if (choice === 'Refine the plan') {
      // The refined turn may answer in prose; without this reset agent_end would skip
      // deriveTodosFromProse and re-display the superseded todo list.
      planFromTool = false
      const refinement = await ctx.ui.editor('Refine the plan:', '')
      if (refinement?.trim()) {
        // A bare send throws (and is silently swallowed) while the agent is
        // streaming, so mid-stream invocations queue as a follow-up turn.
        pi.sendUserMessage(refinement.trim(), ctx.isIdle() ? {} : { deliverAs: 'followUp' })
      }
    }
  }

  // Rebuild completion state from assistant messages after the last execute marker
  function rescanCompletion(entries: SessionEntry[]): void {
    const executeIndex = findLastExecuteIndex(entries)
    const messages: AssistantMessage[] = []
    for (let i = executeIndex + 1; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.type === 'message' && 'message' in entry && isAssistantMessage(entry.message as AgentMessage)) {
        messages.push(entry.message as AssistantMessage)
      }
    }
    markCompletedSteps(messages.map(getTextContent).join('\n'), todoItems)
  }

  pi.registerCommand('plan', {
    description: 'Toggle plan mode (read-only exploration)',
    handler: async (_args, ctx) => togglePlanMode(ctx),
  })

  pi.registerTool({
    name: 'plan_mode_complete',
    label: 'Plan complete',
    description: 'Submit the finished plan for user review while in plan mode. Pass the full plan as numbered steps (1. ... 2. ...). Call this exactly once, when the plan is ready.',
    parameters: Type.Object({ plan: Type.String({ description: 'The complete numbered plan' }) }),
    async execute(_id, params) {
      if (!planModeEnabled) {
        return { content: [{ type: 'text', text: 'Not in plan mode; tool ignored.' }], details: {} }
      }
      todoItems = planToTodos(params.plan)
      planFromTool = true
      persistState()
      return { content: [{ type: 'text', text: 'Plan submitted. The user will now review it.' }], details: {}, terminate: true }
    },
  })

  pi.registerCommand('plan-todos', {
    description: 'Show current plan todo list',
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify('No todos. Create a plan first with /plan', 'info')
        return
      }
      const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? '✓' : '○'} ${item.text}`).join('\n')
      ctx.ui.notify(`Plan Progress:\n${list}`, 'info')
    },
  })

  pi.registerShortcut(Key.ctrlAlt('p'), {
    description: 'Toggle plan mode',
    handler: async (ctx) => togglePlanMode(ctx),
  })

  // Enforce plan mode at call time, not only through the active-tool set: pi
  // activates tools registered after the restriction was applied (an MCP server
  // connecting during session_start, or a mid-session list_changed refresh), so the
  // set alone leaks write-capable tools into plan mode.
  pi.on('tool_call', async (event) => {
    if (!planModeEnabled) return
    if (!PLAN_MODE_TOOLS.includes(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode: tool blocked (read-only mode). Use /plan to disable plan mode first.\nTool: ${event.toolName}`,
      }
    }
    if (event.toolName !== 'bash') return

    const command = event.input.command as string
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
      }
    }
  })

  // Filter out stale plan mode context when not in plan mode
  pi.on('context', async (event) => {
    if (planModeEnabled) return

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string }
        if (msg.customType === 'plan-mode-context') return false
        if (msg.customType === 'plan-execution-context' && !executionMode) return false
        if (msg.role !== 'user') return true

        const content = msg.content
        if (typeof content === 'string') {
          return !content.includes('[PLAN MODE ACTIVE]')
        }
        if (Array.isArray(content)) {
          return !content.some((c) => c.type === 'text' && (c as TextContent).text?.includes('[PLAN MODE ACTIVE]'))
        }
        return true
      }),
    }
  })

  // Inject plan/execution context before agent starts
  pi.on('before_agent_start', async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: 'plan-mode-context',
          content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, question
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is limited to an allowlist of read-only commands, checked per subcommand. Treat it
  as a reminder of intent, not a sandbox: do not look for ways around it

Ask clarifying questions using the question tool.

When your plan is ready, call the plan_mode_complete tool with the full plan as numbered steps:

1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
          display: false,
        },
      }
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed)
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join('\n')
      return {
        message: {
          customType: 'plan-execution-context',
          content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
          display: false,
        },
      }
    }
  })

  // Track progress after each turn
  pi.on('turn_end', async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return
    if (!isAssistantMessage(event.message)) return

    const text = getTextContent(event.message)
    if (markCompletedSteps(text, todoItems) > 0) {
      runProgress = true
      updateStatus(ctx)
    }
    persistState()
  })

  // Handle plan completion and plan mode UI
  pi.on('agent_end', async (event, ctx) => {
    // Check if execution is complete, or has stalled without marker progress
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        finalizeCompletedExecution(ctx)
        stalledRuns = 0
      } else if (runProgress) {
        stalledRuns = 0
      } else {
        stalledRuns++
        if (stalledRuns >= STALLED_RUN_LIMIT) endStalledExecution(ctx)
      }
      runProgress = false
      return
    }

    if (!planModeEnabled || !ctx.hasUI) return

    // Prefer an explicitly submitted plan; fall back to extracting from prose
    if (!planFromTool) {
      deriveTodosFromProse(event.messages)
    }

    // Show plan steps and prompt for next action
    if (todoItems.length > 0) {
      const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join('\n')
      pi.sendMessage(
        {
          customType: 'plan-todo-list',
          content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
          display: true,
        },
        { triggerTurn: false },
      )
    }

    await promptPlanNextAction(ctx)
  })

  // Restore state on session start/resume
  pi.on('session_start', async (_event, ctx) => {
    // One extension instance serves every session, so clear prior state first: a fresh
    // session (/new, no plan entry) must not inherit the last session's plan or execution.
    planModeEnabled = false
    executionMode = false
    todoItems = []
    planFromTool = false
    stalledRuns = 0
    runProgress = false

    if (pi.getFlag('plan') === true) {
      planModeEnabled = true
    }

    const entries = ctx.sessionManager.getEntries()

    // Restore persisted state
    const planModeEntry = findLast(entries, (e: { type: string; customType?: string }) => e.type === 'custom' && e.customType === 'plan-mode') as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean; savedTools?: string[] } } | undefined

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled
      todoItems = planModeEntry.data.todos ?? todoItems
      executionMode = planModeEntry.data.executing ?? executionMode
    }
    publishPlanState()

    // On resume: re-scan messages after the last "plan-mode-execute" to rebuild
    // completion state without picking up [DONE:n] from previous plans
    const isResume = planModeEntry !== undefined
    if (isResume && executionMode && todoItems.length > 0) {
      rescanCompletion(entries)
    }

    if (planModeEnabled) {
      // Restoring into plan mode is the only case the recorded snapshot is for.
      // Re-reading the active set here would capture the restriction pi carried
      // across /reload and cost the session edit and write for good; applying the
      // snapshot when plan mode is off would instead push a stale set over whatever
      // pi has registered since, so it stays scoped to this branch.
      savedTools = planModeEntry?.data?.savedTools ?? pi.getActiveTools()
      pi.setActiveTools(PLAN_MODE_TOOLS.filter((t) => savedTools.includes(t)))
      // --plan enters plan mode without ever toggling, so nothing has persisted yet
      // and a /reload would find no snapshot to restore from. Record it now, while
      // the active set still says what was there before the restriction.
      //
      // Only with no entry at all: an entry written before this field existed means
      // the active set has already been through a restore and may be the restriction
      // itself. Those tools are lost for this process either way, but persisting a
      // guess would write the loss into the session file, where a later resume would
      // inherit it instead of starting over.
      if (!planModeEntry) persistState()
    } else {
      // A prior session in this instance may have shrunk the tool set; undo that when
      // the restored/fresh state is not plan mode.
      restoreTools()
    }
    updateStatus(ctx)
  })
}
