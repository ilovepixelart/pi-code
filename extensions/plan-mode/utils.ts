/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-d|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
]

// Safe read-only commands allowed in plan mode. Deliberately excludes env/printenv
// (secret disclosure, and env is an exec wrapper), curl/wget (fetch plus -o writes),
// awk (system()) and sed (w/W/e write even under -n).
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*jq\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
]

// The shell can hide an arbitrary command inside any of these, so they are refused
// outright rather than parsed.
const SUBSTITUTION = /\$\(|`|<\(|>\(/

/**
 * Split on the shell separators Claude Code documents (`&&`, `||`, `;`, `|`, `|&`, `&`,
 * newline) so every subcommand is checked on its own, ignoring separators inside quotes:
 * `grep 'a|b'` is one read, not a pipe. Returns nothing on an unbalanced quote, which
 * fails the caller closed rather than guessing at the intended split.
 *
 * A shell AST would be exact; this is the honest approximation for a quoting-only concern.
 */
/** Length of the separator at `i`, or 0 when there is none. */
function separatorAt(command: string, i: number): number {
  const pair = command.slice(i, i + 2)
  if (pair === '&&' || pair === '||' || pair === '|&') return 2
  const ch = command[i]
  return ch === ';' || ch === '|' || ch === '&' || ch === '\n' ? 1 : 0
}

function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== undefined) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[++i]
      continue
    }
    const separator = separatorAt(command, i)
    if (separator > 0) {
      segments.push(current)
      current = ''
      i += separator - 1
      continue
    }
    current += ch
  }

  if (quote !== undefined) return []
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

// find is allowlisted for traversal only; these actions run commands or delete.
const FIND_ACTIONS = /\s-(exec|execdir|ok|okdir|delete|fls|fprint|fprintf)\b/

function isSafeSegment(segment: string): boolean {
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(segment))) return false
  if (!SAFE_PATTERNS.some((p) => p.test(segment))) return false
  return !(/^\s*find\b/.test(segment) && FIND_ACTIONS.test(segment))
}

/**
 * Whether plan mode should let this bash command run.
 *
 * Model steering, not a sandbox: an allowlisted interpreter can still read and write
 * whatever the user can, so this narrows the blast radius of a wrong turn rather than
 * containing a determined one. Only OS-level isolation would be a boundary.
 */
export function isSafeCommand(command: string): boolean {
  if (SUBSTITUTION.test(command)) return false
  const segments = splitSegments(command)
  return segments.length > 0 && segments.every(isSafeSegment)
}

export interface TodoItem {
  step: number
  text: string
  completed: boolean
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // Remove bold/italic
    .replace(/`([^`]+)`/g, '$1') // Remove code
    .replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`
  }
  return cleaned
}

// Anchored to line start (m flag) so a prose line merely ending in "plan:" is not taken
// for the header, which would slice the plan section mid-list and drop earlier steps.
// Horizontal whitespace only ([^\S\n]): \s would include \n itself and overlap the
// following \n. The runs are bounded rather than unbounded: an unbounded run retried
// from every position on a long whitespace-only line is what backtracks super-linearly,
// and a real header carries at most a few spaces of indentation.
const PLAN_HEADER = /^[^\S\n]{0,8}\*{0,2}Plan:\*{0,2}[^\S\n]{0,8}\n/im

const isBlank = (ch: string | undefined): boolean => ch !== undefined && ch !== '\n' && ch.trim() === ''

/**
 * Text of a `1. step` / `2) step` line, stopping at an inline `*`, or undefined when
 * the line is not a numbered step. Scanned rather than matched: the equivalent
 * pattern needs adjacent quantifiers over overlapping classes, which backtracks
 * super-linearly on a long line that turns out not to be a step.
 */
function numberedStepText(line: string): string | undefined {
  let i = 0
  while (isBlank(line[i])) i++

  const digitsStart = i
  while (line[i] >= '0' && line[i] <= '9') i++
  if (i === digitsStart) return undefined

  if (line[i] !== '.' && line[i] !== ')') return undefined
  i++

  const spaceStart = i
  while (isBlank(line[i])) i++
  if (i === spaceStart) return undefined // the marker must be followed by whitespace

  for (let stars = 0; stars < 2 && line[i] === '*'; stars++) i++
  const first = line[i]
  if (first === undefined || first === '*' || isBlank(first)) return undefined

  const rest = line.slice(i)
  const star = rest.indexOf('*')
  return star === -1 ? rest : rest.slice(0, star)
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = []
  const headerMatch = PLAN_HEADER.exec(message)
  if (!headerMatch) return items

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length)

  for (const line of planSection.split('\n')) {
    const captured = numberedStepText(line)
    if (captured === undefined) continue
    const text = captured
      .trim()
      .replace(/\*{1,2}$/, '')
      .trim()
    if (text.length > 5 && !text.startsWith('`') && !text.startsWith('/') && !text.startsWith('-')) {
      const cleaned = cleanStepText(text)
      if (cleaned.length > 3) {
        items.push({ step: items.length + 1, text: cleaned, completed: false })
      }
    }
  }
  return items
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = []
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1])
    if (Number.isFinite(step)) steps.push(step)
  }
  return steps
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text)
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step)
    if (item) item.completed = true
  }
  return doneSteps.length
}

/**
 * Parse an explicitly submitted plan (from the plan_mode_complete tool) into
 * todo items. Unlike extractTodoItems, the Plan: header is optional because
 * the tool input is already known to be the plan itself.
 */
export function planToTodos(plan: string): TodoItem[] {
  const withHeader = PLAN_HEADER.test(plan) ? plan : `Plan:\n${plan}`
  return extractTodoItems(withHeader)
}
