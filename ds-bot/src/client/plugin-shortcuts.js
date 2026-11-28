import { t } from './i18n.js'
import { pluginShortcutDefaults, shortcutsForHost, visibleSidebarTargets } from './shortcuts-model.js'

// Plugin shortcuts derive directly from the unified `SHORTCUT_DEFS` table filtered to
// `hosts: ['desktop', 'plugin']`, keeping IDs, labels, and desktop defaults in one source.
export function buildPluginShortcutCommands({ roster, ui, surface, actions, mainView, sessionsById }) {
  const activeBotTarget = () => {
    const snap = roster.getSnapshot()
    const current = mainView()
    if (current && snap.byId?.[current]) return snap.byId[current].id
    return snap.mainBotId ?? snap.bots?.[0]?.id ?? null
  }

  const resolvers = {
    'switch-surface': ({ modal }) => {
      if (modal !== null) return { status: 'blocked', reason: 'modal' }
      return { status: 'handled', run: () => actions.setSurface(surface.getSnapshot().mode === 'agent' ? 'bot' : 'agent') }
    },
    inbox: ({ modal }) => {
      if (surface.getSnapshot().mode !== 'bot') return { status: 'blocked', reason: 'unavailable' }
      if (modal !== null) return { status: 'blocked', reason: 'modal' }
      return {
        status: 'handled',
        run: () => {
          if (ui.getSnapshot().inbox) actions.closeInbox?.()
          else actions.openInbox()
        },
      }
    },
    browser: ({ modal }) => {
      const snap = roster.getSnapshot()
      if (surface.getSnapshot().mode !== 'bot' || snap.browser === false) return { status: 'blocked', reason: 'unavailable' }
      if (modal !== null) return { status: 'blocked', reason: 'modal' }
      const botId = activeBotTarget()
      if (!botId) return { status: 'blocked', reason: 'unavailable' }
      return {
        status: 'handled',
        run: () => actions.toggleBrowser(botId),
      }
    },
    'group-search': ({ modal }) => {
      if (surface.getSnapshot().mode !== 'bot') return { status: 'blocked', reason: 'unavailable' }
      if (modal !== null) return { status: 'blocked', reason: 'modal' }
      const current = mainView()
      const room = current ? roster.getSnapshot().roomsById?.[current] : null
      return {
        status: 'handled',
        run: () => {
          if (room) actions.openGroupSearch?.(room.id)
          else actions.openPalette()
        },
      }
    },
  }

  const resolveSlot = slot => ({ modal }) => {
    if (surface.getSnapshot().mode !== 'bot') return { status: 'blocked', reason: 'unavailable' }
    if (modal !== null) return { status: 'blocked', reason: 'modal' }
    const targets = visibleSidebarTargets(roster.getSnapshot(), sessionsById(), mainView(), ui.getSnapshot().sectionFolds)
    const target = targets[slot]
    if (!target) return { status: 'blocked', reason: 'unavailable' }
    return {
      status: 'handled',
      run: () => (target.kind === 'agent' ? actions.openAgent?.(target.id) : actions.openSession(target.id)),
    }
  }

  const commands = []
  for (const def of shortcutsForHost('plugin')) {
    if (!def.plugin?.id) continue
    if (def.requiresInbox && typeof actions.openInbox !== 'function') continue
    if (def.requiresBrowser && typeof actions.openBrowser !== 'function') continue
    const resolve = Number.isInteger(def.slot) ? resolveSlot(def.slot) : resolvers[def.id]
    if (typeof resolve !== 'function') continue
    commands.push({
      id: def.plugin.id,
      label: () => (def.labelVars ? t(def.label, def.labelVars) : t(def.label)),
      aliases: def.plugin.aliases ?? [],
      defaults: pluginShortcutDefaults(def),
      regions: ['page', 'editable'],
      modals: [],
      resolve,
    })
  }
  return commands
}

export function registerPluginShortcuts(shortcuts, { onError, ...deps }) {
  const commands = buildPluginShortcutCommands(deps)
  const disposers = []
  for (const command of commands) {
    try {
      disposers.push(shortcuts.register(command))
    } catch (error) {
      if (typeof onError === 'function') onError(command.id, error)
      else throw error
    }
  }
  return () => {
    for (const dispose of disposers) dispose?.()
  }
}
