import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'
import type { TeamState } from '../connection.ts'
import { pendingCountOf } from '../nav/pending.ts'

let hooks: ReturnType<typeof registerHooks> | undefined
let useTeamLinkFn: any

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react' || specifier === 'react-native' || specifier === '../connection.ts' || specifier === './gate.ts' || specifier === '../ui/i18n.ts') {
        return { url: `mock:${specifier}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:react') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const useState = (...args) => globalThis.__syncTestHooks.useState(...args)
            export const useRef = (...args) => globalThis.__syncTestHooks.useRef(...args)
            export const useCallback = (...args) => globalThis.__syncTestHooks.useCallback(...args)
            export const useEffect = (...args) => globalThis.__syncTestHooks.useEffect(...args)
          `,
        }
      }
      if (url === 'mock:react-native') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `export const AppState = { addEventListener: (_ev, fn) => { globalThis.__syncTestHooks.setAppStateListener(fn); return { remove() {} } } }`,
        }
      }
      if (url === 'mock:../connection.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const openLink = (...args) => globalThis.__syncTestHooks.openLink(...args)
            export const callBot = (...args) => globalThis.__syncTestHooks.callBot(...args)
            export const callBotState = (...args) => globalThis.__syncTestHooks.callBotState(...args)
          `,
        }
      }
      if (url === 'mock:./gate.ts') {
        return { format: 'module', shortCircuit: true, source: `export const ensureUnlock = async () => {}` }
      }
      if (url === 'mock:../ui/i18n.ts') {
        return { format: 'module', shortCircuit: true, source: `export const t = (s) => s` }
      }
      return nextLoad(url, context)
    },
  })
  ;(globalThis as any).__syncTestHooks = {}
  useTeamLinkFn = (await import('./link.ts')).useTeamLink
})

after(() => {
  hooks?.deregister()
  delete (globalThis as any).__syncTestHooks
})

function mountUseTeamLink(options: {
  onStateCall: (payload: { since?: number; live?: string }) => Promise<TeamState>
  onCallBotState?: (endpoint: string, payload: unknown, state: unknown) => Promise<{ value: unknown; state?: TeamState }>
  onHelloCall?: () => Promise<{ api: number | null; capabilities: string[]; boot: string; seq: number }>
  onOpen?: () => void
}) {
  let states: any[] = []
  let refs: { current: any }[] = []
  let callbacks: { fn: unknown; deps?: unknown[] }[] = []
  let effects: { deps?: unknown[]; cleanup?: () => void }[] = []
  let cursor = 0
  let refCursor = 0
  let cbCursor = 0
  let effectCursor = 0
  let pendingEffects: (() => void)[] = []
  let eventListener: ((ev: { event: string; data: any }) => void) | undefined
  let appStateListener: ((status: string) => void) | undefined

  ;(globalThis as any).__syncTestHooks = {
    setAppStateListener(fn: (status: string) => void) { appStateListener = fn },
    useState(init: unknown) {
      const idx = cursor++
      if (!(idx in states)) states[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (next: unknown) => { states[idx] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next }
      return [states[idx], set]
    },
    useRef(init: unknown) {
      const idx = refCursor++
      if (!(idx in refs)) refs[idx] = { current: init }
      return refs[idx]
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const idx = cbCursor++
      const prev = callbacks[idx]
      const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps![i]))
      if (changed) callbacks[idx] = { fn, deps }
      return callbacks[idx].fn
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const idx = effectCursor++
      const prev = effects[idx]
      const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps![i]))
      if (changed) {
        effects[idx] = { deps, cleanup: prev?.cleanup }
        pendingEffects.push(() => {
          prev?.cleanup?.()
          const cleanup = fn()
          effects[idx] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
      }
    },
    openLink: async () => {
      options.onOpen?.()
      return {
        onEvent(fn: (ev: { event: string; data: any }) => void) { eventListener = fn },
        onClose() {},
        close: async () => {},
        probe() {},
      }
    },
    callBot: async (_client: unknown, endpoint: string, payload: unknown) => {
      if (endpoint === 'state') return options.onStateCall(payload as { since?: number; live?: string })
      if (endpoint === 'hello') return options.onHelloCall ? options.onHelloCall() : { api: 1, capabilities: [], boot: 'boot-1', seq: 0 }
      if (endpoint === 'notices') return { reset: false, notices: [] }
      return {}
    },
    callBotState: async (_client: unknown, endpoint: string, payload: unknown, state: unknown) => {
      if (options.onCallBotState) return options.onCallBotState(endpoint, payload, state)
      return { value: true }
    },
  }

  const computer = { server: 's', hostDeviceId: 'h1', hostKey: 'k1', name: 'PC' }
  const identity = { deviceId: 'p1', publicKey: 'k', privateKey: 's', accessToken: 't' }

  const render = () => {
    for (let pass = 0; pass < 4; pass += 1) {
      cursor = 0; refCursor = 0; cbCursor = 0; effectCursor = 0; pendingEffects = []
      const out = useTeamLinkFn(computer, identity)
      if (pendingEffects.length === 0) return out
      for (const run of pendingEffects) run()
    }
    cursor = 0; refCursor = 0; cbCursor = 0; effectCursor = 0; pendingEffects = []
    return useTeamLinkFn(computer, identity)
  }

  return {
    render,
    emit: (event: string, data: any = {}) => eventListener?.({ event, data }),
    appState: (s: string) => appStateListener?.(s),
    cleanup: () => { for (const effect of effects) effect?.cleanup?.() },
  }
}

test('useTeamLink continues polling after a transient state error and reconciles settled pending items', async (t) => {
  const scheduled: { ms: number; run: () => void }[] = []
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  const timers = new Map<number, { cleared: boolean }>()
  let nextTimerId = 1
  ;(globalThis as any).setTimeout = (fn: () => void, ms: number = 0) => {
    if (ms >= 10_000) {
      const id = nextTimerId++
      timers.set(id, { cleared: false })
      scheduled.push({ ms, run: () => { if (!timers.get(id)?.cleared) fn() } })
      return id as unknown as ReturnType<typeof setTimeout>
    }
    return origSetTimeout(fn, ms)
  }
  ;(globalThis as any).clearTimeout = (id: any) => {
    const entry = timers.get(id)
    if (entry) entry.cleared = true
    else origClearTimeout(id)
  }
  t.after(() => {
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
  })

  let phase = 0
  const hostSnapshots: TeamState[] = [
    {
      revision: 5,
      liveKey: 'run:1',
      bots: [{ id: 'b1', name: 'Chief', sessionId: 's1' }],
      questions: { s1: { id: 'q1', question: 'Confirm?' } },
      work: { approvals: [] },
    },
    {
      revision: 6,
      liveKey: 'run:2',
      bots: [{ id: 'b1', name: 'Chief', sessionId: 's1' }],
      questions: {},
      work: { approvals: [] },
    },
  ]

  const h = mountUseTeamLink({
    async onStateCall() {
      phase += 1
      if (phase === 1) return hostSnapshots[0]
      if (phase === 2) throw new Error('Transient relay timeout')
      return hostSnapshots[1]
    },
  })
  t.after(h.cleanup)
  h.render()
  await new Promise(resolve => origSetTimeout(resolve, 20))
  assert.equal(pendingCountOf(h.render().team), 1)
  assert.equal(scheduled.length, 1)

  // Next periodic poll fails transiently.
  scheduled.shift()!.run()
  await new Promise(resolve => origSetTimeout(resolve, 20))
  assert.equal(h.render().error !== null, true)
  // Polling timer MUST still be rescheduled despite the failed poll so recovery happens automatically.
  assert.equal(scheduled.length, 1, 'poll timer must stay scheduled after transient failure')

  scheduled.shift()!.run()
  await new Promise(resolve => origSetTimeout(resolve, 20))
  assert.equal(pendingCountOf(h.render().team), 0)
})

test('useTeamLink reconciles settled approvals and browserHolds via refresh and non-revision write calls', async (t) => {
  let stateCalls = 0
  let settled = false
  const openSnapshot: TeamState = {
    revision: 10,
    liveKey: 'run:1',
    bots: [{ id: 'b1', name: 'Chief', sessionId: 's1' }],
    questions: {},
    views: {},
    browserHolds: { b1: { callId: 'hold-1', reason: 'verification', note: 'Log in' } },
    work: { approvals: [{ id: 'a1', sessionId: 's1', botId: 'b1', tool: 'bash', reason: 'test', answerable: true }] },
  }
  const h = mountUseTeamLink({
    async onStateCall() {
      stateCalls += 1
      if (!settled) return openSnapshot
      return {
        revision: 10,
        unchanged: true,
        liveKey: 'run:2',
        browserHolds: {},
        work: { approvals: [] },
      } as unknown as TeamState
    },
    async onCallBotState(endpoint) {
      if (endpoint === 'approval-answer') settled = true
      return { value: true } // host phone.js omits state when revision did not change
    },
  })
  t.after(h.cleanup)
  h.render()
  await new Promise(resolve => setTimeout(resolve, 20))
  const first = h.render()
  assert.equal(pendingCountOf(first.team), 2)

  // Calling approval-answer returns no embedded state (revision didn't bump); link should still poll & settle.
  await first.call('approval-answer', { id: 'a1', choice: 'allow' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const afterCall = h.render()
  assert.equal(pendingCountOf(afterCall.team), 0)
  assert.ok(stateCalls >= 2)
  assert.equal(typeof afterCall.refresh, 'function', 'useTeamLink should expose refresh() for screen reconciliation')

  // Also verify live feed event and refresh() reconcile desktop-side open and settlement.
  settled = false
  h.emit('live', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingCountOf(h.render().team), 2)

  settled = true
  h.emit('live', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingCountOf(h.render().team), 0)

  settled = false
  afterCall.refresh()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingCountOf(h.render().team), 2)

  settled = true
  afterCall.refresh()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingCountOf(h.render().team), 0)
})

test('useTeamLink keeps connection retry timer when initial handshake fails before concurrent poll rejects', async (t) => {
  const scheduled: { id: number; ms: number; run: () => void }[] = []
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  const timers = new Map<number, { cleared: boolean }>()
  let nextTimerId = 1
  ;(globalThis as any).setTimeout = (fn: () => void, ms: number = 0) => {
    if (ms >= 1_000) {
      const id = nextTimerId++
      timers.set(id, { cleared: false })
      scheduled.push({ id, ms, run: () => { if (!timers.get(id)?.cleared) fn() } })
      return id as unknown as ReturnType<typeof setTimeout>
    }
    return origSetTimeout(fn, ms)
  }
  ;(globalThis as any).clearTimeout = (id: any) => {
    const entry = timers.get(id)
    if (entry) entry.cleared = true
    else origClearTimeout(id)
  }
  t.after(() => {
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
  })

  let openCount = 0
  let attempt = 0
  let stateCalls = 0
  let rejectFirstState!: (err: Error) => void
  const h = mountUseTeamLink({
    onOpen() { openCount += 1 },
    async onHelloCall() {
      attempt += 1
      if (attempt === 1) throw new Error('handshake failed')
      return { api: 1, capabilities: [], boot: 'boot-1', seq: 0 }
    },
    async onStateCall() {
      stateCalls += 1
      if (stateCalls === 1) {
        return new Promise<TeamState>((_resolve, reject) => { rejectFirstState = reject })
      }
      return { revision: 1, liveKey: 'ok', bots: [{ id: 'b1', name: 'Chief', sessionId: 's1' }], questions: {} }
    },
  })
  t.after(h.cleanup)
  h.render()
  await new Promise(resolve => origSetTimeout(resolve, 20))

  // First hello failed, so connect() scheduled a 2_000ms retry timer.
  // Now the concurrent first poll rejects because the socket closed: it MUST NOT cancel the 2_000ms retry timer!
  rejectFirstState(new Error('closed'))
  await new Promise(resolve => origSetTimeout(resolve, 20))

  const retryEntry = scheduled.find(entry => entry.ms === 2_000)
  assert.ok(retryEntry, 'expected 2_000ms reconnect timer to be scheduled')
  assert.equal(timers.get(retryEntry.id)?.cleared, false, 'failed concurrent poll must not cancel connect retry timer')
  assert.equal(scheduled.some(entry => entry.ms === 15_000 && !timers.get(entry.id)?.cleared), false, 'closed handshake client must not schedule 15_000ms poll timer')

  // Firing the retry timer reconnects and loads state.
  retryEntry.run()
  await new Promise(resolve => origSetTimeout(resolve, 20))
  assert.equal(openCount, 2)
  const reconnected = h.render()
  assert.equal(reconnected.online, true)
  assert.equal(reconnected.team?.revision, 1)
})
