import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The tool cells and the card docks, bundled once and rendered with a minimal React:
// components run as plain functions, effects are collected and run on demand.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ToolCell, TriggerCell, callTree } from './src/client/cells.js'",
      "export { QuestionDock } from './src/client/questions.js'",
      "export { SecretDock } from './src/client/secret-card.js'",
      "export { countCards } from './src/client/sources.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const sets = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createElement: h, Fragment,
  useEffect: (effect) => { effects.push(effect) },
  useLayoutEffect: (effect) => { effects.push(effect) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, value => sets.push(value)],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'card-id',
}
const timers = new Set()
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false },
  setTimeout: (fn) => { const timer = { fn }; timers.add(timer); return timer },
  clearTimeout: timer => timers.delete(timer),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ToolCell, TriggerCell, callTree, QuestionDock, SecretDock, countCards } = module.exports

// Runs the effects collected since the last render; returns the cleanups.
const mount = () => {
  const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function')
  effects = []
  return () => { for (const cleanup of cleanups) cleanup() }
}
const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props.children, match)
}
const count = (haystack, needle) => haystack.split(needle).length - 1

const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const chief = { id: 'chief', name: 'Chief', color: 'green' }
const room = { id: 'room', name: 'Ops', members: ['writer', 'chief'], admin: 'chief' }
const team = (over = {}) => ({
  bots: [writer, chief], byId: { writer, chief }, rooms: [room], roomsById: { room }, exchangeTurns: {},
  questions: {}, secretRequests: {}, secrets: [], ...over,
})
const question = (callId, over = {}) => ({ id: 'question', callId, question: 'Which draft?', options: [{ label: 'Short' }], allowCustom: true, ...over })
const request = (callId, over = {}) => ({ id: 'request', callId, sessionId: chief.id, name: 'DEMO_TOKEN', purpose: 'Test card', status: 'pending', kind: 'fill', ...over })

const text$ = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const call = (name, callId, { args = {}, content = '', subCalls = [], running = false, isError = false } = {}) => (running
  ? { phase: 'start', name, callId, argsRaw: JSON.stringify(args), subCalls, turn: 0 }
  : { kind: 'tool-result', name, callId, call: { name, argsRaw: JSON.stringify(args) }, content: text$(content), isError, subCalls })
const program = (subCalls, over = {}) => call('run_code', 'program', { subCalls, ...over })

const props = (root, { sessionId = chief.id, roster = team(), actions = {}, turn = 1 } = {}) => ({
  node: { key: 'node', data: { root }, location: { turn: { turn } } }, sessionId,
  useRoster: select => select(roster), useUi: select => select({ reactions: {}, visits: {} }), actions,
})
const show = (root, options) => {
  const out = expand(ToolCell(props(root, options)))
  effects = []
  return out
}
const shown = (root, options) => text(show(root, options))

// One finished call of every kind ToolCell draws, and what it shows.
const BRANCHES = [
  ['message_bot', { args: { to: 'Writer' } }, /Messaged.*Writer/],
  ['stop_bot', { args: { bot: 'Writer' } }, /Stopped.*Writer/],
  ['create_bot', { args: { name: 'Writer' } }, /Created.*Writer/],
  ['update_bot', { args: { name: 'Writer' } }, /Updated.*Writer/],
  ['group_relay', { content: { replies: [{ botId: 'writer', text: 'Relay reply.' }] } }, /Writer.*Relay reply\./],
  ['create_group', { content: 'Created group "Ops" with Writer.' }, /Created group.*Ops/],
  ['update_group', { content: 'Updated "Ops".' }, /Updated group.*Ops/],
  ['delete_group', { content: 'Deleted "Ops".' }, /Deleted group/],
  ['post_to_group', { content: 'Posted in "Ops".' }, /Posted in.*Ops/],
  ['ask_user', {}, /Which draft\?.*Short/],
  ['request_secret', { args: { name: 'DEMO_TOKEN' } }, /Chief needs a key.*DEMO_TOKEN/],
  ['ask_user_question', { args: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] }, content: { answers: [{ selected: ['Yes'] }] } }, /Ship it\?.*Yes/],
  ['read_group_chat', { args: { group: 'Ops' } }, /Read.*Ops/],
  ['remember', { args: { scope: 'Chief' }, content: 'Saved to Chief memory.' }, /Memory updated/],
  ['forget', { args: { scope: 'Chief' }, content: 'Removed from Chief memory.' }, /Memory updated/],
]
const rosterFor = callId => team({ questions: { chief: question(callId) }, secretRequests: { chief: [request(callId)] } })

test('every call ToolCell draws shows the same nested in a PTC program as on its own', () => {
  assert.equal(BRANCHES.length, 15)
  for (const [name, options, expected] of BRANCHES) {
    const native = shown(call(name, 'direct', options), { roster: rosterFor('direct') })
    assert.match(native, expected, `${name} on its own`)
    const nested = shown(program([call(name, 'program:ptc:1', options)]), { roster: rosterFor('program:ptc:1') })
    assert.equal(nested, native, `${name} under run_code`)
    const deep = shown(program([call('run_code', 'program:ptc:1', { subCalls: [call(name, 'program:ptc:1:ptc:1', options)] })]), { roster: rosterFor('program:ptc:1:ptc:1') })
    assert.equal(deep, native, `${name} two programs deep`)
  }
})

test('a program draws every known sub-call in dispatch order and each call once', () => {
  const relay = call('group_relay', 'program:ptc:2', { content: { replies: [{ botId: 'writer', text: 'Group reply.' }] } })
  const message = call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })
  const secret = call('request_secret', 'program:ptc:3', { args: { name: 'DEMO_TOKEN' } })
  const root = program([message, call('run_code', 'program:ptc:4', { subCalls: [relay, secret, message] }), relay, call('bash', 'program:ptc:5')])
  assert.deepEqual(JSON.parse(JSON.stringify(callTree(root).map(entry => entry.callId))), ['program', 'program:ptc:1', 'program:ptc:4', 'program:ptc:2', 'program:ptc:3', 'program:ptc:5'])
  const out = shown(root, { roster: team({ secretRequests: { chief: [request('program:ptc:3')] } }) })
  assert.match(out, /Messaged.*Writer.*Group reply\..*Chief needs a key/)
  assert.equal(count(out, 'Messaged'), 1)
  assert.equal(count(out, 'Group reply.'), 1)
  assert.equal(count(out, 'needs a key'), 1)
})

test('nested group relays keep their own replies in order, each once', () => {
  const first = call('group_relay', 'program:ptc:1:ptc:1', { content: { replies: [{ botId: 'writer', text: 'First reply.' }] } })
  const second = call('group_relay', 'program:ptc:1:ptc:2', { content: { replies: [{ botId: 'writer', text: 'Second reply.' }] } })
  const out = shown(program([call('run_code', 'program:ptc:1', { subCalls: [first, second] }), first]), { sessionId: 'room' })
  assert.match(out, /First reply\..*Second reply\./)
  assert.equal(count(out, 'First reply.'), 1)
})

test('cards and replies still show when the program\'s own call head left the loaded history', () => {
  const roster = team({ questions: { chief: question('program:ptc:3') }, secretRequests: { chief: [request('program:ptc:1')] } })
  const relay = call('group_relay', 'program:ptc:2', { content: { replies: [{ botId: 'writer', text: 'Group reply.' }] } })
  const root = { ...program([call('request_secret', 'program:ptc:1', { args: { name: 'DEMO_TOKEN' } }), relay, call('ask_user', 'program:ptc:3')]), name: '', call: null }
  assert.match(shown(root, { roster }), /Chief needs a key.*Group reply\..*Which draft\?/)
})

test('each sub-call shows its own state, not its program\'s', () => {
  const created = call('create_bot', 'program:ptc:1', { args: { name: 'Writer' } })
  assert.match(shown(program([created], { running: true })), /Created.*Writer/)
  assert.equal(shown(program([{ ...call('create_bot', 'program:ptc:1', { args: { name: 'Writer' }, running: true }) }])), '')
  const failed = call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, isError: true })
  assert.match(shown(program([failed])), /Couldn't message Writer/)
  assert.match(shown(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })], { isError: true })), /^Messaged/)
  const refused = call('post_to_group', 'program:ptc:1', { content: 'No group is called "Nope".', isError: true })
  const posted = call('post_to_group', 'program:ptc:2', { content: 'Posted in "Ops".' })
  assert.match(shown(program([refused, posted])), /Couldn't post in the group.*Posted in.*Ops/)
})

test('a program with no known sub-call draws nothing, as before', () => {
  assert.equal(ToolCell(props(program([]))), null)
  assert.equal(ToolCell(props(program([call('bash', 'program:ptc:1'), call('read_file', 'program:ptc:2')]))), null)
  assert.equal(ToolCell(props(call('bash', 'direct'))), null)
  effects = []
})

test('a hidden Bot-to-Bot turn draws none of its sub-calls', () => {
  const roster = team({ exchangeTurns: { chief: [1] }, secretRequests: { chief: [request('program:ptc:1')] } })
  const root = program([call('request_secret', 'program:ptc:1', { args: { name: 'DEMO_TOKEN' } }), call('message_bot', 'program:ptc:2', { args: { to: 'Writer' } })])
  assert.equal(shown(root, { roster }), '')
  assert.match(shown(root, { roster, turn: 2 }), /Chief needs a key.*Messaged/)
})

test('a message line opens the exchange of the chat\'s Bot, from any part', () => {
  const opened = []
  const out = show(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })]), { actions: { openExchange: (...ids) => opened.push(ids) } })
  find(out, node => node.type === 'button').props.onClick()
  const current = { ...chief, sessionId: 'chief-2', parts: ['chief', 'chief-2'] }
  const roster = team({ bots: [writer, current], byId: { writer, chief: current, 'chief-2': current } })
  const later = show(call('message_bot', 'direct', { args: { to: 'Writer' } }), { sessionId: 'chief-2', roster, actions: { openExchange: (...ids) => opened.push(ids) } })
  find(later, node => node.type === 'button').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['chief', 'writer'], ['chief', 'writer']])
})

// The activity row reads one note per chat node.
const notes = (root, options = {}) => {
  const log = []
  ToolCell(props(root, { ...options, actions: { noteLive: (sessionId, id, entry) => log.push({ sessionId, id, entry }) } }))
  const unmount = mount()
  unmount()
  return JSON.parse(JSON.stringify(log))
}

test('the live note follows the running sub-call of a program', () => {
  const asking = notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, running: true })], { running: true }))
  assert.deepEqual(asking, [
    { sessionId: 'chief', id: 'tool:program', entry: { label: 'Asking Writer', state: 'sending' } },
    { sessionId: 'chief', id: 'tool:program', entry: null },
  ])
  const relaying = notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } }), call('group_relay', 'program:ptc:2', { running: true })], { running: true }))
  assert.equal(relaying[0].entry.relay, true)
  const shell = notes(program([call('bash', 'program:ptc:1', { running: true })], { running: true }))
  assert.equal(shell[0].entry.label, 'Running shell commands')
  const between = notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' } })], { running: true }))
  assert.equal(between[0].entry.label, null)
  assert.deepEqual(notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, running: true })])), [])
  const roster = team({ exchangeTurns: { chief: [1] } })
  assert.deepEqual(notes(program([call('message_bot', 'program:ptc:1', { args: { to: 'Writer' }, running: true })], { running: true }), { roster }), [])
  assert.equal(notes(call('message_bot', 'direct', { args: { to: 'Writer' }, running: true }))[0].entry.label, 'Asking Writer')
})

// A minimal cards store, as index.js keeps it.
const cardStore = () => {
  const store = { state: {} }
  store.noteCards = (sessionId, ids, delta) => { store.state = countCards(store.state, sessionId, ids, delta) }
  return store
}
const draw = (root, store, options = {}) => {
  effects = []
  ToolCell(props(root, { ...options, actions: { noteCards: store.noteCards } }))
  const unmount = mount()
  return { out: show(root, options), unmount }
}

test('a cell tells the docks which card calls it draws, until it unmounts', () => {
  const store = cardStore()
  const root = program([call('ask_user', 'program:ptc:1'), call('request_secret', 'program:ptc:2'), call('message_bot', 'program:ptc:3')])
  ToolCell(props(root, { actions: { noteCards: store.noteCards } }))
  const unmount = mount()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), { chief: { 'program:ptc:1': 1, 'program:ptc:2': 1 } })
  ToolCell(props(root, { actions: { noteCards: store.noteCards } }))
  const second = mount()
  assert.equal(store.state.chief['program:ptc:1'], 2)
  second()
  unmount()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), { chief: {} })
  ToolCell(props(root, { actions: { noteCards: store.noteCards }, roster: team({ exchangeTurns: { chief: [1] } }) }))
  mount()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), { chief: {} })
})

const dockProps = (store, roster, { sessionId = chief.id, openState = 'open', actions = {} } = {}) => ({
  sessionId, actions,
  useRoster: select => select(roster),
  useCards: select => select(store.state),
  useSession: select => select({ openState }),
})
const docks = (store, roster, options) => {
  const out = text(expand([QuestionDock(dockProps(store, roster, options)), SecretDock(dockProps(store, roster, options))]))
  effects = []
  return out
}

test('a card whose call is not drawn waits in the dock; a drawn one shows only at its call', () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('program:ptc:1') }, secretRequests: { chief: [request('program:ptc:2')] } })
  const root = program([call('ask_user', 'program:ptc:1'), call('request_secret', 'program:ptc:2', { args: { name: 'DEMO_TOKEN' } })])
  assert.match(docks(store, roster), /Which draft\?.*Chief needs a key/)
  const { out, unmount } = draw(root, store, { roster })
  const inline = text(out)
  assert.equal(docks(store, roster), '')
  assert.equal(count(inline, 'Which draft?'), 1)
  assert.equal(count(inline, 'needs a key'), 1)
  unmount()
  assert.match(docks(store, roster), /Which draft\?.*Chief needs a key/)
})

test('the docks hold a card back while the history loads, and keep cards without a call', () => {
  const store = cardStore()
  const roster = team({ questions: { chief: question('program:ptc:1') }, secretRequests: { chief: [request('program:ptc:2')] } })
  assert.equal(docks(store, roster, { openState: 'loading' }), '')
  assert.equal(docks(store, roster, { openState: 'cold' }), '')
  assert.match(docks(store, roster, { openState: 'error' }), /Which draft\?.*Chief needs a key/)
  const free = team({ questions: { chief: question(undefined) }, secretRequests: { chief: [request(undefined)] } })
  assert.match(docks(store, free, { openState: 'loading' }), /Which draft\?.*Chief needs a key/)
})

test('a card from an earlier part waits in the dock even when a call here has the same id', () => {
  const store = cardStore()
  const current = { ...chief, sessionId: 'chief-2', parts: ['chief', 'chief-2'] }
  const roster = team({ bots: [writer, current], byId: { writer, chief: current, 'chief-2': current }, secretRequests: { chief: [request('call-1', { sessionId: 'chief' })] } })
  const { out, unmount } = draw(call('request_secret', 'call-1', { args: { name: 'DEMO_TOKEN' } }), store, { roster, sessionId: 'chief-2' })
  assert.doesNotMatch(text(out), /needs a key/)
  assert.match(docks(store, roster, { sessionId: 'chief-2' }), /Chief needs a key/)
  unmount()
})

test('a secret in a hidden turn shows in the dock instead of nowhere', () => {
  const store = cardStore()
  const roster = team({ exchangeTurns: { chief: [1] }, secretRequests: { chief: [request('program:ptc:1')] } })
  const { out, unmount } = draw(program([call('request_secret', 'program:ptc:1', { args: { name: 'DEMO_TOKEN' } })]), store, { roster })
  assert.equal(text(out), '')
  assert.match(docks(store, roster), /Chief needs a key/)
  unmount()
})

// #38: a PTC group round's replies vanished once the round ended.
test('a PTC group relay shows its replies from the sub-call, live and after reload', async () => {
  const replies = [{ botId: 'writer', text: 'Hello from Writer.' }, { botId: 'chief', text: 'Hello from Chief.' }]
  const finished = program([call('group_relay', 'call-1-1:ptc:1', { content: { replies } })])
  const reloaded = shown(finished, { sessionId: 'room' })
  assert.match(reloaded, /Writer.*Hello from Writer\..*Chief.*Admin.*Hello from Chief\./)
  const headless = { ...finished, name: '', call: null }
  assert.equal(shown(headless, { sessionId: 'room' }), reloaded)

  const progress = [{ callId: 'other', replies: [{ botId: 'chief', text: 'Not this round.' }] }, { callId: 'call-1-1:ptc:1', replies: replies.slice(0, 1), speaking: 'chief' }]
  const asked = []
  const actions = { roomProgress: async (id) => { asked.push(id); return progress } }
  const running = program([call('group_relay', 'call-1-1:ptc:1', { running: true })], { running: true })
  const relay = find(ToolCell(props(running, { sessionId: 'room', actions })), node => node.type?.name === 'GroupReplies')
  effects = []
  sets.length = 0
  relay.type(relay.props)
  const stop = mount()
  await new Promise(resolve => setImmediate(resolve))
  stop()
  timers.clear()
  assert.deepEqual(asked, ['room'])
  assert.deepEqual(JSON.parse(JSON.stringify(sets)), [{ replies: replies.slice(0, 1), speaking: 'chief' }])
})

// #105: the secret and question cards of a PTC program showed nowhere.
test('PTC secret and question cards show at their sub-calls and act on their own requests', async () => {
  const roster = team({ questions: { chief: question('call-1-2:ptc:1') }, secretRequests: { chief: [request('call-2-1:ptc:1')] } })
  const answers = []
  const canceled = []
  const actions = { answerQuestion: async (...args) => answers.push(args), secretCancel: async id => canceled.push(id) }
  const asking = show(program([call('ask_user', 'call-1-2:ptc:1')]), { roster, actions })
  assert.match(text(asking), /Which draft\?/)
  find(asking, node => node.type === 'button' && node.props.className === 'bt-q-opt').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [['chief', 'question', { selected: ['Short'], custom: '' }]])

  const secret = show(program([call('request_secret', 'call-2-1:ptc:1', { args: { name: 'DEMO_TOKEN' }, running: true })], { running: true }), { roster, actions })
  assert.match(text(secret), /Chief needs a key/)
  await find(secret, node => node.props['aria-label'] === 'Cancel the request').props.onClick()
  assert.deepEqual(canceled, ['request'])

  const settled = team({ secretRequests: { chief: [request('call-2-1:ptc:1', { status: 'canceled' })] } })
  const after = shown(program([call('request_secret', 'call-2-1:ptc:1', { args: { name: 'DEMO_TOKEN' } })]), { roster: settled })
  assert.match(after, /Chief asked for DEMO_TOKEN.*Canceled/)
  assert.doesNotMatch(after, /Paste or type the key/)
  assert.doesNotMatch(shown(program([call('ask_user', 'call-0-1:ptc:1')]), { roster }), /Which draft\?/)
  assert.equal(shown(program([call('ask_user', 'call-1-2:ptc:1')]), { roster: team() }), '')
})

// #133: a DSH goal round showed its raw <goal_round> prompt as an event line.
test('a goal round draws nothing, while another unknown trigger keeps its event line', () => {
  const trigger = source => expand(TriggerCell({
    node: { key: 'node', data: { source, turn: 2, content: text$('<goal_round>Keep going</goal_round>') }, location: { turn: { turn: 2 } } },
    sessionId: 'room',
    useRoster: select => select(team()),
    useSessions: select => select({ byId: {} }),
    useTurnClock: select => select({}),
    useUi: select => select({ visits: {} }),
    actions: {},
  }))
  assert.equal(trigger({ kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 }), null)
  assert.match(text(trigger({ kind: 'webhook' })), /<goal_round>Keep going/)
})
