import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource, heldCardKey } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

// Keep each component's hook state across renders. The tool-cell tests cover where
// these components appear; this harness checks their edits and async lifetimes.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { useDockHold } from './src/client/card-hold.js'",
      "export { PendingQuestion } from './src/client/questions.js'",
      "export { SecretCard } from './src/client/secret-card.js'",
      "export { PendingView, AnsweredReply } from './src/client/widget-cell.js'",
      "export { AnsweredCell } from './src/client/questions.js'",
      "export { HandoffCall, HandoffDock, PendingHandoff, SettledHandoff } from './src/client/handoff-card.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useId: () => slot(() => ({ id: 'card-id' })).id,
  useEffect: effect, useLayoutEffect: effect,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const keys = new Set()
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    assert.ok(name === 'react' || name === '@deepseek-ai/dsh-client-ui-primitives')
    return name === 'react' ? react : { MarkdownText: ({ text }) => text }
  },
  document: {
    activeElement: null, querySelector: () => null,
    addEventListener: (type, listener) => { if (type === 'keydown') keys.add(listener) },
    removeEventListener: (type, listener) => { if (type === 'keydown') keys.delete(listener) },
  },
  HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, HTMLElement: class {},
  URL,
})
const { useDockHold, PendingQuestion, SecretCard, PendingView, AnsweredReply, AnsweredCell, HandoffCall, HandoffDock, PendingHandoff, SettledHandoff } = module.exports
const mount = (Component, props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = Component(next)
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
    unmount() { for (const cell of instance.slots) cell.stop?.() },
  }
  return instance
}
const find = (node, check) => {
  if (Array.isArray(node)) return node.map(child => find(child, check)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return check(node) ? node : find(node.props.children, check)
}
const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props.children, check)]
}
const options = node => all(node, child => child.type === 'button' && child.props.className === 'bt-q-opt')
const field = node => find(node, child => child.type === 'textarea')
const childOf = node => node.props.children[0]
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const lease = () => {
  const source = createSource({})
  const actions = teamActions({ heldCards: source })
  const count = (sessionId, kind, id) => source.getSnapshot()[sessionId]?.[heldCardKey(kind, id)] ?? 0
  return { source, actions, count }
}
const Hold = props => useDockHold(props.sessionId, props.kind, props.id, props.actions, props.inline)
const question = { id: 'question', question: 'Which draft?', options: ['Short', 'Detailed'], allowCustom: true, multiSelect: true }

// Multiple slot instances may coexist briefly during a render. One cleanup must
// not release another instance's ownership of that same request.
test('dock ownership counts each instance once and releases only its own request', () => {
  const { actions, count, source } = lease()
  const props = { actions, sessionId: 'chief', kind: 'question', id: 'request' }
  const first = mount(Hold, props)
  const second = mount(Hold, props)
  const takeFirst = first.render()
  takeFirst()
  takeFirst()
  second.render()()
  assert.equal(count('chief', 'question', 'request'), 2)
  first.unmount()
  assert.equal(count('chief', 'question', 'request'), 1)
  second.unmount()
  assert.equal(count('chief', 'question', 'request'), 0)
  const inline = mount(Hold, { ...props, inline: true })
  inline.render()()
  inline.unmount()
  assert.deepEqual(source.getSnapshot(), { chief: {} })
})

test('changing session, request or kind releases the old identity before a fresh interaction', () => {
  const { actions, count, source } = lease()
  const instance = mount(Hold, { actions, sessionId: 'chief', kind: 'question', id: 'same' })
  instance.render()()
  const take = instance.render({ actions, sessionId: 'other', kind: 'secret', id: 'same' })
  assert.equal(count('chief', 'question', 'same'), 0)
  assert.equal(count('other', 'secret', 'same'), 0)
  take()
  assert.deepEqual(source.getSnapshot(), { chief: {}, other: { '["secret","same"]': 1 } })
  instance.render({ actions, sessionId: 'other', kind: 'secret', id: 'next' })()
  assert.equal(count('other', 'secret', 'same'), 0)
  assert.equal(count('other', 'secret', 'next'), 1)
  instance.unmount()
  assert.deepEqual(source.getSnapshot(), { chief: {}, other: {} })
})

test('a question keeps its custom answer and selection while submitting, after failure, and on retry', async () => {
  const { actions, count } = lease()
  const wait = deferred()
  const sent = []
  let result = wait.promise
  actions.answerQuestion = (...args) => { sent.push(plain(args)); return result }
  const pending = mount(PendingQuestion, { actions, sessionId: 'chief', question, inline: false })
  const initial = childOf(pending.render())
  const view = mount(initial.type, initial.props)
  let form = view.render()
  field(form).props.onChange({ target: { value: 'Custom draft' } })
  options(form)[1].props.onClick()
  form = view.render()
  form.props.onSubmit({ preventDefault() {} })
  form.props.onSubmit({ preventDefault() {} })
  const submitting = childOf(pending.render())
  assert.equal(submitting.type, initial.type)
  assert.equal(submitting.props.key, initial.props.key)
  form = view.render(submitting.props)
  assert.equal(field(form).props.value, 'Custom draft')
  assert.equal(field(form).props.readOnly, true)
  assert.ok(options(form).every(option => option.props.disabled))
  assert.equal(count('chief', 'question', question.id), 1)
  await tick()
  assert.deepEqual(sent, [['chief', 'question', { selected: ['Detailed'], custom: 'Custom draft' }]])
  wait.reject(new Error('Temporary failure'))
  await tick()
  form = view.render(childOf(pending.render()).props)
  assert.equal(field(form).props.value, 'Custom draft')
  assert.equal(field(form).props.readOnly, false)
  assert.deepEqual(options(form).map(option => option.props['aria-pressed']), [false, true])
  result = Promise.resolve()
  form.props.onSubmit({ preventDefault() {} })
  await tick()
  assert.equal(sent.length, 2)
  assert.equal(pending.render(), null)
  view.unmount()
  pending.unmount()
  assert.equal(count('chief', 'question', question.id), 0)
})

test('keyboard selection owns a dock card and busy questions cannot submit or dismiss twice', async () => {
  const { actions, count } = lease()
  const wait = deferred()
  const sent = []
  actions.answerQuestion = (...args) => { sent.push(args); return wait.promise }
  actions.dismissQuestion = () => { sent.push('dismiss'); return wait.promise }
  const pending = mount(PendingQuestion, { actions, sessionId: 'chief', question: { ...question, multiSelect: false }, inline: false })
  const initial = childOf(pending.render())
  const view = mount(initial.type, initial.props)
  view.render()
  const key = () => ({ key: 'a', target: null, preventDefault() { this.defaultPrevented = true } })
  for (const listener of keys) listener(key())
  for (const listener of keys) listener(key())
  initial.props.onDismiss()
  assert.equal(count('chief', 'question', question.id), 1)
  view.render(childOf(pending.render()).props)
  assert.equal(keys.size, 0)
  await tick()
  assert.equal(sent.length, 1)
  wait.resolve()
  await tick()
  view.unmount()
  pending.unmount()
  assert.equal(count('chief', 'question', question.id), 0)
})

test('secret edits stay local and an in-flight save preserves value and scope for a retry', async () => {
  const { actions, count, source } = lease()
  const wait = deferred()
  const sent = []
  let result = wait.promise
  actions.secretSet = payload => { sent.push(payload); return result }
  const request = { id: 'request', kind: 'fill', name: 'DEMO_TOKEN' }
  const card = mount(SecretCard, { actions, sessionId: 'chief', bot: { id: 'chief', name: 'Chief' }, request, roster: { secrets: [] } })
  let out = card.render()
  find(out, node => node.type.name === 'MaskedInput').props.onChange('synthetic-test-value')
  find(out, node => node.type.name === 'ScopeSwitch').props.onChange('bot')
  out = card.render()
  const save = find(out, node => node.props.className === 'bt-q-submit').props.onClick
  save()
  save()
  out = card.render()
  assert.equal(find(out, node => node.props.className === 'bt-q-submit').props.disabled, true)
  assert.equal(find(out, node => node.type.name === 'MaskedInput').props.value, 'synthetic-test-value')
  assert.deepEqual(source.getSnapshot(), { chief: { '["secret","request"]': 1 } })
  await tick()
  assert.equal(sent.length, 1)
  wait.reject(new Error('Save failed'))
  await tick()
  out = card.render()
  assert.equal(find(out, node => node.type.name === 'MaskedInput').props.value, 'synthetic-test-value')
  assert.equal(find(out, node => node.type.name === 'ScopeSwitch').props.value, 'bot')
  assert.equal(find(out, node => node.props.className === 'bt-q-submit').props.disabled, false)
  result = Promise.resolve()
  find(out, node => node.props.className === 'bt-q-submit').props.onClick()
  await tick()
  assert.deepEqual(plain(sent), [
    { requestId: 'request', value: 'synthetic-test-value', scope: 'bot' },
    { requestId: 'request', value: 'synthetic-test-value', scope: 'bot' },
  ])
  assert.equal(find(card.render(), node => node.type.name === 'MaskedInput').props.value, '')
  card.unmount()
  assert.equal(count('chief', 'secret', 'request'), 0)
})

const pendingView = () => ({ id: 'view-1', callId: 'call-1', title: 'Pick', view: { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] } })

test('a pending view hides but stays mounted while its request is in flight', async () => {
  const { actions, count } = lease()
  const wait = deferred()
  const sent = []
  let result = wait.promise
  actions.answerView = (...args) => { sent.push(plain(args)); return result }
  actions.dismissView = () => { sent.push('dismiss'); return result }
  const pending = mount(PendingView, { actions, sessionId: 'chief', view: pendingView(), inline: false })
  const card = pending.render()
  assert.equal(card.props.style, undefined)
  // A second submit while the first is in flight is swallowed.
  childOf(card).props.onSubmit('pick', { selected: ['A'] })
  childOf(card).props.onSubmit('pick', { selected: ['B'] })
  const flying = pending.render()
  assert.deepEqual(plain(flying.props.style), { display: 'none' })
  assert.equal(childOf(flying).props.busy, true)
  assert.equal(count('chief', 'view', 'view-1'), 1)
  await tick()
  assert.deepEqual(sent, [['chief', 'view-1', 'pick', { selected: ['A'] }]])
  wait.reject(new Error('Temporary failure'))
  await tick()
  // The rejection brings the card back, still holding what the user picked.
  const back = pending.render()
  assert.equal(back.props.style, undefined)
  assert.equal(childOf(back).props.busy, false)
  // A failed dismiss brings the card back too: the server still waits on it.
  const dismiss = deferred()
  result = dismiss.promise
  childOf(pending.render()).props.onDismiss()
  assert.deepEqual(plain(pending.render().props.style), { display: 'none' })
  await tick()
  assert.deepEqual(sent.at(-1), 'dismiss')
  dismiss.reject(new Error('flush failed'))
  await tick()
  assert.equal(pending.render().props.style, undefined)
  result = Promise.resolve()
  childOf(pending.render()).props.onSubmit('pick', { selected: ['B'] })
  await tick()
  assert.equal(sent.at(-1)[2], 'pick')
  assert.deepEqual(plain(pending.render().props.style), { display: 'none' })
  pending.unmount()
  assert.equal(count('chief', 'view', 'view-1'), 0)
})

test('letter keys answer a card only while it is the sole open card with keys', async () => {
  const { actions } = lease()
  const answers = []
  actions.answerQuestion = (...args) => { answers.push(plain(args)); return Promise.resolve() }
  actions.dismissQuestion = () => Promise.resolve()
  const ask = id => ({ ...question, id, multiSelect: false })
  const first = mount(PendingQuestion, { actions, sessionId: 'chief', question: ask('first'), inline: false })
  const second = mount(PendingQuestion, { actions, sessionId: 'chief', question: ask('second'), inline: false })
  const firstCard = childOf(first.render())
  const secondCard = childOf(second.render())
  const firstView = mount(firstCard.type, firstCard.props)
  const secondView = mount(secondCard.type, secondCard.props)
  firstView.render()
  // A lone card advertises its keys: both options and the own-answer row.
  assert.equal(all(firstView.render(), node => node.props.className === 'bt-key').length, 3)
  secondView.render()
  assert.equal(keys.size, 2)
  // With two cards open neither shows letters for keys it will not answer.
  assert.equal(all(firstView.render(), node => node.props.className === 'bt-key').length, 0)
  const both = secondView.render()
  assert.equal(all(both, node => node.props.className === 'bt-key').length, 0)
  assert.ok(options(both).every(option => option.props['aria-keyshortcuts'] === undefined))
  assert.equal(field(both).props['aria-keyshortcuts'], undefined)
  const key = () => ({ key: 'a', target: null, preventDefault() { this.defaultPrevented = true } })
  const shared = key()
  for (const listener of [...keys]) listener(shared)
  // Two open cards both stay silent rather than the first listener stealing the key.
  assert.equal(shared.defaultPrevented, undefined)
  assert.equal(answers.length, 0)
  firstView.unmount()
  assert.equal(keys.size, 1)
  // Alone again, the surviving card brings its letters back.
  const alone = secondView.render()
  assert.equal(all(alone, node => node.props.className === 'bt-key').length, 3)
  assert.ok(options(alone).every(option => option.props['aria-keyshortcuts'] !== undefined))
  assert.equal(field(alone).props['aria-keyshortcuts'], 'c')
  for (const listener of [...keys]) listener(key())
  await tick()
  assert.deepEqual(answers, [['chief', 'second', { selected: ['Short'], custom: '' }]])
  secondView.unmount()
  first.unmount()
  second.unmount()
  assert.equal(keys.size, 0)
})

const handoff = (extra = {}) => ({ by: 'bot', reason: 'login', note: 'Sign in to the shop.', callId: 'call-1', ...extra })
const browser = {
  useBrowserTabs: pick => pick({ b2: { active: 't1' } }),
  useBrowserPages: pick => pick({ t1: { url: 'https://www.shop.example.com/login', title: 'Shop sign-in' } }),
}
const buttons = node => all(node, child => child.type === 'button')
const labelOf = button => button.props.children[0]
const press = (node, label) => find(node, child => child.type === 'button' && labelOf(child) === label).props.onClick()
const byClass = (node, name) => find(node, child => child.props.className === name)

test('a handoff card names the step and the site, with Skip, Take over and I\'m done in that order', () => {
  const { actions } = lease()
  actions.browserGiveBack = () => Promise.resolve()
  const card = mount(PendingHandoff, { actions, sessionId: 'b2', bot: { id: 'b2' }, hold: handoff(), hooks: browser, inline: true }).render()
  assert.deepEqual(buttons(card).map(labelOf), ['Skip', 'Take over', "I'm done"])
  assert.deepEqual(buttons(card).map(button => button.props.className), ['bt-q-btn', 'bt-q-btn', 'bt-q-submit'])
  assert.equal(byClass(card, 'bt-q-title').props.children[0], 'Sign-in needed')
  assert.equal(byClass(card, 'bt-q-detail').props.children[0], 'Sign in to the shop.')
  // Only the host: the page's own title stays out of the card.
  assert.equal(byClass(card, 'bt-handoff-site').props.children[1].props.children[0], 'shop.example.com')
  assert.equal(byClass(card, 'bt-handoff-state'), undefined)
  const titles = reason => byClass(mount(PendingHandoff, { actions, sessionId: 'b2', bot: { id: 'b2' }, hold: handoff({ reason, note: '' }), hooks: {}, inline: true }).render(), 'bt-q-title').props.children[0]
  assert.deepEqual(['payment', 'captcha', 'other'].map(titles), ['Payment needed', 'Verification needed', 'Help needed in the browser'])
  const bare = mount(PendingHandoff, { actions, sessionId: 'b2', bot: { id: 'b2' }, hold: handoff({ note: '' }), hooks: {}, inline: true }).render()
  assert.equal(byClass(bare, 'bt-q-detail'), undefined)
  assert.equal(byClass(bare, 'bt-handoff-site'), undefined)
})

test('a handoff card answers once, hides while its answer is on the way, and returns when it fails', async () => {
  const { actions, count } = lease()
  const wait = deferred()
  const sent = []
  const reported = []
  actions.browserGiveBack = (...args) => { sent.push(plain(args)); return wait.promise }
  actions.reportError = (error, where) => reported.push([error.message, where])
  const pending = mount(PendingHandoff, { actions, sessionId: 'b2', bot: { id: 'b2' }, hold: handoff(), hooks: browser, inline: false })
  const card = pending.render()
  assert.equal(card.props.style, undefined)
  // A second click while the first is in flight is swallowed.
  press(card, "I'm done")
  press(card, 'Skip')
  assert.deepEqual(plain(pending.render().props.style), { display: 'none' })
  assert.equal(count('b2', 'handoff', 'call-1'), 1)
  await tick()
  assert.deepEqual(sent, [['b2', { callId: 'call-1', outcome: 'done' }]])
  wait.reject(new Error('Network down'))
  await tick()
  // The rejection brings the card back, and says why.
  assert.equal(pending.render().props.style, undefined)
  assert.deepEqual(reported, [['Network down', 'handoff']])
  actions.browserGiveBack = (...args) => { sent.push(plain(args)); return Promise.resolve() }
  press(pending.render(), 'Skip')
  await tick()
  assert.deepEqual(sent.at(-1), ['b2', { callId: 'call-1', outcome: 'skip' }])
  assert.deepEqual(plain(pending.render().props.style), { display: 'none' })
  pending.unmount()
  assert.equal(count('b2', 'handoff', 'call-1'), 0)
})

test('Take over opens the browser and keeps the card, which then shows who has it', async () => {
  const { actions } = lease()
  const calls = []
  actions.browserTakeover = async botId => { calls.push(['takeover', botId]) }
  actions.openBrowser = botId => { calls.push(['open', botId]) }
  actions.browserGiveBack = () => Promise.resolve()
  const pending = mount(PendingHandoff, { actions, sessionId: 'b2', bot: { id: 'b2' }, hold: handoff(), hooks: browser, inline: true })
  press(pending.render(), 'Take over')
  press(pending.render(), 'Take over')
  await tick()
  assert.deepEqual(calls, [['takeover', 'b2'], ['open', 'b2']])
  // The card stays up: only Skip and I'm done close it.
  assert.equal(pending.render().props.style, undefined)
  const taken = pending.render({ ...pending.props, hold: handoff({ by: 'user' }) })
  assert.deepEqual(buttons(taken).map(labelOf), ['Skip', "I'm done"])
  const state = byClass(taken, 'bt-handoff-state')
  assert.equal(state.props.role, 'status')
  assert.equal(state.props.children[1], 'You control this browser')
  // A failed takeover frees the card for another try.
  actions.browserTakeover = async () => { throw new Error('Nope') }
  const reported = []
  actions.reportError = (error, where) => reported.push([error.message, where])
  press(pending.render({ ...pending.props, hold: handoff() }), 'Take over')
  await tick()
  assert.deepEqual(reported, [['Nope', 'handoff']])
  assert.equal(pending.render().props.style, undefined)
  actions.browserTakeover = async botId => { calls.push(['takeover', botId]) }
  press(pending.render(), 'Take over')
  await tick()
  assert.equal(calls.length, 4)
})

test('a handoff call draws its card only while the browser is held for that call', () => {
  const { actions } = lease()
  actions.browserGiveBack = () => Promise.resolve()
  const roster = { byId: { b2: { id: 'b2' } } }
  const draw = (props = {}) => {
    const hooks = { ...browser, useBrowserHolds: pick => pick({ b2: props.hold }) }
    return mount(HandoffCall, { sessionId: 'b2', callId: 'call-1', roster, actions, heldCards: {}, hooks, ...props }).render()
  }
  assert.equal(draw({ hold: handoff() }).type, PendingHandoff)
  assert.equal(draw({ hold: handoff() }).props.inline, true)
  // Answered, another call's hold, no hold, a chat without the Bot, or no answer path: nothing, and no gap.
  for (const gone of [draw({ hold: undefined }), draw({ hold: handoff({ callId: 'call-2' }) }), draw({ hold: handoff(), roster: { byId: {} } }), draw({ hold: handoff(), actions: {} })]) {
    assert.equal(gone.type, 'span')
    assert.equal(gone.props.hidden, true)
  }
  // The dock draws it while the user is working in it.
  assert.equal(draw({ hold: handoff(), heldCards: { [JSON.stringify(['handoff', 'call-1'])]: 1 } }), null)
})

test('the dock draws a handoff the transcript does not, and keeps one the user started on', () => {
  const { actions } = lease()
  actions.browserGiveBack = () => Promise.resolve()
  const dock = ({ drawn = 0, held = 0, ...rest } = {}) => mount(HandoffDock, {
    sessionId: 'b2',
    useRoster: pick => pick({ byId: { b2: { id: 'b2' } } }),
    useCards: pick => pick({ b2: { 'call-1': drawn } }),
    useHeldCards: pick => pick({ b2: { [JSON.stringify(['handoff', 'call-1'])]: held } }),
    useBrowserHolds: pick => pick({ b2: 'hold' in rest ? rest.hold : handoff() }),
    ...browser,
    actions,
    ...rest,
  }).render()
  const card = dock()
  assert.equal(card.type, PendingHandoff)
  assert.equal(card.props.inline, false)
  assert.equal(dock({ drawn: 1 }), null)
  assert.equal(dock({ drawn: 1, held: 1 }).type, PendingHandoff)
  assert.equal(dock({ hold: undefined }), null)
  assert.equal(dock({ hold: { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' } }), null)
  assert.equal(dock({ actions: {} }), null)
})

test('an answered handoff keeps its title and how it ended, and nothing to press', () => {
  const done = SettledHandoff({ handoff: { reason: 'payment', note: 'Pay the invoice.', outcome: 'done' } })
  assert.equal(byClass(done, 'bt-q-title').props.children[0], 'Payment needed')
  assert.ok(byClass(done, 'bt-q-check'))
  assert.equal(byClass(done, 'bt-q-badge'), undefined)
  assert.equal(buttons(done).length, 0)
  const skipped = SettledHandoff({ handoff: { reason: 'login', note: '', outcome: 'skipped' } })
  assert.equal(byClass(skipped, 'bt-q-badge').props.children[0], 'Skipped')
  assert.equal(byClass(skipped, 'bt-q-check'), undefined)
  assert.match(skipped.props.children[0].props.className, /bt-q-dismissed/)
  assert.doesNotMatch(done.props.children[0].props.className, /bt-q-dismissed/)
  const returned = SettledHandoff({ handoff: { reason: 'login', note: '', outcome: 'returned' } })
  assert.equal(byClass(returned, 'bt-q-badge').props.children[0], 'Returned')
  assert.equal(byClass(returned, 'bt-q-check'), undefined)
  assert.doesNotMatch(returned.props.children[0].props.className, /bt-q-dismissed/)
})

test('answered handoff replies route to their settled row in history and live transcripts', () => {
  const fromHistory = AnsweredReply({ node: { data: { handoff: { reason: 'login', note: 'Sign in', outcome: 'returned' } } } })
  assert.equal(fromHistory.type, SettledHandoff)
  assert.deepEqual(plain(fromHistory.props.handoff), { reason: 'login', note: 'Sign in', outcome: 'returned' })

  const fromText = AnsweredReply({ node: { data: { text: JSON.stringify({
    kind: 'answer_to_pending_handoff', callId: 'call-1', reason: 'payment', note: 'Pay', outcome: 'done',
  }) } } })
  assert.equal(fromText.type, SettledHandoff)
  assert.deepEqual(plain(fromText.props.handoff), { reason: 'payment', note: 'Pay', outcome: 'done' })

  for (const node of [
    { data: { handoff: { reason: 7, outcome: 'done' } } },
    { data: { text: JSON.stringify({ kind: 'answer_to_pending_handoff', callId: 'call-1', reason: 7, outcome: 'done' }) } },
  ]) {
    assert.equal(AnsweredReply({ node }).type, AnsweredCell)
  }
})
