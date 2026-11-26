import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { STATES, stateName } from '../src/client/avatar/states.js'

const bundle = await build({
  stdin: { contents: "export { botState, lastTurnFailed, useLastTurnFailed, BotAvatar, BotMark, RoomAvatar } from './src/client/mark.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
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
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}) })
const { botState, lastTurnFailed, useLastTurnFailed, BotAvatar, BotMark, RoomAvatar } = module.exports

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

test('a last turn failed until a turn of that chat goes through: the host keeps the failure on the Bot', () => {
  assert.equal(lastTurnFailed({ id: 'b' }), false)
  assert.equal(lastTurnFailed({ id: 'b', failures: { b: { turn: 3, code: 'NETWORK' } } }), true)
  // A failure in an earlier part of the chat no longer stands.
  assert.equal(lastTurnFailed({ id: 'b', sessionId: 'b-2', failures: { b: { turn: 3, code: 'NETWORK' } } }), false)
  assert.equal(lastTurnFailed({ id: 'b', sessionId: 'b-2', failures: { 'b-2': { turn: 1, code: 'AUTH' } } }), true)
  // A failure that stands until it is fixed (a key, a balance).
  assert.equal(lastTurnFailed({ id: 'b', blocked: { code: 'AUTH' } }), true)
})

// Runs a hook as React does for one component: its state stays between renders, and a
// set made while rendering renders it again.
function hookRunner(hook) {
  let kept
  return (...args) => {
    for (let pass = 0; pass < 5; pass += 1) {
      states.length = 0
      sets.length = 0
      if (kept !== undefined) states.push(kept.value)
      const out = hook(...args)
      if (sets.length === 0) return out
      kept = { value: sets.at(-1) }
    }
    throw new Error('the hook keeps setting its state')
  }
}

test('a failure from before the latest turn stops showing when that turn ends, before the polled roster drops it', () => {
  // The host's shapes (turns.js): a failure under the part it happened in, a block on the Bot.
  const failedAt = (turn, at) => ({ id: 'b', failures: { b: { turn, code: 'NETWORK', message: 'socket hang up', at } } })
  const shown = hookRunner(useLastTurnFailed)
  assert.equal(shown(failedAt(3, 10), false), true)
  // A retry runs, and goes through: the session says so at once, the roster a poll later.
  shown(failedAt(3, 10), true)
  assert.equal(shown(failedAt(3, 10), false), false)
  assert.equal(shown({ id: 'b' }, false), false)
  // A turn that fails again shows its own failure as soon as the roster brings it.
  const again = hookRunner(useLastTurnFailed)
  again(failedAt(3, 10), false)
  again(failedAt(3, 10), true)
  assert.equal(again(failedAt(3, 10), false), false)
  assert.equal(again(failedAt(4, 20), false), true)
  // Also when the roster brings it while the session still reads as running.
  const early = hookRunner(useLastTurnFailed)
  early(failedAt(3, 10), true)
  early(failedAt(4, 20), true)
  assert.equal(early(failedAt(4, 20), false), true)
  // A block from before the turn counts the same way; a new block shows.
  const blocked = at => ({ id: 'b', blocked: { code: 'AUTH', provider: 'deepseek', at } })
  const block = hookRunner(useLastTurnFailed)
  assert.equal(block(blocked(10), false), true)
  block(blocked(10), true)
  assert.equal(block(blocked(10), false), false)
  assert.equal(block(blocked(30), false), true)
  // A mark with no Bot shows no failure.
  assert.equal(hookRunner(useLastTurnFailed)(undefined, false), false)
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
