export const BUILTIN_PACKS = {
  'team-admin': {
    tools: ['create_bot', 'stop_bot', 'create_group', 'delete_group'],
    defaults: { main: 'always', bot: 'off' },
  },
}

export function install(rt) {
  const mainBySession = new Map()
  rt.isMainForTurn = id => mainBySession.get(id) ?? rt.isMain(rt.selfOf(id))
  rt.hiddenBuiltinTools = id => {
    if (!rt.isBotSession(id)) return new Set()
    const role = rt.isMainForTurn(id) ? 'main' : 'bot'
    return new Set(Object.values(BUILTIN_PACKS).flatMap(pack => pack.defaults[role] === 'off' ? pack.tools : []))
  }
  rt.ctx.on('session/event', function freezeBuiltinPacks(session, event) {
    if (event.type === 'turn/start' && rt.isBotSession(session.id)) mainBySession.set(session.id, rt.isMain(rt.selfOf(session.id)))
    if (event.type === 'turn/end') mainBySession.delete(session.id)
  })
  rt.ctx.on('agent/created', ({ agent }) => {
    agent.ctx?.effect?.(() => () => mainBySession.delete(agent.session?.id))
  })
  // Filter built-in packs once at host level by the request's own Session id so
  // per-Agent hooks cannot accumulate or strip another Session's tools.
  rt.ctx.on('llm/stream', function filterBuiltinTools(options, next) {
    if (options.sessionId === undefined || !Array.isArray(options.tools) || options.tools.length === 0) return next()
    const hidden = rt.hiddenBuiltinTools(options.sessionId)
    if (!options.tools.some(tool => hidden.has(tool?.name))) return next()
    return rt.ctx.llm.stream({ ...options, tools: options.tools.filter(tool => !hidden.has(tool?.name)) })
  })
  rt.ctx.effect(() => () => mainBySession.clear(), 'ds-bot: built-in pack roles')
}
