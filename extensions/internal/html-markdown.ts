/**
 * HTML to markdown conversion for web_fetch, mirroring Claude's WebFetch, which
 * converts pages to markdown before the model reads them.
 *
 * A regex pipeline, not a DOM: pi ships no HTML parser and the output is prose
 * for a model, not a rendering. Every pattern bounds its tag matches with
 * [^<>]* so a failed match stops at the next tag instead of rescanning to the
 * end of input, keeping the pass linear on hostile pages.
 */

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeAllEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/g, (token, hex?: string, dec?: string, named?: string) => {
    if (named) return NAMED_ENTITIES[named] ?? token
    const code = hex ? Number.parseInt(hex, 16) : Number(dec)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : token
  })
}

const stripInnerTags = (html: string): string => html.replace(/<[^<>]*>/g, '')

export function htmlToMarkdown(html: string): string {
  // Pre blocks are lifted out first so no later transform touches their content.
  const preBodies: string[] = []
  let work = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|head|svg)\b[^<>]*>[\s\S]*?<\/\1[^<>]*>/gi, ' ')
    .replace(/<pre\b[^<>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
      preBodies.push(decodeAllEntities(stripInnerTags(inner)).replace(/^\n+|\n+$/g, ''))
      return `\n\n\uE000PRE${preBodies.length - 1}\uE000\n\n`
    })

  work = work
    .replace(/<code\b[^<>]*>([\s\S]*?)<\/code>/gi, (_whole, inner: string) => `\`${stripInnerTags(inner)}\``)
    // Only real web links become markdown links; fragment and javascript hrefs
    // keep their label and lose the target.
    .replace(/<a\b[^<>]*?href=(?:"([^"]*)"|'([^']*)')[^<>]*>([\s\S]*?)<\/a>/gi, (_whole, dq: string | undefined, sq: string | undefined, inner: string) => {
      const href = decodeAllEntities(dq ?? sq ?? '')
      const label = stripInnerTags(inner).trim()
      if (!label) return ' '
      return /^https?:\/\//i.test(href) ? `[${label}](${href})` : label
    })
    .replace(/<(strong|b)\b[^<>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner: string) => `**${stripInnerTags(inner).trim()}**`)
    .replace(/<(em|i)\b[^<>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner: string) => `*${stripInnerTags(inner).trim()}*`)
    .replace(/<h([1-6])\b[^<>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${stripInnerTags(inner).trim()}\n\n`)
    .replace(/<img\b[^<>]*?alt=(?:"([^"]*)"|'([^']*)')[^<>]*>/gi, (_whole, dq?: string, sq?: string) => dq ?? sq ?? '')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^<>]*>/gi, '\n\n> ')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<(?:br|hr)\b[^<>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|ul|ol|li|table|tr|blockquote|tbody|thead|header|footer|main|nav)[^<>]*>/gi, '\n\n')

  const text = decodeAllEntities(work.replace(/<[^<>]*>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.replace(/\uE000PRE(\d+)\uE000/g, (_whole, index: string) => `\`\`\`\n${preBodies[Number(index)]}\n\`\`\``)
}
