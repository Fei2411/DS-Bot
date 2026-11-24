export const BUILTIN_PACKS = {
  'team-admin': {
    tools: ['create_bot', 'stop_bot', 'create_group', 'delete_group'],
    defaults: { main: 'always', bot: 'off' },
  },
}

export function install(rt) {
  const scopeBySession = new Map()
  const computeScope = (id) => {
    const botId = rt.selfOf?.(id)
    const bot = rt.botOf?.(botId)
    const main = rt.isMain?.(botId) === true
    const hasRooms = Object.keys(rt.state?.rooms ?? {}).length > 0
    const inRoom = botId !== undefined && (rt.roomsOf?.(botId)?.length ?? 0) > 0
    const isTask = rt.taskOwners?.has(id) === true
    const hasTaskRoom = isTask && rt.taskOwners?.get(id)?.roomId !== undefined
    const hasPacks = (bot?.packs?.length ?? 0) > 0 || rt.hasLoadedPacks?.(id) === true
    return { main, hasRooms, inRoom, isTask, hasTaskRoom, hasPacks }
  }
  // Only a Main role is frozen for the turn (a demotion waits for the next one): a
  // frozen ordinary role would hide Main-only tools from a Main Bot all turn whenever
  // its role did not resolve at turn start, so an ordinary role stays live (#2127).
  rt.toolScopeForTurn = id => {
    const frozen = scopeBySession.get(id)
    if (frozen === undefined) return computeScope(id)
    return frozen.main || rt.isMain?.(rt.selfOf?.(id)) !== true ? frozen : { ...frozen, main: true }
  }
  rt.isMainForTurn = id => rt.toolScopeForTurn(id).main
  rt.refreshToolScopeForSession = (id) => {
    if (id === undefined || !rt.isBotSession?.(id)) return
    if (scopeBySession.has(id)) scopeBySession.set(id, computeScope(id))
    rt.syncScopedSession?.(id)
  }
  rt.hiddenBuiltinTools = id => {
    if (!rt.isBotSession?.(id)) return new Set()
    const role = rt.isMainForTurn(id) ? 'main' : 'bot'
    return new Set(Object.values(BUILTIN_PACKS).flatMap(pack => pack.defaults[role] === 'off' ? pack.tools : []))
  }
  rt.ctx.on('session/event', function freezeBuiltinPacks(session, event) {
    if (event.type === 'turn/start' && rt.isBotSession?.(session.id)) scopeBySession.set(session.id, computeScope(session.id))
    if (event.type === 'turn/end') {
      scopeBySession.delete(session.id)
      rt.syncScopedSession?.(session.id)
    }
  })
  rt.ctx.on('agent/created', ({ agent }) => {
    agent.ctx?.effect?.(() => () => scopeBySession.delete(agent.session?.id))
  })
  // Filter built-in packs and context-pruned tools once at host level by the
  // request's own Session id so per-Agent hooks cannot accumulate or strip
  // another Session's tools.
  rt.ctx.on('llm/stream', function filterBuiltinTools(options, next) {
    if (options.sessionId === undefined || !Array.isArray(options.tools) || options.tools.length === 0) return next()
    const hidden = rt.hiddenSessionTools?.(options.sessionId) ?? rt.hiddenBuiltinTools(options.sessionId)
    if (!options.tools.some(tool => hidden.has(tool?.name))) return next()
    return rt.ctx.llm.stream({ ...options, tools: options.tools.filter(tool => !hidden.has(tool?.name)) })
  })
  rt.ctx.effect(() => () => scopeBySession.clear(), 'ds-bot: built-in pack roles')
}
