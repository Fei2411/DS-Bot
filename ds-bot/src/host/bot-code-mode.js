import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

// Track native fallback disposers across plugin reloads without mutating DSH services.
const FALLBACKS_KEY = Symbol.for('ds-bot:code-mode-fallbacks')
const fallbackMap = () => (globalThis[FALLBACKS_KEY] ??= new WeakMap())

export function installBotCodeMode(rt, { ctx: scopeCtx = rt.ctx, plugin, config }) {
  const scopes = new Map()
  const disposedAgents = new WeakSet()
  const fallbacks = fallbackMap()

  const clearFallback = (key, dispose = true) => {
    const entry = fallbacks.get(key)
    if (entry === undefined) return
    fallbacks.delete(key)
    if (!dispose) return
    try {
      if (scopeCtx.tools.selectExecutor(key) === entry.executor) entry.dispose()
    } catch { /* executor already unavailable or replaced */ }
  }

  // DSH's tools.setExecutor() leaves a disposed scope fail-closed (record.executor = undefined)
  // rather than falling back to the root executor. Re-mount a native executor on the Agent's own
  // context so live Sessions keep working after losing Bot ownership or after plugin/PTC unload.
  const restoreNative = async (id, agent, key) => {
    if (agent === undefined || key === undefined || disposedAgents.has(agent)) return
    if (typeof plugin.createFallbackExecutor !== 'function' || typeof agent.ctx?.plugin !== 'function') return
    if (agent.ctx.fiber?.disposed === true) return
    try {
      scopeCtx.tools.selectExecutor(key)
      return
    } catch { /* expected: scope is currently unavailable and needs a native fallback */ }
    try {
      let fiber
      fiber = agent.ctx.plugin({
        name: 'ds-bot-code-mode-fallback',
        inject: ['tools'],
        apply(child) {
          if (scopes.get(id)?.agent === agent || disposedAgents.has(agent)) {
            void fiber?.dispose?.().catch?.(() => {})
            return
          }
          const executor = plugin.createFallbackExecutor(child)
          const disposeExecutor = child.tools.setExecutor(executor)
          fallbacks.set(key, {
            executor,
            dispose: () => {
              // Dispose the tools.setExecutor() effect synchronously so a same-tick re-scope succeeds.
              disposeExecutor?.()
              void fiber?.dispose?.().catch?.(() => {})
            },
          })
        },
      })
      await fiber
    } catch { /* Agent context is already disposing or replaced */ }
  }

  const releaseEntry = async (id, held, { restore }) => {
    if (scopes.get(id) === held) scopes.delete(id)
    try {
      await held.scope.dispose()
    } catch (error) {
      rt.warn?.('ds-bot: disposing code-mode scope for %s failed: %s', id, error)
    }
    if (restore && scopes.get(id)?.agent !== held.agent) await restoreNative(id, held.agent, held.key)
  }

  const scopeCodeMode = agent => {
    const id = agent?.session?.id
    if (id === undefined) return
    const held = scopes.get(id)
    if (!rt.isBotSession(id)) {
      return held === undefined ? undefined : releaseEntry(id, held, { restore: true })
    }
    if (held?.agent === agent) return
    if (held !== undefined) void releaseEntry(id, held, { restore: true })
    const key = scopeOf(agent.ctx)
    if (key === undefined) throw new Error('DS Bot code-mode requires an Agent registration scope')
    clearFallback(key, true)
    const scope = createScope(scopeCtx, key)
    const filterTools = tools => {
      const hidden = rt.hiddenToolsFor?.(id)
      return hidden === undefined || hidden.size === 0 ? tools : tools.filter(tool => !hidden.has(tool.name))
    }
    try {
      plugin.apply(scope.ctx, config, { filterTools })
      scopes.set(id, { agent, key, scope })
    } catch (error) {
      void Promise.resolve().then(() => scope.dispose()).catch(disposeError => {
        rt.warn?.('ds-bot: disposing failed code-mode scope for %s failed: %s', id, disposeError)
      })
      throw error
    }
  }

  rt.scopeCodeMode = scopeCodeMode

  const sync = () => {
    for (const agent of scopeCtx.get('agents')?.list() ?? []) {
      try {
        scopeCodeMode(agent)
      } catch (error) {
        rt.warn?.('ds-bot: scoping code-mode for %s failed: %s', agent?.session?.id, error)
      }
    }
  }
  const offSaved = rt.onSaved(sync)
  scopeCtx.on('agent/disposed', ({ agent }) => {
    if (agent !== undefined) disposedAgents.add(agent)
    const id = agent?.session?.id
    if (id !== undefined) {
      const held = scopes.get(id)
      if (held !== undefined && held.agent === agent) {
        void releaseEntry(id, held, { restore: false })
      }
    }
    const key = agent?.ctx === undefined ? undefined : scopeOf(agent.ctx)
    if (key !== undefined) clearFallback(key, false)
  })
  scopeCtx.effect(() => async () => {
    offSaved()
    if (rt.scopeCodeMode === scopeCodeMode) rt.scopeCodeMode = undefined
    const entries = [...scopes.entries()]
    await Promise.all(entries.map(([id, held]) => releaseEntry(id, held, { restore: true })))
  }, 'ds-bot: code-mode scopes')
  sync()
}
