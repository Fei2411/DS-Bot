// #2418: SchedulesPage / BotSchedules / ScheduleSummary must offer one-click
// enablement when the host's DSH schedule plugin is off, surface load errors with
// Retry instead of sticking on "Loading…", and show real startup diagnostics.
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function loadSchedulesModule() {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { SchedulesPage, BotSchedules, ScheduleSummary } from './src/client/schedules.js'",
      resolveDir: join(repoRoot, 'ds-bot'),
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

function makeReact() {
  const states = new Map()
  const refs = new Map()
  const effects = []
  const cleanups = []
  let path = ''
  let idx = 0

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    useState(init) {
      const key = `${path}#${idx++}`
      if (!states.has(key)) states.set(key, typeof init === 'function' ? init() : init)
      const set = (next) => {
        const prev = states.get(key)
        states.set(key, typeof next === 'function' ? next(prev) : next)
      }
      return [states.get(key), set]
    },
    useRef(init) {
      const key = `${path}#${idx++}`
      if (!refs.has(key)) refs.set(key, { current: init })
      return refs.get(key)
    },
    useEffect(fn, deps) {
      const key = `${path}#${idx++}`
      if (deps !== undefined && deps.length === 0 && refs.has(`eff:${key}`)) return
      refs.set(`eff:${key}`, true)
      effects.push(fn)
    },
    useLayoutEffect(fn, deps) { React.useEffect(fn, deps) },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useId() { return 'bt-sched-id' },
  }

  function renderNode(node, p = 'root') {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, i) => renderNode(child, `${p}[${i}]`))
    if (typeof node.type === 'function') {
      const prevPath = path
      const prevIdx = idx
      path = `${p}/${node.type.name || 'fn'}`
      idx = 0
      const out = node.type(node.props)
      path = prevPath
      idx = prevIdx
      return renderNode(out, `${p}/${node.type.name || 'fn'}`)
    }
    return { ...node, children: (node.children ?? []).map((child, i) => renderNode(child, `${p}.${i}`)) }
  }

  return {
    React,
    render(el) {
      const tree = renderNode(el)
      while (effects.length > 0) {
        const fn = effects.shift()
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      return tree
    },
    unmount() {
      let firstError = null
      while (cleanups.length > 0) {
        try { cleanups.pop()() } catch (error) { firstError ??= error }
      }
      if (firstError) throw firstError
    },
  }
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const ROSTER = {
  bots: [{ id: 'b1', name: 'Chief', color: 'deepseek', avatar: { shape: 'whale' } }],
  rooms: [],
  byId: { b1: { id: 'b1', name: 'Chief' } },
  roomsById: {},
}

test('SchedulesPage surfaces load errors with Retry instead of hanging on Loading…', async (t) => {
  const code = await loadSchedulesModule()
  const harness = makeReact()
  t.after(() => harness.unmount())
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
    id === 'react-dom' ? { createPortal: el => el } : harness.React
  ))
  const { SchedulesPage } = mod.exports

  let fail = true
  let calls = 0
  const actions = {
    schedules: async () => {
      calls += 1
      if (fail) throw new Error('Host temporarily unreachable')
      return { available: true, canPause: true, tasks: [] }
    },
    openSettings() {},
  }
  const el = () => harness.React.createElement(SchedulesPage, { roster: ROSTER, actions })
  const first = harness.render(el())
  assert.match(textOf(first), /Loading…/)
  await tick()
  await tick()
  const failed = harness.render(el())
  assert.match(textOf(failed), /Host temporarily unreachable/)
  const retryBtn = findAll(failed, n => n.type === 'button' && textOf(n) === 'Retry')[0]
  assert.ok(retryBtn, 'failed load must offer a Retry button')

  fail = false
  retryBtn.props.onClick()
  await tick()
  await tick()
  const recovered = harness.render(el())
  assert.equal(calls, 2)
  assert.match(textOf(recovered), /No scheduled tasks yet\./)
})

test('SchedulesPage enables a disabled DSH schedule plugin in one click and opens TaskForm when started for a Bot', async (t) => {
  const prevWindow = globalThis.window
  const prevRaf = globalThis.requestAnimationFrame
  const prevCancelRaf = globalThis.cancelAnimationFrame
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  const code = await loadSchedulesModule()
  const harness = makeReact()
  t.after(() => {
    try { harness.unmount() } finally {
      if (prevWindow === undefined) delete globalThis.window
      else globalThis.window = prevWindow
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame
      else globalThis.requestAnimationFrame = prevRaf
      if (prevCancelRaf === undefined) delete globalThis.cancelAnimationFrame
      else globalThis.cancelAnimationFrame = prevCancelRaf
    }
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
    id === 'react-dom' ? { createPortal: el => el } : harness.React
  ))
  const { SchedulesPage } = mod.exports

  let enabled = false
  let enableCalls = 0
  const actions = {
    schedules: async () => (enabled
      ? { available: true, canPause: true, tasks: [] }
      : { available: false, tasks: [], canEnable: true, reason: 'disabled' }),
    scheduleEnable: async () => {
      enableCalls += 1
      enabled = true
      return { available: true, canPause: true, tasks: [] }
    },
    scheduleCreate: async () => ({ available: true, canPause: true, tasks: [] }),
    openSettings() {},
  }
  const el = () => harness.React.createElement(SchedulesPage, { roster: ROSTER, actions, start: 'b1' })
  harness.render(el())
  await tick()
  await tick()
  const off = harness.render(el())
  assert.match(textOf(off), /Scheduled tasks are off/)
  const enableBtn = findAll(off, n => n.type === 'button' && n.props['data-tour'] === 'open-plugins')[0]
  assert.ok(enableBtn, 'one-click enable button must keep data-tour="open-plugins" for SettingsTour')
  assert.equal(textOf(enableBtn), 'Turn on scheduled tasks')

  enableBtn.props.onClick()
  await tick()
  await tick()
  const on = harness.render(el())
  assert.equal(enableCalls, 1)
  // Because `start="b1"` was passed, enabling immediately reveals the create form.
  const form = findAll(on, n => n.type === 'form')[0]
  assert.ok(form, 'enabling scheduled tasks should immediately reveal TaskForm when opened with a target Bot')
})

test('SchedulesPage shows startup failure diagnostics instead of the obsolete Automation tasks prompt', async (t) => {
  const code = await loadSchedulesModule()
  const harness = makeReact()
  t.after(() => harness.unmount())
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => (
    id === 'react-dom' ? { createPortal: el => el } : harness.React
  ))
  const { SchedulesPage } = mod.exports

  const actions = {
    schedules: async () => ({ available: false, tasks: [], reason: 'error', error: 'corrupt_schedule_log' }),
    openSettings() {},
  }
  const el = () => harness.React.createElement(SchedulesPage, { roster: ROSTER, actions })
  harness.render(el())
  await tick()
  await tick()
  const tree = harness.render(el())
  assert.match(textOf(tree), /Scheduled tasks failed to start/)
  assert.match(textOf(tree), /corrupt_schedule_log/)
  assert.equal(textOf(tree).includes('Turn on Automation tasks in DSH'), false)
})
