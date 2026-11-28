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
    const isGroup = rt.groupOwners?.has(id) === true
    const isTask = rt.taskOwners?.has(id) === true
    const hasTaskRoom = isTask && rt.taskOwners?.get(id)?.roomId !== undefined
    const preserveTaskPrefix = isTask && rt.taskOwners?.get(id)?.preservePrefix === true
    const hasPacks = (bot?.packs?.length ?? 0) > 0 || rt.hasLoadedPacks?.(id) === true
    return { main, hasRooms, inRoom, isGroup, isTask, hasTaskRoom, preserveTaskPrefix, hasPacks }
  }
  rt.toolScopeForTurn = id => scopeBySession.get(id) ?? computeScope(id)
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
    if (rt.isCacheAffinityRewritten?.(options) || options.sessionId === undefined || !Array.isArray(options.tools) || options.tools.length === 0) return next()
    const hidden = rt.hiddenSessionTools?.(options.sessionId) ?? rt.hiddenBuiltinTools(options.sessionId)
    if (!options.tools.some(tool => hidden.has(tool?.name))) return next()
    return rt.ctx.llm.stream({ ...options, tools: options.tools.filter(tool => !hidden.has(tool?.name)) })
  })
  rt.ctx.effect(() => () => scopeBySession.clear(), 'ds-bot: built-in pack roles')
}
