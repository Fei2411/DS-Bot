import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { STATES, stateName } from '../src/client/avatar/states.js'

const bundle = await build({
  stdin: { contents: "export { botPendingOf, botState, dmMarkState, lastTurnFailed, latestTurnOf, BotAvatar, BotMark, RoomAvatar } from './src/client/mark.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
// A test can queue the values the next useState calls return, and read what was set.
const states = []
const sets = []
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [states.length > 0 ? states.shift() : initial, value => sets.push(value)], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {}, Fragment: 'fragment',
}
// A clock the test moves by hand, for the module's timers.
const clock = { now: 0, next: 1, timers: new Map() }
const timers = {
  setTimeout: (fn, ms = 0) => { const id = clock.next++; clock.timers.set(id, { at: clock.now + ms, fn }); return id },
  clearTimeout: id => clock.timers.delete(id),
}
const advance = (ms) => {
  clock.now += ms
  for (const [id, timer] of [...clock.timers].sort((a, b) => a[1].at - b[1].at)) {
    if (timer.at > clock.now || !clock.timers.has(id)) continue
    clock.timers.delete(id)
    timer.fn()
  }
}
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}), ...timers })
const { botPendingOf, botState, dmMarkState, lastTurnFailed, latestTurnOf, BotAvatar, BotMark, RoomAvatar } = module.exports

test('a group photo replaces its collage at all sizes and a broken photo falls back', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const room = { id: 'r', members: ['b', 'c'], avatar: { image } }
  const roster = { byId: { b: { id: 'b' }, c: { id: 'c' } } }
  for (const size of [18, 36, 64]) {
    assert.equal(RoomAvatar({ room, roster, size }).children[0].props.src, image)
  }
  sets.length = 0
  RoomAvatar({ room, roster }).children[0].props.onError()
  assert.deepEqual(sets, [image])
  states.push(image)
  assert.equal(RoomAvatar({ room, roster }).props.className, 'bt-cluster')
  assert.equal(RoomAvatar({ room: { ...room, avatar: undefined }, roster }).props.className, 'bt-cluster')
  states.push(image)
  assert.equal(RoomAvatar({ room: { ...room, avatar: { image: `${image}AA` } }, roster }).children[0].type, 'img')
})

test('a Bot that waits for work it handed on has a mark of its own, behind a running turn and a question', () => {
  assert.equal(botState(false, 'waiting', false), 'waiting')
  // A turn of its own runs: the turn shows, not the wait.
  assert.equal(botState(true, 'waiting', false), 'working')
  assert.equal(botState(true, 'searching', false), 'searching')
  assert.equal(botState(false, 'waiting', true), 'alert')
  assert.equal(botState(false, undefined, false), 'idle')
  // Waiting and relaying each have motion of their own in the avatar engine.
  assert.equal(stateName('waiting'), 'waiting')
  assert.equal(stateName('orbit'), 'relaying')
  assert.ok(STATES.waiting.loop && STATES.relaying.loop)
  assert.equal(stateName('no such state'), 'idle')
})

test('a waiting Bot does not wear the working badge, since no turn of it runs', () => {
  const badges = state => BotAvatar({ bot: { id: 'b', name: 'Writer' }, size: 36, state }).children.slice(1).filter(Boolean).map(child => child.props.className)
  assert.deepEqual(badges('waiting'), [])
  assert.deepEqual(badges('working'), ['bt-badge bt-badge-working'])
  // Between turns the motion says it all.
  for (const state of ['background', 'failed', 'replied']) assert.deepEqual(badges(state), [], state)
})

test('between turns a Bot shows, in order: a question, a failed turn, work handed on, background tasks, an unread reply', () => {
  const all = { failed: true, background: true, replied: true }
  assert.equal(botState(false, 'waiting', true, all), 'alert')
  assert.equal(botState(false, 'waiting', false, all), 'failed')
  assert.equal(botState(false, 'waiting', false, { background: true, replied: true }), 'waiting')
  assert.equal(botState(false, undefined, false, { background: true, replied: true }), 'background')
  assert.equal(botState(false, undefined, false, { replied: true }), 'replied')
  assert.equal(botState(false, undefined, false), 'idle')
  // A running turn shows what it does over all of them.
  assert.equal(botState(true, 'searching', false, all), 'searching')
  assert.equal(botState(true, 'background', false, all), 'working')
  assert.equal(botState(true, 'failed', false), 'working')
  for (const state of ['background', 'failed', 'replied']) assert.equal(stateName(state), state)
})

test('dmMarkState alerts on background task approvals when idle without overriding foreground work', () => {
  // Single waiting_approval background task: alerts instead of calm background nod.
  assert.equal(dmMarkState({ running: false, background: true, waitingApproval: true }), 'alert')
  assert.equal(dmMarkState({ running: false, background: true, bgApproval: true }), 'alert')
  // Plain running background task with no pending approval stays calm background.
  assert.equal(dmMarkState({ running: false, background: true }), 'background')
  // Non-blocking background approval does not override an active foreground turn.
  assert.equal(dmMarkState({ running: true, doing: 'working', background: true, waitingApproval: true, bgApproval: true }), 'working')
  // Foreground approval / pending card / question / handoff overrides even a running foreground turn.
  assert.equal(dmMarkState({ running: true, doing: 'working', fgApproval: true }), 'alert')
  assert.equal(dmMarkState({ running: true, doing: 'working', handoff: true }), 'alert')
  assert.equal(dmMarkState({ running: true, doing: 'working', pending: botPendingOf({ questions: { b: { id: 'q1' } } }, { id: 'b' }) }), 'alert')
  // Group approval activity ('alert' without DM blocker) is stripped during foreground work (#1623).
  assert.equal(dmMarkState({ running: true, doing: 'alert' }), 'working')
})

test('a last turn failed until a later turn of that chat shows in its live outline', () => {
  // The host's shapes (turns.js): a failure under the part and turn it happened in, a
  // block on the Bot. The outline is DSH's turnOutline, numbered by the same turn/start.
  const failed = { id: 'b', failures: { b: { turn: 3, code: 'NETWORK', message: 'socket hang up', at: 10 } } }
  assert.equal(lastTurnFailed(undefined, 3), false)
  assert.equal(lastTurnFailed({ id: 'b' }, 2), false)
  assert.equal(lastTurnFailed(failed, 3), true)
  assert.equal(lastTurnFailed(failed, undefined), true, 'with no outline listed, the failure counts')
  // A retry under way, finished or stopped leaves it behind before the polled roster drops it.
  assert.equal(lastTurnFailed(failed, 4), false)
  // A failure in an earlier part of the chat no longer stands.
  assert.equal(lastTurnFailed({ id: 'b', sessionId: 'b-2', failures: { b: { turn: 3, code: 'NETWORK' } } }, 1), false)
  assert.equal(lastTurnFailed({ id: 'b', sessionId: 'b-2', failures: { 'b-2': { turn: 1, code: 'AUTH' } } }, 1), true)
  // A turn picked up after a restart has no number to place it by, so it counts.
  assert.equal(lastTurnFailed({ id: 'b', failures: { b: { turn: -1, code: 'NETWORK' } } }, 5), true)
  // A block stands for the whole Bot, from wherever it came (a group, a task)...
  assert.equal(lastTurnFailed({ id: 'b', blocked: { code: 'QUOTA', provider: 'deepseek', at: 10 } }, 7), true)
  assert.equal(lastTurnFailed({ ...failed, blocked: { code: 'QUOTA', provider: 'deepseek', at: 12 } }, 4), true)
  // A block stands for the whole Bot until the host lifts it, even when a retry turn
  // starts or is manually stopped in the live outline.
  const auth = { id: 'b', failures: { b: { turn: 3, code: 'AUTH', at: 1_000_000 } }, blocked: { code: 'AUTH', provider: 'deepseek', at: 1_000_002 } }
  assert.equal(lastTurnFailed(auth, 3), true)
  assert.equal(lastTurnFailed(auth, 4), true)
  // Once the host lifts the block, the superseded failure no longer holds failed.
  assert.equal(lastTurnFailed({ ...auth, blocked: undefined }, 4), false)
  // A block with the same code from a later failure elsewhere (a group) still stands.
  assert.equal(lastTurnFailed({ ...auth, blocked: { ...auth.blocked, at: 1_045_000 } }, 4), true)
  // The newest turn of a part, from the live list.
  assert.equal(latestTurnOf({ byId: { b: { projectionValues: { turnOutline: [{ turn: 2, seq: 5, prompt: 'hi', response: '' }, { turn: 3, seq: 9, prompt: 'again', response: '' }] } } } }, 'b'), 3)
  assert.equal(latestTurnOf({ byId: {} }, 'b'), undefined)
  assert.equal(latestTurnOf({ byId: { b: { projectionValues: { turnOutline: [] } } } }, 'b'), undefined)
})

// One component under React's rules for hooks: state and refs stay between renders;
// after a render, effects whose deps changed clean up their last run, then run, in
// order; a state set renders again.
function mountComponent(component) {
  const slots = []
  const saved = { useState: react.useState, useRef: react.useRef, useEffect: react.useEffect }
  let props
  let rendering = false
  let dirty = false
  const view = { out: undefined }
  const render = () => {
    rendering = true
    let index = 0
    const due = []
    Object.assign(react, {
      useState: (initial) => {
        const slot = (slots[index++] ??= { value: initial })
        return [slot.value, (value) => {
          const next = typeof value === 'function' ? value(slot.value) : value
          if (Object.is(next, slot.value)) return
          slot.value = next
          if (rendering) dirty = true
          else render()
        }]
      },
      useRef: initial => (slots[index++] ??= { current: initial }),
      useEffect: (run, deps) => {
        const slot = (slots[index++] ??= {})
        if (deps === undefined || slot.deps === undefined || deps.some((dep, at) => !Object.is(dep, slot.deps[at]))) due.push({ slot, run, deps })
      },
    })
    try { view.out = component(props) } finally { Object.assign(react, saved) }
    for (const { slot } of due) slot.cleanup?.()
    for (const effect of due) { effect.slot.cleanup = effect.run() ?? undefined; effect.slot.deps = effect.deps }
    rendering = false
    if (dirty) { dirty = false; render() }
  }
  view.render = (next) => { props = next; render() }
  return view
}

test('done plays once when work ends and stops on time, also when the chat opens on the unread reply', () => {
  const avatar = mountComponent(props => BotAvatar({ bot: { id: 'b', name: 'Writer' }, size: 36, badge: false, ...props }))
  const shown = () => avatar.out.children[0].props.state
  const go = (...states) => { for (const state of states) avatar.render({ state }) }
  go('idle', 'thinking', 'working')
  assert.equal(shown(), 'working')
  go('replied')
  assert.equal(shown(), 'done')
  // The chat opens on the reply while done plays: it still ends on time.
  advance(600)
  go('idle')
  assert.equal(shown(), 'done')
  advance(1300)
  assert.equal(shown(), 'idle')
  advance(5000)
  assert.equal(shown(), 'idle')
  // A question answered or a failure is not work done; a retry that goes through is.
  go('alert', 'idle')
  assert.equal(shown(), 'idle')
  go('failed', 'idle')
  assert.equal(shown(), 'idle')
  go('failed', 'thinking', 'idle')
  assert.equal(shown(), 'done')
  advance(1800)
  assert.equal(shown(), 'idle')
  // Back to work cuts the moment short.
  go('working', 'idle', 'searching')
  assert.equal(shown(), 'searching')
  advance(2000)
  go('idle')
  assert.equal(shown(), 'done')
  advance(1800)
  assert.equal(clock.timers.size, 0, 'no timer left behind')
})

test('a photo that does not load shows the Bot\'s character instead', () => {
  const photo = 'data:image/png;base64,iVBORw0KGgo='
  const bot = { id: 'b', name: 'Writer', avatar: { shape: 'fox', image: photo } }
  const img = BotMark({ bot }).children[0]
  assert.equal(img.type, 'img')
  sets.length = 0
  img.props.onError()
  assert.deepEqual(sets, [photo])
  // Rendered again with that photo marked broken: the character, not an empty image.
  states.push(photo)
  const mark = BotMark({ bot })
  assert.equal(mark.children[0].type, 'svg')
  assert.notEqual(mark.props['data-shape'], 'image')
  // A new photo is tried again.
  states.push(photo)
  assert.equal(BotMark({ bot: { ...bot, avatar: { ...bot.avatar, image: `${photo}AA` } } }).children[0].type, 'img')
})
