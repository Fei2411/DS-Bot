import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { openFeed } from '../ui/src/api.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function makeStream(chunks, onCancel) {
  let index = 0
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { value: undefined, done: true }
          return { value: new TextEncoder().encode(chunks[index++]), done: false }
        },
        async cancel() { onCancel?.() },
      }
    },
  }
}

test('openFeed escalates backoff on repeated 200-EOF responses, resets on valid event, cancels timer on stop, and closes stream on SSE buffer cap', async (t) => {
  const origFetch = globalThis.fetch
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  t.after(() => {
    globalThis.fetch = origFetch
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
  })

  const delays = []
  const pendingTimers = new Map()
  let nextId = 1
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++
    delays.push(ms)
    pendingTimers.set(id, fn)
    return id
  }
  globalThis.clearTimeout = (id) => { pendingTimers.delete(id) }
  const fireTimer = () => {
    const entry = pendingTimers.entries().next().value
    if (!entry) return false
    pendingTimers.delete(entry[0])
    entry[1]()
    return true
  }

  let calls = 0
  let overflowCancelled = false
  let overflowSignal
  const events = []
  globalThis.fetch = async (_url, init) => {
    calls += 1
    // First 3 attempts: 200 OK with immediate EOF (no valid events) -> backoff must escalate!
    if (calls <= 3) return { ok: true, status: 200, body: makeStream([]) }
    // 4th attempt: delivers a valid event then closes -> resets backoff back to 500ms!
    if (calls === 4) return { ok: true, status: 200, body: makeStream(['event: hello\ndata: {"ok":true}\n\n']) }
    // 5th attempt: exceeds 8 MB buffer without \n\n -> cancels reader & aborts fetch cleanly.
    overflowSignal = init?.signal
    return { ok: true, status: 200, body: makeStream(['data: ' + 'x'.repeat(8 * 1024 * 1024 + 64)], () => { overflowCancelled = true }) }
  }

  const stop = openFeed((event, data) => events.push([event, data]))
  for (let i = 0; i < 4; i++) {
    await tick()
    await tick()
    if (i < 3) fireTimer()
  }
  assert.deepEqual(delays.slice(0, 3), [500, 1000, 2000], 'immediate 200-EOF must not reset failure backoff')
  assert.equal(events.some(([ev]) => ev === 'hello'), true)
  // After valid event on call 4, next backoff resets to 500ms.
  assert.equal(delays[3], 500, 'receiving a valid SSE event resets backoff to 500ms')
  fireTimer()
  await tick()
  await tick()
  assert.equal(calls, 5, 'oversized incomplete SSE frame throws and transitions to retry')
  assert.equal(overflowCancelled, true, 'oversized SSE stream reader must be cancelled')
  assert.equal(overflowSignal?.aborted, true, 'oversized SSE fetch controller must be aborted')
  assert.equal(pendingTimers.size, 1, 'retry timer is armed before stop()')
  stop()
  assert.equal(pendingTimers.size, 0, 'stop() cancels active backoff timer immediately')
})

test('openFeed reconnects immediately without backoff or lost event on server : rotate comment', async (t) => {
  const origFetch = globalThis.fetch
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  t.after(() => {
    globalThis.fetch = origFetch
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
  })

  const delays = []
  const pendingTimers = new Map()
  let nextId = 1
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++
    delays.push(ms)
    pendingTimers.set(id, fn)
    return id
  }
  globalThis.clearTimeout = (id) => { pendingTimers.delete(id) }

  let calls = 0
  const events = []
  globalThis.fetch = async () => {
    calls += 1
    // 1st connection: hello followed by server-initiated `: rotate` -> must reconnect immediately with no timer and no `lost`.
    if (calls === 1) return { ok: true, status: 200, body: makeStream(['event: hello\ndata: {"revision":1}\n\n', ': rotate\n\n']) }
    // 2nd connection: delivers fresh hello then stays open until stop().
    if (calls === 2) {
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            let sent = false
            return {
              async read() {
                if (!sent) {
                  sent = true
                  return { value: new TextEncoder().encode('event: hello\ndata: {"revision":2}\n\n'), done: false }
                }
                return await new Promise(() => {})
              },
              async cancel() {},
            }
          },
        },
      }
    }
    return { ok: true, status: 200, body: makeStream([]) }
  }

  const stop = openFeed((event, data) => events.push([event, data]))
  await tick()
  await tick()
  await tick()
  assert.equal(calls, 2, 'server : rotate triggers immediate second fetch without waiting on setTimeout')
  assert.deepEqual(delays, [], 'no backoff timer scheduled on clean : rotate')
  assert.deepEqual(events, [
    ['hello', { revision: 1 }],
    ['hello', { revision: 2 }],
  ], 'no synthetic lost event emitted on clean : rotate')
  stop()

  // Guard: a bare `: rotate` with NO prior event still backs off instead of tight-spinning.
  calls = 0
  delays.length = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, body: makeStream([': rotate\n\n']) }
  }
  const stop2 = openFeed(() => {})
  await tick()
  await tick()
  assert.equal(calls, 1)
  assert.deepEqual(delays, [500], 'bare : rotate without hello falls back to normal backoff')
  stop2()
})

test('createTeam pauses catch-up polling while hidden, caches sessionHook, prunes deleted sessions, and fires noteLive only on stream transitions', async (t) => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../ui/src/team.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react'],
    plugins: [{
      name: 'team-test-stubs',
      setup(bundler) {
        bundler.onResolve({ filter: /src\/client\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'team-stub' }))
        bundler.onLoad({ filter: /^api-stub$/, namespace: 'team-stub' }, () => ({ contents: 'export const call = (...args) => globalThis.__call(...args)', loader: 'js' }))
        bundler.onResolve({ filter: /src\/client\/cells\.js$/ }, () => ({ path: 'cells-stub', namespace: 'team-stub' }))
        bundler.onLoad({ filter: /^cells-stub$/, namespace: 'team-stub' }, () => ({ contents: 'export const workPhrase = () => "working"', loader: 'js' }))
        bundler.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: 'feed-stub', namespace: 'team-stub' }))
        bundler.onLoad({ filter: /^feed-stub$/, namespace: 'team-stub' }, () => ({ contents: 'export const openFeed = (cb) => { globalThis.__feedCb = cb; return () => { globalThis.__feedClosed = true } }', loader: 'js' }))
      },
    }],
  })

  let intervalCb = null
  let intervalsStarted = 0
  let intervalsCleared = 0
  const docListeners = new Map()
  let isHidden = false
  let rosterValue = {
    revision: 1,
    modelsKey: 'm1',
    bots: [
      { id: 'b1', sessionId: 'b1', name: 'Alpha', parts: ['b1'] },
      { id: 'b2', sessionId: 'b2', name: 'Beta', parts: ['b2'] },
    ],
    rooms: [],
    agents: [],
    activity: {},
    work: { bots: {}, approvals: [] },
    memoryNews: {},
  }
  let pullCount = 0

  // Enforce React 19 useSyncExternalStore contract: consecutive getSnapshot() reads must be Object.is equal.
  const react = {
    useRef: initial => ({ current: initial }),
    useSyncExternalStore(_sub, read) {
      const first = read()
      const second = read()
      assert.ok(Object.is(first, second), 'useSyncExternalStore getSnapshot must be referentially stable across consecutive reads')
      return first
    },
  }
  const module = { exports: {} }
  const storageData = new Map()
  let nextRead
  let delayedSave
  const localStorage = {
    getItem: k => storageData.get(k) ?? null,
    setItem: (k, v) => storageData.set(k, String(v)),
    removeItem: k => storageData.delete(k),
  }
  const sandbox = {
    module,
    exports: module.exports,
    __call: async (name, body) => {
      if (name === 'state') {
        pullCount += 1
        if (nextRead) {
          const read = nextRead
          nextRead = undefined
          return read.promise
        }
        if (body.since === rosterValue.revision) return { revision: rosterValue.revision, unchanged: true }
        return rosterValue
      }
      if (name === 'section-save') {
        const section = { ...rosterValue.sections[0], collapsed: body.collapsed }
        rosterValue = { ...rosterValue, revision: rosterValue.revision + 1, sections: [section] }
        const reply = body.withRevision ? { section, revision: rosterValue.revision } : section
        if (delayedSave) {
          const delay = delayedSave
          delayedSave = undefined
          await delay.promise
        }
        return reply
      }
      return {}
    },
    __feedCb: null,
    __feedClosed: false,
    require(name) {
      if (name === 'react') return react
      throw new Error(`unexpected require ${name}`)
    },
    localStorage,
    navigator: { language: 'en' },
    document: {
      get hidden() { return isHidden },
      addEventListener(type, fn) { docListeners.set(type, fn) },
      removeEventListener(type) { docListeners.delete(type) },
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      localStorage,
    },
    setInterval(fn) { intervalsStarted += 1; intervalCb = fn; return intervalsStarted },
    clearInterval() { intervalsCleared += 1; intervalCb = null },
    setTimeout,
    clearTimeout,
    console,
  }
  runInNewContext(outputFiles[0].text, sandbox)
  const { createTeam } = module.exports
  const team = createTeam()

  // 1. sessionHook is referentially stable per sessionId and reuses stable EMPTY_PENDING.
  const hookA1 = team.sessionHook('b1')
  const hookA2 = team.sessionHook('b1')
  assert.equal(hookA1, hookA2, 'sessionHook returns cached hook per sessionId')
  const p1 = hookA1(s => s.pendingSubmissions)
  const p2 = hookA2(s => s.pendingSubmissions)
  assert.equal(p1, p2, 'empty pendingSubmissions reuses stable array reference')

  // 2. Start team: catch-up interval pauses when hidden and catches up on visibilitychange.
  const stop = team.start()
  t.after(stop)
  await tick()
  assert.equal(pullCount, 1)
  assert.equal(intervalsStarted, 1)
  assert.ok(intervalCb !== null)

  isHidden = true
  docListeners.get('visibilitychange')()
  assert.equal(intervalsCleared, 1, 'interval paused when document becomes hidden')
  assert.equal(intervalCb, null)

  isHidden = false
  docListeners.get('visibilitychange')()
  await tick()
  assert.equal(pullCount, 2, 'visibilitychange triggers catch-up pull on becoming visible')
  assert.equal(intervalsStarted, 2, 'interval resumes when visible')

  // 3. noteLive for 'reply' fires only on start/end transitions, not every token!
  let liveUpdates = 0
  const unsubLive = team.hooks.useLive ? null : null
  const origNoteLive = team.actions.noteLive
  const replyCalls = []
  team.actions.noteLive = (sid, kind, value) => {
    if (kind === 'reply') replyCalls.push([sid, value])
    return origNoteLive(sid, kind, value)
  }
  sandbox.__feedCb('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'a1', phase: 'start' })
  for (let i = 0; i < 10; i++) {
    sandbox.__feedCb('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'a1', text: `tok${i}` })
  }
  sandbox.__feedCb('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'a1', phase: 'end' })
  assert.deepEqual(
    JSON.parse(JSON.stringify(replyCalls)),
    [['b1', { text: true }], ['b1', null]],
    'noteLive fires once on stream text start and once on stream end across 10 deltas',
  )

  // 4. Replies arriving while Inbox covers the active chat and group notices mark completionUnread, and closing Inbox clears the active chat.
  rosterValue = {
    ...rosterValue,
    revision: 2,
    rooms: [{ id: 'r1', sessionId: 'r1', name: 'Ops', members: ['b1', 'b2'] }],
  }
  sandbox.__feedCb('revision', {})
  await tick()
  team.actions.openSession('b1')
  team.actions.openInbox()
  sandbox.__feedCb('message', { botId: 'b1', sessionId: 'b1', item: { kind: 'bot', text: 'while inbox open', time: 110 } })
  sandbox.__feedCb('notice', { kind: 'group', roomId: 'r1', botId: 'b2', text: 'ops update', time: 111 })
  assert.equal(team.hooks.useSessionStatus(map => map.get('b1')?.completionUnread), true, 'active chat reply marks unread while Inbox covers it')
  assert.equal(team.hooks.useSessionStatus(map => map.get('r1')?.completionUnread), true, 'group reply notice marks group unread')
  // Opening r1 from Inbox clears r1 without clearing b1!
  team.actions.openSession('r1')
  assert.equal(team.hooks.useSessionStatus(map => map.get('r1')?.completionUnread), false, 'opening the group clears its unread flag')
  assert.equal(team.hooks.useSessionStatus(map => map.get('b1')?.completionUnread), true, 'opening r1 from Inbox preserves b1 unread')
  // Opening Inbox over r1, receiving a reply on r1, switching to New chat, then dismissing New chat clears r1 on reveal.
  team.actions.openInbox()
  sandbox.__feedCb('notice', { kind: 'group', roomId: 'r1', botId: 'b2', text: 'ops update 2', time: 112 })
  assert.equal(team.hooks.useSessionStatus(map => map.get('r1')?.completionUnread), true)
  team.actions.openNewChat('bot')
  assert.equal(team.hooks.useSessionStatus(map => map.get('r1')?.completionUnread), true, 'replacing Inbox with New chat keeps covered chat unread')
  team.actions.closeNewChat()
  assert.equal(team.hooks.useSessionStatus(map => map.get('r1')?.completionUnread), false, 'dismissing New chat reveals r1 and clears its unread flag')
  team.actions.openSession('b1')
  assert.equal(team.hooks.useSessionStatus(map => map.get('b1')?.completionUnread), false)

  // 5. Deleting a bot in a roster update prunes its sessionId from sessions, status, sent, and sessionHooks.
  team.actions.noteSent('b2')
  sandbox.__feedCb('message', { botId: 'b2', sessionId: 'b2', item: { kind: 'bot', text: 'bye', time: 100 } })
  const hookB2Before = team.sessionHook('b2')
  assert.ok(team.hooks.useSessions(list => list.ids.includes('b2')))
  assert.ok(team.hooks.useSessionStatus(map => map.has('b2')))

  rosterValue = {
    ...rosterValue,
    revision: 3,
    bots: [{ id: 'b1', sessionId: 'b1', name: 'Alpha', parts: ['b1'] }],
    rooms: [],
  }
  sandbox.__feedCb('revision', {})
  await tick()
  assert.equal(team.hooks.useSessions(list => list.ids.includes('b2')), false, 'deleted session pruned from sessions')
  assert.equal(team.hooks.useSessionStatus(map => map.has('b2')), false, 'deleted session pruned from status')
  assert.notEqual(team.sessionHook('b2'), hookB2Before, 'deleted session pruned from sessionHook cache')

  await t.test('a read from another window wins over an older fold acknowledgement', async () => {
    rosterValue = { ...rosterValue, revision: 4, sections: [{ id: 'work', name: 'Work' }] }
    intervalCb()
    await tick()
    const snapshot = () => team.snapshots.roster()

    for (const replyFirst of [true, false]) {
      const saveGate = delayedSave = Promise.withResolvers()
      const collapse = team.actions.saveSection({ id: 'work', collapsed: true })
      await tick()
      assert.equal(rosterValue.sections[0].collapsed, true)
      const readGate = nextRead = Promise.withResolvers()
      sandbox.__feedCb('revision', {})
      await sandbox.__call('section-save', { id: 'work', collapsed: false })
      const deliverSave = async () => {
        saveGate.resolve()
        await collapse
      }
      const deliverRead = async () => {
        readGate.resolve(rosterValue)
        await tick()
      }
      if (replyFirst) {
        await deliverSave()
        assert.equal(snapshot().sections[0].collapsed, true)
        await deliverRead()
      } else {
        await deliverRead()
        await deliverSave()
      }
      intervalCb()
      await tick()
      assert.equal(snapshot().revision, rosterValue.revision)
      assert.equal(snapshot().sections[0].collapsed, false, `newer fold wins (save reply first: ${replyFirst})`)
    }
  })

  void liveUpdates
  void unsubLive
  stop()
  assert.equal(sandbox.__feedClosed, true)
})
