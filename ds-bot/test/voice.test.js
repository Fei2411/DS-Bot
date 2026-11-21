import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// voice.js imports react; the client tests bundle it and stub react, as the
// other client tests do.
const bundle = await build({
  stdin: { contents: "export { watchReply, transcribeUtterance } from './src/client/voice.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const platform = {
  react: {
    createElement: () => null, Fragment: 'fragment',
    useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
    useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (sub, get) => get(),
    createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value,
  },
  'react-dom': { createPortal: node => node },
  '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
}
// The bundle's sandbox gets the browser APIs the client code uses: the VM
// context carries only the globals put on it.
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  AbortController, AbortSignal, btoa, atob,
  require: name => platform[name] ?? {},
})
const { watchReply, transcribeUtterance } = module.exports

// transcribeUtterance is the utterance lifecycle the pane runs per recording:
// isCurrent() stands in for its turn guard (pause/close/session-switch bump it)
// and ctl for the shared slot pause/close/unmount abort.
const wave = new Uint8Array([1, 2, 3])
const catalog = { maxAudioBytes: 1000, maxDurationSeconds: 30, selection: { providerId: 'p', language: 'auto' } }
const utterance = ({ isCurrent = () => true, transcribe, finish, ...calls }) => transcribeUtterance({
  speech: { transcribe }, catalog,
  capture: { finish: finish ?? (async () => wave) },
  isCurrent,
  ctl: calls.ctl ?? { current: null },
  submit: calls.submit ?? (() => {}),
  resume: calls.resume ?? (() => {}),
  fail: calls.fail ?? (() => {}),
})

test('a finished recording is transcribed once and submitted', async () => {
  const events = []
  const speech = { transcribe: async (request, signal) => { events.push(['transcribe', signal.aborted]); return { ok: true, value: { text: 'hello' } } } }
  await utterance({ transcribe: speech.transcribe, submit: text => events.push(['submit', text]), resume: () => events.push(['resume']), fail: () => events.push(['fail']) })
  assert.deepEqual(events, [['transcribe', false], ['submit', 'hello']])
})

test('a recording with nothing in it goes back to listening without a request', async () => {
  const events = []
  await utterance({ finish: async () => null, transcribe: async () => { events.push(['transcribe']); return { ok: true, value: { text: 'x' } } }, resume: () => events.push(['resume']) })
  assert.deepEqual(events, [['resume']])
})

test('a transcript landing after pause or unmount does not submit', async () => {
  // The pane's turn guard flips while the paid request is out: the answer is
  // dropped, nothing is submitted and the pane does not resume recording.
  let current = true
  const events = []
  await utterance({ isCurrent: () => current, transcribe: async () => { current = false; return { ok: true, value: { text: 'late' } } }, submit: text => events.push(['submit', text]), resume: () => events.push(['resume']) })
  assert.deepEqual(events, [])
})

test('the pending transcription is aborted and its result dropped', async () => {
  // What pause/close does to the shared slot: the request's signal aborts and
  // the late answer never submits.
  const ctl = { current: null }
  const events = []
  const pending = utterance({
    ctl, events,
    transcribe: (request, signal) => new Promise(resolve => signal.addEventListener('abort', () => {
      events.push(['aborted', signal.aborted])
      resolve({ ok: true, value: { text: 'late' } })
    })),
    submit: text => events.push(['submit', text]),
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.notEqual(ctl.current, null)
  ctl.current.abort()
  await pending
  assert.deepEqual(events, [['aborted', true]])
  assert.equal(ctl.current, null)
})

test('a session switch during recording drops the transcript without resuming', async () => {
  let current = true
  const events = []
  const pending = utterance({ isCurrent: () => current, finish: async () => { current = false; return wave }, transcribe: async () => { events.push(['transcribe']); return { ok: true, value: { text: 'x' } } }, resume: () => events.push(['resume']) })
  await pending
  assert.deepEqual(events, [])
})

test('a transcription failure while current is a note, not a submission', async () => {
  const events = []
  await utterance({ transcribe: async () => ({ ok: false, error: { message: 'down' } }), submit: text => events.push(['submit', text]), fail: error => events.push(['fail', error.kind]) })
  assert.deepEqual(events, [['fail', 'service']])
})

test('a reply published synchronously during subscribe is spoken once', () => {
  const consumed = []
  // DSH's target publishes on subscribe, before watch() returns the disposer.
  const watch = (listener) => { listener(); return () => {} }
  const off = watchReply(() => 'the answer', watch, text => consumed.push(text))
  assert.deepEqual(consumed, ['the answer'])
  off()
})

test('watchReply waits for the reply, speaks it once, then stops', () => {
  const consumed = []
  const calls = []
  let text
  const listeners = new Set()
  const off = watchReply(
    () => text,
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    (value) => { calls.push('consume'); consumed.push(value) })
  assert.deepEqual(consumed, [])
  text = 'first'
  for (const listener of listeners) listener()
  assert.deepEqual(consumed, ['first'])
  assert.equal(listeners.size, 0)
  // A later publish must not speak the same reply again.
  text = 'again'
  assert.deepEqual(consumed, ['first'])
  assert.equal(calls.length, 1)
  off()
})
