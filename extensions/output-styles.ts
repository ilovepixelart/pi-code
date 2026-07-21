/**
 * Output Styles Extension
 *
 * Bridges Claude Code's output styles into pi. It discovers `.claude/output-styles/*.md`
 * (user then project), honors the active style recorded as `outputStyle` in
 * `.claude/settings.json` (user, project, then settings.local.json, last wins),
 * and appends that style's body to the system prompt so the agent adopts its
 * tone and role. `/output-style` lists the styles and persists a choice to the
 * project's settings.local.json.
 *
 * pi keeps its own base system prompt (tools, safety); the style is layered on
 * top rather than replacing it wholesale.
 *
 * Docs: https://code.claude.com/docs/en/output-styles.md
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { isProjectApproved } from './internal/project-approval.js'

export interface OutputStyle {
  name: string
  description: string
  body: string
}

function field(frontmatter: string, key: string): string {
  const match = new RegExp(String.raw`^\s*${key}\s*:\s*(.+)$`, 'm').exec(frontmatter)
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
}

/** Parse an output-style markdown file into its name, description, and body. */
export function parseStyle(content: string, fallbackName: string): OutputStyle {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const frontmatter = match ? match[1] : ''
  const body = match ? content.slice(match[0].length) : content
  return { name: field(frontmatter, 'name') || fallbackName, description: field(frontmatter, 'description'), body: body.trim() }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Existing `.claude/output-styles` directories, user first then project. The project
 * directory is included only for trusted projects, since its style body is injected
 * verbatim into the system prompt.
 */
export function styleDirs(cwd: string, home: string, trusted: boolean): string[] {
  const dirs = [path.join(home, '.claude', 'output-styles')]
  if (trusted) dirs.push(path.join(cwd, '.claude', 'output-styles'))
  return dirs.filter((dir) => isDirectory(dir))
}

/** All output styles, project entries overriding user entries of the same name. */
export function loadStyles(dirs: string[]): OutputStyle[] {
  const byName = new Map<string, OutputStyle>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const style = parseStyle(fs.readFileSync(path.join(dir, entry), 'utf-8'), entry.replace(/\.md$/, ''))
      byName.set(style.name, style)
    }
  }
  return [...byName.values()]
}

/** Settings files that carry `outputStyle`. Project settings apply only when trusted. */
export function settingsFiles(cwd: string, home: string, trusted: boolean): string[] {
  const files = [path.join(home, '.claude', 'settings.json')]
  if (trusted) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'))
  return files
}

/** The `outputStyle` recorded in settings, last file winning. */
export function readActiveStyleName(files: string[]): string | undefined {
  let name: string | undefined
  for (const file of files) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (typeof settings.outputStyle === 'string') name = settings.outputStyle
    } catch {
      // missing or invalid file: skip
    }
  }
  return name
}

export function styleForName(styles: OutputStyle[], name: string | undefined): OutputStyle | undefined {
  return name ? styles.find((style) => style.name === name) : undefined
}

function persistActiveStyle(file: string, name: string): void {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    // start from an empty config when the file is missing or invalid
  }
  config.outputStyle = name
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}

export default function outputStylesExtension(pi: ExtensionAPI) {
  let styles: OutputStyle[] = []
  let activeName: string | undefined
  let localSettingsPath = ''

  pi.on('session_start', async (_event, ctx) => {
    const home = os.homedir()
    // A project style body is injected verbatim into the system prompt, so only honor
    // project styles / selection once the project is approved. isProjectTrusted alone
    // is true for a repo pi never asked about; see project-approval.
    const trusted = await isProjectApproved(ctx)
    styles = loadStyles(styleDirs(ctx.cwd, home, trusted))
    localSettingsPath = path.join(ctx.cwd, '.claude', 'settings.local.json')
    activeName = readActiveStyleName(settingsFiles(ctx.cwd, home, trusted))
    const active = styleForName(styles, activeName)
    if (active) ctx.ui.notify(`Output style: ${active.name}`, 'info')
  })

  pi.on('before_agent_start', async (event) => {
    const active = styleForName(styles, activeName)
    if (!active || active.body.length === 0) return
    return { systemPrompt: `${event.systemPrompt}\n\n## Output Style: ${active.name}\n\n${active.body}` }
  })

  pi.registerCommand('output-style', {
    description: 'Choose the active Claude output style',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('/output-style requires interactive mode', 'error')
        return
      }
      if (styles.length === 0) {
        ctx.ui.notify('No output styles found in .claude/output-styles', 'info')
        return
      }
      const labels = styles.map((style) => (style.description ? `${style.name} — ${style.description}` : style.name))
      const choice = await ctx.ui.select('Output style:', labels)
      if (!choice) return
      const picked = styles[labels.indexOf(choice)]
      activeName = picked.name
      persistActiveStyle(localSettingsPath, picked.name)
      ctx.ui.notify(`Output style set to ${picked.name} (applies next turn)`, 'info')
    },
  })
}
