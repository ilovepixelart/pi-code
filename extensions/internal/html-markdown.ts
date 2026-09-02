/**
 * HTML to markdown conversion for web_fetch, mirroring Claude's WebFetch, which
 * converts pages to markdown before the model reads them.
 *
 * A regex pipeline, not a DOM: pi ships no HTML parser and the output is prose
 * for a model, not a rendering. Every pattern bounds its tag matches with
 * [^<>]* so a failed match stops at the next tag instead of rescanning to the
 * end of input, keeping the pass linear on hostile pages. Bare tag removal is a
 * scanner rather than a regex: see removeTags.
 */

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeAllEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/g, (token, hex?: string, dec?: string, named?: string) => {
    if (named) return NAMED_ENTITIES[named] ?? token
    const code = hex ? Number.parseInt(hex, 16) : Number(dec)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : token
  })
}

/** The HTML tokenizer's tag-open rule: `<` starts a tag only before a letter, `/`,
 * `!`, or `?`; any other `<` (as in `1 < 2`) is text. */
const TAG_OPEN = /^<[A-Za-z/!?]/

/**
 * Drop every tag in one linear pass. A regex strip can rebuild a tag out of nested
 * brackets: `<scr<b>ipt>` loses `<b>` and becomes `<script>` (CodeQL's incomplete
 * multi-character sanitization). Skipping from a tag's `<` to the next `>` removes the
 * whole span, so nothing removed can reassemble; a tag that never closes stays as text.
 */
export function removeTags(html: string): string {
  let out = ''
  let cursor = 0
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor)
    if (open === -1) return out + html.slice(cursor)
    if (!TAG_OPEN.test(html.slice(open, open + 2))) {
      out += html.slice(cursor, open + 1)
      cursor = open + 1
      continue
    }
    const close = html.indexOf('>', open + 1)
    if (close === -1) return out + html.slice(cursor)
    out += html.slice(cursor, open)
    cursor = close + 1
  }
  return out
}

// Strip leading and trailing newline runs in linear time. The equivalent
// /^\n+|\n+$/g backtracks super-linearly on a long run of newlines (S8786).
const trimNewlines = (value: string): string => {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '\n') start++
  while (end > start && value[end - 1] === '\n') end--
  return value.slice(start, end)
}

export function htmlToMarkdown(html: string): string {
  // Pre blocks are lifted out first so no later transform touches their content.
  const preBodies: string[] = []
  let work = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|head|svg)\b[^<>]*>[\s\S]*?<\/\1[^<>]*>/gi, ' ')
    .replace(/<pre\b[^<>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
      preBodies.push(trimNewlines(decodeAllEntities(removeTags(inner))))
      return `\n\n\uE000PRE${preBodies.length - 1}\uE000\n\n`
    })

  work = work
    .replace(/<code\b[^<>]*>([\s\S]*?)<\/code>/gi, (_whole, inner: string) => `\`${removeTags(inner)}\``)
    // Only real web links become markdown links; fragment and javascript hrefs
    // keep their label and lose the target.
    .replace(/<a\b[^<>]*?href=(?:"([^"]*)"|'([^']*)')[^<>]*>([\s\S]*?)<\/a>/gi, (_whole, dq: string | undefined, sq: string | undefined, inner: string) => {
      const href = decodeAllEntities(dq ?? sq ?? '')
      const label = removeTags(inner).trim()
      if (!label) return ' '
      return /^https?:\/\//i.test(href) ? `[${label}](${href})` : label
    })
    .replace(/<(strong|b)\b[^<>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner: string) => `**${removeTags(inner).trim()}**`)
    .replace(/<(em|i)\b[^<>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner: string) => `*${removeTags(inner).trim()}*`)
    .replace(/<h([1-6])\b[^<>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${removeTags(inner).trim()}\n\n`)
    .replace(/<img\b[^<>]*?alt=(?:"([^"]*)"|'([^']*)')[^<>]*>/gi, (_whole, dq?: string, sq?: string) => dq ?? sq ?? '')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^<>]*>/gi, '\n\n> ')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<(?:br|hr)\b[^<>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|ul|ol|li|table|tr|blockquote|tbody|thead|header|footer|main|nav)[^<>]*>/gi, '\n\n')

  const text = decodeAllEntities(removeTags(work))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.replace(/\uE000PRE(\d+)\uE000/g, (_whole, index: string) => `\`\`\`\n${preBodies[Number(index)]}\n\`\`\``)
}
