// Process-lifetime secret resolver for external secret providers.
// - Lock-free fast path on cache hit (including cached errors so repeated tool calls
//   do not keep prompting for Touch ID).
// - Single-flight deduplication and grouped batching by (providerId, configKey) on miss.
// - Manual `invalidate(providerId?)` clears cached values/errors for explicit refresh.

function configKeyOf(config) {
  if (!config || typeof config !== 'object') return ''
  const keys = Object.keys(config).sort()
  return JSON.stringify(keys.map(key => [key, config[key]]))
}

export function createSecretResolver({ registry }) {
  /** @type {Map<string, { ok: true, value: string } | { ok: false, error: Error }>} */
  const cache = new Map()
  /** @type {Map<string, Promise<{ ok: true, value: string } | { ok: false, error: Error }>>} */
  const inflight = new Map()
  /** @type {Map<string, Promise<void>>} */
  const groupLocks = new Map()
  let generation = 0

  const entryKey = (providerId, configKey, reference) => `${providerId}\0${configKey}\0${reference}`

  function getCached(providerId, config, reference) {
    return cache.get(entryKey(providerId, configKeyOf(config), reference))
  }

  function invalidate(providerId) {
    generation += 1
    if (providerId === undefined || providerId === null || providerId === '') {
      cache.clear()
      return
    }
    const prefix = `${providerId}\0`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
  }

  function allCachedValues() {
    const out = []
    for (const [key, entry] of cache.entries()) {
      if (entry.ok) {
        const parts = key.split('\0')
        out.push({ providerId: parts[0], reference: parts.slice(2).join('\0'), value: entry.value })
      }
    }
    return out
  }

  async function resolve(items, { signal } = {}) {
    const list = Array.isArray(items) ? items : []
    const results = new Map()
    if (list.length === 0) return results

    // Lock-free fast path: when every requested item is cached, return immediately.
    const missed = []
    for (const item of list) {
      const configKey = configKeyOf(item.config)
      const key = entryKey(item.providerId, configKey, item.reference)
      const hit = cache.get(key)
      if (hit !== undefined) {
        results.set(item.reference, hit)
      } else {
        missed.push({ ...item, configKey, key })
      }
    }
    if (missed.length === 0) return results

    // Deduplicate against already in-flight requests, and group fresh misses by
    // (providerId, configKey) so each provider unlocks in a single batch.
    const waits = []
    /** @type {Map<string, { providerId: string, config: any, configKey: string, items: Map<string, { reference: string, key: string, resolve: Function }> }>} */
    const freshGroups = new Map()

    for (const item of missed) {
      const existing = inflight.get(item.key)
      if (existing !== undefined) {
        waits.push(existing.then(res => results.set(item.reference, res)))
        continue
      }
      const groupKey = `${item.providerId}\0${item.configKey}`
      let group = freshGroups.get(groupKey)
      if (group === undefined) {
        group = { providerId: item.providerId, config: item.config, configKey: item.configKey, items: new Map() }
        freshGroups.set(groupKey, group)
      }
      if (group.items.has(item.key)) continue
      let done
      const promise = new Promise(resolveItem => { done = resolveItem })
      inflight.set(item.key, promise)
      group.items.set(item.key, { reference: item.reference, key: item.key, resolve: done })
      waits.push(promise.then(res => results.set(item.reference, res)))
    }

    const batchJobs = []
    for (const [groupKey, group] of freshGroups.entries()) {
      const prev = groupLocks.get(groupKey) ?? Promise.resolve()
      const job = prev.then(async () => {
        const batchGen = generation
        const pending = []
        for (const item of group.items.values()) {
          const hit = cache.get(item.key)
          if (hit !== undefined) {
            item.resolve(hit)
            inflight.delete(item.key)
          } else {
            pending.push(item)
          }
        }
        if (pending.length === 0) return

        const driver = registry.get(group.providerId)
        if (!driver) {
          const error = Object.assign(new Error(`Unknown secret provider "${group.providerId}".`), { code: 'SECRET_PROVIDER_UNKNOWN' })
          for (const item of pending) {
            const outcome = { ok: false, error }
            if (generation === batchGen) cache.set(item.key, outcome)
            inflight.delete(item.key)
            item.resolve(outcome)
          }
          return
        }

        try {
          const resolvedMap = await driver.readBatch(group.config, pending.map(item => item.reference), signal)
          for (const item of pending) {
            const value = resolvedMap.get(item.reference)
            const outcome = typeof value === 'string'
              ? { ok: true, value }
              : { ok: false, error: Object.assign(new Error(`Secret provider "${group.providerId}" did not return a value for ${item.reference}.`), { code: 'SECRET_PROVIDER_MISSING' }) }
            if (generation === batchGen) cache.set(item.key, outcome)
            inflight.delete(item.key)
            item.resolve(outcome)
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          const callerAborted = err.code === 'ABORT_ERR' && signal?.aborted === true
          for (const item of pending) {
            const outcome = { ok: false, error: err }
            // Cache provider errors so subsequent tool calls don't repeatedly pop OS prompts;
            // skip caching only when the caller explicitly aborted before completion.
            if (!callerAborted && generation === batchGen) cache.set(item.key, outcome)
            inflight.delete(item.key)
            item.resolve(outcome)
          }
        }
      })
      const settled = job.catch(() => {})
      groupLocks.set(groupKey, settled)
      settled.finally(() => {
        if (groupLocks.get(groupKey) === settled) groupLocks.delete(groupKey)
      })
      batchJobs.push(settled)
    }

    await Promise.all([...batchJobs, ...waits])
    return results
  }

  return {
    getCached,
    resolve,
    invalidate,
    allCachedValues,
  }
}
