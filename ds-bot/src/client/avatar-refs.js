// -------------------------------------------------------------------------
// The state answer names each Bot photo by a hash of its image (`imageRef`), so a
// pull does not carry every photo again; each image is fetched once per hash.

export function createAvatarResolver(fetchAvatar) {
  let cache = new Map()
  let missing = 0
  async function resolveAvatars(value) {
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
      if (!pending.has(ref)) pending.set(ref, fetchAvatar(bot.id).catch(() => null))
      const answer = await pending.get(ref)
      if (typeof answer?.image !== 'string') {
        failed += 1
        return { ...bot, avatar }
      }
      // The photo may have changed since the state answer: file it under its own ref.
      if (typeof answer.ref === 'string') next.set(answer.ref, answer.image)
      return { ...bot, avatar: { ...avatar, image: answer.image } }
    }))
    // Only the photos in this answer stay cached; a changed photo has a new ref.
    cache = next
    missing = failed
    return { ...value, bots }
  }
  // A photo that could not be fetched is asked for again on the next full answer;
  // an unchanged answer carries no Bots to fill it in.
  resolveAvatars.missing = () => missing > 0
  return resolveAvatars
}
