// -------------------------------------------------------------------------
// The state answer names each Bot photo by a hash of its image (`imageRef`), so a
// pull does not carry every photo again; each image is fetched once per hash.

export function createAvatarResolver(fetchAvatar) {
  let cache = new Map()
  return async function resolveAvatars(value) {
    if (!Array.isArray(value?.bots)) return value
    const next = new Map()
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
      const answer = await fetchAvatar(bot.id).catch(() => null)
      if (typeof answer?.image !== 'string') return { ...bot, avatar }
      // The photo may have changed since the state answer: file it under its own ref.
      if (typeof answer.ref === 'string') next.set(answer.ref, answer.image)
      return { ...bot, avatar: { ...avatar, image: answer.image } }
    }))
    // Only the photos in this answer stay cached; a changed photo has a new ref.
    cache = next
    return { ...value, bots }
  }
}
