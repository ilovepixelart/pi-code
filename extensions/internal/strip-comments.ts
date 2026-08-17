/**
 * Block-level HTML comment stripping for context and rule files.
 *
 * Claude Code strips block-level HTML comments (`<!-- maintainer notes -->`)
 * from CLAUDE.md files before injection, while preserving comments inside code
 * blocks. "Block-level" is read as whole-line-anchored: a comment counts only
 * when it starts a line (after optional indentation) and nothing but comments
 * and whitespace occupy the line(s) it spans; those lines are removed entirely,
 * a multi-line comment with every line it covers. A comment sharing a line with
 * real content is inline prose and stays verbatim, as does anything inside a
 * fenced code block (backtick or tilde).
 */

/** The fence a line opens or closes, if any; mirrors context-imports. */
export function fenceMarker(lineStart: string): string | null {
  if (lineStart.startsWith('```')) return '`'
  if (lineStart.startsWith('~~~')) return '~'
  return null
}

/** Length of the fence run starting `lineStart`, a run of `marker` characters. */
function fenceLength(lineStart: string, marker: string): number {
  let length = 0
  while (length < lineStart.length && lineStart[length] === marker) length++
  return length
}

/** Remove whole-line HTML comments, keeping fenced code and inline comments. */
export function stripBlockComments(text: string): string {
  const out: string[] = []
  // CommonMark closes a fenced block only with a fence of the same character
  // that is at least as long as the opener, so both are tracked: a shorter
  // same-char fence line (the classic 3-backtick block quoted inside a
  // 4-backtick one) is content, not a closer.
  let fence: { marker: string; length: number } | null = null
  let inComment = false
  for (const line of text.split('\n')) {
    if (inComment) {
      const close = line.indexOf('-->')
      if (close === -1) continue // still inside the comment: the line goes with it
      inComment = false
      const rest = line.slice(close + 3)
      // Content trailing the closer keeps its line; a bare closer line is dropped.
      if (rest.trim().length > 0) out.push(rest.trimStart())
      continue
    }
    const trimmed = line.trimStart()
    const marker = fenceMarker(trimmed)
    if (marker !== null && fence === null) {
      fence = { marker, length: fenceLength(trimmed, marker) }
      out.push(line)
      continue
    }
    if (fence !== null) {
      if (marker === fence.marker && fenceLength(trimmed, marker) >= fence.length) fence = null
      out.push(line) // fenced code, closer included: comments are content, not maintainer notes
      continue
    }
    // Consume comments anchored at the line start; several may share one line.
    let rest = trimmed
    let sawComment = false
    while (rest.startsWith('<!--')) {
      sawComment = true
      const close = rest.indexOf('-->')
      if (close === -1) {
        inComment = true // opens a multi-line comment
        rest = ''
        break
      }
      rest = rest.slice(close + 3).trimStart()
    }
    if (sawComment && rest.length === 0) continue // the whole line was comment
    // No comment, or a line-starting comment followed by content: inline, verbatim.
    out.push(line)
  }
  return out.join('\n')
}
