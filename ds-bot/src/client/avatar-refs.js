// Client-side cache for avatar photos returned by reference (`avatars: 'ref'`).
// State polls carry a short content hash (`imageRef`) instead of multi-MB data URLs;
// missing refs are fetched once via `avatar`, cached by ref, restored onto each entry's
// `avatar.image` with `imageRef` stripped, and evicted once no Bot or group uses them.

function stripRef(avatar, image) {
  const { imageRef: _drop, ...rest } = avatar
  return typeof image === 'string' ? { ...rest, image } : rest
}

/**
 * Create a per-window avatar reference cache.
 * @param {(endpoint: string, payload: object) => Promise<any>} call
 */
export function createAvatarRefCache(call) {
  const cache = new Map()
  const inflight = new Map()
  const ownerImage = new Map()
  let latestGen = 0
  let latestLiveRefs = new Set()

  const fetchRef = (ref, payload) => {
    let job = inflight.get(ref)
    if (job === undefined) {
      job = Promise.resolve()
        .then(() => call('avatar', payload))
        .then((reply) => {
          if (typeof reply?.image === 'string') {
            const actual = typeof reply?.ref === 'string' && reply.ref !== '' ? reply.ref : ref
            if (latestLiveRefs.has(actual) || latestLiveRefs.has(ref)) {
              cache.set(actual, reply.image)
            }
            return { status: 'ok', ref: actual, image: reply.image }
          }
          if (reply !== null && typeof reply === 'object' && reply.image === null) {
            return { status: 'empty' }
          }
          return { status: 'error' }
        })
        .catch(() => ({ status: 'error' }))
        .finally(() => { inflight.delete(ref) })
      inflight.set(ref, job)
    }
    return job
  }

  /**
   * Resolve all `imageRef` entries on a full `state` payload in place-free fashion.
   * Entries that already carry inline `avatar.image` without `imageRef` stay untouched.
   * Returns `{ state, incomplete, resolved }` so callers can retry transient fetch failures
   * without losing previously displayed photos or misinterpreting authoritative empties.
   */
  async function hydrate(value) {
    if (value === null || typeof value !== 'object') return { state: value, incomplete: false, resolved: false }
    const bots = Array.isArray(value.bots) ? value.bots : null
    const rooms = Array.isArray(value.rooms) ? value.rooms : null
    if (bots === null && rooms === null) return { state: value, incomplete: false, resolved: false }

    const gen = ++latestGen
    const liveRefs = new Set()
    const liveOwners = new Set()
    const missing = new Map()
    const collect = (entries, key, kind) => {
      if (entries === null) return
      for (const entry of entries) {
        if (entry?.id !== undefined) liveOwners.add(`${kind}:${entry.id}`)
        const ref = entry?.avatar?.imageRef
        if (typeof ref !== 'string' || ref === '') continue
        liveRefs.add(ref)
        if (!cache.has(ref) && !missing.has(ref)) {
          missing.set(ref, { [key]: entry.id, ref })
        }
      }
    }
    collect(bots, 'botId', 'bot')
    collect(rooms, 'roomId', 'room')
    latestLiveRefs = liveRefs

    const fetched = new Set()
    const results = new Map()
    let resolved = false
    if (missing.size > 0) {
      await Promise.all([...missing.entries()].map(async ([ref, payload]) => {
        const result = await fetchRef(ref, payload)
        results.set(ref, result)
        if (result.status === 'ok') {
          resolved = true
          if (result.ref) fetched.add(result.ref)
        }
      }))
    }

    const isLatest = gen === latestGen
    if (isLatest) {
      // Only the latest hydrate may evict unused refs so an out-of-order slow pull
      // never drops live refs cached by a newer pull.
      for (const ref of cache.keys()) {
        if (!liveRefs.has(ref) && !fetched.has(ref)) cache.delete(ref)
      }
      for (const key of ownerImage.keys()) {
        if (!liveOwners.has(key)) ownerImage.delete(key)
      }
    }

    let incomplete = false
    const restore = (kind) => (entry) => {
      const ownerKey = `${kind}:${entry?.id ?? ''}`
      const avatar = entry?.avatar
      if (avatar === null || typeof avatar !== 'object' || typeof avatar.imageRef !== 'string' || avatar.imageRef === '') {
        if (isLatest) {
          if (typeof avatar?.image === 'string') ownerImage.set(ownerKey, avatar.image)
          else ownerImage.delete(ownerKey)
        }
        return entry
      }
      if (typeof avatar.image === 'string') {
        if (isLatest) ownerImage.set(ownerKey, avatar.image)
        return { ...entry, avatar: stripRef(avatar, avatar.image) }
      }
      const cached = cache.get(avatar.imageRef)
      if (typeof cached === 'string') {
        if (isLatest) ownerImage.set(ownerKey, cached)
        return { ...entry, avatar: stripRef(avatar, cached) }
      }
      const outcome = results.get(avatar.imageRef)
      if (outcome?.status === 'ok') {
        if (isLatest) ownerImage.set(ownerKey, outcome.image)
        return { ...entry, avatar: stripRef(avatar, outcome.image) }
      }
      if (outcome?.status === 'empty') {
        if (isLatest) ownerImage.delete(ownerKey)
        return { ...entry, avatar: stripRef(avatar, undefined) }
      }
      incomplete = true
      return { ...entry, avatar: stripRef(avatar, ownerImage.get(ownerKey)) }
    }

    return {
      state: {
        ...value,
        ...(bots !== null ? { bots: bots.map(restore('bot')) } : {}),
        ...(rooms !== null ? { rooms: rooms.map(restore('room')) } : {}),
      },
      incomplete,
      resolved,
    }
  }

  return {
    hydrate,
    size: () => cache.size,
    has: ref => cache.has(ref),
    clear: () => {
      latestGen += 1
      latestLiveRefs = new Set()
      cache.clear()
      inflight.clear()
      ownerImage.clear()
    },
  }
}
