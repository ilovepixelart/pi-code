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
  // The & of a redirection (`2>&1`, `&>file`) belongs to the command, not between two.
  if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) return 0
  return ch === ';' || ch === '|' || ch === '&' || ch === '\n' ? 1 : 0
}

/** The quoting bash applies: '...' with no escapes, "..." where a backslash escapes the
 * next character, and ANSI-C $'...' where a backslash escapes anything, `\'` included. */
export type Quote = "'" | '"' | "$'"

/** The quote that opens at `i`, if any, and how many characters open it. */
export function quoteOpensAt(command: string, i: number): { quote: Quote; length: number } | undefined {
  const ch = command[i]
  if (ch === "'" || ch === '"') return { quote: ch, length: 1 }
  if (ch === '$' && command[i + 1] === "'") return { quote: "$'", length: 2 }
  return undefined
}

/** Whether a backslash inside this quote escapes the character after it. */
export const quoteEscapes = (quote: Quote): boolean => quote !== "'"

/** The character that closes this quote. */
export const quoteCloser = (quote: Quote): string => (quote === '"' ? '"' : "'")

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
  let quote: Quote | undefined

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== undefined) {
      if (ch === '\\' && quoteEscapes(quote) && i + 1 < command.length) {
        current += ch + command[++i]
        continue
      }
      current += ch
      if (ch === quoteCloser(quote)) quote = undefined
      continue
    }
    const opened = quoteOpensAt(command, i)
    if (opened !== undefined) {
      quote = opened.quote
      current += command.slice(i, i + opened.length)
      i += opened.length - 1
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

// Characters a backslash escapes inside "...": everything else keeps its backslash.
const DOUBLE_QUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n'])

/** One escaped character as bash reads it: inside "..." the backslash stays unless it
 * escapes one of DOUBLE_QUOTE_ESCAPABLE; elsewhere only the character is kept. ANSI-C
 * escapes beyond `\'` and `\\` (`\n`, `\x2d`) keep the bare character, which is enough
 * to read flags; callers that must not guess refuse those with hasAnsiCNumericEscape. */
function escaped(quote: Quote | undefined, next: string): string {
  return quote === '"' && !DOUBLE_QUOTE_ESCAPABLE.has(next) ? `\\${next}` : next
}

/**
 * The words of one segment as the command receives them, after bash's quote removal:
 * `'-delete'`, `-de'lete'` and `$'-o'` are the words `-delete` and `-o`, so a flag cannot
 * hide behind quoting. An empty quoted argument is still a word.
 */
export function shellWords(segment: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: Quote | undefined
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    const opened = quote === undefined ? quoteOpensAt(segment, i) : undefined
    if (ch === '\\' && i + 1 < segment.length && (quote === undefined || quoteEscapes(quote))) {
      word += escaped(quote, segment[++i])
      inWord = true
    } else if (quote !== undefined) {
      if (ch === quoteCloser(quote)) quote = undefined
      else word += ch
    } else if (opened !== undefined) {
      quote = opened.quote
      inWord = true
      i += opened.length - 1
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += ch
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

/** Whether an ANSI-C $'...' string uses a numeric or control escape (`\x2d`, `\055`,
 * `\u002d`, `\cA`), which can spell any character, a flag's dash included. */
export const hasAnsiCNumericEscape = (command: string): boolean => /\$'(?:[^'\\]|\\.)*?\\[xuU0-7c]/.test(command)
