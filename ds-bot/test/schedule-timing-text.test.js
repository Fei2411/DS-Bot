import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The schedules page imports the browser's React; bundle it with a minimal stand-in, as the
// sidebar tests do. timingText is a plain function of a task, so nothing is rendered.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { timingText } from './src/client/schedules.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}], useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, documentElement: { setAttribute() {}, removeAttribute() {} } },
  setTimeout: () => 0, clearTimeout() {},
})
const { timingText } = module.exports

// #1221: the time input can report seconds, the service keeps and lists HH:mm:ss.SSS (a daily
// task made at 07:05:30 comes back as "07:05:30.000"), and the row must say when the task
// fires: the seconds were cut off, so 07:05:30 read as 07:05.
test('a daily task shows its seconds when they are not zero, and hides ":00"', () => {
  const daily = time => timingText({ kind: 'daily', time })
  // The shape the schedule service lists.
  assert.equal(daily('07:05:30.000'), 'Every day at 07:05:30')
  assert.equal(daily('18:25:00.000'), 'Every day at 18:25')
  assert.equal(daily('00:00:01.000'), 'Every day at 00:00:01')
  assert.equal(daily('09:30:59.000'), 'Every day at 09:30:59')
  // Without the milliseconds.
  assert.equal(daily('07:05:30'), 'Every day at 07:05:30')
  assert.equal(daily('18:25:00'), 'Every day at 18:25')
  // The zone suffix is unchanged by the seconds.
  assert.match(timingText({ kind: 'daily', time: '07:05:30.000', timeZone: 'Pacific/Kiritimati' }), /^Every day at 07:05:30 \(Pacific\/Kiritimati\)$/)
})

test('a weekly task shows its seconds in every way the row words its days', () => {
  const at = (weekdays, time) => timingText({ kind: 'weekly', time, weekdays })
  assert.equal(at([1, 2, 3, 4, 5], '08:00:15.000'), 'Every weekday at 08:00:15')
  assert.equal(at([1, 2, 3, 4, 5], '08:00:00.000'), 'Every weekday at 08:00')
  assert.equal(at([6, 7], '10:20:30.000'), 'Every weekend at 10:20:30')
  assert.equal(at([6, 7], '10:20:00.000'), 'Every weekend at 10:20')
  assert.equal(at([1, 2, 3, 4, 5, 6, 7], '18:25:45.000'), 'Every day at 18:25:45')
  assert.equal(at([1, 2, 3, 4, 5, 6, 7], '18:25:00.000'), 'Every day at 18:25')
  assert.match(at([1, 3], '18:25:30.000'), /^Every Mon, Wed at 18:25:30$/)
  assert.match(at([1, 3], '18:25:00.000'), /^Every Mon, Wed at 18:25$/)
  assert.equal(at([1, 2, 3, 4, 5], '08:00:15'), 'Every weekday at 08:00:15')
})

test('a time kept without seconds, or missing, still reads as before', () => {
  assert.equal(timingText({ kind: 'daily', time: '07:05' }), 'Every day at 07:05')
  assert.equal(timingText({ kind: 'daily', time: undefined }), 'Every day at ')
})
