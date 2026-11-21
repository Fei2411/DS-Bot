import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

export function installBotCodeMode(rt, { plugin, config }) {
  const { ctx } = rt
  const scopes = new Map()
  const remove = id => {
    const held = scopes.get(id)
    scopes.delete(id)
    return held?.scope.dispose()
  }
  rt.scopeCodeMode = agent => {
    const id = agent?.session?.id
    if (id === undefined) return
    const held = scopes.get(id)
    if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) {
      return remove(id)
    }
    if (held?.agent === agent) return
    if (held !== undefined) throw new Error(`code-mode scope for ${id} has not been disposed`)
    const key = scopeOf(agent.ctx)
    if (key === undefined) throw new Error('DS Bot code-mode requires an Agent registration scope')
    const scope = createScope(ctx, key)
    try {
      plugin.apply(scope.ctx, config)
      scopes.set(id, { agent, scope })
    } catch (error) {
      void scope.dispose()
      throw error
    }
  }
  const sync = () => {
    for (const agent of ctx.get('agents')?.list() ?? []) rt.scopeCodeMode(agent)
  }
  const offSaved = rt.onSaved(sync)
  ctx.on('agent/disposed', ({ agent }) => remove(agent.session?.id))
  ctx.effect(() => async () => {
    offSaved()
    await Promise.all([...scopes.keys()].map(remove))
  }, 'ds-bot: code-mode scopes')
  sync()
}
