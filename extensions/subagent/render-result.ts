/**
 * How a subagent call and its results are drawn in the transcript: the collapsed and
 * expanded forms for a single run, a chain and a parallel batch.
 *
 * Split from the extension body, which was the only place these lived, so the factory
 * keeps the schema, the dispatch and the session hooks; nothing here touches process
 * state, and these are the only users of the tui container and markdown widgets.
 */

import type { getMarkdownTheme, Theme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'

import type { AgentScope } from './agents.js'
import { type DisplayItem, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput } from './render.js'
import type { SingleResult } from './types.js'

const COLLAPSED_ITEM_COUNT = 10

interface CallItem {
  agent: string
  task: string
}

export function renderChainCall(chain: CallItem[], scope: AgentScope | undefined, theme: Theme): Text {
  let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', `chain (${chain.length} steps)`) + scopeTag(scope, theme)
  for (let i = 0; i < Math.min(chain.length, 3); i++) {
    const step = chain[i]
    // Clean up {previous} placeholder for display
    const cleanTask = step.task.replaceAll('{previous}', '').trim()
    const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask
    const stepNumber = theme.fg('muted', `${i + 1}.`)
    const stepLabel = theme.fg('accent', step.agent) + theme.fg('dim', ` ${preview}`)
    text += `\n  ${stepNumber} ${stepLabel}`
  }
  if (chain.length > 3) {
    const more = theme.fg('muted', `... +${chain.length - 3} more`)
    text += `\n  ${more}`
  }
  return new Text(text, 0, 0)
}

export function renderParallelCall(tasks: CallItem[], scope: AgentScope | undefined, theme: Theme): Text {
  let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', `parallel (${tasks.length} tasks)`) + scopeTag(scope, theme)
  for (const t of tasks.slice(0, 3)) {
    const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task
    const taskLabel = theme.fg('accent', t.agent) + theme.fg('dim', ` ${preview}`)
    text += `\n  ${taskLabel}`
  }
  if (tasks.length > 3) {
    const more = theme.fg('muted', `... +${tasks.length - 3} more`)
    text += `\n  ${more}`
  }
  return new Text(text, 0, 0)
}

const scopeTag = (scope: AgentScope | undefined, theme: Theme): string => (scope ? theme.fg('muted', ` [${scope}]`) : '')

export function renderSingleCall(agent: string | undefined, task: string | undefined, scope: AgentScope | undefined, theme: Theme): Text {
  const agentName = agent || '...'
  let preview = '...'
  if (task) preview = task.length > 60 ? `${task.slice(0, 60)}...` : task
  let text = theme.fg('toolTitle', theme.bold('subagent ')) + theme.fg('accent', agentName) + scopeTag(scope, theme)
  text += `\n  ${theme.fg('dim', preview)}`
  return new Text(text, 0, 0)
}

type MarkdownTheme = ReturnType<typeof getMarkdownTheme>

function aggregateUsage(results: SingleResult[]) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
  for (const r of results) {
    total.input += r.usage.input
    total.output += r.usage.output
    total.cacheRead += r.usage.cacheRead
    total.cacheWrite += r.usage.cacheWrite
    total.cost += r.usage.cost
    total.turns += r.usage.turns
  }
  return total
}

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme, limit?: number): string {
  const toShow = limit ? items.slice(-limit) : items
  const skipped = limit && items.length > limit ? items.length - limit : 0
  let text = ''
  if (skipped > 0) text += theme.fg('muted', `... ${skipped} earlier items\n`)
  for (const item of toShow) {
    if (item.type === 'text') {
      const preview = expanded ? item.text : item.text.split('\n').slice(0, 3).join('\n')
      text += `${theme.fg('toolOutput', preview)}\n`
    } else {
      text += `${theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`
    }
  }
  return text.trimEnd()
}

function addToolCallNodes(container: Container, items: DisplayItem[], theme: Theme): void {
  for (const item of items) {
    if (item.type === 'toolCall') {
      container.addChild(new Text(theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0))
    }
  }
}

function addTotalUsage(container: Container, results: SingleResult[], theme: Theme): void {
  const usageStr = formatUsageStats(aggregateUsage(results))
  if (usageStr) {
    container.addChild(new Spacer(1))
    const totalLine = theme.fg('dim', `Total: ${usageStr}`)
    container.addChild(new Text(totalLine, 0, 0))
  }
}

function renderSingleExpanded(r: SingleResult, isError: boolean, icon: string, theme: Theme, mdTheme: MarkdownTheme): Container {
  const container = new Container()
  const source = theme.fg('muted', ` (${r.agentSource})`)
  let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${source}`
  if (isError && r.stopReason) {
    const reason = theme.fg('error', `[${r.stopReason}]`)
    header += ` ${reason}`
  }
  container.addChild(new Text(header, 0, 0))
  if (isError && r.errorMessage) container.addChild(new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0))
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0))
  container.addChild(new Text(theme.fg('dim', r.task), 0, 0))
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0))

  const displayItems = getDisplayItems(r.messages)
  const finalOutput = getFinalOutput(r.messages)
  if (displayItems.length === 0 && !finalOutput) {
    container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
  } else {
    addToolCallNodes(container, displayItems, theme)
    if (finalOutput) {
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
    }
  }

  const usageStr = formatUsageStats(r.usage, r.model)
  if (usageStr) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim', usageStr), 0, 0))
  }
  return container
}

function renderSingleCollapsed(r: SingleResult, isError: boolean, icon: string, theme: Theme, expanded: boolean): Text {
  const displayItems = getDisplayItems(r.messages)
  const source = theme.fg('muted', ` (${r.agentSource})`)
  let text = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${source}`
  if (isError && r.stopReason) {
    const reason = theme.fg('error', `[${r.stopReason}]`)
    text += ` ${reason}`
  }
  if (isError && r.errorMessage) {
    const errorLine = theme.fg('error', `Error: ${r.errorMessage}`)
    text += `\n${errorLine}`
  } else if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`
  else {
    text += `\n${renderDisplayItems(displayItems, expanded, theme, COLLAPSED_ITEM_COUNT)}`
    if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
  }
  const usageStr = formatUsageStats(r.usage, r.model)
  if (usageStr) text += `\n${theme.fg('dim', usageStr)}`
  return new Text(text, 0, 0)
}

export function renderSingleResult(r: SingleResult, expanded: boolean, theme: Theme, mdTheme: MarkdownTheme): Container | Text {
  const isError = r.exitCode !== 0 || r.stopReason === 'error' || r.stopReason === 'aborted'
  const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
  if (expanded) return renderSingleExpanded(r, isError, icon, theme, mdTheme)
  return renderSingleCollapsed(r, isError, icon, theme, expanded)
}

function renderChainExpanded(results: SingleResult[], successCount: number, icon: string, theme: Theme, mdTheme: MarkdownTheme): Container {
  const container = new Container()
  const summary = theme.fg('accent', `${successCount}/${results.length} steps`)
  container.addChild(new Text(`${icon} ${theme.fg('toolTitle', theme.bold('chain '))}${summary}`, 0, 0))

  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const displayItems = getDisplayItems(r.messages)
    const finalOutput = getFinalOutput(r.messages)

    container.addChild(new Spacer(1))
    const stepLabel = theme.fg('muted', `─── Step ${r.step}: `) + theme.fg('accent', r.agent)
    container.addChild(new Text(`${stepLabel} ${rIcon}`, 0, 0))
    container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0))

    addToolCallNodes(container, displayItems, theme)

    if (finalOutput) {
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
    }

    const stepUsage = formatUsageStats(r.usage, r.model)
    if (stepUsage) container.addChild(new Text(theme.fg('dim', stepUsage), 0, 0))
  }

  addTotalUsage(container, results, theme)
  return container
}

function renderChainCollapsed(results: SingleResult[], successCount: number, icon: string, theme: Theme, expanded: boolean): Text {
  const summary = theme.fg('accent', `${successCount}/${results.length} steps`)
  let text = `${icon} ${theme.fg('toolTitle', theme.bold('chain '))}${summary}`
  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const displayItems = getDisplayItems(r.messages)
    const stepLabel = theme.fg('muted', `─── Step ${r.step}: `)
    text += `\n\n${stepLabel}${theme.fg('accent', r.agent)} ${rIcon}`
    if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`
    else text += `\n${renderDisplayItems(displayItems, expanded, theme, 5)}`
  }
  const usageStr = formatUsageStats(aggregateUsage(results))
  if (usageStr) {
    const totalLine = theme.fg('dim', `Total: ${usageStr}`)
    text += `\n\n${totalLine}`
  }
  text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
  return new Text(text, 0, 0)
}

export function renderChainResult(results: SingleResult[], expanded: boolean, theme: Theme, mdTheme: MarkdownTheme): Container | Text {
  const successCount = results.filter((r) => r.exitCode === 0).length
  const icon = successCount === results.length ? theme.fg('success', '✓') : theme.fg('error', '✗')
  if (expanded) return renderChainExpanded(results, successCount, icon, theme, mdTheme)
  return renderChainCollapsed(results, successCount, icon, theme, expanded)
}

function renderParallelExpanded(results: SingleResult[], icon: string, status: string, theme: Theme, mdTheme: MarkdownTheme): Container {
  const container = new Container()
  const summary = theme.fg('accent', status)
  container.addChild(new Text(`${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${summary}`, 0, 0))

  for (const r of results) {
    const rIcon = r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
    const displayItems = getDisplayItems(r.messages)
    const finalOutput = getFinalOutput(r.messages)

    container.addChild(new Spacer(1))
    const agentLabel = theme.fg('muted', '─── ') + theme.fg('accent', r.agent)
    container.addChild(new Text(`${agentLabel} ${rIcon}`, 0, 0))
    container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0))

    addToolCallNodes(container, displayItems, theme)

    if (finalOutput) {
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
    }

    const taskUsage = formatUsageStats(r.usage, r.model)
    if (taskUsage) container.addChild(new Text(theme.fg('dim', taskUsage), 0, 0))
  }

  addTotalUsage(container, results, theme)
  return container
}

function renderParallelCollapsed(results: SingleResult[], icon: string, status: string, theme: Theme, expanded: boolean, isRunning: boolean): Text {
  const summary = theme.fg('accent', status)
  let text = `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${summary}`
  for (const r of results) {
    let rIcon = theme.fg('error', '✗')
    if (r.exitCode === -1) rIcon = theme.fg('warning', '⏳')
    else if (r.exitCode === 0) rIcon = theme.fg('success', '✓')
    const displayItems = getDisplayItems(r.messages)
    text += `\n\n${theme.fg('muted', '─── ')}${theme.fg('accent', r.agent)} ${rIcon}`
    if (displayItems.length === 0) {
      const placeholder = r.exitCode === -1 ? '(running...)' : '(no output)'
      text += `\n${theme.fg('muted', placeholder)}`
    } else text += `\n${renderDisplayItems(displayItems, expanded, theme, 5)}`
  }
  if (!isRunning) {
    const usageStr = formatUsageStats(aggregateUsage(results))
    if (usageStr) {
      const totalLine = theme.fg('dim', `Total: ${usageStr}`)
      text += `\n\n${totalLine}`
    }
  }
  if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
  return new Text(text, 0, 0)
}

export function renderParallelResult(results: SingleResult[], expanded: boolean, theme: Theme, mdTheme: MarkdownTheme): Container | Text {
  const running = results.filter((r) => r.exitCode === -1).length
  const successCount = results.filter((r) => r.exitCode === 0).length
  const failCount = results.filter((r) => r.exitCode > 0).length
  const isRunning = running > 0

  let icon = theme.fg('success', '✓')
  if (isRunning) icon = theme.fg('warning', '⏳')
  else if (failCount > 0) icon = theme.fg('warning', '◐')

  let status = `${successCount}/${results.length} tasks`
  if (isRunning) status = `${successCount + failCount}/${results.length} done, ${running} running`

  if (expanded && !isRunning) return renderParallelExpanded(results, icon, status, theme, mdTheme)
  return renderParallelCollapsed(results, icon, status, theme, expanded, isRunning)
}
