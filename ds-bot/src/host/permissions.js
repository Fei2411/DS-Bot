import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

// Permissions. A Bot's permission preset is its own: kept on the Bot and set on every
// Session it speaks from, so a fresh part or a new group Session keeps it. A group may
// set one preset for all its members there, in place of each member's own, as it may
// set one working folder.
import { activeTasksOf } from './threads.js'

// DSH offers Auto review for the current Session only, so neither a Bot nor a group keeps it.
const SESSION_ONLY = 'auto'

export function install(rt) {
  const { ctx } = rt

  const presets = () => ctx.get?.('permissionPresets')
  const reviewAvailable = () => Boolean(ctx.get?.('approval')?.setPolicy && ctx.get?.('sandboxPolicy'))

  // The presets DSH offers, or undefined when the profile has none.
  function permissionCatalog() {
    const service = presets()
    if (service === undefined) return undefined
    const { options, defaultPreset } = service.catalog()
    const choices = options.filter(option => option.value !== SESSION_ONLY && option.value !== 'review')
    if (reviewAvailable()) choices.push({ value: 'review', name: 'Review for me', description: 'Workspace sandbox with model review; uncertain decisions come back to you.' })
    return { options: choices, defaultPreset }
  }

  const roomOfSession = sessionId => rt.roomOf(rt.groupOwners.get(sessionId)?.roomId ?? rt.taskOwners?.get(sessionId)?.roomId)

  // `name` may be a function: it is read once the agent resolves, so a change asked
  // for while the resolve ran wins over the one still being applied.
  async function setPreset(sessionId, name, restartCli = false) {
    const agent = await rt.resolveAgent(sessionId)
    if (restartCli && (typeof name === 'function' ? name() : name)) await rt.closeLocalAgentSession?.(sessionId, 'the permission mode changed')
    const wanted = typeof name === 'function' ? name() : name
    if (wanted) {
      if (wanted === 'review') {
        if (!reviewAvailable()) throw new Error('Approval review is unavailable in this DeepSeek Harness')
        setSandboxMode(agent.session, 'workspace-write')
        ctx.get('approval').setPolicy(agent, 'ask')
      } else presets().set(agent.session, wanted)
      if (rt.state?.approvalPolicies) delete rt.state.approvalPolicies[sessionId]
    }
    return wanted
  }

  // Sets the preset on one of the Bot's Sessions: its group's there, else its own; a Bot
  // without one keeps DSH's default. `room` is for a group Session not indexed yet.
  // Returns the preset it set, or undefined when it set none.
  async function applyPermission(bot, sessionId, room = roomOfSession(sessionId)) {
    const name = () => room?.permission ?? bot.permission
    if (presets() !== undefined && name()) return setPreset(sessionId, name)
    if (rt.state?.approvalPolicies?.[sessionId] !== undefined) await applyReviewPolicy(await rt.resolveAgent(sessionId))
  }

  function checkPreset(name, whose) {
    const service = presets()
    if (service === undefined) throw new Error('Permissions are not available in this DeepSeek Harness')
    const wanted = String(name ?? '').trim()
    if (wanted === SESSION_ONLY) throw new Error(`Auto review applies to one Session only and cannot be ${whose} permission`)
    if (wanted === 'review') {
      if (!reviewAvailable()) throw new Error('Approval review is unavailable in this DeepSeek Harness')
    } else service.resolve(wanted)
    return wanted
  }

  // Per Bot, requests are numbered and the last preset an apply actually set is
  // tracked: only the newest request may roll the field back, and then to that
  // applied value, never to a value a request had only asked for.
  const requests = new Map()
  const roomRequests = new WeakMap()

  async function setPermission(bot, name) {
    const wanted = checkPreset(name, 'a Bot\'s')
    const request = requests.get(bot.id) ?? { seq: 0, applied: bot.permission }
    const mine = ++request.seq
    requests.set(bot.id, request)
    // The Bot's own chat may have background parts opened while it was busy: a stricter
    // preset must reach those live Sessions too, or the user would think it applied.
    // Group tasks follow their group's permission below (inheriting bot.permission if unset).
    const own = () => [rt.chatOf(bot.id), ...activeTasksOf(bot).filter(task => task.roomId === undefined).map(task => task.sessionId)]
      .filter((sessionId, index, list) => sessionId !== undefined && list.indexOf(sessionId) === index)
    const groupSessions = () => [
      ...rt.groupSessionsOf(bot.id),
      ...activeTasksOf(bot).filter(task => task.roomId !== undefined).map(task => task.sessionId),
    ].filter((sessionId, index, list) => sessionId !== undefined && list.indexOf(sessionId) === index)
    // The snapshot covers every Session groupSessions() applies to, task Sessions
    // included: without their entry a stale room request marker reads as newer and
    // the Bot's new preset never reaches that Session.
    const groupRequests = new Map(groupSessions().map(id => [id, roomRequests.get(roomOfSession(id))]))
    // The preset is written before its first await: a request still being applied
    // then reads the one asked for last.
    rt.cancelApprovalReviews?.({ botId: bot.id })
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      const room = roomOfSession(sessionId)
      if (room && !room.permission) rt.cancelApprovalReviews?.({ botId: bot.id, roomId: room.id })
    }
    bot.permission = wanted
    // The preset for one Session is read once its agent resolves: undefined once a
    // newer request exists, so a superseded request writes no more Sessions — every
    // Session the Bot has ends at the value the newest request actually applied.
    const applyTo = (sessionId, room = roomOfSession(sessionId)) => {
      const groupRequest = groupRequests.get(sessionId)
      return setPreset(sessionId, () => request.seq === mine
        && (!room || (!room.permission && roomRequests.get(room) === groupRequest)) ? bot.permission : undefined, true)
    }
    const groups = async (warnFail) => {
      for (const sessionId of groupSessions()) {
        if (request.seq !== mine) break
        if (roomOfSession(sessionId)?.permission) continue
        await applyTo(sessionId).catch(warnFail)
      }
    }
    try {
      let applied
      for (const sessionId of own()) {
        if (request.seq !== mine) break
        applied = await applyTo(sessionId)
      }
      if (applied !== undefined) request.applied = applied
    } catch (error) {
      if (request.seq === mine) {
        // A change that fails halfway leaves Sessions on the preset it asked for: the
        // preset goes back on every one of them, including when the Bot had none before,
        // where it is the default that Bot ran on. Rolling only the field back would tell
        // the user the Bot is strict again while a part still runs wider.
        if (request.applied === undefined) delete bot.permission
        else bot.permission = request.applied
        const fallback = request.applied ?? presets().catalog().defaultPreset
        const warnFail = error => rt.warn('ds-bot: permission for %s not restored: %s', bot.name, error)
        // Read through the staleness check, like applyTo: a newer request that applies to
        // a Session while this rollback waits on it must not be written over afterwards.
        const restoreTo = (sessionId) => setPreset(sessionId, () => (request.seq === mine ? roomOfSession(sessionId)?.permission ?? fallback : undefined))
        for (const sessionId of own()) {
          if (request.seq !== mine) break
          await restoreTo(sessionId).catch(warnFail)
        }
        for (const sessionId of groupSessions()) {
          if (request.seq !== mine) break
          if (roomOfSession(sessionId)?.permission) continue
          await restoreTo(sessionId).catch(warnFail)
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
    const request = {}
    roomRequests.set(room, request)
    rt.cancelApprovalReviews?.({ roomId: room.id })
    if (wanted === undefined) delete room.permission
    else room.permission = wanted
    const service = presets()
    if (service === undefined) return true
    const members = Object.entries(room.sessions ?? {}).map(([id, sessionId]) => ({ id, sessionId, seq: requests.get(id)?.seq }))
    for (const { id: botId, sessionId, seq } of members) {
      if (roomRequests.get(room) !== request) break
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      // A member without a preset of its own goes back to the default its Session started on.
      await setPreset(sessionId, () => roomRequests.get(room) === request
        && (room.permission !== undefined || requests.get(botId)?.seq === seq)
        ? room.permission ?? bot.permission ?? service.catalog().defaultPreset : undefined, true)
        .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', bot.name, room.name, error))
    }
    for (const botId of room.members ?? []) {
      if (roomRequests.get(room) !== request) break
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      const seq = requests.get(botId)?.seq
      for (const task of activeTasksOf(bot)) {
        if (roomRequests.get(room) !== request) break
        if (task.roomId !== room.id) continue
        const requested = wanted ?? bot.permission ?? service.catalog().defaultPreset
        const requestedPreset = requested === 'review' ? 'workspace-write' : requested
        const launchPreset = rt.localAgentLaunchPreset?.(task.sessionId)
        // The adapter records the mode the live CLI actually opened with, including
        // the profile default and opens that raced with an earlier settings request.
        const restart = launchPreset === undefined || launchPreset !== requestedPreset
        await setPreset(task.sessionId, () => roomRequests.get(room) === request
          && (room.permission !== undefined || requests.get(botId)?.seq === seq)
          ? room.permission ?? bot.permission ?? service.catalog().defaultPreset : undefined, restart)
          .catch(error => rt.warn('ds-bot: permission for task %s of %s in %s not applied: %s', task.id, bot.name, room.name, error))
      }
    }
    return true
  }

  async function applyReviewPolicy(agent) {
    const approval = ctx.get?.('approval')
    if (!approval || !rt.state) return
    const sessionId = agent.session?.id ?? agent.id
    let owner
    let current = agent
    const seen = new Set()
    while (current && seen.size < 16) {
      const id = current.session?.id ?? current.id
      if (seen.has(id)) break
      seen.add(id)
      const group = rt.groupOwners.get(id)
      const task = rt.taskOwners?.get(id)
      const bot = rt.botOf(group?.botId ?? task?.botId ?? rt.chatOwners?.get(id))
      if (bot) {
        owner = { id, bot, room: rt.roomOf(group?.roomId ?? task?.roomId) }
        break
      }
      const parent = current.session?.header?.parentSession
      current = parent && current.session.header.origin === 'subagent' ? await rt.resolveAgent(parent).catch(() => undefined) : undefined
    }
    if (!owner) return
    const wanted = owner.room?.permission ?? owner.bot.permission
    const saved = rt.state.approvalPolicies ??= {}
    if (wanted === 'review') {
      if (!reviewAvailable()) throw new Error('Approval review is unavailable in this DeepSeek Harness')
      const mode = ctx.get('sandboxPolicy').resolve({ session: agent.session }).mode
      // Child Sessions keep a narrower sandbox; a full-access child is capped at workspace.
      if (mode !== 'workspace-write' && (owner.id === sessionId || mode !== 'read-only')) setSandboxMode(agent.session, 'workspace-write')
      if (owner.id !== sessionId && !Object.hasOwn(saved, sessionId)) {
        const override = approval.overrideOf(agent.session)
        // DSH exposes no public way to remove a temporary override. An inherited
        // policy must stay inherited; only an explicit override can be restored.
        if (override === undefined) return
        saved[sessionId] = override
      }
      approval.setPolicy(agent, 'ask')
    } else if (Object.hasOwn(saved, sessionId)) {
      approval.setPolicy(agent, saved[sessionId])
      delete saved[sessionId]
    }
  }
  ctx.on?.('tools/pre-execute', async (exec, next) => {
    await applyReviewPolicy(exec.agent)
    return next()
  }, { prepend: true })

  const forgetBotPermissions = botId => requests.delete(botId)

  Object.assign(rt, { permissionCatalog, applyPermission, setPermission, cleanRoomPermission, setRoomPermission, forgetBotPermissions, applyReviewPolicy })
}
