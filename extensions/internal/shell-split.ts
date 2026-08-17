/**
 * Quote-aware splitting of a shell command into its top-level segments.
 *
 * Shared by plan mode's bash guard and the commands extension's allowed-tools
 * scope enforcement: both vet each subcommand on its own, and both refuse to
 * guess when the shell could be hiding another command.
 */

// The shell can hide an arbitrary command inside any of these, so callers refuse
// such a command outright rather than parse it.
const SUBSTITUTION = /\$\(|`|<\(|>\(/

export const hasSubstitution = (command: string): boolean => SUBSTITUTION.test(command)

/** Length of the separator at `i`, or 0 when there is none. */
function separatorAt(command: string, i: number): number {
  const pair = command.slice(i, i + 2)
  if (pair === '&&' || pair === '||' || pair === '|&') return 2
  const ch = command[i]
  return ch === ';' || ch === '|' || ch === '&' || ch === '\n' ? 1 : 0
}

/**
 * Split on the shell separators Claude Code documents (`&&`, `||`, `;`, `|`, `|&`, `&`,
 * newline) so every subcommand is checked on its own, ignoring separators inside quotes:
 * `grep 'a|b'` is one read, not a pipe. Returns nothing on an unbalanced quote, which
 * fails the caller closed rather than guessing at the intended split.
 *
 * A shell AST would be exact; this is the honest approximation for a quoting-only concern.
 */
export function splitSegments(command: string): string[] {
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
