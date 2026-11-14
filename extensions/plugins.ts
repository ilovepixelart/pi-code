/**
 * Plugin Toggle Command
 *
 * `/claude-plugins` lists the installed Claude Code plugins pi-code loads and turns them on or off
 * for pi only, through `piCode.enabledPlugins` in pi's settings.json (see
 * docs/plugins.md). Installing and removing plugins stays with Claude Code.
 */

import * as os from 'node:os'
import { type ExtensionAPI, getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { type SettingItem, SettingsList } from '@earendil-works/pi-tui'
import { type EnablementSource, type PluginState, pluginStates, setPiPluginEnabled } from './internal/plugins.ts'
import { errorMessage } from './internal/values.ts'

const SOURCE_LABEL: Record<EnablementSource, string> = {
  managed: 'managed settings',
  pi: 'pi override',
  claude: 'Claude settings',
  default: 'plugin default',
}

const MAX_VISIBLE = 15

export function pluginLabel(state: PluginState): string {
  return `${state.enabled ? '●' : '○'} ${state.qualified} — ${state.enabled ? 'on' : 'off'} (${SOURCE_LABEL[state.decidedBy]})`
}

/** The `piCode.enabledPlugins` value that gives the wanted state: no entry when Claude's
 * settings already give it, so the override only holds real differences. */
export function overrideFor(state: PluginState, wanted: boolean): boolean | undefined {
  return wanted === state.withoutPi ? undefined : wanted
}

function settingItem(state: PluginState): SettingItem {
  const value = state.enabled ? 'on' : 'off'
  // An item without `values` cannot be cycled: managed settings decide it.
  if (state.decidedBy === 'managed') return { id: state.qualified, label: state.qualified, currentValue: value, description: 'Set by managed settings' }
  return { id: state.qualified, label: state.qualified, currentValue: value, values: ['on', 'off'], description: `Currently from ${SOURCE_LABEL[state.decidedBy]}` }
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
      const changed = await ctx.ui.custom<boolean>((tui, _theme, _keybindings, done) => {
        let saved = false
        const list = new SettingsList(
          states.map(settingItem),
          Math.min(states.length, MAX_VISIBLE),
          getSettingsListTheme(),
          (id, value) => {
            const state = states.find((candidate) => candidate.qualified === id)
            if (!state) return
            try {
              setPiPluginEnabled(id, overrideFor(state, value === 'on'))
              saved = true
            } catch (error) {
              list.updateValue(id, value === 'on' ? 'off' : 'on')
              ctx.ui.notify(`Could not update pi settings: ${errorMessage(error)}`, 'error')
            }
          },
          () => done(saved),
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
      // A reload aborts running subagents and background work, so it stays the user's call.
      if (changed) ctx.ui.notify('Plugin changes saved. Run /reload to apply them.', 'info')
    },
  })
}
