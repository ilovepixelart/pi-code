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

/** Every match of the global regex `re` in `html`, as `{start, end}` spans. One linear
 * scan: `matchAll` resumes after each match rather than restarting the search. */
function matchSpans(html: string, re: RegExp): Array<{ start: number; end: number }> {
  return [...html.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

/**
 * Replace every `open...close` span with `transform(open, body)`. `closeSource(open)`
 * gives the close pattern's regex source for this particular open (a fixed literal for
 * most callers; a backreference to `open[1]` for a shared tag family like
 * script|style|noscript, so each open pairs only with its own tag name). An open with no
 * reachable close is left as literal text, the same as a non-matching `[\s\S]*?` regex
 * would leave it.
 *
 * Both the opens and each distinct close pattern are found with one bounded, linear scan
 * (`openRe`'s attrs never cross a `<`/`>`, and neither does a close tag's), then paired by
 * a single forward walk with a cursor per close pattern that only advances. A page that
 * repeats one unclosed tag thousands of times used to cost one rescan to the end of the
 * document per occurrence (O(n^2) for the lazy `[\s\S]*?<\/tag>` shape this replaces);
 * this costs one pass.
 */
function replaceTagSpans(html: string, openRe: RegExp, closeSource: (open: RegExpMatchArray) => string, transform: (open: RegExpMatchArray, body: string) => string): string {
  const opens = [...html.matchAll(openRe)]
  if (opens.length === 0) return html

  const closeSpans = new Map<string, Array<{ start: number; end: number }>>()
  const closeCursor = new Map<string, number>()

  let out = ''
  let cursor = 0
  for (const open of opens) {
    const openStart = open.index ?? 0
    if (openStart < cursor) continue // inside a span an earlier open of this pass already consumed
    const source = closeSource(open)
    if (!closeSpans.has(source)) {
      closeSpans.set(source, matchSpans(html, new RegExp(source, 'gi')))
      closeCursor.set(source, 0)
    }
    const spans = closeSpans.get(source) as Array<{ start: number; end: number }>
    const openEnd = openStart + open[0].length
    let idx = closeCursor.get(source) as number
    while (idx < spans.length && spans[idx].start < openEnd) idx++
    closeCursor.set(source, idx)
    if (idx >= spans.length) continue // no close anywhere after this open: leave it as text
    out += html.slice(cursor, openStart) + transform(open, html.slice(openEnd, spans[idx].start))
    cursor = spans[idx].end
  }
  return out + html.slice(cursor)
}

export function htmlToMarkdown(html: string): string {
  // Pre blocks are lifted out first so no later transform touches their content.
  const preBodies: string[] = []
  // Each of these bodies can legitimately hold anything up to and including another `<`, so
  // the body itself cannot be bounded like an open tag's attrs; replaceTagSpans keeps the
  // pass linear instead by pairing opens and closes in one pass rather than rescanning the
  // document from every open that turns out to have no close (a broken template or a fetch
  // truncated mid-tag repeats that shape often enough to matter).
  let work = replaceTagSpans(
    html,
    /<!--/g,
    () => '-->',
    () => ' ',
  )
  work = replaceTagSpans(
    work,
    /<(script|style|noscript|head|svg)\b[^<>]*>/gi,
    (open) => `</${open[1]}[^<>]*>`,
    () => ' ',
  )
  work = replaceTagSpans(
    work,
    /<pre\b[^<>]*>/gi,
    () => '</pre[^<>]*>',
    (_open, body) => {
      preBodies.push(trimNewlines(decodeAllEntities(removeTags(body))))
      return `\n\n\uE000PRE${preBodies.length - 1}\uE000\n\n`
    },
  )

  work = replaceTagSpans(
    work,
    /<code\b[^<>]*>/gi,
    () => '</code[^<>]*>',
    (_open, body) => `\`${removeTags(body)}\``,
  )
  // Only real web links become markdown links; fragment and javascript hrefs
  // keep their label and lose the target.
  work = replaceTagSpans(
    work,
    /<a\b[^<>]*?href=(?:"([^"]*)"|'([^']*)')[^<>]*>/gi,
    () => '</a[^<>]*>',
    (open, body) => {
      const href = decodeAllEntities(open[1] ?? open[2] ?? '')
      const label = removeTags(body).trim()
      if (!label) return ' '
      return /^https?:\/\//i.test(href) ? `[${label}](${href})` : label
    },
  )
  work = replaceTagSpans(
    work,
    /<(strong|b)\b[^<>]*>/gi,
    (open) => `</${open[1]}[^<>]*>`,
    (_open, body) => `**${removeTags(body).trim()}**`,
  )
  work = replaceTagSpans(
    work,
    /<(em|i)\b[^<>]*>/gi,
    (open) => `</${open[1]}[^<>]*>`,
    (_open, body) => `*${removeTags(body).trim()}*`,
  )
  work = replaceTagSpans(
    work,
    /<h([1-6])\b[^<>]*>/gi,
    (open) => `</h${open[1]}[^<>]*>`,
    (open, body) => `\n\n${'#'.repeat(Number(open[1]))} ${removeTags(body).trim()}\n\n`,
  )

  work = work
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
