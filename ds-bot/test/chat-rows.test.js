import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stackReplies } from '../src/shared/group-replies.js'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, Intl, Date, TextEncoder,
  window: { innerWidth: 1200, addEventListener() {}, removeEventListener() {} },
  document: { body: {} },
  setTimeout,
  clearTimeout,
  require: (name) => {
    const platform = {
      react: { Fragment: 'fragment', createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: current => ({ current }),
        useLayoutEffect() {}, useEffect() {}, useMemo: make => make(),
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': {
        MarkdownText: props => ({ type: 'markdown', props, children: [] }),
        writeClipboard: async () => true,
      },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
  queueMicrotask,
})
const { Bubbles, ChatRows, ThinkingRow, thinkingPreviewLine, syncGroupChains, claimLines, GroupMessage, TriggerCell, earlierClosedKey, mergeEarlierPage, earlierItems } = module.exports

const roster = { byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {} }
const MINUTE = 60_000
const shape = rows => [...rows].map(row => (row.props.className === 'bt-time-sep' ? 'clock' : row.type.name === 'Bubbles' ? `bot:${row.props.texts.join('+')}` : row.type.name))

test('stored duplicate bubbles stay visible, with reactions on indexes 1 and 3', () => {
  const tree = Bubbles({
    texts: ['...', '...', 'other', '...', '...'], roster, selfId: 'b', actions: {}, msgKey: 'room:1',
    useUi: select => select({ reactions: { 'room:1': { 1: ['👍'], 3: ['😂'] } } }),
    streaming: true, lead: 'avatar',
  })
  const bubbles = tree.children.filter(child => child?.type?.name === 'Bubble')
  assert.deepEqual(bubbles.map(bubble => [bubble.props.text, bubble.props.index, bubble.props.picked[0] ?? null]), [
    ['...', 0, null], ['...', 1, '👍'], ['other', 2, null], ['...', 3, '😂'], ['...', 4, null],
  ])
  assert.deepEqual(bubbles.map(bubble => bubble.props.live), [false, false, false, false, true])
  assert.deepEqual(bubbles.map(bubble => bubble.props.lead), [null, null, null, null, 'avatar'])
})

test('whitespace variants stay separate bubbles', () => {
  const tree = Bubbles({ texts: ['...', '... ', '...\n'], roster, selfId: 'b', actions: {} })
  const bubbles = tree.children.filter(child => child?.type?.name === 'Bubble')
  assert.deepEqual(bubbles.map(bubble => bubble.props.text), ['...', '... ', '...\n'])
  assert.deepEqual(bubbles.map(bubble => bubble.props.index), [0, 1, 2])
})

test('a Bot\'s messages in a row are one block', () => {
  const items = [
    { kind: 'user', text: 'hi', time: MINUTE },
    { kind: 'bot', text: 'one', time: 2 * MINUTE },
    { kind: 'bot', text: 'two', time: 2 * MINUTE },
    { kind: 'user', text: 'and?', time: 3 * MINUTE },
    { kind: 'bot', text: 'three', time: 4 * MINUTE },
  ]
  assert.deepEqual(shape(ChatRows({ items, sessionId: 'b', roster, actions: {} })), ['EarlierUser', 'bot:one+two', 'EarlierUser', 'bot:three'])
})

test('a view row renders as a view card from its blueprint', () => {
  const items = [
    { kind: 'user', text: 'show me', time: MINUTE },
    { kind: 'view', title: 'A long note', view: { type: 'stack', children: [0, 1, 2, 3].map(() => ({ type: 'text', text: 'x'.repeat(1900) })) }, callId: 'c1', time: 2 * MINUTE },
    { kind: 'bot', text: 'done', time: 3 * MINUTE },
  ]
  const rows = [...ChatRows({ items, sessionId: 'b', roster, actions: {} })]
  assert.deepEqual(shape(rows), ['EarlierUser', 'WidgetCell', 'bot:done'])
  // The card draws the blueprint, not nothing: run the cell and look inside.
  const cell = rows[1]
  const rendered = cell.type(cell.props)
  assert.equal(rendered.props.className, 'bt-q-inline')
})

test('with the clock, a time separator sits above the first entry and after each pause of half an hour', () => {
  const items = [
    { kind: 'divider', time: 0 },
    { kind: 'user', text: 'hi', time: MINUTE },
    { kind: 'bot', text: 'one', time: 2 * MINUTE },
    { kind: 'bot', text: 'two', time: 40 * MINUTE },
    { kind: 'user', text: 'back', time: 75 * MINUTE },
  ]
  assert.deepEqual(shape(ChatRows({ items, sessionId: 'b', roster, actions: {}, clock: true })), ['PartLine', 'clock', 'EarlierUser', 'bot:one+two', 'clock', 'EarlierUser'])
})

test('a reasoning row the reader opened stays open when the turn moves it to a later step', () => {
  const first = ThinkingRow({ text: 'one', live: true, viewKey: 's:7' })
  first.props.onToggle({ currentTarget: { open: true } })
  assert.equal(ThinkingRow({ text: 'one\n\ntwo', live: true, viewKey: 's:7' }).props.open, true)
  assert.equal(ThinkingRow({ text: 'other', viewKey: 's:8' }).props.open, false)
})

test('the reasoning row is a closed details with latest paragraph preview and renders Markdown when opened', () => {
  const row = ThinkingRow({ text: 'first paragraph\n\n**Latest** reasoning\nsecond line' })
  assert.equal(row.type, 'details')
  assert.equal(row.props.className, 'bt-think')
  assert.equal(row.props.open, false)
  assert.equal(typeof row.props.onToggle, 'function')
  const [title, box] = row.children
  assert.equal(title.type, 'summary')
  assert.equal(title.children[0], 'Thought it through')
  const preview = title.children.find(child => child?.props?.className === 'bt-think-preview')
  assert.equal(preview?.children.join(''), 'Latest reasoning')
  assert.equal(box.props.className, 'bt-think-text')
  assert.equal(box.children.filter(Boolean).length, 0, 'collapsed reasoning defers Markdown rendering until expanded')

  // Opening hides the collapsed preview and renders MarkdownText inside .bt-think-text.
  const opened = ThinkingRow({ text: 'first paragraph\n\n**Latest** reasoning\nsecond line', viewKey: 's:open-md' })
  opened.props.onToggle({ currentTarget: { open: true } })
  const expanded = ThinkingRow({ text: 'first paragraph\n\n**Latest** reasoning\nsecond line', viewKey: 's:open-md' })
  assert.equal(expanded.props.open, true)
  const [openTitle, openBox] = expanded.children
  assert.equal(openTitle.children.find(child => child?.props?.className === 'bt-think-preview'), undefined)
  assert.equal(openBox.children.filter(Boolean).length, 1)
  assert.equal(openBox.children[0]?.props?.text, 'first paragraph\n\n**Latest** reasoning\nsecond line')
})

test('a live reasoning row titles "Thinking" with a ticking clock', () => {
  const row = ThinkingRow({ text: 'one\ntwo', live: true, at: Date.now() - 4000 })
  const title = row.children[0]
  assert.equal(title.children[0], 'Thinking')
  assert.equal(title.children[1]?.type?.name, 'Elapsed')
  assert.equal(title.children[1]?.props.at <= Date.now() - 4000, true)
})

test('a settled reasoning row shows the turn’s thinking time when known', () => {
  const timed = ThinkingRow({ text: 'one\ntwo', ms: 12_000 })
  const [title] = timed.children
  assert.equal(title.children[0], 'Thought it through')
  const time = title.children.find(child => child?.props?.className === 'bt-think-time')
  assert.equal(time?.children.join(''), '· 12s')
  const untimed = ThinkingRow({ text: 'one\ntwo' })
  assert.equal(untimed.children[0].children[0], 'Thought it through')
  assert.equal(untimed.children[0].children.find(child => child?.props?.className === 'bt-think-time'), undefined)
})

test('consecutive group messages from the same Bot chain together, and cards or user rows break the chain', () => {
  const node = (classes, botId, turn = {}) => ({
    dataset: botId ? { botId } : {},
    classList: { contains: name => classes.includes(name) },
    closest: sel => (sel === '[data-bt-group-key]' ? turn : null),
  })
  const t1 = { dataset: {} }, t2 = { dataset: {} }, t3 = { dataset: {} }, t4 = { dataset: {} }
  const m1 = node(['bt-group-msg'], 'a', t1)
  const m2 = node(['bt-group-msg'], 'a', t2)
  const card = node(['bt-q-inline'])
  const m3 = node(['bt-group-msg'], 'a', t3)
  const hostUser = node([], undefined)
  const m4 = node(['bt-group-msg'], 'a', t4)
  syncGroupChains({ querySelectorAll: () => [m1, m2, card, m3, hostUser, m4] })
  assert.equal(m1.dataset.chainPrev, undefined)
  assert.equal(m1.dataset.chainNext, '')
  assert.equal(t1.dataset.btChainNext, '')
  assert.equal(m2.dataset.chainPrev, '')
  assert.equal(m2.dataset.chainNext, undefined)
  assert.equal(t2.dataset.btChainPrev, '')
  assert.equal(m3.dataset.chainPrev, undefined)
  assert.equal(m3.dataset.chainNext, undefined)
  assert.equal(m4.dataset.chainPrev, undefined)
})

test('a final reply with a missing file and no work running draws both markers', () => {
  const claims = { inProgress: true, missingFiles: ['./out/report.pptx'] }
  assert.deepEqual([...claimLines(claims)].map(line => String(line.text)), ['No background work detected', 'File not found: ./out/report.pptx'])
  assert.equal(claimLines(undefined).length, 0)
  const tree = GroupMessage({
    bot: { id: 'b', name: 'Writer' }, text: '正在导出，稍后汇报。', room: { id: 'r1' }, roster: { prefs: {} }, actions: { openSession() {} }, claims,
  })
  const markers = tree.children.filter(child => String(child?.props?.className ?? '').startsWith('bt-claim'))
  assert.deepEqual([...markers].map(child => [String(child.props.className), [...child.children].join('')]), [
    ['bt-claim bt-claim-inProgress', 'No background work detected'],
    ['bt-claim bt-claim-file', 'File not found: ./out/report.pptx'],
  ])
})

test('a group post carries claims both live and in earlier chat rows', () => {
  const claims = { missingFiles: ['./missing.md'] }
  const source = { kind: 'bot', role: 'post', senderSessionId: 'b', claims }
  const team = { ...roster, roomsById: { g: { id: 'g' } }, exchangeTurns: {} }
  const live = TriggerCell({
    node: { data: { source, turn: 1, time: 1, content: [{ type: 'text', text: 'Report' }] } },
    sessionId: 'g', useRoster: pick => pick(team), useSessions: pick => pick({ byId: {} }),
    useTurnClock: pick => pick({}), useUi: pick => pick({}), actions: {},
  })
  assert.deepEqual(live.props.claims, claims)
  const [earlier] = ChatRows({
    items: [{ kind: 'post', botId: 'b', text: 'Report', claims }], sessionId: 'g', roster: team, actions: {},
  })
  assert.deepEqual(earlier.props.claims, claims)
})

test('a marked final reply stacks onto earlier progress and keeps later messages below its marker', () => {
  const claims = { missingFiles: ['./missing.md'] }
  const progress = { botId: 'b', text: 'Started' }
  const final = { botId: 'b', text: 'Report', claims }
  const stacked = stackReplies([progress, final, { botId: 'b', text: 'Follow-up' }])
  assert.equal(stacked.length, 2)
  assert.deepEqual(stacked[0].texts, ['Started', 'Report'])
  assert.deepEqual(stacked[0].claims, claims)
  assert.deepEqual(stacked[1].texts, ['Follow-up'])
  assert.equal(stacked[1].claims, undefined)
})

test('consecutive part dividers collapse into one keeping the latest timestamp', () => {
  const items = [
    { kind: 'user', text: 'switch model', time: MINUTE },
    { kind: 'divider', time: 2 * MINUTE },
    { kind: 'divider', time: 3 * MINUTE },
    { kind: 'bot', text: 'ready', time: 4 * MINUTE },
  ]
  const rows = [...ChatRows({ items, sessionId: 'b', roster, actions: {} })]
  assert.deepEqual(shape(rows), ['EarlierUser', 'PartLine', 'bot:ready'])
  assert.equal(rows[1].props.time, 3 * MINUTE)
})

test('earlierItems drops trailing dividers, drops leading dividers only when fully loaded, and reports empty history', () => {
  // All-empty earlier parts carry no content and suppress the trailing PartLine.
  const empty = earlierItems([{ partIndex: 0, items: [{ kind: 'divider', time: MINUTE }], btw: [] }], { cursor: null, loading: false })
  assert.equal(empty.hasContent, false)
  assert.equal(empty.items.length, 0)

  // A leading divider stays while older pages still exist or are loading, then drops once done.
  const paged = [{ partIndex: 1, items: [{ kind: 'divider', time: 2 * MINUTE }, { kind: 'user', text: 'hi', time: 3 * MINUTE }], btw: [] }]
  const withMore = earlierItems(paged, { cursor: { part: 0 }, loading: false })
  assert.equal(withMore.hasContent, true)
  assert.deepEqual([...withMore.items].map(item => item.kind), ['divider', 'user'])
  const whileLoading = earlierItems(paged, { cursor: null, loading: true })
  assert.deepEqual([...whileLoading.items].map(item => item.kind), ['divider', 'user'])
  const allLoaded = earlierItems(paged, { cursor: null, loading: false })
  assert.deepEqual([...allLoaded.items].map(item => item.kind), ['user'])

  // Deleting the last btw card on an otherwise empty earlier part drops its orphaned trailing divider.
  const afterBtwDelete = earlierItems([
    { partIndex: 0, items: [{ kind: 'user', text: 'earlier', time: MINUTE }], btw: [] },
    { partIndex: 1, items: [{ kind: 'divider', time: 2 * MINUTE }], btw: [] },
  ], { cursor: null, loading: false })
  assert.equal(afterBtwDelete.hasContent, true)
  assert.deepEqual([...afterBtwDelete.items].map(item => item.kind), ['user'])
})

test('mergeEarlierPage merges multi-page responses under page.partIndex after skipping an empty part', () => {
  // Part 2 was empty and skipped by the host, so page 1 of part 1 arrives with partIndex: 1 even though fallback was 2.
  const p1 = mergeEarlierPage([], { partIndex: 1, items: [{ kind: 'bot', text: 'later', time: 2 * MINUTE }], btw: [] }, 2)
  const p2 = mergeEarlierPage(p1, { partIndex: 1, items: [{ kind: 'user', text: 'earlier', time: MINUTE }], btw: [] }, 1)
  assert.equal(p2.length, 1)
  assert.equal(p2[0].partIndex, 1)
  assert.deepEqual([...p2[0].items].map(item => item.text), ['earlier', 'later'])
})

test('earlierClosedKey stays stable when newer parts without closed cards append to bot.parts', () => {
  const closed = { p1: { c1: true } }
  const k1 = earlierClosedKey(['p1', 'p2'], 'p2', closed)
  const k2 = earlierClosedKey(['p1', 'p2', 'p3'], 'p2', closed)
  assert.equal(k1, k2)
  const k3 = earlierClosedKey(['p1', 'p2', 'p3'], 'p3', closed)
  assert.equal(k1, k3)
  // A closed card added to an earlier part still invalidates the key.
  const k4 = earlierClosedKey(['p1', 'p2', 'p3'], 'p3', { ...closed, p2: { c2: true } })
  assert.notEqual(k3, k4)
})

test('thinkingPreviewLine extracts cleaned first line of the latest reasoning paragraph', () => {
  assert.equal(thinkingPreviewLine(''), '')
  assert.equal(thinkingPreviewLine('First para\n\n### **Step 2:** inspect `cells.js`\nMore detail'), 'Step 2: inspect cells.js')
  assert.equal(thinkingPreviewLine('- bullet item\n\n> quoted note'), 'quoted note')
})

test('MessageTools copy uses writeClipboard fallback and reports clipboard failures', async () => {
  const findAll = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { node.forEach(item => findAll(item, pred, out)); return out }
    if (pred(node)) out.push(node)
    if (Array.isArray(node.children)) node.children.forEach(item => findAll(item, pred, out))
    return out
  }
  const reported = []
  const actions = { reportError: (err, kind) => reported.push([err?.message, kind]), quote() {}, toggleReaction() {} }
  const copyMod = { exports: {} }
  const copyCalls = []
  let shouldSucceed = true
  let toolsMode = false
  let sIdx = 0
  runInNewContext(bundle.outputFiles[0].text, {
    module: copyMod, exports: copyMod.exports, Intl, Date, TextEncoder,
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    document: { body: {} },
    setTimeout,
    clearTimeout,
    require: (name) => {
      if (name === 'react') {
        return {
          Fragment: 'fragment',
          createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
          useContext: ctx => ctx.value,
          useCallback: fn => fn,
          useId: () => 'id',
          useSyncExternalStore: (sub, snap) => snap(),
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: (initial) => {
            if (toolsMode) {
              const idx = sIdx++
              if (idx === 0) return [{ kind: 'more', node: { getBoundingClientRect: () => ({ left: 10, top: 100, bottom: 120, width: 28 }) } }, () => {}]
            }
            return [typeof initial === 'function' ? initial() : initial, () => {}]
          },
          useRef: current => ({ current }),
          useLayoutEffect() {},
          useEffect() {},
          useMemo: make => make(),
        }
      }
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        return {
          MarkdownText: props => ({ type: 'markdown', props, children: [] }),
          writeClipboard: async (val) => { copyCalls.push(val); return shouldSucceed },
        }
      }
      throw new Error(`no module ${name}`)
    },
    queueMicrotask,
  })
  const b2 = copyMod.exports.Bubbles({ texts: ['Copy me'], roster, selfId: 'b', actions, sessionId: 'b' })
  const bubble2 = findAll(b2, n => n.type?.name === 'Bubble')[0]
  const tools2 = findAll(bubble2.type(bubble2.props), n => n.type?.name === 'MessageTools')[0]
  toolsMode = true
  sIdx = 0
  const renderedTools = tools2.type(tools2.props)
  const copyBtn = findAll(renderedTools, n => n.type === 'button' && n.props.role === 'menuitem' && n.children.includes('Copy'))[0]
  assert.ok(copyBtn, 'Copy menu item renders')
  shouldSucceed = true
  copyBtn.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(copyCalls, ['Copy me'])
  assert.equal(reported.length, 0)
  shouldSucceed = false
  copyBtn.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reported.length, 1)
  assert.equal(reported[0][1], 'copy')
})
