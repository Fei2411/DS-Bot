import { STORAGE } from './storage.js'

const readJournal = (storage) => {
  const map = new Map()
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE.agentForks) ?? '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (typeof entry?.sessionId === 'string' && typeof entry?.agentId === 'string') {
          map.set(entry.sessionId, { agentId: entry.agentId, sessionId: entry.sessionId })
        }
      }
    }
  } catch { /* storage unavailable or invalid */ }
  return map
}

// Read-modify-write against current shared storage so concurrent windows never
// overwrite each other's pending recovery records.
const mutateJournal = (storage, update) => {
  if (!storage) return
  try {
    const map = readJournal(storage)
    const changed = update(map)
    if (changed !== false) storage.setItem(STORAGE.agentForks, JSON.stringify([...map.values()]))
  } catch { /* storage unavailable */ }
}

// A DSH fork has no durable parent relationship. Capture its source at the
// public client call, including forks that never navigate the main view.
export function installAgentForks({ sessions, ownerOf, hasAgent, pending, adopt, refresh, report, storage, ready }) {
  const localJournal = readJournal(storage)
  const inFlight = new Map()
  const forks = new Set()
  let stopped = false

  const remember = (agentId, sessionId) => {
    const entry = { agentId, sessionId }
    localJournal.set(sessionId, entry)
    pending.set(sessionId, agentId)
    mutateJournal(storage, (map) => { map.set(sessionId, entry) })
    return entry
  }

  const forget = (sessionId) => {
    localJournal.delete(sessionId)
    mutateJournal(storage, map => map.delete(sessionId))
  }

  const persist = (entry) => {
    const running = inFlight.get(entry.sessionId)
    if (running !== undefined) return running
    pending.set(entry.sessionId, entry.agentId)
    const task = Promise.resolve().then(() => adopt(entry.agentId, entry.sessionId)).then(async () => {
      forget(entry.sessionId)
      if (!stopped) {
        try { await refresh() } catch (error) { report(error, 'agent-fork-refresh') }
      }
    }).catch((error) => {
      // Clear provisional pending ownership when adoption fails so rejected
      // sessions do not appear Agent-owned or propagate a false owner to later forks.
      if (pending.get(entry.sessionId) === entry.agentId) pending.delete(entry.sessionId)
      if (!stopped) report(error, 'agent-fork-adopt')
    }).finally(() => { inFlight.delete(entry.sessionId) })
    inFlight.set(entry.sessionId, task)
    return task
  }

  const original = sessions.fork
  const descriptor = Object.getOwnPropertyDescriptor(sessions, 'fork')
  const wrapped = function (options) {
    if (stopped) return Reflect.apply(original, this, [options])
    const receiver = this
    const captured = ownerOf(options.sessionId) ?? pending.get(options.sessionId)
    const task = (async () => {
      if (captured === undefined) {
        // Keep unrelated native DSH forks working even if the Bot API is down on cold start.
        try { await ready() } catch { /* Bot roster unavailable */ }
      }
      const agentId = captured ?? ownerOf(options.sessionId) ?? pending.get(options.sessionId)
      if (agentId === undefined) return Reflect.apply(original, receiver, [options])
      let created
      let adoption
      const onCreated = (sessionId) => {
        created = sessionId
        adoption = persist(remember(agentId, sessionId))
        options.onCreated?.(sessionId)
      }
      try {
        const child = await Reflect.apply(original, receiver, [{ ...options, onCreated }])
        if (created === undefined && typeof child === 'string') onCreated(child)
        if (adoption !== undefined) await adoption
        return child
      } catch (error) {
        // A workspace attach may fail after publication but before onCreated;
        // title rename or the caller's callback may also throw after creation.
        const rpc = error?.rpcError
        const partial = rpc?.code === 'session/workspace-attach-failed' ? rpc.details?.sessionId : undefined
        if (created === undefined && typeof partial === 'string') adoption = persist(remember(agentId, partial))
        if (adoption !== undefined) await adoption
        throw error
      }
    })()
    forks.add(task)
    const settle = () => { forks.delete(task) }
    task.then(settle, settle)
    return task
  }
  sessions.fork = wrapped

  const reconcile = async () => {
    if (stopped) return
    const listed = sessions.list.getSnapshot().byId ?? {}
    const entries = storage ? readJournal(storage) : new Map(localJournal)
    for (const [id, entry] of localJournal) if (!entries.has(id)) entries.set(id, entry)
    for (const entry of entries.values()) {
      if (stopped) return
      if (!hasAgent(entry.agentId)) continue
      if (ownerOf(entry.sessionId) === entry.agentId) {
        forget(entry.sessionId)
        continue
      }
      if (listed[entry.sessionId] === undefined) continue
      await persist(entry)
    }
  }

  return {
    reconcile,
    async dispose() {
      stopped = true
      if (sessions.fork === wrapped) {
        if (descriptor === undefined) delete sessions.fork
        else Object.defineProperty(sessions, 'fork', descriptor)
      }
      // Hot reload waits for already-started host writes; no stale UI refreshes.
      await Promise.allSettled([...forks, ...inFlight.values()])
    },
  }
}
