// Safe Cordis service member access across DSH versions.
//
// A Cordis `Service` instance is wrapped in a traceable proxy whose `get` trap redirects
// `service.<prop>` to `ctx['<service>.<prop>']` whenever `<service>.<prop>` is registered in
// `ctx.reflect.props`. Reading `ctx.get('uiSession')?.sessionStatus` therefore throws
// `cannot get property "uiSession.sessionStatus" without inject` on DSH hosts where
// `uiSession.sessionStatus` is its own dotted service, even though `ctx.get('uiSession')`
// itself bypasses inject. Conversely, declaring `uiSession.sessionStatus` in top-level
// `inject` would prevent `ds-bot` from activating on DSH hosts where `sessionStatus` is a
// plain property on `uiSession` (such as 0.2.2-rc.5).

const EMPTY_SESSION_STATUS = new Map()

export function hasContextProperty(ctx, name) {
  const props = ctx?.reflect?.props
  return Boolean(props && Object.prototype.hasOwnProperty.call(props, name))
}

export function readServiceMember(ctx, serviceName, propName) {
  const dotted = `${serviceName}.${propName}`
  const direct = ctx?.get?.(dotted)
  if (direct !== undefined) return direct
  if (hasContextProperty(ctx, dotted)) return undefined
  return ctx?.get?.(serviceName)?.[propName]
}

export function callServiceMethod(ctx, serviceName, methodName, ...args) {
  const dotted = `${serviceName}.${methodName}`
  const direct = ctx?.get?.(dotted)
  if (typeof direct === 'function') return direct(...args)
  if (hasContextProperty(ctx, dotted)) return undefined
  const service = ctx?.get?.(serviceName)
  return typeof service?.[methodName] === 'function' ? service[methodName](...args) : undefined
}

// Reactive `HostObservable` bridge for `uiSession.sessionStatus`.
// Reading `ctx.uiSession` directly enforces the top-level `uiSession` inject declaration.
// Supports both DSH layouts: a plain `uiSession.sessionStatus` property (0.2.2-rc.5) and a
// split dotted Cordis service `'uiSession.sessionStatus'` (0.2.3-alpha.2+), subscribing to
// the dotted service through a child `ctx.inject` fiber so hosts without it never block.
export function createSessionStatusSource(ctx) {
  const uiSession = ctx.uiSession
  const listeners = new Set()
  let disposed = false
  let active = null
  let unsubActive = null
  let dottedSource = null
  let fallbackSource = null

  const emit = () => {
    if (disposed) return
    for (const listener of Array.from(listeners)) listener()
  }

  const rebind = () => {
    if (disposed) return
    const next = dottedSource ?? fallbackSource ?? null
    if (next === active) return
    unsubActive?.()
    unsubActive = null
    active = next
    if (active && typeof active.subscribe === 'function') {
      unsubActive = active.subscribe(emit)
    }
    emit()
  }

  const dottedFiber = typeof ctx.inject === 'function'
    ? ctx.inject(['uiSession.sessionStatus'], (scope) => {
      scope.effect(() => {
        if (disposed) return () => {}
        const status = scope['uiSession.sessionStatus']
        dottedSource = status && typeof status.getSnapshot === 'function' ? status : null
        rebind()
        return () => {
          dottedSource = null
          rebind()
        }
      }, 'ds-bot: uiSession.sessionStatus')
    })
    : null

  if (!hasContextProperty(ctx, 'uiSession.sessionStatus')) {
    const direct = uiSession?.sessionStatus
    if (direct && typeof direct.getSnapshot === 'function') {
      fallbackSource = direct
      rebind()
    }
  }

  return {
    source: {
      getSnapshot: () => (disposed ? EMPTY_SESSION_STATUS : active?.getSnapshot?.() ?? EMPTY_SESSION_STATUS),
      subscribe: (listener) => {
        if (disposed) return () => {}
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubActive?.()
      unsubActive = null
      active = null
      dottedSource = null
      fallbackSource = null
      listeners.clear()
      dottedFiber?.dispose?.()
    },
  }
}
