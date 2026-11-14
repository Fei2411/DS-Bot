// DS Bot's own actions in the `/` menu of a Bot's chat and a group chat. The DSH
// command rows cannot be removed from that menu through the documented client API (the
// `/` source registry is global and offers no per-Session filtering); the host module
// `agent-commands.js` stops their execution there. This module only adds rows:
//
//   - Scheduled task (`/scheduled-task`) opens this chat's scheduled tasks.
//   - In a group chat, a bare `/goal` opens DS Bot's group goal instead of DSH's goal
//     command. The DSH row stays; the decoration replaces its bare invocation only.
//
// "Reference a chat" stays in the composer's "+" menu: a command action receives the
// Session only, never the composer's caret/insertion, and the reference menu opens at
// that insertion.
import { ClockIcon } from './icons.js'
import { t } from './i18n.js'

// The contribution name; DSH rejects a contribution whose name collides with a host
// command, so it is namespaced and unlikely to collide.
export const SCHEDULED_TASK = 'scheduled-task'

export function commandEntries({ roster, actions }) {
  const entry = (sessionId) => {
    const snapshot = roster.getSnapshot()
    return snapshot.byId?.[sessionId] ?? snapshot.roomsById?.[sessionId]
  }
  const isRoom = sessionId => roster.getSnapshot().roomsById?.[sessionId] !== undefined
  const isBotSurface = sessionId => entry(sessionId) !== undefined
  return {
    contributions: [{
      name: SCHEDULED_TASK,
      label: () => t('Scheduled task'),
      description: () => t('Open the scheduled tasks of this chat'),
      icon: ClockIcon,
      available: session => isBotSurface(session?.sessionId),
      ui: {
        kind: 'action',
        run(session) {
          const target = entry(session?.sessionId)
          if (target !== undefined) actions.openSettings('schedules', target.id)
        },
      },
    }],
    decorations: [{
      name: 'goal',
      available: session => isRoom(session?.sessionId),
      ui: {
        kind: 'action',
        run(session) {
          const room = roster.getSnapshot().roomsById?.[session?.sessionId]
          if (room !== undefined) actions.composeGoal(room.id)
        },
      },
    }],
  }
}

export function installCommandActions(ctx, { roster, actions }) {
  return ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => {
      const entries = commandEntries({ roster, actions })
      const disposers = [
        ...entries.contributions.map(contribution => scope.commandUi.register(contribution)),
        ...entries.decorations.map(decoration => scope.commandUi.decorate(decoration)),
      ]
      return () => {
        for (const dispose of disposers) {
          try { dispose?.() } catch { /* the fiber is going away */ }
        }
      }
    }, 'ds-bot: bot command actions')
  })
}
