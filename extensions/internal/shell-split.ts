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

/** One step inside a quote at `i`: an escape takes the backslash and the character after
 * it (where this quote has escapes), anything else one character, which may close it. */
function stepInQuote(text: string, i: number, quote: Quote): { taken: number; closes: boolean } {
  if (text[i] === '\\' && quoteEscapes(quote) && i + 1 < text.length) return { taken: 2, closes: false }
  return { taken: 1, closes: text[i] === quoteCloser(quote) }
}

/** Characters an unquoted step at `i` takes: a backslash and the character it escapes, or one. */
const unquotedStep = (text: string, i: number): number => (text[i] === '\\' && i + 1 < text.length ? 2 : 1)

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

  for (let i = 0; i < command.length; ) {
    if (quote !== undefined) {
      const step = stepInQuote(command, i, quote)
      current += command.slice(i, i + step.taken)
      if (step.closes) quote = undefined
      i += step.taken
      continue
    }
    const opened = quoteOpensAt(command, i)
    const separator = opened === undefined ? separatorAt(command, i) : 0
    const taken = opened?.length ?? (separator > 0 ? separator : unquotedStep(command, i))
    if (separator > 0) {
      segments.push(current)
      current = ''
    } else current += command.slice(i, i + taken)
    if (opened !== undefined) quote = opened.quote
    i += taken
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

/** The characters an unquoted step at `i` adds to a word: an escaped character alone. */
const wordChars = (text: string, i: number): string => (unquotedStep(text, i) === 2 ? escaped(undefined, text[i + 1]) : text[i])

/**
 * The words of one segment as the command receives them, after bash's quote removal:
 * `'-delete'`, `-de'lete'` and `$'-o'` are the words `-delete` and `-o`, so a flag cannot
 * hide behind quoting. An empty quoted argument is still a word.
 */
export function shellWords(segment: string): string[] {
  const words: string[] = []
  // undefined between words; a quoted empty argument is the word ''.
  let word: string | undefined
  let quote: Quote | undefined
  for (let i = 0; i < segment.length; ) {
    if (quote !== undefined) {
      const step = stepInQuote(segment, i, quote)
      if (step.taken === 2) word = `${word ?? ''}${escaped(quote, segment[i + 1])}`
      else if (!step.closes) word = `${word ?? ''}${segment[i]}`
      if (step.closes) quote = undefined
      i += step.taken
      continue
    }
    const opened = quoteOpensAt(segment, i)
    if (opened !== undefined) quote = opened.quote
    if (opened !== undefined || !/\s/.test(segment[i])) word = `${word ?? ''}${opened ? '' : wordChars(segment, i)}`
    else if (word !== undefined) {
      words.push(word)
      word = undefined
    }
    i += opened?.length ?? unquotedStep(segment, i)
  }
  if (word !== undefined) words.push(word)
  return words
}

/** Whether an ANSI-C $'...' string uses a numeric or control escape (`\x2d`, `\055`,
 * `\u002d`, `\cA`), which can spell any character, a flag's dash included. */
export const hasAnsiCNumericEscape = (command: string): boolean => /\$'(?:[^'\\]|\\.)*?\\[xuU0-7c]/.test(command)
