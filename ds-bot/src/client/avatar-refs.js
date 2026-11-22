// -------------------------------------------------------------------------
// The state answer names each Bot photo by a hash of its image (`imageRef`), so a
// pull does not carry every photo again; each image is fetched once per hash.

export function createAvatarResolver(fetchAvatar) {
  let cache = new Map()
  let missing = 0
  let committed = 0
  // `order` is the pull's place: pulls overlap, and an older one that finishes
  // late must not replace the cache and missing count of a newer one.
  async function resolveAvatars(value, order) {
    if (!Array.isArray(value?.bots)) return value
    const next = new Map()
    // Bots that share a photo share one fetch.
    const pending = new Map()
    let failed = 0
    const bots = await Promise.all(value.bots.map(async (bot) => {
      const ref = bot.avatar?.imageRef
      if (typeof ref !== 'string') return bot
      // The ref stays out of the roster: settings send `bot.avatar` back on save.
      const { imageRef: _ref, ...avatar } = bot.avatar
      const known = cache.get(ref) ?? next.get(ref)
      if (known !== undefined) {
        next.set(ref, known)
        return { ...bot, avatar: { ...avatar, image: known } }
      }
      let shared = pending.get(ref)
      if (shared === undefined) pending.set(ref, shared = { botId: bot.id, answer: fetchAvatar(bot.id).catch(() => null) })
      let answer = await shared.answer
      // The Bot that was asked may have a new photo by now: then this one asks for its own.
      if (shared.botId !== bot.id && typeof answer?.ref === 'string' && answer.ref !== ref) answer = await fetchAvatar(bot.id).catch(() => null)
      if (typeof answer?.image !== 'string') {
        failed += 1
        return { ...bot, avatar }
      }
      // The photo may have changed since the state answer: file it under its own ref.
      if (typeof answer.ref === 'string') next.set(answer.ref, answer.image)
      return { ...bot, avatar: { ...avatar, image: answer.image } }
    }))
    if (order === undefined || order >= committed) {
      if (order !== undefined) committed = order
      // Only the photos in this answer stay cached; a changed photo has a new ref.
      cache = next
      missing = failed
    }
    return { ...value, bots }
  }
  // A photo that could not be fetched is asked for again on the next full answer;
  // an unchanged answer carries no Bots to fill it in.
  resolveAvatars.missing = () => missing > 0
  return resolveAvatars
}

// A full answer at the roster's own revision is skipped, unless it was asked for to
// fetch photos that failed last time: then it carries the photos the roster lacks.
export function sameRoster(value, current, retrying = false) {
  if (value.unchanged) return true
  return !retrying && value.revision === current.revision && value.modelsKey === current.modelsKey
}
