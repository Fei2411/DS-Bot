import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createQuestionDrafts, mergeRescuedDraft, readRescuedForChat, blockingQuestionId } from '../src/client/question-draft.js'
import { indexRoster } from '../src/client/sources.js'
import { STORAGE } from '../src/client/storage.js'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const memoryStorage = () => {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
  }
}

const makeRoster = ({ questions = {}, bots, rooms = [] } = {}) => indexRoster({
  revision: 1,
  bots: bots ?? [
    { id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] },
    { id: 'bee', name: 'Bee', sessionId: 'bee-2', parts: ['bee', 'bee-2'] },
  ],
  rooms,
  agents: [],
  sections: [],
  questions,
  prefs: {},
})

const bundle = await build({
  stdin: {
    contents: [
      "export { DraftKeeper } from './src/client/composer.js'",
      "export { PendingQuestion, QuestionCard, QuestionDock, AskUserCell } from './src/client/questions.js'",
      "export { createQuestionDrafts, mergeRescuedDraft } from './src/client/question-draft.js'",
      "export { keepDraft, takeDraft, forgetKeptFiles } from './src/client/draft-keep.js'",
      "export { createSource, indexRoster } from './src/client/sources.js'",
      "export { teamActions } from './src/client/team-actions.js'",
    ].join('\n'),
    resolveDir: PLUGIN_DIR,
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
})

function loadHarness(localStorage = memoryStorage()) {
  let current
  const slot = (make) => {
    const index = current.index++
    return current.slots[index] ??= make()
  }
  const depsChanged = (prev, next) => prev === undefined || next === undefined || prev.length !== next.length || next.some((v, i) => !Object.is(v, prev[i]))
  const effect = (make, deps) => {
    const cell = slot(() => ({}))
    if (cell.deps === undefined || depsChanged(cell.deps, deps)) {
      current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
    }
  }
  const react = {
    Fragment: 'fragment',
    createContext: value => ({ _current: value, Provider: ({ children }) => children }),
    useContext: ctx => ctx._current,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (initial) => {
      const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    useRef: initial => slot(() => ({ current: initial })),
    useId: () => slot(() => ({ id: 'q-id' })).id,
    useMemo: make => make(),
    useCallback: fn => fn,
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
  }
  const mod = { exports: {} }
  const warnings = []
  runInNewContext(bundle.outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    localStorage,
    console: { warn: (...args) => warnings.push(args) },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLElement: class {},
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  const mount = (Component, props) => {
    const instance = {
      slots: [],
      effects: [],
      props,
      render(next = instance.props) {
        instance.props = next
        instance.index = 0
        current = instance
        const out = Component(next)
        current = undefined
        for (const run of instance.effects.splice(0)) run()
        return out
      },
      unmount() {
        for (const cell of instance.slots) cell.stop?.()
      },
    }
    return instance
  }
  return { ...mod.exports, mount, warnings, localStorage }
}

const find = (node, check) => {
  if (Array.isArray(node)) return node.map(child => find(child, check)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return check(node) ? node : find(node.props?.children, check)
}
const childOf = node => node.props.children[0]
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// -------------------------------------------------------------------------
// 1. Pure merge & deduplication rules

test('mergeRescuedDraft preserves existing draft, separates with blank line, and avoids duplicate appends', () => {
  assert.equal(mergeRescuedDraft('', 'Use PostgreSQL'), 'Use PostgreSQL')
  assert.equal(mergeRescuedDraft('   \n  ', '  Use PostgreSQL  '), 'Use PostgreSQL')
  assert.equal(mergeRescuedDraft('Keep this draft', '   '), 'Keep this draft')
  assert.equal(mergeRescuedDraft('Keep this draft', 'Use PostgreSQL'), 'Keep this draft\n\nUse PostgreSQL')
  assert.equal(mergeRescuedDraft('Keep this draft\n\n', 'Use PostgreSQL'), 'Keep this draft\n\nUse PostgreSQL')
  // Identical trailing block is deduplicated.
  assert.equal(mergeRescuedDraft('Use PostgreSQL', 'Use PostgreSQL'), 'Use PostgreSQL')
  assert.equal(mergeRescuedDraft('Keep this draft\n\nUse PostgreSQL', 'Use PostgreSQL'), 'Keep this draft\n\nUse PostgreSQL')
  assert.equal(mergeRescuedDraft('Keep this draft\nUse PostgreSQL', 'Use PostgreSQL'), 'Keep this draft\nUse PostgreSQL')
  // A substring at the end of a different word is NOT treated as a duplicate.
  assert.equal(mergeRescuedDraft('hello world', 'world'), 'hello world\n\nworld')
  // Multiple chunks append in order and deduplicate repeats.
  assert.equal(mergeRescuedDraft('Intro', ['First', 'Second', 'Second']), 'Intro\n\nFirst\n\nSecond')
})

test('readRescuedForChat combines chatId and sessionId entries without duplication', () => {
  assert.equal(readRescuedForChat({ bee: 'first', 'bee-2': 'second' }, 'bee', 'bee-2'), 'first\n\nsecond')
  assert.equal(readRescuedForChat({ bee: 'same', 'bee-2': 'same' }, 'bee', 'bee-2'), 'same')
  assert.equal(readRescuedForChat({ chief: 'only' }, 'chief', 'chief'), 'only')
  assert.equal(readRescuedForChat(undefined, 'chief', 'chief'), '')
})

// -------------------------------------------------------------------------
// 2. Pure tracker state machine: external interruption vs submit/skip/scroll/rollover

test('external cancellation, timeout, normal message interruption, and new question replacement rescue the draft', () => {
  const storage = memoryStorage()
  const tracker = createQuestionDrafts({ storage })
  const q1 = { id: 'q1', question: 'DB?', options: ['SQLite'], allowCustom: true }
  const q2 = { id: 'q2', question: 'Cache?', options: ['Redis'], allowCustom: true }

  // Active question with custom draft.
  tracker.noteDraft({ kind: 'ask_user', id: 'q1', sessionId: 'chief', chatId: 'chief', text: 'Use Postgres with pgvector' })
  // Still pending -> no rescue.
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: { chief: q1 } })), [])
  assert.deepEqual(tracker.rescued.getSnapshot(), {})

  // Replaced by a new question (q2) -> q1's custom draft is rescued immediately.
  const rescued1 = tracker.reconcileRoster(makeRoster({ questions: { chief: q2 } }))
  assert.equal(rescued1.length, 1)
  assert.equal(rescued1[0].text, 'Use Postgres with pgvector')
  assert.equal(tracker.rescued.getSnapshot().chief, 'Use Postgres with pgvector')
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.rescuedDrafts)), { chief: 'Use Postgres with pgvector' })

  // A second question cancelled externally merges onto the waiting rescued draft without losing the first.
  tracker.noteDraft({ kind: 'ask_user', id: 'q2', sessionId: 'chief', chatId: 'chief', text: 'Valkey instead' })
  const rescued2 = tracker.reconcileRoster(makeRoster({ questions: {} }))
  assert.equal(rescued2.length, 1)
  assert.equal(tracker.rescued.getSnapshot().chief, 'Use Postgres with pgvector\n\nValkey instead')
})

test('explicit submit and explicit skip never rescue, even when roster updates before the request promise resolves', () => {
  const storage = memoryStorage()
  const tracker = createQuestionDrafts({ storage })

  // Submit race: roster drops q1 while answerQuestion is still in flight, then promise resolves.
  tracker.noteDraft({ kind: 'ask_user', id: 'q1', sessionId: 'chief', chatId: 'chief', text: 'Submitted answer' })
  tracker.beginSettle('ask_user', 'q1', 'answered')
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: {} })), [])
  assert.equal(tracker.finishSettle('ask_user', 'q1', true), null)
  assert.deepEqual(tracker.rescued.getSnapshot(), {})

  // Skip race: roster drops q2 while dismissQuestion is in flight, then promise resolves.
  tracker.noteDraft({ kind: 'ask_user', id: 'q2', sessionId: 'chief', chatId: 'chief', text: 'Abandoned draft' })
  tracker.beginSettle('ask_user', 'q2', 'dismissed')
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: {} })), [])
  assert.equal(tracker.finishSettle('ask_user', 'q2', true), null)
  assert.deepEqual(tracker.rescued.getSnapshot(), {})

  // Skip that fails after question already vanished still does NOT rescue (user explicitly clicked Skip).
  tracker.noteDraft({ kind: 'ask_user', id: 'q3', sessionId: 'chief', chatId: 'chief', text: 'Skipped anyway' })
  tracker.beginSettle('ask_user', 'q3', 'dismissed')
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: {} })), [])
  assert.equal(tracker.finishSettle('ask_user', 'q3', false), null)
  assert.deepEqual(tracker.rescued.getSnapshot(), {})
})

test('submit failure keeps draft active on transient error, and rescues if question vanished (bot/stale)', () => {
  const storage = memoryStorage()
  const tracker = createQuestionDrafts({ storage })

  tracker.noteDraft({ kind: 'ask_user', id: 'q1', sessionId: 'chief', chatId: 'chief', text: 'Important note' })
  // Transient failure while still pending: stays active for retry, no rescue.
  tracker.beginSettle('ask_user', 'q1', 'answered')
  assert.equal(tracker.finishSettle('ask_user', 'q1', false), null)
  assert.equal(tracker.readDraft('ask_user', 'q1'), 'Important note')
  assert.deepEqual(tracker.rescued.getSnapshot(), {})

  // Stale failure: question disappeared externally right before submit settled -> rescues draft!
  tracker.beginSettle('ask_user', 'q1', 'answered')
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: {} })), [])
  const rescued = tracker.finishSettle('ask_user', 'q1', false)
  assert.equal(rescued?.text, 'Important note')
  assert.equal(tracker.rescued.getSnapshot().chief, 'Important note')
  // Does not rescue again on later reconciles.
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: {} })), [])
})

test('part rollover keeps the question active under the new part without false rescue, and rescues to chatId later', () => {
  const storage = memoryStorage()
  const tracker = createQuestionDrafts({ storage })
  const q1 = { id: 'q-roll', question: 'Next?', options: ['Go'], allowCustom: true }

  tracker.noteDraft({ kind: 'ask_user', id: 'q-roll', sessionId: 'bee', chatId: 'bee', text: 'Continue on part 2' })
  // Question moved from part 'bee' to 'bee-2' with the same id.
  assert.deepEqual(tracker.reconcileRoster(makeRoster({ questions: { 'bee-2': { ...q1, callSessionId: 'bee' } } })), [])
  assert.deepEqual(tracker.rescued.getSnapshot(), {})
  assert.equal(tracker.readDraft('ask_user', 'q-roll'), 'Continue on part 2')

  // Later cancelled externally -> rescued under chatId 'bee'.
  const rescued = tracker.reconcileRoster(makeRoster({ questions: {} }))
  assert.equal(rescued.length, 1)
  assert.equal(rescued[0].targetKey, 'bee')
  assert.equal(tracker.rescued.getSnapshot().bee, 'Continue on part 2')
})

test('deleted chats prune both active and rescued drafts without leaking into storage', () => {
  const storage = memoryStorage()
  const tracker = createQuestionDrafts({ storage })
  tracker.noteDraft({ kind: 'ask_user', id: 'q-del', sessionId: 'bee-2', chatId: 'bee', text: 'Will vanish with bee' })
  // Roster no longer includes bee -> active entry is dropped without rescuing.
  assert.deepEqual(tracker.reconcileRoster(makeRoster({
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    questions: {},
  })), [])
  assert.deepEqual(tracker.rescued.getSnapshot(), {})

  // Explicitly queued rescued draft for a deleted chat is removed by pruneChats.
  tracker.enqueueRescue('bee', 'Old rescue')
  tracker.enqueueRescue('chief', 'Keep chief')
  tracker.pruneChats(['bee'])
  assert.deepEqual(tracker.rescued.getSnapshot(), { chief: 'Keep chief' })
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.rescuedDrafts)), { chief: 'Keep chief' })
})

test('unready roster never falsely rescues active drafts', () => {
  const storage = memoryStorage()
  const tracker = createQuestionDrafts({ storage })
  tracker.noteDraft({ kind: 'ask_user', id: 'q1', sessionId: 'chief', chatId: 'chief', text: 'Wait for ready' })
  assert.deepEqual(tracker.reconcileRoster({ ready: false, questions: {} }), [])
  assert.deepEqual(tracker.rescued.getSnapshot(), {})
})

// -------------------------------------------------------------------------
// 3. Component integration: PendingQuestion (inline + dock) & DraftKeeper

test('inline + dock PendingQuestion share one draft, survive virtual scroll / chat switch, and rescue once on interruption', async () => {
  const h = loadHarness()
  const q1 = { id: 'q-1', callId: 'call-1', question: 'Which option?', options: ['A', 'B'], allowCustom: true }
  const roster = h.createSource(h.indexRoster({
    revision: 1,
    bots: [
      { id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] },
      { id: 'bee', name: 'Bee', sessionId: 'bee-2', parts: ['bee', 'bee-2'] },
    ],
    rooms: [],
    agents: [],
    sections: [],
    questions: { chief: q1 },
    prefs: {},
  }))
  const questionDrafts = h.createQuestionDrafts({ storage: h.localStorage })
  roster.subscribe(() => questionDrafts.reconcileRoster(roster.getSnapshot()))
  const heldCards = h.createSource({})
  const actions = h.teamActions({
    call: async () => ({}),
    after: value => value,
    partFor: id => id,
    roster,
    ui: h.createSource({}),
    live: h.createSource({}),
    cards: h.createSource({}),
    heldCards,
    turnClock: h.createSource({}),
    panelFolded: () => false,
    questionDrafts,
  })
  actions.draftFiles = () => []
  actions.restoreDraftFiles = () => []
  actions.releaseDraftFiles = () => {}
  actions.reopenPastes = () => {}

  // Mount composer DraftKeeper on chief with an existing draft.
  const composerState = { draft: 'Already typing', attachmentIds: [], phase: 'plain' }
  const setDraftCalls = []
  const inputActions = {
    setDraft: (text) => { setDraftCalls.push(text); composerState.draft = text },
    addAttachments: () => true,
  }
  const keeperProps = () => ({
    sessionId: 'chief',
    inputActions,
    actions,
    useRoster: pick => pick(roster.getSnapshot()),
    useInput: pick => pick(composerState),
    useRescuedDrafts: pick => pick(questionDrafts.rescued.getSnapshot()),
  })
  const keeper = h.mount(h.DraftKeeper, keeperProps())
  keeper.render(keeperProps())

  // Mount inline card AND dock card for the same question id (simulating overlap/handoff).
  const inlinePending = h.mount(h.PendingQuestion, { sessionId: 'chief', question: q1, actions, inline: true })
  const dockPending = h.mount(h.PendingQuestion, { sessionId: 'chief', question: q1, actions, inline: false })
  const inlineViewNode = childOf(inlinePending.render())
  const dockViewNode = childOf(dockPending.render())
  const inlineView = h.mount(inlineViewNode.type, inlineViewNode.props)
  const dockView = h.mount(dockViewNode.type, dockViewNode.props)
  const form = inlineView.render()
  dockView.render()

  // User types custom text in the inline card.
  find(form, node => node.type === 'textarea').props.onChange({ target: { value: 'Half-written answer' } })
  assert.equal(questionDrafts.readDraft('ask_user', 'q-1'), 'Half-written answer')

  // Virtual scroll unmounts inline card AND user switches away unmounting dock card, while q-1 is STILL pending.
  inlineView.unmount()
  inlinePending.unmount()
  dockView.unmount()
  dockPending.unmount()
  assert.deepEqual(setDraftCalls, [], 'unmount while still pending must not rescue into composer')
  assert.deepEqual(plain(questionDrafts.rescued.getSnapshot()), {})

  // Remounting inline card while still pending restores the typed text!
  const remountPending = h.mount(h.PendingQuestion, { sessionId: 'chief', question: q1, actions, inline: true })
  const remountViewNode = childOf(remountPending.render())
  const remountView = h.mount(remountViewNode.type, remountViewNode.props)
  assert.equal(find(remountView.render(), node => node.type === 'textarea').props.value, 'Half-written answer')

  // Now the question is cancelled externally (e.g. Bot aborted or timed out).
  roster.set(h.indexRoster({ ...roster.getSnapshot(), questions: {} }))
  remountView.unmount()
  remountPending.unmount()

  // Re-render DraftKeeper with the updated rescuedDrafts store -> merges once without overwriting existing text!
  keeper.render(keeperProps())
  assert.deepEqual(setDraftCalls, ['Already typing\n\nHalf-written answer'])
  assert.equal(composerState.draft, 'Already typing\n\nHalf-written answer')
  assert.deepEqual(plain(questionDrafts.rescued.getSnapshot()), {})

  // Re-rendering DraftKeeper again does not duplicate the text.
  keeper.render(keeperProps())
  assert.deepEqual(setDraftCalls, ['Already typing\n\nHalf-written answer'])
  keeper.unmount()
})

test('PendingQuestion normal submit and Skip do not rescue into DraftKeeper', async () => {
  const h = loadHarness()
  const q1 = { id: 'q-sub', question: 'Confirm?', options: ['Yes'], allowCustom: true }
  const q2 = { id: 'q-skip', question: 'Other?', options: ['No'], allowCustom: true }
  const roster = h.createSource(h.indexRoster({
    revision: 1,
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    rooms: [],
    agents: [],
    sections: [],
    questions: { chief: q1 },
    prefs: {},
  }))
  const questionDrafts = h.createQuestionDrafts({ storage: h.localStorage })
  roster.subscribe(() => questionDrafts.reconcileRoster(roster.getSnapshot()))
  const actions = h.teamActions({
    call: async () => ({}),
    after: value => value,
    partFor: id => id,
    roster,
    ui: h.createSource({}),
    live: h.createSource({}),
    cards: h.createSource({}),
    heldCards: h.createSource({}),
    turnClock: h.createSource({}),
    panelFolded: () => false,
    questionDrafts,
  })
  const waitAnswer = deferred()
  actions.answerQuestion = () => waitAnswer.promise
  const waitDismiss = deferred()
  actions.dismissQuestion = () => waitDismiss.promise

  // Submit flow with roster updating BEFORE promise resolves.
  const p1 = h.mount(h.PendingQuestion, { sessionId: 'chief', question: q1, actions, inline: false })
  const v1Node = childOf(p1.render())
  const v1 = h.mount(v1Node.type, v1Node.props)
  const form1 = v1.render()
  find(form1, node => node.type === 'textarea').props.onChange({ target: { value: 'My submitted text' } })
  v1.render().props.onSubmit({ preventDefault() {} })
  roster.set(h.indexRoster({ ...roster.getSnapshot(), questions: {} }))
  waitAnswer.resolve()
  await tick()
  assert.deepEqual(plain(questionDrafts.rescued.getSnapshot()), {})
  v1.unmount()
  p1.unmount()

  // Skip/Dismiss flow.
  roster.set(h.indexRoster({ ...roster.getSnapshot(), questions: { chief: q2 } }))
  const p2 = h.mount(h.PendingQuestion, { sessionId: 'chief', question: q2, actions, inline: false })
  const v2Node = childOf(p2.render())
  const v2 = h.mount(v2Node.type, v2Node.props)
  find(v2.render(), node => node.type === 'textarea').props.onChange({ target: { value: 'Text I chose to skip' } })
  v2Node.props.onDismiss()
  roster.set(h.indexRoster({ ...roster.getSnapshot(), questions: {} }))
  waitDismiss.resolve()
  await tick()
  assert.deepEqual(plain(questionDrafts.rescued.getSnapshot()), {})
  v2.unmount()
  p2.unmount()
})

test('interruption while viewing another chat persists rescued draft and delivers it upon return (even after reload)', () => {
  const storage = memoryStorage()
  const h1 = loadHarness(storage)
  const q1 = { id: 'q-away', question: 'What next?', options: ['A'], allowCustom: true }
  const rosterData = (questions) => h1.indexRoster({
    revision: 1,
    bots: [
      { id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] },
      { id: 'bee', name: 'Bee', sessionId: 'bee-2', parts: ['bee', 'bee-2'] },
    ],
    rooms: [],
    agents: [],
    sections: [],
    questions,
    prefs: {},
  })
  const roster = h1.createSource(rosterData({ 'bee-2': q1 }))
  const qd1 = h1.createQuestionDrafts({ storage })
  roster.subscribe(() => qd1.reconcileRoster(roster.getSnapshot()))

  // User types in bee-2's question card, then switches away to chief (bee-2's composer is unmounted).
  qd1.noteDraft({ kind: 'ask_user', id: 'q-away', sessionId: 'bee-2', chatId: 'bee', text: 'Do not lose this while away' })
  // While user is on chief, bee-2's question disappears externally.
  roster.set(rosterData({}))
  assert.equal(qd1.rescued.getSnapshot().bee, 'Do not lose this while away')

  // Simulate a full page reload (fresh harness reading the same localStorage) and returning to bee-2!
  const h2 = loadHarness(storage)
  const qd2 = h2.createQuestionDrafts({ storage })
  assert.equal(qd2.rescued.getSnapshot().bee, 'Do not lose this while away')
  const setDrafts = []
  const composerState = { draft: 'Previous composer text', attachmentIds: [], phase: 'plain' }
  const keeper = h2.mount(h2.DraftKeeper, {
    sessionId: 'bee-2',
    inputActions: { setDraft: text => { setDrafts.push(text); composerState.draft = text }, addAttachments: () => true },
    actions: {
      draftFiles: () => [],
      restoreDraftFiles: () => [],
      releaseDraftFiles: () => {},
      reopenPastes: () => {},
      consumeRescuedDraft: (chatId, sessionId, taken) => qd2.consumeRescue(chatId, sessionId, taken),
    },
    useRoster: pick => pick(rosterData({})),
    useInput: pick => pick(composerState),
    useRescuedDrafts: pick => pick(qd2.rescued.getSnapshot()),
  })
  keeper.render()
  assert.deepEqual(setDrafts, ['Previous composer text\n\nDo not lose this while away'])
  assert.deepEqual(plain(qd2.rescued.getSnapshot()), {})
  assert.equal(storage.getItem(STORAGE.rescuedDrafts), null)
  keeper.unmount()
})

test('interruption triggered by sending a normal message waits for frozen composer to return to plain', () => {
  const h = loadHarness()
  const qd = h.createQuestionDrafts({ storage: h.localStorage })
  const roster = h.indexRoster({
    revision: 1,
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    rooms: [],
    agents: [],
    sections: [],
    questions: {},
    prefs: {},
  })
  const setDrafts = []
  const composerState = { draft: 'Normal message being sent', attachmentIds: [], phase: 'plain' }
  const props = () => ({
    sessionId: 'chief',
    inputActions: { setDraft: text => { setDrafts.push(text); composerState.draft = text }, addAttachments: () => true },
    actions: {
      draftFiles: () => [],
      restoreDraftFiles: () => [],
      releaseDraftFiles: () => {},
      reopenPastes: () => {},
      consumeRescuedDraft: (chatId, sessionId, taken) => qd.consumeRescue(chatId, sessionId, taken),
    },
    useRoster: pick => pick(roster),
    useInput: pick => pick(composerState),
    useRescuedDrafts: pick => pick(qd.rescued.getSnapshot()),
  })
  const keeper = h.mount(h.DraftKeeper, props())
  keeper.render(props())

  // User hits Send -> composer enters sending (frozen), host closes question, rescue arrives during sending.
  composerState.phase = 'sending'
  qd.enqueueRescue('chief', 'Rescued card note')
  keeper.render(props())
  assert.deepEqual(setDrafts, [], 'must wait while composer is frozen during send')
  assert.equal(qd.rescued.getSnapshot().chief, 'Rescued card note')

  // Send completes -> composer clears to empty plain phase -> rescued note lands!
  composerState.draft = ''
  composerState.phase = 'plain'
  keeper.render(props())
  assert.deepEqual(setDrafts, ['Rescued card note'])
  assert.equal(composerState.draft, 'Rescued card note')
  assert.deepEqual(plain(qd.rescued.getSnapshot()), {})
  keeper.unmount()
})

test('if setDraft throws during rescue, the rescued draft stays queued instead of being dropped', () => {
  const h = loadHarness()
  const qd = h.createQuestionDrafts({ storage: h.localStorage })
  const roster = h.indexRoster({
    revision: 1,
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    rooms: [],
    agents: [],
    sections: [],
    questions: {},
    prefs: {},
  })
  qd.enqueueRescue('chief', 'Keep safe')
  const keeper = h.mount(h.DraftKeeper, {
    sessionId: 'chief',
    inputActions: { setDraft: () => { throw new Error('editor busy') }, addAttachments: () => true },
    actions: {
      draftFiles: () => [],
      restoreDraftFiles: () => [],
      releaseDraftFiles: () => {},
      reopenPastes: () => {},
      consumeRescuedDraft: (chatId, sessionId, taken) => qd.consumeRescue(chatId, sessionId, taken),
    },
    useRoster: pick => pick(roster),
    useInput: pick => pick({ draft: '', attachmentIds: [], phase: 'plain' }),
    useRescuedDrafts: pick => pick(qd.rescued.getSnapshot()),
  })
  keeper.render()
  assert.equal(h.warnings.length, 1)
  assert.equal(qd.rescued.getSnapshot().chief, 'Keep safe')
  keeper.unmount()
})

// -------------------------------------------------------------------------
// 4. Blocking QuestionCard (ask_user_question) multi-question rescue

test('blocking QuestionCard rescues unsent custom answers across steps on external abort, not on switch/answer/dismiss', async () => {
  const h = loadHarness()
  const qd = h.createQuestionDrafts({ storage: h.localStorage })
  const roster = h.createSource(h.indexRoster({
    revision: 1,
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    rooms: [],
    agents: [],
    sections: [],
    questions: {},
    prefs: {},
  }))
  const actions = h.teamActions({
    call: async () => ({}),
    after: value => value,
    partFor: id => id,
    roster,
    ui: h.createSource({}),
    live: h.createSource({}),
    cards: h.createSource({}),
    heldCards: h.createSource({}),
    turnClock: h.createSource({}),
    panelFolded: () => false,
    questionDrafts: qd,
  })

  const pending = {
    key: 'req-1',
    kind: 'question',
    sessionId: 'chief',
    questions: [
      { id: 'step-1', question: 'Step 1?', options: ['A'] },
      { id: 'step-2', question: 'Step 2?', options: ['B'] },
    ],
    answer: () => Promise.resolve(),
    dismiss: () => Promise.resolve(),
  }
  const card = h.mount(h.QuestionCard, { sessionId: 'chief', matched: pending, actions })
  const v1Node = card.render()
  const v1 = h.mount(v1Node.type, v1Node.props)
  // Type custom answer on Step 1 and advance to Step 2 (not submitted to host yet!).
  find(v1.render(), node => node.type === 'textarea').props.onChange({ target: { value: 'Step 1 custom' } })
  v1.render().props.onSubmit({ preventDefault() {} })
  v1.unmount()

  const v2Node = card.render()
  const v2 = h.mount(v2Node.type, v2Node.props)
  find(v2.render(), node => node.type === 'textarea').props.onChange({ target: { value: 'Step 2 half typed' } })

  // Switching chats unmounts QuestionCard while pendingInteraction is STILL active in sessionStatus -> NO rescue!
  v2.unmount()
  card.unmount()
  const activeStatus = new Map([['chief', { pendingInteraction: { key: 'req-1', kind: 'question', sessionId: 'chief' } }]])
  assert.deepEqual(plain(qd.reconcileBlocking(activeStatus, roster.getSnapshot())), [])
  assert.deepEqual(plain(qd.rescued.getSnapshot()), {})

  // Turn aborts externally -> pendingInteraction disappears -> BOTH unsent custom answers rescue in order!
  const clearedStatus = new Map([['chief', { pendingInteraction: undefined }]])
  const rescued = qd.reconcileBlocking(clearedStatus, roster.getSnapshot())
  assert.equal(rescued.length, 1)
  assert.equal(qd.rescued.getSnapshot().chief, 'Step 1 custom\n\nStep 2 half typed')
  qd.consumeRescue('chief', 'chief', 'Step 1 custom\n\nStep 2 half typed')

  // Explicit answer and dismiss on blocking QuestionCard do NOT rescue.
  for (const mode of ['answer', 'dismiss']) {
    const req = {
      key: `req-${mode}`,
      kind: 'question',
      sessionId: 'chief',
      questions: [{ id: 'only', question: 'Single?', options: ['A'] }],
      answer: () => Promise.resolve(),
      dismiss: () => Promise.resolve(),
    }
    const c = h.mount(h.QuestionCard, { sessionId: 'chief', matched: req, actions })
    const vn = c.render()
    const v = h.mount(vn.type, vn.props)
    find(v.render(), node => node.type === 'textarea').props.onChange({ target: { value: `Text ${mode}` } })
    if (mode === 'answer') v.render().props.onSubmit({ preventDefault() {} })
    else vn.props.onDismiss()
    qd.reconcileBlocking(clearedStatus, roster.getSnapshot())
    await tick()
    assert.deepEqual(plain(qd.rescued.getSnapshot()), {})
    v.unmount()
    c.unmount()
  }
})

// -------------------------------------------------------------------------
// 5. Review hardening: multi-window storage RMW, blocking QuestionCard steps & busy,
//    shadowed interactions, deleted chat parts, claimed/chip composer protection,
//    and pinned DSH contract checks

test('two windows sharing localStorage use read-modify-write and syncFromStorage without clobbering each other', () => {
  const storage = memoryStorage()
  const winA = createQuestionDrafts({ storage })
  const winB = createQuestionDrafts({ storage })

  winA.enqueueRescue('bot-a', 'Draft from window A')
  // Window B writes without having received a storage event yet -> must keep bot-a.
  winB.enqueueRescue('bot-b', 'Draft from window B')
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.rescuedDrafts)), {
    'bot-a': 'Draft from window A',
    'bot-b': 'Draft from window B',
  })

  // Window A consumes bot-a -> must preserve bot-b written by window B, never removeItem the whole key.
  winA.consumeRescue('bot-a', 'bot-a', 'Draft from window A')
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.rescuedDrafts)), { 'bot-b': 'Draft from window B' })
  assert.deepEqual(winA.rescued.getSnapshot(), { 'bot-b': 'Draft from window B' })

  // External change in storage is picked up by syncFromStorage().
  storage.setItem(STORAGE.rescuedDrafts, JSON.stringify({ 'bot-b': 'Draft from window B', 'bot-c': 'From window C' }))
  winA.syncFromStorage()
  assert.deepEqual(winA.rescued.getSnapshot(), { 'bot-b': 'Draft from window B', 'bot-c': 'From window C' })

  // pruneChats also uses read-modify-write and preserves unrelated team keys in shared storage.
  winB.pruneChats(['bot-b'])
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.rescuedDrafts)), { 'bot-c': 'From window C' })
})

test('blocking QuestionCard drops abandoned step custom text when preset option is chosen and guards double-click busy', async () => {
  const h = loadHarness()
  const qd = h.createQuestionDrafts({ storage: h.localStorage })
  const roster = h.createSource(h.indexRoster({
    revision: 1,
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    rooms: [],
    agents: [],
    sections: [],
    questions: {},
    prefs: {},
  }))
  const actions = h.teamActions({
    call: async () => ({}),
    after: value => value,
    partFor: id => id,
    roster,
    ui: h.createSource({}),
    live: h.createSource({}),
    cards: h.createSource({}),
    heldCards: h.createSource({}),
    turnClock: h.createSource({}),
    panelFolded: () => false,
    questionDrafts: qd,
  })

  const pending = {
    key: 'req-multi-abandon',
    kind: 'question',
    sessionId: 'chief',
    questions: [
      { id: 'step-1', question: 'Step 1?', options: ['Preset A', 'Preset B'] },
      { id: 'step-2', question: 'Step 2?', options: ['Preset C'] },
    ],
    answer: () => Promise.resolve(),
    dismiss: () => Promise.resolve(),
  }
  const card = h.mount(h.QuestionCard, { sessionId: 'chief', matched: pending, actions })
  const v1Node = card.render()
  const v1 = h.mount(v1Node.type, v1Node.props)
  const form1 = v1.render()
  // User types custom text on Step 1, then clicks Preset A instead of submitting custom text.
  find(form1, node => node.type === 'textarea').props.onChange({ target: { value: 'Abandoned step 1 text' } })
  find(form1, node => node.type === 'button' && node.props.className === 'bt-q-opt').props.onClick()
  v1.unmount()

  // On Step 2, user types custom text and the turn is aborted externally.
  const v2Node = card.render()
  const v2 = h.mount(v2Node.type, v2Node.props)
  find(v2.render(), node => node.type === 'textarea').props.onChange({ target: { value: 'Step 2 kept text' } })
  v2.unmount()
  card.unmount()

  const rescued = qd.reconcileBlocking(new Map([['chief', { pendingInteraction: undefined }]]), roster.getSnapshot())
  assert.equal(rescued.length, 1)
  assert.equal(rescued[0].text, 'Step 2 kept text')
  assert.equal(qd.rescued.getSnapshot().chief, 'Step 2 kept text')
  qd.consumeRescue('chief', 'chief', 'Step 2 kept text')

  // Double-click guard: while pending.answer is in flight, a second click is ignored and does not trigger a false failure rescue.
  let calls = 0
  const gate = deferred()
  const single = {
    key: 'req-busy',
    kind: 'question',
    sessionId: 'chief',
    questions: [{ id: 'only', question: 'Single?', options: ['A'] }],
    answer: () => { calls += 1; return gate.promise },
    dismiss: () => Promise.resolve(),
  }
  const c2 = h.mount(h.QuestionCard, { sessionId: 'chief', matched: single, actions })
  const vn2 = c2.render()
  const vSingle = h.mount(vn2.type, vn2.props)
  find(vSingle.render(), node => node.type === 'textarea').props.onChange({ target: { value: 'Double click test' } })
  vSingle.render().props.onSubmit({ preventDefault() {} })
  vSingle.render().props.onSubmit({ preventDefault() {} })
  await tick()
  assert.equal(calls, 1, 'busyRef must block re-entrant submit calls')
  // Pending interaction disappears while submit is still in flight; resolve cleanly -> no rescue.
  qd.reconcileBlocking(new Map([['chief', { pendingInteraction: undefined }]]), roster.getSnapshot())
  gate.resolve()
  await tick()
  assert.deepEqual(plain(qd.rescued.getSnapshot()), {})
  vSingle.unmount()
  c2.unmount()
})

test('reconcileBlocking ignores higher-precedence shadowing, live non-closed PendingQuestion, deleted chats, and matches fallback keys', () => {
  const storage = memoryStorage()
  const qd = createQuestionDrafts({ storage })
  const roster = makeRoster()

  // 1. Higher-precedence non-question interaction (e.g. plan-review) shadowing the seat must NOT rescue.
  qd.noteDraft({ kind: 'blocking', id: 'req-shadow', sessionId: 'chief', chatId: 'chief', text: 'Waiting behind plan-review' })
  const shadowed = new Map([['chief', { pendingInteraction: { key: 'plan-1', kind: 'plan-review', sessionId: 'chief' } }]])
  assert.deepEqual(qd.reconcileBlocking(shadowed, roster), [])
  assert.deepEqual(qd.rescued.getSnapshot(), {})

  // 2. Real DSH PendingQuestion with closed === false stays protected even when seat is hidden.
  let closed = false
  qd.noteDraft({
    kind: 'blocking',
    id: 'req-hidden',
    sessionId: 'chief',
    chatId: 'chief',
    text: 'Hidden panel still alive',
    isStillOpen: () => !closed,
  })
  const emptyStatus = new Map([['chief', { pendingInteraction: undefined }]])
  // Seat clears: req-shadow (no longer shadowed and no open card handle) rescues, while req-hidden stays protected because closed === false.
  const firstRescued = qd.reconcileBlocking(emptyStatus, roster)
  assert.equal(firstRescued.length, 1)
  assert.equal(firstRescued[0].text, 'Waiting behind plan-review')
  assert.equal(qd.rescued.getSnapshot().chief, 'Waiting behind plan-review')
  assert.equal(qd.readDraft('blocking', 'req-hidden'), 'Hidden panel still alive')

  // Once the hidden card actually closes, its draft rescues and merges without overwriting.
  closed = true
  const secondRescued = qd.reconcileBlocking(emptyStatus, roster)
  assert.equal(secondRescued.length, 1)
  assert.equal(secondRescued[0].text, 'Hidden panel still alive')
  assert.equal(qd.rescued.getSnapshot().chief, 'Waiting behind plan-review\n\nHidden panel still alive')
  qd.consumeRescue('chief', 'chief')

  // 3. Deleted chat is dropped without writing into storage.
  qd.noteDraft({ kind: 'blocking', id: 'req-del', sessionId: 'bee-2', chatId: 'bee', text: 'Deleted bot draft' })
  const rosterWithoutBee = makeRoster({ bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }] })
  assert.deepEqual(qd.reconcileBlocking(new Map([['bee-2', { pendingInteraction: undefined }]]), rosterWithoutBee), [])
  assert.deepEqual(qd.rescued.getSnapshot(), {})

  // 4. Shared blockingQuestionId fallback matches id / callId consistently.
  assert.equal(blockingQuestionId({ id: 'fallback-id' }), 'fallback-id')
  assert.equal(blockingQuestionId({ callId: 'call-9' }), 'call-9')
  qd.noteDraft({ kind: 'blocking', id: blockingQuestionId({ callId: 'call-9' }), sessionId: 'chief', chatId: 'chief', text: 'CallId draft' })
  const activeCallId = new Map([['chief', { pendingInteraction: { kind: 'question', callId: 'call-9', sessionId: 'chief' } }]])
  assert.deepEqual(qd.reconcileBlocking(activeCallId, roster), [])
})

test('DraftKeeper waits during claimed slash-command phase and uses insertText when inline reference chips exist', () => {
  const h = loadHarness()
  const qd = h.createQuestionDrafts({ storage: h.localStorage })
  const roster = h.indexRoster({
    revision: 1,
    bots: [{ id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] }],
    rooms: [],
    agents: [],
    sections: [],
    questions: {},
    prefs: {},
  })

  const setDraftCalls = []
  const insertCalls = []
  const composerState = {
    draft: '/goal ship',
    attachmentIds: [],
    phase: 'claimed',
    occurrences: [],
    draftRev: 7,
  }
  const inputActions = {
    setDraft: (text) => { setDraftCalls.push(text); composerState.draft = text },
    addAttachments: () => true,
    captureInsertion: () => ({ start: 4, end: 11, draftRev: composerState.draftRev }),
    insertText: (text, span) => {
      insertCalls.push({ text, span })
      composerState.draft = `${composerState.draft}${text}`
      return true
    },
  }
  const props = () => ({
    sessionId: 'chief',
    inputActions,
    actions: {
      draftFiles: () => [],
      restoreDraftFiles: () => [],
      releaseDraftFiles: () => {},
      reopenPastes: () => {},
      consumeRescuedDraft: (chatId, sessionId, taken) => qd.consumeRescue(chatId, sessionId, taken),
    },
    useRoster: pick => pick(roster),
    useInput: pick => pick(composerState),
    useRescuedDrafts: pick => pick(qd.rescued.getSnapshot()),
  })

  const keeper = h.mount(h.DraftKeeper, props())
  keeper.render(props())

  // Enqueue rescue while in claimed command phase -> must NOT call setDraft or cancel the command chip.
  qd.enqueueRescue('chief', 'Rescued note')
  keeper.render(props())
  assert.deepEqual(setDraftCalls, [])
  assert.deepEqual(insertCalls, [])
  assert.equal(qd.rescued.getSnapshot().chief, 'Rescued note')

  // Return to plain phase WITH an inline reference chip -> uses insertText at collapsed span.end without calling setDraft.
  composerState.phase = 'plain'
  composerState.draft = '@Bee check'
  composerState.occurrences = [{ occurrenceId: 1, source: 'mention', ref: 'bee', offset: 0 }]
  composerState.draftRev = 8
  keeper.render(props())
  assert.deepEqual(setDraftCalls, [], 'must not call setDraft when inline reference chips exist')
  assert.deepEqual(plain(insertCalls), [{ text: '\n\nRescued note', span: { start: 11, end: 11, draftRev: 8 } }])
  assert.deepEqual(plain(qd.rescued.getSnapshot()), {})
  keeper.unmount()
})

test('pinned DSH client UI packages satisfy the sessionStatus, PendingQuestion, and InputActions contracts used for rescue', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const harnessPkg = (pkg, rel) => readFileSync(join(PLUGIN_DIR, 'dev', 'harness', 'node_modules', '@deepseek-ai', pkg, rel), 'utf8')
  const sessionTypes = harnessPkg('dsh-client-ui-session', 'lib/types/client/index.d.ts')
  const questionTypes = harnessPkg('dsh-client-ui-user-questions', 'lib/types/client/contract/slots.d.ts')
  const inputTypes = harnessPkg('dsh-client-ui-conversation', 'lib/types/client/contract/input.d.ts')

  // SessionStatus exposes the single highest-precedence pendingInteraction.
  assert.match(sessionTypes, /readonly pendingInteraction: SessionPendingInteraction \| undefined;/)
  assert.match(sessionTypes, /readonly key: string;/)
  assert.match(sessionTypes, /readonly kind: string;/)

  // PendingQuestion exposes key, kind, and getSnapshot().closed.
  assert.match(questionTypes, /readonly kind: 'question' \| 'plan-review';/)
  assert.match(questionTypes, /readonly key: string;/)
  assert.match(questionTypes, /readonly closed: boolean;/)
  assert.match(questionTypes, /readonly getSnapshot: \(\) => QuestionCardSnapshot;/)

  // InputState & InputActions expose claimed phase, occurrences, captureInsertion, and insertText.
  assert.match(inputTypes, /readonly phase: 'plain' \| 'adjudicating' \| 'claimed' \| 'submitting' \| 'sending';/)
  assert.match(inputTypes, /readonly occurrences: readonly Occurrence\[\];/)
  assert.match(inputTypes, /captureInsertion\(\): TokenSpan;/)
  assert.match(inputTypes, /insertText\(text: string, span: TokenSpan\): boolean;/)
  assert.match(inputTypes, /setDraft\(text: string\): void;/)
})
