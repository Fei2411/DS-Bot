// Permissions. A Bot's permission preset is its own: kept on the Bot and set on every
// Session it speaks from, so a fresh part or a new group Session keeps it. A group may
// set one preset for all its members there, in place of each member's own, as it may
// set one working folder.
// DSH offers Auto review for the current Session only, so neither a Bot nor a group keeps it.
const SESSION_ONLY = 'auto'

export function install(rt) {
  const { ctx } = rt

  const presets = () => ctx.get?.('permissionPresets')

  // The presets DSH offers, or undefined when the profile has none.
  function permissionCatalog() {
    const service = presets()
    if (service === undefined) return undefined
    const { options, defaultPreset } = service.catalog()
    return { options: options.filter(option => option.value !== SESSION_ONLY), defaultPreset }
  }

  const roomOfSession = sessionId => rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)

  // `name` may be a function: it is read once the agent resolves, so a change asked
  // for while the resolve ran wins over the one still being applied.
  async function setPreset(sessionId, name) {
    const agent = await rt.resolveAgent(sessionId)
    const wanted = typeof name === 'function' ? name() : name
    if (wanted) presets().set(agent.session, wanted)
    return wanted
  }

  // Sets the preset on one of the Bot's Sessions: its group's there, else its own; a Bot
  // without one keeps DSH's default. `room` is for a group Session not indexed yet.
  // Returns the preset it set, or undefined when it set none.
  async function applyPermission(bot, sessionId, room = roomOfSession(sessionId)) {
    const name = () => room?.permission ?? bot.permission
    if (presets() === undefined || !name()) return
    return setPreset(sessionId, name)
  }

  function checkPreset(name, whose) {
    const service = presets()
    if (service === undefined) throw new Error('Permissions are not available in this DeepSeek Harness')
    const wanted = String(name ?? '').trim()
    if (wanted === SESSION_ONLY) throw new Error(`Auto review applies to one Session only and cannot be ${whose} permission`)
    service.resolve(wanted)
    return wanted
  }

  // Per Bot, requests are numbered and the last preset an apply actually set is
  // tracked: only the newest request may roll the field back, and then to that
  // applied value, never to a value a request had only asked for.
  const requests = new Map()

  async function setPermission(bot, name) {
    const wanted = checkPreset(name, 'a Bot\'s')
    const request = requests.get(bot.id) ?? { seq: 0, applied: bot.permission }
    const mine = ++request.seq
    requests.set(bot.id, request)
    // The preset is written before its first await: a request still being applied
    // then reads the one asked for last.
    bot.permission = wanted
    // The preset for one Session is read once its agent resolves: undefined once a
    // newer request exists, so a superseded request writes no more Sessions — every
    // Session the Bot has ends at the value the newest request actually applied.
    const applyTo = (sessionId, room = roomOfSession(sessionId)) =>
      setPreset(sessionId, () => (request.seq === mine ? room?.permission ?? bot.permission : undefined))
    const groups = async (warnFail) => {
      for (const sessionId of rt.groupSessionsOf(bot.id)) {
        if (request.seq !== mine) break
        if (roomOfSession(sessionId)?.permission) continue
        await applyTo(sessionId).catch(warnFail)
      }
    }
    try {
      const applied = await applyTo(rt.chatOf(bot.id))
      if (applied !== undefined) request.applied = applied
    } catch (error) {
      if (request.seq === mine) {
        if (request.applied === undefined) delete bot.permission
        else {
          bot.permission = request.applied
          // The restored preset goes back on every Session the change left behind.
          const warnFail = error => rt.warn('ds-bot: permission for %s not restored: %s', bot.name, error)
          await applyTo(rt.chatOf(bot.id)).catch(warnFail)
          await groups(warnFail)
        }
      }
      throw error
    }
    await groups(error => rt.warn('ds-bot: permission for %s in a group not applied: %s', bot.name, error))
  }

  // A group's preset, or null when each member uses its own.
  const cleanRoomPermission = name => (name === null || name === '' ? null : checkPreset(name, 'a group\'s'))

  // Members' Sessions in the group change now; a member that has none there yet gets the
  // group's preset when its first turn there makes one. Returns whether it changed.
  async function setRoomPermission(room, name) {
    const wanted = cleanRoomPermission(name) ?? undefined
    if (wanted === room.permission) return false
    if (wanted === undefined) delete room.permission
    else room.permission = wanted
    const service = presets()
    if (service === undefined) return true
    for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      // A member without a preset of its own goes back to the default its Session started on.
      await setPreset(sessionId, () => room.permission ?? bot.permission ?? service.catalog().defaultPreset)
        .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', bot.name, room.name, error))
    }
    return true
  }

  Object.assign(rt, { permissionCatalog, applyPermission, setPermission, cleanRoomPermission, setRoomPermission })
}
