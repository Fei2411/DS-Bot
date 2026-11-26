import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { RANGES, bucketsOf, compact, percent, spanOf, spanRange, summarize } from '../src/client/usage-data.js'

const range = id => RANGES.find(item => item.id === id)
// [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls]
const row = (hour, owner, tokens, model = 0) => [hour, owner, model, 0, tokens, 0, 0, 0, 1]

test('buckets end at the current hour, day, week, or month, after as many before them', () => {
  const hours = bucketsOf(range('24h'), '2026-10-09 22')
  assert.equal(hours.length, 48)
  assert.equal(hours.at(-1).key, '2026-10-09 22')
  assert.equal(hours.at(-24).key, '2026-10-08 23')
  assert.equal(hours[0].key, '2026-10-07 23')

  const days = bucketsOf(range('7d'), '2026-10-09 22')
  assert.deepEqual(days.slice(7).map(bucket => bucket.key), ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])

  // 2026-10-09 is a Friday; its week starts on Monday the 5th.
  const weeks = bucketsOf(range('12w'), '2026-10-09 22')
  assert.equal(weeks.at(-1).key, '2026-10-05')
  assert.equal(weeks.at(-2).key, '2026-09-28')

  const months = bucketsOf(range('12m'), '2026-02-01 00')
  assert.equal(months.at(-1).key, '2026-02')
  assert.equal(months.at(-3).key, '2025-12')
  assert.equal(months[0].key, '2024-03')
})

test('a summary sums the range, the span before it, and each owner, model, and stack', () => {
  const view = {
    now: '2026-10-09 22',
    rows: [
      row('2026-10-01 09', 0, 50),
      row('2026-10-05 08', 0, 100),
      ['2026-10-05 09', 1, 1, 2, 10, 30, 5, 20, 2],
      row('2026-10-09 21', 0, 7),
      row('2026-09-01 00', 0, 999),
    ],
  }
  const week = summarize(view, range('7d'), undefined, item => `o${item[1]}`)
  assert.equal(week.total.total, 172)
  // The cache write counts as input.
  assert.deepEqual(week.total, { input: 122, cacheRead: 30, output: 20, calls: 4, total: 172 })
  assert.equal(week.previous, 50)
  assert.equal(week.buckets[2].key, '2026-10-05')
  assert.equal(week.buckets[2].sum.total, 165)
  assert.deepEqual([...week.buckets[2].stacks], [['o0', 100], ['o1', 65]])
  assert.equal(week.owners.get(1).total, 65)
  assert.equal(week.models.get(0).total, 107)
  assert.equal(week.kinds.get(2).calls, 2)

  const one = summarize(view, range('12w'), item => item[1] === 0)
  assert.equal(one.total.total, 1156)
  assert.equal(one.buckets.find(bucket => bucket.key === '2026-08-31').sum.total, 999)
  assert.equal(one.buckets.at(-1).sum.total, 107)
  assert.equal(one.buckets.at(-2).sum.total, 50)
})

test('a picked span sums by hour, day, week, or month by its length', () => {
  const units = [['2026-10-09', '2026-10-09'], ['2026-10-08', '2026-10-09'], ['2026-10-07', '2026-10-09'], ['2026-08-09', '2026-10-09'], ['2026-08-08', '2026-10-09'], ['2026-04-11', '2026-10-09'], ['2026-04-10', '2026-10-09']]
    .map(([from, to]) => { const span = spanRange(from, to); return [span.days, span.unit] })
  assert.deepEqual(units, [[1, 'hour'], [2, 'hour'], [3, 'day'], [62, 'day'], [63, 'week'], [182, 'week'], [183, 'month']])
  assert.deepEqual(spanRange('2026-10-09', '2026-10-01'), spanRange('2026-10-01', '2026-10-09'))

  const hours = spanRange('2026-10-08', '2026-10-09')
  const hourSpan = spanOf(hours, '2026-10-09 22')
  assert.equal(hours.count, 48)
  assert.equal(hourSpan.buckets[0].key, '2026-10-08 00')
  assert.equal(hourSpan.buckets.at(-1).key, '2026-10-09 23')
  assert.equal(hourSpan.before, '2026-10-06 00')

  // 2026-07-01 is a Wednesday: the first week starts on Monday the 29th but is cut to the span.
  const weeks = spanRange('2026-07-01', '2026-10-09')
  const weekSpan = spanOf(weeks, '2026-10-09 22')
  assert.equal(weeks.count, 15)
  assert.equal(weeks.stride, 2)
  assert.equal(weekSpan.buckets[0].key, '2026-06-29')
  assert.equal(weekSpan.buckets[0].start, Date.UTC(2026, 6, 1))
  assert.equal(weekSpan.buckets.at(-1).end, Date.UTC(2026, 9, 10))

  const months = spanOf(spanRange('2025-11-15', '2026-10-09'), '2026-10-09 22')
  assert.deepEqual([months.buckets.length, months.buckets[0].key, months.buckets.at(-1).key], [12, '2025-11', '2026-10'])
  assert.equal(months.buckets[0].start, Date.UTC(2025, 10, 15))
  assert.equal(months.buckets[1].start, Date.UTC(2025, 11, 1))
})

test('a picked span compares with as many days just before it and ignores the days after', () => {
  const view = {
    now: '2026-10-09 22',
    rows: [
      row('2026-09-27 23', 0, 1000),
      row('2026-09-28 00', 0, 5),
      row('2026-09-30 23', 0, 6),
      row('2026-10-01 00', 0, 10),
      row('2026-10-03 23', 1, 20),
      row('2026-10-04 00', 0, 999),
    ],
  }
  const days = summarize(view, spanRange('2026-10-01', '2026-10-03'))
  assert.deepEqual(days.buckets.map(bucket => [bucket.key, bucket.sum.total]), [['2026-10-01', 10], ['2026-10-02', 0], ['2026-10-03', 20]])
  assert.equal(days.total.total, 30)
  assert.equal(days.previous, 11)
  assert.equal(days.owners.get(1).total, 20)

  // The Tuesday before the span shares its first week's key but counts as the span before.
  const weeks = summarize({ now: view.now, rows: [row('2026-06-30 10', 0, 4), row('2026-07-01 00', 0, 9)] }, spanRange('2026-07-01', '2026-10-09'))
  assert.equal(weeks.buckets[0].sum.total, 9)
  assert.equal(weeks.previous, 4)
})

test('counts read short and shares round', () => {
  assert.equal(compact(0), '0')
  assert.equal(compact(950), '950')
  assert.equal(compact(1500), '1.5K')
  assert.equal(compact(12_340), '12.3K')
  assert.equal(compact(999_999), '1M')
  assert.equal(compact(2_000_000), '2M')
  assert.equal(compact(345_100_000), '345M')
  assert.equal(percent(1, 300), '<1')
  assert.equal(percent(0, 300), '0')
  assert.equal(percent(1, 3), '33')
  assert.equal(percent(5, 0), '0')
})

// Mounts the real Stats component from usage-page.js with stateful React hooks and
// controllable rAF / clock so tests exercise useTween and layout structure directly.
async function mountStats({ reduced = false } = {}) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/usage-page.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  let now = 0
  let nextFrame = 1
  const frames = new Map()
  const cancelled = []
  let slots = []
  let cursor = 0
  let pendingEffects = []
  let activeProps = null
  let tree = null
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    useId: () => 'u-id',
    useMemo: make => make(),
    useCallback: fn => fn,
    useSyncExternalStore: (_sub, get) => get(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState(initial) {
      const idx = cursor++
      if (!(idx in slots)) slots[idx] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[idx]) : next
        if (!Object.is(slots[idx], value)) {
          slots[idx] = value
          render(activeProps)
        }
      }
      return [slots[idx], set]
    },
    useRef(initial) {
      const idx = cursor++
      if (!(idx in slots)) slots[idx] = { current: initial }
      return slots[idx]
    },
    useLayoutEffect(fn, deps) {
      const idx = cursor++
      const prev = slots[idx]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        pendingEffects.push({ idx, fn, deps, cleanup: prev?.cleanup })
      }
    },
    useEffect() {},
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    Intl, URL, URLSearchParams, setTimeout, clearTimeout,
    performance: { now: () => now },
    requestAnimationFrame: (cb) => { const id = nextFrame++; frames.set(id, cb); return id },
    cancelAnimationFrame: (id) => { cancelled.push(id); frames.delete(id) },
    window: { matchMedia: () => ({ matches: reduced }) },
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected external ${name}`)
    },
  })
  const { Stats, USAGE_CSS } = module.exports
  const render = (props) => {
    activeProps = props
    cursor = 0
    pendingEffects = []
    tree = Stats(props)
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) {
      effect.cleanup?.()
      const cleanup = effect.fn()
      slots[effect.idx] = { deps: effect.deps, cleanup }
    }
    return tree
  }
  const find = (node, pred) => {
    if (!node || typeof node !== 'object') return null
    if (pred(node)) return node
    for (const child of node.children ?? []) {
      const hit = find(child, pred)
      if (hit) return hit
    }
    return null
  }
  const text = (node) => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    return (node.children ?? []).map(text).join('')
  }
  const tick = (ms) => {
    now = ms
    const batch = [...frames.entries()]
    frames.clear()
    for (const [, cb] of batch) cb(now)
  }
  const unmount = () => {
    for (const slot of slots) slot?.cleanup?.()
    slots = []
  }
  return { render, find, text, tick, unmount, frames, cancelled, USAGE_CSS, get tree() { return tree } }
}

// #1547: switching ranges snaps Stats immediately without counting across unrelated
// totals, while updates within the same range still ease smoothly, and .bt-us-delta
// lives in the header row decoupled from the animated figure's width.
test('Stats snaps total immediately on range switch, eases within one range, and decouples the delta badge from the figure', async () => {
  const m = await mountStats()
  const statsOf = total => ({ input: total, cacheRead: 0, output: 0, calls: 1, total })
  const mainValue = () => m.text(m.find(m.tree, n => n.props?.className === 'bt-us-stat-value'))
  const head = () => m.find(m.tree, n => n.props?.className === 'bt-us-stat-head')
  const valueNode = () => m.find(m.tree, n => n.props?.className === 'bt-us-stat-value')

  // Initial mount eases from 0 toward 10K via requestAnimationFrame.
  m.render({ range: range('24h'), total: statsOf(10_000), previous: 8_000 })
  assert.equal(m.frames.size, 1, 'initial render schedules tween rAF')
  m.tick(325)
  const midway = mainValue()
  assert.notEqual(midway, '0tokens')
  assert.notEqual(midway, '10Ktokens')
  m.tick(650)
  assert.equal(mainValue(), '10Ktokens')
  assert.equal(m.frames.size, 0)

  // Same range growth eases smoothly and cleans up if interrupted.
  m.render({ range: range('24h'), total: statsOf(20_000), previous: 8_000 })
  assert.equal(m.frames.size, 1, 'same-range total change schedules tween rAF')
  const pendingId = [...m.frames.keys()][0]

  // Switching range cancels any in-flight tween and snaps immediately to the new range total.
  m.render({ range: range('7d'), total: statsOf(4_330_000_000), previous: 2_000_000_000 })
  assert.ok(m.cancelled.includes(pendingId), 'in-flight rAF from previous range is cancelled')
  assert.equal(m.frames.size, 0, 'range switch must not schedule a tween across unrelated totals')
  assert.equal(mainValue(), '4.33Btokens', 'switched range displays its total immediately')

  // Switching between custom spans also snaps immediately.
  m.render({ range: spanRange('2026-10-01', '2026-10-03'), total: statsOf(500), previous: 400 })
  assert.equal(m.frames.size, 0)
  assert.equal(mainValue(), '500tokens')
  m.render({ range: spanRange('2026-10-04', '2026-10-06'), total: statsOf(1_500_000), previous: 500 })
  assert.equal(m.frames.size, 0)
  assert.equal(mainValue(), '1.5Mtokens')

  // Layout contract: .bt-us-delta sits in .bt-us-stat-head (not inside .bt-us-stat-value),
  // so number width changes during initial load, same-range updates, or range switches never shift it.
  const deltaInHead = m.find(head(), n => n.props?.className === 'bt-us-delta')
  const deltaInValue = m.find(valueNode(), n => n.props?.className === 'bt-us-delta')
  assert.ok(deltaInHead, '.bt-us-delta must render in .bt-us-stat-head')
  assert.equal(deltaInValue, null, '.bt-us-delta must not sit inline inside .bt-us-stat-value')
  assert.match(m.USAGE_CSS, /\.bt-us-stat-head\{[^}]*display:flex[^}]*justify-content:space-between/)
  m.unmount()
})
