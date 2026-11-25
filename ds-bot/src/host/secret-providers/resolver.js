// Process-lifetime secret resolver for external secret providers.
// - Lock-free fast path on cache hit (including cached errors so repeated tool calls
//   do not keep prompting for Touch ID).
// - Single-flight deduplication and grouped batching by (providerId, configKey) on miss.
// - Per-caller AbortSignal isolation so aborting one caller never cancels shared batches
//   while another caller is still waiting; aborts underlying driver only when all callers abort.
// - Manual `invalidate(providerId?)` and targeted `invalidateRef(providerId, config, ref)`.

function configKeyOf(config) {
  if (!config || typeof config !== 'object') return ''
  const keys = Object.keys(config).sort()
  return JSON.stringify(keys.map(key => [key, config[key]]))
}

function abortError() {
  return Object.assign(new Error('Secret resolution was aborted.'), { code: 'ABORT_ERR', name: 'AbortError' })
}

export function createSecretResolver({ registry }) {
  /** @type {Map<string, { ok: true, value: string } | { ok: false, error: Error }>} */
  const cache = new Map()
  /** @type {Map<string, { promise: Promise<{ ok: true, value: string } | { ok: false, error: Error }>, batch: { controller: AbortController, waiters: Set<object>, settled: boolean } }>} */
  const inflight = new Map()
  /** @type {Map<string, Promise<void>>} */
  const groupLocks = new Map()
  /** @type {Map<string, number>} */
  const keyGenerations = new Map()
  let generation = 0

  const entryKey = (providerId, configKey, reference) => `${providerId}\0${configKey}\0${reference}`

  function getCached(providerId, config, reference) {
    return cache.get(entryKey(providerId, configKeyOf(config), reference))
  }

  function invalidate(providerId) {
    generation += 1
    if (providerId === undefined || providerId === null || providerId === '') {
      cache.clear()
      keyGenerations.clear()
      return
    }
    const prefix = `${providerId}\0`
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
    for (const key of keyGenerations.keys()) {
      if (key.startsWith(prefix)) keyGenerations.delete(key)
    }
  }

  function invalidateRef(providerId, config, reference) {
    if (!providerId || !reference) return
    const key = entryKey(providerId, configKeyOf(config), reference)
    cache.delete(key)
    keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1)
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
    if (signal?.aborted) throw abortError()
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
    const attachedBatches = new Set()
    const waiterToken = {}
    /** @type {Map<string, { providerId: string, config: any, configKey: string, batch: { controller: AbortController, waiters: Set<object>, settled: boolean }, items: Map<string, { reference: string, key: string, keyGen: number, resolve: Function }> }>} */
    const freshGroups = new Map()

    const attachBatch = (batch) => {
      if (attachedBatches.has(batch)) return
      attachedBatches.add(batch)
      batch.waiters.add(waiterToken)
    }

    for (const item of missed) {
      const existing = inflight.get(item.key)
      if (existing !== undefined) {
        attachBatch(existing.batch)
        waits.push(existing.promise.then(res => results.set(item.reference, res)))
        continue
      }
      const groupKey = `${item.providerId}\0${item.configKey}`
      let group = freshGroups.get(groupKey)
      if (group === undefined) {
        const batch = { controller: new AbortController(), waiters: new Set(), settled: false }
        group = { providerId: item.providerId, config: item.config, configKey: item.configKey, batch, items: new Map() }
        freshGroups.set(groupKey, group)
      }
      attachBatch(group.batch)
      if (group.items.has(item.key)) continue
      let done
      const promise = new Promise(resolveItem => { done = resolveItem })
      inflight.set(item.key, { promise, batch: group.batch })
      group.items.set(item.key, {
        reference: item.reference,
        key: item.key,
        keyGen: keyGenerations.get(item.key) ?? 0,
        resolve: done,
      })
      waits.push(promise.then(res => results.set(item.reference, res)))
    }

    for (const [groupKey, group] of freshGroups.entries()) {
      const { batch } = group
      const prev = groupLocks.get(groupKey) ?? Promise.resolve()
      const job = prev.then(async () => {
        const batchGen = generation
        const pending = []
        for (const item of group.items.values()) {
          const hit = cache.get(item.key)
          if (hit !== undefined) {
            inflight.delete(item.key)
            item.resolve(hit)
          } else {
            pending.push(item)
          }
        }
        if (pending.length === 0) {
          batch.settled = true
          return
        }

        if (batch.controller.signal.aborted) {
          batch.settled = true
          const err = abortError()
          for (const item of pending) {
            inflight.delete(item.key)
            item.resolve({ ok: false, error: err })
          }
          return
        }

        const driver = registry.get(group.providerId)
        if (!driver) {
          batch.settled = true
          const error = Object.assign(new Error(`Unknown secret provider "${group.providerId}".`), { code: 'SECRET_PROVIDER_UNKNOWN' })
          for (const item of pending) {
            const outcome = { ok: false, error }
            if (generation === batchGen && (keyGenerations.get(item.key) ?? 0) === item.keyGen) {
              cache.set(item.key, outcome)
            }
            inflight.delete(item.key)
            item.resolve(outcome)
          }
          return
        }

        try {
          const resolvedMap = await driver.readBatch(group.config, pending.map(item => item.reference), batch.controller.signal)
          batch.settled = true
          for (const item of pending) {
            const raw = resolvedMap.get(item.reference)
            let outcome
            if (typeof raw === 'string') {
              outcome = { ok: true, value: raw }
            } else if (raw && typeof raw === 'object' && raw.ok === true && typeof raw.value === 'string') {
              outcome = { ok: true, value: raw.value }
            } else if (raw && typeof raw === 'object' && raw.ok === false && raw.error) {
              const err = raw.error instanceof Error ? raw.error : new Error(String(raw.error))
              outcome = { ok: false, error: err }
            } else {
              outcome = {
                ok: false,
                error: Object.assign(new Error(`Secret provider "${group.providerId}" did not return a value for ${item.reference}.`), { code: 'SECRET_PROVIDER_MISSING' }),
              }
            }
            const skipCache = !outcome.ok && outcome.error?.code === 'ABORT_ERR' && batch.controller.signal.aborted
            if (!skipCache && generation === batchGen && (keyGenerations.get(item.key) ?? 0) === item.keyGen) {
              cache.set(item.key, outcome)
            }
            inflight.delete(item.key)
            item.resolve(outcome)
          }
        } catch (error) {
          batch.settled = true
          const err = error instanceof Error ? error : new Error(String(error))
          const batchAborted = err.code === 'ABORT_ERR' && batch.controller.signal.aborted
          for (const item of pending) {
            const outcome = { ok: false, error: err }
            // Cache provider errors so subsequent tool calls don't repeatedly pop OS prompts;
            // skip caching only when all callers explicitly aborted before completion.
            if (!batchAborted && generation === batchGen && (keyGenerations.get(item.key) ?? 0) === item.keyGen) {
              cache.set(item.key, outcome)
            }
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
    }

    const detachWaiter = (propagateAbort) => {
      for (const batch of attachedBatches) {
        batch.waiters.delete(waiterToken)
        if (propagateAbort && !batch.settled && batch.waiters.size === 0) {
          batch.controller.abort()
        }
      }
      attachedBatches.clear()
    }

    if (!signal) {
      try {
        await Promise.all(waits)
        return results
      } finally {
        detachWaiter(false)
      }
    }

    let onAbort
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => {
        detachWaiter(true)
        reject(abortError())
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    try {
      await Promise.race([Promise.all(waits), abortPromise])
      return results
    } finally {
      signal.removeEventListener('abort', onAbort)
      detachWaiter(false)
    }
  }

  return {
    getCached,
    resolve,
    invalidate,
    invalidateRef,
    allCachedValues,
  }
}
