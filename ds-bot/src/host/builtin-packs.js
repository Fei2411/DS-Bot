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
  rt.ctx.effect(() => () => mainBySession.clear(), 'ds-bot: built-in pack roles')
}
