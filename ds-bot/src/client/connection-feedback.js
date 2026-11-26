export const CONNECTION_GRACE_MS = 2000
export const CONNECTING_MIN_VISIBLE_MS = 800
export const RECOVERY_CONFIRMATION_MS = 2000

const OUTAGE_STATES = new Set(['connecting', 'disconnected'])

// Keep brief socket churn out of the sidebar. An outage becomes visible only after the
// grace period, then stays up for a short minimum before the recovery note can replace it.
export function createConnectionFeedback(onChange, {
  graceMs = CONNECTION_GRACE_MS,
  minimumVisibleMs = CONNECTING_MIN_VISIBLE_MS,
  recoveryMs = RECOVERY_CONFIRMATION_MS,
  now = Date.now,
  schedule = setTimeout,
  clear = clearTimeout,
} = {}) {
  let state
  let received = false
  let view
  let outageAt
  let visibleAt
  let timer
  let generation = 0
  let suspended = false

  const publish = (next) => {
    if (next === view) return
    view = next
    onChange?.(next)
  }

  const cancel = () => {
    generation += 1
    if (timer === undefined) return
    clear(timer)
    timer = undefined
  }

  const later = (run, wait) => {
    const active = generation
    timer = schedule(() => {
      if (active !== generation) return
      timer = undefined
      run()
    }, wait)
  }

  const reset = () => {
    outageAt = undefined
    visibleAt = undefined
    publish(undefined)
  }

  const showOutage = () => {
    if (suspended || !OUTAGE_STATES.has(state)) return
    visibleAt = now()
    publish(state)
  }

  const recover = () => {
    if (suspended || state !== 'connected') return
    visibleAt = undefined
    publish('recovered')
    later(() => {
      if (suspended || state !== 'connected') return
      publish(undefined)
    }, recoveryMs)
  }

  const reconcile = () => {
    const current = now()
    if (state === 'connected') {
      if (visibleAt === undefined) {
        reset()
        return
      }
      outageAt = undefined
      const remaining = minimumVisibleMs - (current - visibleAt)
      if (remaining > 0) later(recover, remaining)
      else recover()
      return
    }
    if (!OUTAGE_STATES.has(state)) {
      reset()
      return
    }
    if (visibleAt !== undefined) {
      publish(state)
      return
    }
    if (outageAt === undefined) {
      outageAt = current
      if (view === 'recovered') publish(undefined)
    }
    const remaining = graceMs - (current - outageAt)
    if (remaining > 0) later(showOutage, remaining)
    else showOutage()
  }

  return {
    update(next) {
      if (!suspended && received && next === state) return
      cancel()
      suspended = false
      state = next
      received = true
      reconcile()
    },
    suspend() {
      suspended = true
      cancel()
    },
    getView: () => view,
  }
}
