/**
 * The bus channel skills.ts publishes frontmatter hooks on. Claude registers a
 * skill's hooks when the skill is invoked and keeps them for the rest of the
 * session; the hooks extension owns running them, so the skill side only
 * announces the declaration.
 */

export const SKILL_HOOKS_CHANNEL = 'pi-code:skill-hooks'

export interface SkillHooksEvent {
  skillName: string
  hooks: Record<string, unknown>
}

export function isSkillHooksEvent(data: unknown): data is SkillHooksEvent {
  if (typeof data !== 'object' || data === null) return false
  const event = data as { skillName?: unknown; hooks?: unknown }
  return typeof event.skillName === 'string' && typeof event.hooks === 'object' && event.hooks !== null && !Array.isArray(event.hooks)
}
