// Shared `state` pull engine: serializes out-of-order responses, short-circuits
// when `liveKey` is unchanged, hydrates ref-based avatars, reconciles optimistic
// section fold writes, persists cold-start prefs, and reports removed chats.
import { createAvatarRefCache } from '../avatar-refs.js'
import { language } from '../i18n.js'
import { indexRoster } from './roster.js'
import { persistPrefs } from './store.js'

// Live roster fields sent by `ds-bot/src/host/channel.js` that can change without
// bumping `state.revision`. Each entry specifies its comparison mode and default.
export const LIVE_ROSTER_FIELDS = [
  { key: 'readOnly', mode: 'nullable', fallback: null },
  { key: 'secretStore', mode: 'json', fallback: {} },
  { key: 'secrets', mode: 'json', fallback: [] },
  { key: 'connectors', mode: 'json', fallback: [] },
  { key: 'capabilityStatuses', mode: 'json', fallback: {} },
  { key: 'phone', mode: 'json', fallback: null },
  { key: 'api', mode: 'json', fallback: null },
  { key: 'learning', mode: 'json', fallback: {} },
  { key: 'learningSettled', mode: 'json', fallback: {} },
  { key: 'btwCards', mode: 'json', fallback: {} },
  { key: 'sideChats', mode: 'json', fallback: {} },
  { key: 'imStatus', mode: 'json', fallback: {} },
  { key: 'imVia', mode: 'json', fallback: {} },
  { key: 'apiVia', mode: 'json', fallback: {} },
  { key: 'memoryReviews', mode: 'json', fallback: {} },
  { key: 'plugins', mode: 'json', fallback: null },
  { key: 'inbox', mode: 'json', fallback: null },
  { key: 'speech', mode: 'boolean', fallback: false },
  { key: 'telemetryPrompt', mode: 'boolean', fallback: false },
  { key: 'releaseNotes', mode: 'json', fallback: null },
]

export function diffLiveRosterFields(value, base) {
  const next = {}
  for (const field of LIVE_ROSTER_FIELDS) {
    const incoming = value[field.key]
    if (incoming === undefined) continue
    if (field.mode === 'nullable') {
      if ((incoming ?? null) !== (base[field.key] ?? null)) next[field.key] = incoming
    } else if (field.mode === 'boolean') {
      if (Boolean(incoming) !== Boolean(base[field.key])) next[field.key] = Boolean(incoming)
    } else if (JSON.stringify(incoming) !== JSON.stringify(base[field.key] ?? field.fallback)) {
      next[field.key] = incoming
    }
  }
  return next
}

export function collectRemovedChatIds(prevRoster, nextRoster) {
  if (!prevRoster?.ready) return []
  return [
    ...Object.keys(prevRoster.byId ?? {}).filter(id => nextRoster.byId[id] === undefined),
    ...Object.keys(prevRoster.roomsById ?? {}).filter(id => nextRoster.roomsById[id] === undefined),
    ...Object.keys(prevRoster.agentOf ?? {}).filter(id => nextRoster.agentOf?.[id] === undefined),
  ]
}

export function createTeamPull({
  call,
  store,
  foldWrites = null,
  avatarRefs = createAvatarRefCache(call),
  storage = globalThis.localStorage,
  onLiveValue = null,
  onHydrated = null,
  onChatsRemoved = null,
} = {}) {
  const { roster, activity, work, computer } = store
  let pulls = 0
  let applied = 0
  let avatarIncomplete = false
  let liveKey
  let activityKey = '{}'
  let workKey = ''
  let computerKey = '{}'

  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const since = avatarIncomplete ? -1 : known.revision
    const value = await call('state', {
      since,
      models: known.modelsKey ?? '',
      live: liveKey,
      locale: language(),
      avatars: 'ref',
    })
    if (order < applied) return false
    applied = order

    const prevLiveKey = liveKey
    const liveSame = liveKey !== undefined && value.liveKey !== undefined && value.liveKey === liveKey
    if (value.liveKey !== undefined) liveKey = value.liveKey

    if (!liveSame) {
      if (value.activity !== undefined) {
        const nextActivity = JSON.stringify(value.activity)
        if (nextActivity !== activityKey) {
          activityKey = nextActivity
          activity.set(value.activity)
        }
      }
      if (value.work !== undefined) {
        const nextWork = JSON.stringify(value.work)
        if (nextWork !== workKey) {
          workKey = nextWork
          work.set(value.work)
        }
      }
      if (value.computerLive !== undefined) {
        const nextComputer = JSON.stringify(value.computerLive)
        if (nextComputer !== computerKey) {
          computerKey = nextComputer
          computer.set(value.computerLive)
        }
      }
      if (value.memoryNews !== undefined) store.noteMemoryNews(value.memoryNews)
      onLiveValue?.(value)
    }

    const current = roster.getSnapshot()
    const liveChanged = value.liveKey !== undefined && value.liveKey !== prevLiveKey
    if (value.unchanged || (!avatarIncomplete && value.revision === current.revision && value.modelsKey === current.modelsKey)) {
      if (!liveSame) {
        const changed = diffLiveRosterFields(value, current)
        if (Object.keys(changed).length > 0 && current.ready) roster.set({ ...current, ...changed })
      }
      return liveChanged
    }

    const { state: hydrated, incomplete } = await avatarRefs.hydrate(value)
    if (order < applied) return false
    avatarIncomplete = incomplete

    const latest = roster.getSnapshot()
    const sameState = hydrated.revision === latest.revision && hydrated.modelsKey === latest.modelsKey && latest.ready
    const avatarsChanged = sameState && (
      (hydrated.bots ?? []).some(bot => bot?.avatar?.image !== latest.byId?.[bot.id]?.avatar?.image)
      || (hydrated.rooms ?? []).some(room => room?.avatar?.image !== latest.roomsById?.[room.id]?.avatar?.image)
    )
    if (sameState && !avatarsChanged) {
      if (!liveSame) {
        const changed = diffLiveRosterFields(value, latest)
        if (Object.keys(changed).length > 0) roster.set({ ...latest, ...changed })
      }
      return liveChanged
    }

    // In a window with no visit record yet, everything already there counts as seen.
    if (!store.hasSeenRecords()) {
      store.leaveVisits([...(hydrated.bots ?? []), ...(hydrated.rooms ?? [])].map(entry => entry.id))
    }

    const sections = foldWrites ? foldWrites.reconcile(hydrated.sections, hydrated.revision) : hydrated.sections
    const indexed = indexRoster({ ...hydrated, sections })
    const removed = collectRemovedChatIds(latest, indexed)
    if (removed.length > 0) onChatsRemoved?.(removed, latest, indexed)

    roster.set(indexed)
    persistPrefs(indexed.prefs, storage)
    onHydrated?.(indexed, latest)
    return true
  }

  const reset = () => {
    avatarRefs.clear()
    avatarIncomplete = false
  }

  return { pull, reset, avatarRefs }
}
