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
  async function setPreset(sessionId, name, target) {
    const agent = await rt.resolveAgent(sessionId)
    const wanted = typeof name === 'function' ? name() : name
    if (wanted) {
      presets().set(agent.session, wanted)
      const saved = rt.state?.approvalPolicies
      if (saved && Object.hasOwn(saved, sessionId)) saved[sessionId] = ctx.get('approval').effectivePolicy(agent.session)
      await applyAutoApproval(agent, target)
    }
    return wanted
  }

  // Sets the preset on one of the Bot's Sessions: its group's there, else its own; a Bot
  // without one keeps DSH's default. `room` is for a group Session not indexed yet.
  // Returns the preset it set, or undefined when it set none.
  async function applyPermission(bot, sessionId, room = roomOfSession(sessionId)) {
    const name = () => room?.permission ?? bot.permission
    if (presets() !== undefined && name()) return setPreset(sessionId, name, room ?? bot)
    if ((room ?? bot).autoApprove === true || rt.state?.approvalPolicies?.[sessionId] !== undefined) {
      await applyAutoApproval(await rt.resolveAgent(sessionId), room ?? bot)
    }
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

  const changes = new WeakMap()
  async function applyAutoApproval(agent, known) {
    const approval = ctx.get?.('approval')
    if (!approval || !rt.state) return
    const sessionId = agent.session?.id ?? agent.id
    let target = known
    let current = agent
    const seen = new Set()
    while (!target && current && seen.size < 16) {
      const id = current.session?.id ?? current.id
      if (seen.has(id)) break
      seen.add(id)
      const group = rt.groupOwners.get(id)
      target = group ? rt.roomOf(group.roomId) : rt.botOf(rt.chatOwners?.get(id))
      if (target) break
      const parent = current.session?.header?.parentSession
      current = parent ? await rt.resolveAgent(parent).catch(() => undefined) : undefined
    }
    if (!target) return
    const saved = rt.state.approvalPolicies ??= {}
    if (target.autoApprove === true) {
      if (!Object.hasOwn(saved, sessionId)) saved[sessionId] = approval.effectivePolicy(agent.session)
      approval.setPolicy(agent, 'ask')
    } else if (Object.hasOwn(saved, sessionId)) {
      approval.setPolicy(agent, saved[sessionId])
      delete saved[sessionId]
    }
  }
  ctx.on?.('tools/pre-execute', async (exec, next) => {
    await applyAutoApproval(exec.agent)
    return next()
  }, { prepend: true })

  function setAutoApprove(target, value, group = false) {
    if (typeof value !== 'boolean') throw new Error('Automatic approval must be true or false')
    if (!ctx.get?.('approval')?.setPolicy) throw new Error('Approval review is unavailable in this DeepSeek Harness')
    const before = changes.get(target) ?? Promise.resolve()
    const run = before.catch(() => {}).then(async () => {
      const previous = target.autoApprove
      rt.cancelApprovalReviews?.(group ? { roomId: target.id } : { botId: target.id })
      target.autoApprove = value
      const ids = group ? Object.values(target.sessions ?? {}) : [rt.chatOf(target.id)]
      try {
        for (const id of ids) await applyAutoApproval(await rt.resolveAgent(id), target)
      } catch (error) {
        target.autoApprove = previous
        for (const id of ids) await applyAutoApproval(await rt.resolveAgent(id), target).catch(() => {})
        throw error
      }
    })
    changes.set(target, run)
    return run.finally(() => { if (changes.get(target) === run) changes.delete(target) })
  }
  Object.assign(rt, { permissionCatalog, applyPermission, setPermission, cleanRoomPermission, setRoomPermission, applyAutoApproval, setAutoApprove })
}
