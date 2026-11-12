import { STORAGE } from './storage.js'

// A DSH fork has no durable parent relationship. Capture its source at the
// public client call, including forks that never navigate the main view.
export function installAgentForks({ sessions, ownerOf, hasAgent, pending, adopt, refresh, report, storage, ready }) {
  const journal = new Map()
  const inFlight = new Map()
  const forks = new Set()
  let stopped = false
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE.agentForks) ?? '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (typeof entry?.sessionId === 'string' && typeof entry?.agentId === 'string') journal.set(entry.sessionId, entry)
      }
    }
  } catch { /* storage unavailable or invalid */ }
  const save = () => {
    try { storage?.setItem(STORAGE.agentForks, JSON.stringify([...journal.values()])) } catch { /* storage unavailable */ }
  }
  const remember = (agentId, sessionId) => {
    const entry = { agentId, sessionId }
    journal.set(sessionId, entry)
    pending.set(sessionId, agentId)
    save()
    return entry
  }
  const persist = (entry) => {
    const running = inFlight.get(entry.sessionId)
    if (running !== undefined) return running
    const task = Promise.resolve().then(() => adopt(entry.agentId, entry.sessionId)).then(async () => {
      journal.delete(entry.sessionId)
      save()
      if (!stopped) {
        try { await refresh() } catch (error) { report(error, 'agent-fork-refresh') }
      }
    }).catch((error) => {
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
      if (captured === undefined) await ready()
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
    for (const entry of journal.values()) {
      if (stopped) return
      if (!hasAgent(entry.agentId)) continue
      if (ownerOf(entry.sessionId) === entry.agentId) {
        journal.delete(entry.sessionId)
        save()
        continue
      }
      if (listed[entry.sessionId] === undefined) continue
      pending.set(entry.sessionId, entry.agentId)
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
