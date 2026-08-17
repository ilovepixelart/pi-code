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

// CommonMark closes a fenced block only with a fence of the same character that
// is at least as long as the opener, so both are tracked: a shorter same-char
// fence line (the classic 3-backtick block quoted inside a 4-backtick one) is
// content, not a closer.
interface Fence {
  marker: string
  length: number
}

/** The fence state after a line, plus whether the line is fenced code (opener,
 * body, or closer) and so emitted verbatim rather than scanned for comments. */
function stepFence(fence: Fence | null, trimmed: string, marker: string | null): { fence: Fence | null; fenced: boolean } {
  if (marker !== null && fence === null) {
    return { fence: { marker, length: fenceLength(trimmed, marker) }, fenced: true }
  }
  if (fence !== null) {
    const closes = marker === fence.marker && fenceLength(trimmed, marker) >= fence.length
    return { fence: closes ? null : fence, fenced: true } // closer included: comments are content, not maintainer notes
  }
  return { fence, fenced: false }
}

/** Advance a line while inside an open multi-line comment. Emits any content that
 * trails the closer onto its own line; returns whether the comment stays open. */
function continueOpenComment(out: string[], line: string): boolean {
  const close = line.indexOf('-->')
  if (close === -1) return true // still inside the comment: the line goes with it
  const rest = line.slice(close + 3)
  // Content trailing the closer keeps its line; a bare closer line is dropped.
  if (rest.trim().length > 0) out.push(rest.trimStart())
  return false
}

/** Fold line-starting HTML comments off `trimmed`; several may share one line.
 * `allComment` means the line held nothing but comments and whitespace, so it is
 * dropped; `opensBlock` means the last comment opened a multi-line block. */
function consumeLineComments(trimmed: string): { allComment: boolean; opensBlock: boolean } {
  let rest = trimmed
  let sawComment = false
  while (rest.startsWith('<!--')) {
    sawComment = true
    const close = rest.indexOf('-->')
    if (close === -1) return { allComment: true, opensBlock: true } // opens a multi-line comment
    rest = rest.slice(close + 3).trimStart()
  }
  return { allComment: sawComment && rest.length === 0, opensBlock: false }
}

/** Remove whole-line HTML comments, keeping fenced code and inline comments. */
export function stripBlockComments(text: string): string {
  const out: string[] = []
  let fence: Fence | null = null
  let inComment = false
  for (const line of text.split('\n')) {
    if (inComment) {
      inComment = continueOpenComment(out, line)
      continue
    }
    const trimmed = line.trimStart()
    const step = stepFence(fence, trimmed, fenceMarker(trimmed))
    fence = step.fence
    if (step.fenced) {
      out.push(line)
      continue
    }
    const { allComment, opensBlock } = consumeLineComments(trimmed)
    if (opensBlock) inComment = true
    if (allComment) continue // the whole line was comment
    // No comment, or a line-starting comment followed by content: inline, verbatim.
    out.push(line)
  }
  return out.join('\n')
}
