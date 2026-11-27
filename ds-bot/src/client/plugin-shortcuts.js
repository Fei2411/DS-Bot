import { t } from './i18n.js'
import { visibleSidebarTargets } from './shortcuts-model.js'

// Explicit per-profile defaults for DSH's ShortcutRegistry.
// DSH validates every declared profile at register() time and rejects unsupported Web combos
// or any overlap with built-in DSH shortcuts:
// - web:macos / web:windows admit primary+alt, primary+shift, or 3+ modifiers (not bare primary+Key)
// - web:linux only admits primary+Slash / primary+shift+Comma / primary+shift+Period, so all other
//   commands omit web:linux (left unbound by default, matching DSH's own built-in commands)
// - desktop/web choices avoid DSH built-ins (sidebar.left.toggle Mod+B / Mod+Alt+B,
//   sidebar.right.toggle Mod+Alt+B / Mod+Shift+B, session.fork Mod+Alt+F / Mod+Shift+F).
const pluginDefaults = (code, desktopModifiers, webModifiers) => ({
  'desktop:macos': { code, modifiers: desktopModifiers },
  'desktop:windows': { code, modifiers: desktopModifiers },
  'desktop:linux': { code, modifiers: desktopModifiers },
  ...(webModifiers ? {
    'web:macos': { code, modifiers: webModifiers },
    'web:windows': { code, modifiers: webModifiers },
  } : {}),
})

export function buildPluginShortcutCommands({ roster, ui, surface, actions, mainView, sessionsById }) {
  const activeBotTarget = () => {
    const snap = roster.getSnapshot()
    const current = mainView()
    if (current && snap.byId?.[current]) return snap.byId[current].id
    return snap.mainBotId ?? snap.bots?.[0]?.id ?? null
  }

  return [
    {
      id: 'ds-bot.switch-surface',
      label: () => t('Switch Bot / Classic Agent mode'),
      aliases: ['classic', 'agent', 'bot', 'mode'],
      defaults: pluginDefaults('KeyM', ['primary', 'shift'], ['primary', 'shift']),
      regions: ['page', 'editable'],
      modals: [],
      resolve: ({ modal }) => {
        if (modal !== null) return { status: 'blocked', reason: 'modal' }
        return { status: 'handled', run: () => actions.setSurface(surface.getSnapshot().mode === 'agent' ? 'bot' : 'agent') }
      },
    },
    ...(typeof actions.openInbox === 'function' ? [{
      id: 'ds-bot.open-inbox',
      label: () => t('Open Inbox'),
      aliases: ['inbox', 'notifications'],
      defaults: pluginDefaults('KeyI', ['primary'], ['primary', 'alt']),
      regions: ['page', 'editable'],
      modals: [],
      resolve: ({ modal }) => {
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
    }] : []),
    ...(typeof actions.openBrowser === 'function' ? [{
      id: 'ds-bot.open-browser',
      label: () => t('Toggle Bot browser'),
      aliases: ['browser', 'web'],
      defaults: pluginDefaults('KeyB', ['primary', 'shift'], ['primary', 'alt', 'shift']),
      regions: ['page', 'editable'],
      modals: [],
      resolve: ({ modal }) => {
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
    }] : []),
    {
      id: 'ds-bot.group-search',
      label: () => t('Search in group'),
      aliases: ['search', 'group'],
      defaults: pluginDefaults('KeyF', ['primary', 'shift'], ['primary', 'alt']),
      regions: ['page', 'editable'],
      modals: [],
      resolve: ({ modal }) => {
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
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `ds-bot.switch-bot-${index + 1}`,
      label: () => t('Switch to conversation {n}', { n: index + 1 }),
      aliases: ['bot', 'switch', String(index + 1)],
      defaults: pluginDefaults(`Digit${index + 1}`, ['primary'], ['primary', 'alt']),
      regions: ['page', 'editable'],
      modals: [],
      resolve: ({ modal }) => {
        if (surface.getSnapshot().mode !== 'bot') return { status: 'blocked', reason: 'unavailable' }
        if (modal !== null) return { status: 'blocked', reason: 'modal' }
        const targets = visibleSidebarTargets(roster.getSnapshot(), sessionsById(), mainView(), ui.getSnapshot().sectionFolds)
        const target = targets[index]
        if (!target) return { status: 'blocked', reason: 'unavailable' }
        return {
          status: 'handled',
          run: () => (target.kind === 'agent' ? actions.openAgent?.(target.id) : actions.openSession(target.id)),
        }
      },
    })),
  ]
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
