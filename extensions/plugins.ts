/**
 * Plugin Toggle Command
 *
 * `/claude-plugins` lists the installed Claude Code plugins pi-code loads and turns them on or off
 * for pi only, through `piCode.enabledPlugins` in pi's settings.json (see
 * docs/plugins.md). Installing and removing plugins stays with Claude Code.
 */

import * as os from 'node:os'
import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { type SettingItem, SettingsList } from '@earendil-works/pi-tui'
import { type EnablementSource, type PluginState, pluginStates, setPiPluginEnabled } from './internal/plugins.ts'
import { errorMessage } from './internal/values.ts'

const SOURCE_LABEL: Record<EnablementSource, string> = {
  managed: 'managed settings',
  flag: '--settings flag',
  pi: 'pi override',
  claude: 'Claude user settings',
  default: 'plugin default',
}

const MAX_VISIBLE = 15

export function pluginLabel(state: PluginState): string {
  return `${state.enabled ? '●' : '○'} ${state.qualified} — ${state.enabled ? 'on' : 'off'} (${SOURCE_LABEL[state.decidedBy]})`
}

function settingItem(state: PluginState): SettingItem {
  const value = state.enabled ? 'on' : 'off'
  // An item without `values` cannot be cycled: managed settings decide it.
  if (state.decidedBy === 'managed') return { id: state.qualified, label: state.qualified, currentValue: value, description: 'Set by managed settings' }
  return { id: state.qualified, label: state.qualified, currentValue: value, values: ['on', 'off'], description: `Currently from ${SOURCE_LABEL[state.decidedBy]}` }
}

/** Save one toggle through pi's settings. A failed write puts the row back and says why. */
function saveToggle(ctx: ExtensionCommandContext, list: SettingsList, items: SettingItem[], state: PluginState, value: string): void {
  try {
    setPiPluginEnabled(state, value === 'on')
  } catch (error) {
    list.updateValue(state.qualified, value === 'on' ? 'off' : 'on')
    ctx.ui.notify(`Could not update pi settings: ${errorMessage(error)}`, 'error')
    return
  }
  const fresh = pluginStates(os.homedir()).find((candidate) => candidate.qualified === state.qualified)
  const item = items.find((candidate) => candidate.id === state.qualified)
  if (fresh && item) item.description = settingItem(fresh).description
}

/** Show the plugins as a settings list; resolves when it is closed. */
async function showPluginList(ctx: ExtensionCommandContext, states: PluginState[]): Promise<void> {
  const items = states.map(settingItem)
  await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
    const list = new SettingsList(
      items,
      Math.min(states.length, MAX_VISIBLE),
      getSettingsListTheme(),
      (id, value) => {
        const state = states.find((candidate) => candidate.qualified === id)
        if (state) saveToggle(ctx, list, items, state, value)
      },
      () => done(),
    )
    return {
      render: (width: number) => list.render(width),
      invalidate: () => list.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data)
        tui.requestRender()
      },
    }
  })
}

export default function pluginsExtension(pi: ExtensionAPI) {
  pi.registerCommand('claude-plugins', {
    description: 'Turn installed Claude plugins on or off in pi only',
    handler: async (_args, ctx) => {
      const states = pluginStates(os.homedir())
      if (states.length === 0) {
        ctx.ui.notify('No Claude plugins installed. Install them with Claude Code’s /plugin.', 'info')
        return
      }
      if (ctx.mode !== 'tui') {
        ctx.ui.notify(states.map(pluginLabel).join('\n'), 'info')
        return
      }
      const enabledAtOpen = new Map(states.map((state) => [state.qualified, state.enabled]))
      await showPluginList(ctx, states)
      const changed = pluginStates(os.homedir()).some((state) => enabledAtOpen.get(state.qualified) !== state.enabled)
      // A reload aborts running subagents and background work, so it stays the user's call.
      if (changed) ctx.ui.notify('Plugin changes saved. Run /reload to apply them.', 'info')
    },
  })
}
