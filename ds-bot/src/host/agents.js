// The DSH Agent: a team's one plain dsh entry, listed beside the Bots but not one of
// them. Its Sessions are ordinary root Sessions in the DS Bot workspace, so they get
// the whole dsh conversation surface and none of the team tools.
import { randomUUID } from 'node:crypto'
import { AGENT_NAME, AGENT_SESSION_TITLE_MAX } from './constants.js'

export function install(rt) {
  const { ctx, state } = rt

  /** @type {Map<string, string>} Session id -> DSH Agent record id. */
  const sessionIndex = new Map()
  // store.js calls this from indexSessions after every adopt and save.
  rt.indexAgents = () => {
    sessionIndex.clear()
    for (const agent of Object.values(state.agents)) {
      for (const sessionId of agent.sessions ?? []) sessionIndex.set(sessionId, agent.id)
    }
  }
  // The DSH Agent a Session belongs to; Bot and group Sessions get undefined.
  const agentOf = sessionId => state.agents[sessionIndex.get(sessionId)]
  // A DSH Agent by id, for the windows that page its Sessions.
  const agentById = agentId => rt.own(state.agents, agentId)

  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const record = (agentId) => {
    const agent = rt.own(state.agents, agentId)
    if (agent === undefined) throw new Error('Unknown DSH Agent')
    return agent
  }

  async function createAgentSession(agentId, workspaceId) {
    writeCheck()
    const agent = record(agentId)
    // A known workspace id wins (the Agent's latest Session may live outside the
    // team workspace after a workspace switch); anything else gets the team's own.
    const target = typeof workspaceId === 'string' && ctx.workspaceRegistry.get(workspaceId)
      ? workspaceId
      : await rt.ensureWorkspace()
    const { sessionId } = await ctx.sessionController.create({ workspaceId: target })
    agent.sessions.push(sessionId)
    await rt.save()
    return sessionId
  }

  // A root Session the user opened from a DSH Agent page (the hero's workspace
  // picker or a fork) is adopted into the same Agent: it keeps dsh's surface and
  // the team tools stay hidden.
  async function adoptAgentSession(agentId, sessionId) {
    writeCheck()
    const agent = record(agentId)
    if (agent.sessions.includes(sessionId)) return sessionId
    await rt.resolveAgent(sessionId)
    const owned = rt.selfOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined
      || rt.roomOf(sessionId) !== undefined || agentOf(sessionId) !== undefined
    if (owned) throw new Error('Session already belongs to the team')
    agent.sessions.push(sessionId)
    await rt.save()
    return sessionId
  }

  async function addAgent() {
    writeCheck()
    if (Object.keys(state.agents).length > 0) throw new Error('The team already has a DSH Agent')
    const agent = { id: randomUUID(), name: AGENT_NAME, sessions: [], createdAt: Date.now() }
    state.agents[agent.id] = agent
    try {
      await createAgentSession(agent.id)
    } catch (error) {
      // The first Session may already be created and saved: archive it and
      // persist the rollback, or the Agent returns on restart with its team
      // tools never denied.
      const createdSessions = [...agent.sessions]
      delete state.agents[agent.id]
      for (const sessionId of createdSessions) await ctx.workspaceRegistry.archiveSession(sessionId).catch(() => {})
      await rt.save().catch(() => {})
      throw error
    }
    return agent
  }

  // A Session another plugin deleted outright is already gone: archiving it either
  // wrote it before (resolving without a write) or cannot find it at all. Only that
  // definite miss for this exact Session may drop the reference; an active Session, a
  // storage fault, or a miss naming another Session stays a failure, so the reference
  // and its tool restriction stay retryable.
  const alreadyGone = (error, sessionId) => error?.name === 'WorkspaceUnknownSessionError'
    && error?.sessionId === sessionId

  async function archiveAgentSession(agentId, sessionId) {
    writeCheck()
    const agent = record(agentId)
    if (!agent.sessions.includes(sessionId)) throw new Error('Session does not belong to the DSH Agent')
    // Archive first: the Session leaves the Agent only once it is actually gone,
    // so a failed archive stays retryable and keeps its tool restriction.
    try {
      await ctx.workspaceRegistry.archiveSession(sessionId)
    } catch (error) {
      if (!alreadyGone(error, sessionId)) throw error
    }
    agent.sessions = agent.sessions.filter(id => id !== sessionId)
    await rt.save()
  }

  // A permanent delete by another plugin leaves a reference whose Session can never
  // be opened or archived again. The session manager reports a completed physical
  // delete on its own event (not a dsh teardown signal: a plain close or unload is
  // not a deletion), and this window drops the reference so the sidebar loses it
  // too. Without such a plugin the listener never runs; an older dangling reference
  // is still cleared by the archive action above.
  ctx.on('session-manager/session-deleted', async ({ sessionId } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    await rt.load()
    const agent = Object.values(state.agents).find(item => item.sessions?.includes(sessionId))
    if (agent === undefined) return
    writeCheck()
    const position = agent.sessions.indexOf(sessionId)
    agent.sessions = agent.sessions.filter(id => id !== sessionId)
    try {
      // The deletion already happened elsewhere, so the reference must not come
      // back after a restart: this write has to land.
      await rt.save({ required: true })
    } catch (error) {
      // The write did not land: keep the reference so the archive action or a
      // later attempt can still clear it, rather than forgetting it in this window.
      // The failed save had already re-indexed the state without this Session, so
      // rebuild the Agent index after putting the reference back: until the next
      // save or adopt, rt.agentOf must still see an owned Agent Session, or every
      // window treats it as a Session no Agent owns.
      if (state.agents[agent.id] === agent && !agent.sessions.includes(sessionId)) {
        agent.sessions.splice(Math.min(position, agent.sessions.length), 0, sessionId)
      }
      rt.indexAgents()
      throw error
    }
  })

  async function renameAgentSession(agentId, sessionId, title) {
    writeCheck()
    const agent = record(agentId)
    if (!agent.sessions.includes(sessionId)) throw new Error('Session does not belong to the DSH Agent')
    const clean = String(title ?? '').trim()
    if (clean === '') throw new Error('A session needs a title')
    const agent_ = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent_.session, clean.slice(0, AGENT_SESSION_TITLE_MAX))
  }

  async function removeAgent(agentId) {
    writeCheck()
    const agent = record(agentId)
    const sessions = [...agent.sessions]
    const kept = []
    let failure
    for (const sessionId of sessions) {
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId)
      } catch (error) {
        // A Session deleted outside dsh is already gone; it must not keep the
        // whole Agent alive forever.
        if (alreadyGone(error, sessionId)) continue
        failure ??= error
        kept.push(sessionId)
      }
    }
    // What could not be archived stays with the Agent, so it keeps its tool
    // restriction and the removal can be retried from the same place.
    if (kept.length > 0) {
      agent.sessions = kept
      await rt.save()
      throw failure
    }
    delete state.agents[agentId]
    await rt.save()
  }

  Object.assign(rt, { agentOf, agentById, addAgent, createAgentSession, adoptAgentSession, archiveAgentSession, renameAgentSession, removeAgent })
}
