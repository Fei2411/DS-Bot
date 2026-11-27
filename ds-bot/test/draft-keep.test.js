import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  captureAdmissionBaseline, chatOfSession, dropPartDraft, dropSentDraft,
  forgetKeptFiles, hasLivePartDraft, isSentAdmitted, keepDraft, keepSentDraft,
  markSentAdmitted, maxUserSeqOf, peekSentDraft, pruneDrafts, takeDraft, takeSentDraft,
} from '../src/client/draft-keep.js'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'
import { STORAGE } from '../src/client/storage.js'

const memoryStorage = () => {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
  }
}

const image = name => ({ kind: 'image', file: { name } })

let storage
beforeEach(() => {
  storage = memoryStorage()
  forgetKeptFiles()
})

const roster = {
  byId: {
    bee: { id: 'bee', sessionId: 'bee-2', parts: ['bee', 'bee-2'] },
    'bee-2': { id: 'bee', sessionId: 'bee-2', parts: ['bee', 'bee-2'] },
    chief: { id: 'chief', parts: ['chief'] },
  },
  roomsById: {
    room: { id: 'room', sessionId: 'room-3', ownParts: ['room', 'room-3'] },
  },
}

// Built before any test is declared: under --test-force-exit the runner ends the
// process once the tests declared so far are done, so tests declared after a
// top-level await would never run.
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const keeperBundle = await build({
  stdin: {
    contents: "export { DraftKeeper } from './src/client/composer.js'; export { keepDraft, takeDraft, forgetKeptFiles } from './src/client/draft-keep.js'",
    resolveDir: PLUGIN_DIR,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})

test('a Session finds its chat and the part the chat is on', () => {
  assert.deepEqual(chatOfSession(roster, 'bee'), { id: 'bee', part: 'bee-2' })
  assert.deepEqual(chatOfSession(roster, 'bee-2'), { id: 'bee', part: 'bee-2' })
  assert.deepEqual(chatOfSession(roster, 'chief'), { id: 'chief', part: 'chief' })
  assert.deepEqual(chatOfSession(roster, 'room-3'), { id: 'room', part: 'room-3' })
  assert.deepEqual(chatOfSession(roster, 'room'), { id: 'room', part: 'room-3' })
  assert.equal(chatOfSession(roster, 'agent-session'), undefined, 'a DSH Agent Session is not a chat')
  assert.equal(chatOfSession(roster, ''), undefined)
})

test('coming back to the same part gets the files back; the shell keeps the text itself', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [image('red.png')] }, storage)
  const back = takeDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', attached: 0 }, storage)
  assert.equal(back.text, '')
  assert.deepEqual(back.files.map(item => item.file.name), ['red.png'])
  assert.equal(back.from, 'bee-2')
})

test('a newer part gets the text and the files when its box is empty', () => {
  keepDraft({ chatId: 'bee', part: 'bee', text: 'hello', files: [image('red.png')] }, storage)
  const back = takeDraft({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, storage)
  assert.equal(back.text, 'hello')
  assert.equal(back.files.length, 1)
  assert.equal(back.from, 'bee')
})

test('a box that already has its own text or files keeps them', () => {
  keepDraft({ chatId: 'bee', part: 'bee', text: 'old', files: [image('red.png')] }, storage)
  const back = takeDraft({ chatId: 'bee', part: 'bee-2', text: 'typed here', attached: 1 }, storage)
  assert.equal(back.text, '')
  assert.deepEqual(back.files, [])
  assert.equal(back.from, undefined)
})

test('a send or an emptied box leaves nothing to take back', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [image('red.png')] }, storage)
  keepDraft({ chatId: 'bee', part: 'bee-2', text: '', files: [] }, storage)
  assert.equal(storage.getItem(STORAGE.drafts), '{}')
  const back = takeDraft({ chatId: 'bee', part: 'bee-3', text: '', attached: 0 }, storage)
  assert.deepEqual(back, { text: '', files: [], from: undefined })
})

test('a sent text is remembered for this page and Session only, and read once', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [] }, storage)
  keepSentDraft({ chatId: 'bee', sessionId: 'bee-2', text: 'hello', baseline: captureAdmissionBaseline() })
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'hello' } }, 'the shared draft store is not touched')
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-3' }), undefined, 'another Session of the chat does not read it')
  assert.equal(peekSentDraft({ chatId: 'bee', sessionId: 'bee-2' })?.text, 'hello')
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-2' })?.text, 'hello')
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-2' }), undefined, 'the sent text is read once')
})

test('a settled send forgets its text, so a later visit cannot clear a same-text draft', () => {
  keepSentDraft({ chatId: 'bee', sessionId: 'bee-2', text: '继续' })
  keepSentDraft({ chatId: 'bee', sessionId: 'bee-3', text: 'another' })
  dropSentDraft({ chatId: 'bee', sessionId: 'bee-2' })
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-2' }), undefined)
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-3' })?.text, 'another', 'only that Session is forgotten')
})

test('a deleted chat takes this page\'s sent marks with it, and only that chat\'s', () => {
  keepSentDraft({ chatId: 'bee', sessionId: 'bee-a', text: 'one' })
  keepSentDraft({ chatId: 'bee', sessionId: 'bee-b', text: 'two' })
  keepSentDraft({ chatId: 'chief', sessionId: 'chief', text: 'three' })
  pruneDrafts(['bee'], storage)
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-a' }), undefined)
  assert.equal(takeSentDraft({ chatId: 'bee', sessionId: 'bee-b' }), undefined)
  assert.equal(takeSentDraft({ chatId: 'chief', sessionId: 'chief' })?.text, 'three')
})

test('admission verification distinguishes new Host admissions from pre-existing history and unconfirmed attempts', () => {
  const oldChat = {
    order: ['u1'],
    nodes: {
      get: k => (k === 'u1' ? { kind: 'user', anchorSeq: 4, data: { seq: 4, content: [{ type: 'text', text: '继续' }] } } : undefined),
      values: () => [{ kind: 'user', anchorSeq: 4, data: { seq: 4, content: [{ type: 'text', text: '继续' }] } }],
    },
  }
  assert.equal(maxUserSeqOf(oldChat), 4)
  const baseline = captureAdmissionBaseline({
    chat: oldChat,
    pendingSubmissions: [{ requestId: 'old-req', text: '继续' }],
    queue: [{ id: 'old-q', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }],
  })
  const watch = { text: ' 继续 ', baseline, admitted: false }
  // Nothing new since baseline: not admitted.
  assert.equal(isSentAdmitted(watch, {
    chat: oldChat,
    pendingSubmissions: [{ requestId: 'old-req', text: '继续' }],
    queue: [{ id: 'old-q', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }],
  }), false)
  // A new accepted pendingSubmission confirms admission (trimmed like DSH serializeDraftPrompt).
  assert.equal(isSentAdmitted(watch, { pendingSubmissions: [{ requestId: 'new-req', text: '继续' }] }), true)
  // A new user queue row confirms admission; a bot-sourced row does not.
  assert.equal(isSentAdmitted(watch, { queue: [{ id: 'bot-q', source: { kind: 'bot' }, content: [{ type: 'text', text: '继续' }] }] }), false)
  assert.equal(isSentAdmitted(watch, { queue: [{ id: 'new-q', source: { kind: 'user' }, content: [{ type: 'image' }, { type: 'text', text: '继续' }] }] }), true)
  // A new durable user or steering node above baseline.maxUserSeq confirms admission.
  const admittedChat = {
    order: ['u1', 's2'],
    nodes: {
      get: k => (k === 's2' ? { kind: 'steering', anchorSeq: 7, data: { seq: 7, messageId: 'new-steer', source: { kind: 'user', rpcId: 'new-req' }, content: [{ type: 'text', text: '继续' }] } } : oldChat.nodes.get(k)),
      values: () => [
        ...oldChat.nodes.values(),
        { kind: 'steering', anchorSeq: 7, data: { seq: 7, messageId: 'new-steer', source: { kind: 'user', rpcId: 'new-req' }, content: [{ type: 'text', text: '继续' }] } },
      ],
    },
  }
  assert.equal(isSentAdmitted(watch, { chat: admittedChat }), true)
  // Latching admitted via markSentAdmitted sticks even after echoes retire.
  keepSentDraft({ chatId: 'bee', sessionId: 'bee-2', text: '继续', baseline })
  markSentAdmitted({ chatId: 'bee', sessionId: 'bee-2' })
  assert.equal(isSentAdmitted(peekSentDraft({ chatId: 'bee', sessionId: 'bee-2' }), {}), true)
})

test('dropPartDraft drops only the named part and hasLivePartDraft detects another tab\'s draft on the same part', () => {
  keepDraft({ chatId: 'bee', part: 'bee', text: 'older', files: [image('a.png')] }, storage)
  assert.equal(hasLivePartDraft({ chatId: 'bee', part: 'bee-2' }, storage), false)
  dropPartDraft({ chatId: 'bee', part: 'bee-2' }, storage)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.drafts)), { bee: { part: 'bee', text: 'older' } })
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'fresh', files: [] }, storage)
  assert.equal(hasLivePartDraft({ chatId: 'bee', part: 'bee-2' }, storage), true)
  dropPartDraft({ chatId: 'bee', part: 'bee-2' }, storage)
  assert.equal(hasLivePartDraft({ chatId: 'bee', part: 'bee-2' }, storage), false)
})

test('a removed image stays removed', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: '', files: [image('green.png'), image('blue.png')] }, storage)
  keepDraft({ chatId: 'bee', part: 'bee-2', text: '', files: [image('blue.png')] }, storage)
  const back = takeDraft({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, storage)
  assert.deepEqual(back.files.map(item => item.file.name), ['blue.png'])
})

test('each chat keeps its own draft', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'for Bee', files: [image('bee.png')] }, storage)
  keepDraft({ chatId: 'chief', part: 'chief', text: 'for Chief', files: [] }, storage)
  assert.deepEqual(takeDraft({ chatId: 'chief', part: 'chief', text: 'for Chief', attached: 0 }, storage).files, [])
  assert.deepEqual(takeDraft({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, storage).files.map(item => item.file.name), ['bee.png'])
})

test('the text is kept in browser storage, the files are not', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [image('red.png')] }, storage)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'hello' } })
  forgetKeptFiles()
  const back = takeDraft({ chatId: 'bee', part: 'bee-3', text: '', attached: 0 }, storage)
  assert.equal(back.text, 'hello', 'a reload still carries the text to a newer part')
  assert.deepEqual(back.files, [])
})

test('broken or missing storage keeps nothing and breaks nothing', () => {
  storage.setItem(STORAGE.drafts, 'not json')
  assert.deepEqual(takeDraft({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, storage), { text: '', files: [], from: undefined })
  const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [] }, throwing)
  assert.equal(takeDraft({ chatId: 'bee', part: 'bee-3', text: '', attached: 0 }, throwing).text, '')
})

test('a deleted chat takes its draft with it', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [image('red.png')] }, storage)
  keepDraft({ chatId: 'chief', part: 'chief', text: 'stay', files: [] }, storage)
  pruneDrafts(['bee'], storage)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE.drafts)), { chief: { part: 'chief', text: 'stay' } })
  assert.deepEqual(takeDraft({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, storage).files, [])
})

test('paste cards wait for their files again, in the part the draft went to', () => {
  const ui = createSource({ paste: {} })
  const actions = teamActions({ call: async () => ({}), after: value => value, partFor: id => id, roster: createSource({}), ui, live: createSource({}), cards: createSource({}), heldCards: createSource({}), turnClock: createSource({}), panelFolded: () => false })
  const id = actions.addPaste('bee', 'long text', 'Pasted text (9 characters).txt')
  actions.linkPastes('bee', [{ blockId: id, attachmentId: 'draft-1' }])
  actions.reopenPastes('bee', 'bee')
  assert.deepEqual(ui.getSnapshot().paste.bee.map(block => block.attachmentId), [null])
  actions.linkPastes('bee', [{ blockId: id, attachmentId: 'draft-2' }])
  actions.reopenPastes('bee', 'bee-2')
  assert.equal(ui.getSnapshot().paste.bee, undefined)
  assert.deepEqual(ui.getSnapshot().paste['bee-2'].map(block => [block.text, block.attachmentId]), [['long text', null]])
  actions.reopenPastes(undefined, 'bee-2')
  assert.equal(ui.getSnapshot().paste['bee-2'].length, 1, 'a draft with no cards moves none')
})

// The files go back through the shell's own draft intake; a DSH that renames it must
// fail here, not silently in a Bot chat.
test('the pinned DSH conversation service has the draft intake the keeper uses', async () => {
  const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
  const harness = process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness')
  const require = createRequire(join(harness, 'package.json'))
  const types = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
  const { readFile } = await import('node:fs/promises')
  const service = await readFile(join(dirname(types), 'lib', 'types', 'client', 'service.d.ts'), 'utf8')
  assert.match(service, /createDrafts\(sessionId: SessionId, files: readonly File\[\], uploadImages: boolean\): readonly ComposerAttachment\[\];/)
  assert.match(service, /resolveDraftAttachments\(ids: readonly DraftAttachmentId\[\]\): readonly ComposerAttachment\[\];/)
  assert.match(service, /releaseDraftAttachment\(id: DraftAttachmentId\): void;/)
  const input = await readFile(join(dirname(types), 'lib', 'types', 'client', 'contract', 'input.d.ts'), 'utf8')
  assert.match(input, /addAttachments\(ids: readonly DraftAttachmentId\[\]\): boolean;/)
  assert.match(input, /readonly phase: 'plain' \| 'adjudicating' \| 'claimed' \| 'submitting' \| 'sending';/)
  assert.match(input, /readonly queue: InboxState\['next-turn'\];/)
  const records = await readFile(join(dirname(types), 'lib', 'types', 'client', 'contract', 'records.d.ts'), 'utf8')
  assert.match(records, /export interface UserMessageNode \{[\s\S]*?messageId\?: MessageId;/)
  assert.match(records, /export interface SteeringMessageNode \{[\s\S]*?messageId: MessageId;/)
  const sessionTypes = require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')
  const sessionSnap = await readFile(join(dirname(sessionTypes), 'lib', 'types', 'client', 'contract', 'snapshot.d.ts'), 'utf8')
  assert.match(sessionSnap, /readonly requestId: SessionRequestId;/)
  assert.match(sessionSnap, /readonly pendingSubmissions: readonly PendingSubmission\[\];/)
  assert.match(sessionSnap, /readonly openState: OpenState;/)
  const chatTypes = require.resolve('@deepseek-ai/dsh-client-ui-chat/package.json')
  const chatSnap = await readFile(join(dirname(chatTypes), 'lib', 'types', 'client', 'contract', 'snapshot.d.ts'), 'utf8')
  assert.match(chatSnap, /chat: ChatSnapshot;/)
  assert.match(chatSnap, /readonly nodes: ChatNodeStore;/)
  const chatMsg = await readFile(join(dirname(chatTypes), 'lib', 'types', 'client', 'conversation-nodes', 'message.d.ts'), 'utf8')
  assert.match(chatMsg, /user: ReferencedUserMessageNode;/)
  assert.match(chatMsg, /steering: ReferencedSteeringMessageNode;/)
  const uiSessionTypes = require.resolve('@deepseek-ai/dsh-client-ui-session/package.json')
  const uiSession = await readFile(join(dirname(uiSessionTypes), 'lib', 'types', 'client', 'index.d.ts'), 'utf8')
  assert.match(uiSession, /useProjection: UseProjection;/)
  const agentTypes = require.resolve('@deepseek-ai/dsh-agent/package.json')
  const agent = await readFile(join(dirname(agentTypes), 'lib', 'types', 'types.d.ts'), 'utf8')
  assert.match(agent, /readonly 'next-step': readonly UserMessage\[\];/)
  assert.match(agent, /inbox: InboxWireState;/)
})


function loadKeeper(localStorage, extraGlobals = {}) {
  let cursor = 0
  const slots = []
  const pendingEffects = []
  const depsChanged = (prev, next) => prev === undefined || next === undefined || prev.length !== next.length || next.some((v, i) => !Object.is(v, prev[i]))
  const scheduleEffect = (fn, deps) => {
    const i = cursor++
    const prev = slots[i]
    if (prev === undefined || depsChanged(prev.deps, deps)) {
      const cell = prev ?? {}
      cell.deps = deps
      slots[i] = cell
      pendingEffects.push(() => {
        cell.cleanup?.()
        cell.cleanup = fn()
      })
    }
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'fragment',
    useRef: (init) => {
      const i = cursor++
      if (slots[i] === undefined) slots[i] = { current: init }
      return slots[i]
    },
    useEffect: scheduleEffect,
    useLayoutEffect: scheduleEffect,
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useMemo: make => make(),
    useCallback: fn => fn,
  }
  const mod = { exports: {} }
  const warnings = []
  runInNewContext(keeperBundle.outputFiles[0].text, {
    module: mod, exports: mod.exports, localStorage,
    console: { warn: (...args) => warnings.push(args) },
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
    ...extraGlobals,
  })
  const render = (props) => {
    cursor = 0
    pendingEffects.length = 0
    mod.exports.DraftKeeper(props)
    for (const fn of pendingEffects.splice(0)) fn()
  }
  const unmount = () => {
    for (const cell of slots) cell?.cleanup?.()
    slots.length = 0
  }
  // A fresh mount of the same module: the component's refs start empty, the kept draft
  // stays in storage, as when the user leaves the chat and comes back.
  const remount = (props) => {
    unmount()
    render(props)
  }
  return { ...mod.exports, render, remount, unmount, warnings }
}

test('DraftKeeper releases refused drafts, tells the user, and does not retry on every later send', () => {
  const ls = memoryStorage()
  const { keepDraft: keep, takeDraft: take, render } = loadKeeper(ls)
  keep({ chatId: 'bee', part: 'bee-2', text: 'hello', files: [image('red.png')] }, ls)

  const released = []
  const reopened = []
  const notices = []
  let restores = 0
  const actions = {
    draftFiles: ids => ids.map(id => image(id)),
    restoreDraftFiles: (_sid, files) => { restores += 1; return files.map((_, i) => `draft-${i + 1}`) },
    releaseDraftFiles: ids => released.push(...ids),
    reopenPastes: (from, to) => reopened.push([from, to]),
    notice: text => notices.push(text),
  }
  const inputActions = { setDraft() {}, addAttachments: () => false }
  const state = { draft: 'hello', attachmentIds: [], phase: 'plain' }
  const props = { sessionId: 'bee-2', inputActions, actions, useRoster: pick => pick(roster), useInput: pick => pick(state) }
  render(props)

  assert.deepEqual(released, ['draft-1'], 'refused drafts must be released so uploads do not leak')
  assert.deepEqual(reopened, [], 'paste cards stay closed when attachments were refused')
  assert.equal(notices.length, 1, 'the user hears the files could not come back')
  const now = take({ chatId: 'bee', part: 'bee-2', text: 'hello', attached: 0 }, ls)
  assert.equal(now.files.length, 0, 'the draft is kept from what the box holds now')

  // A send and its return to plain do not run the failed restore again.
  state.phase = 'sending'
  render(props)
  state.draft = ''
  state.phase = 'plain'
  render(props)
  assert.equal(restores, 1)
  assert.equal(notices.length, 1)
})

test('DraftKeeper waits while a send is in flight and restores once the composer returns to plain', () => {
  const ls = memoryStorage()
  const { keepDraft: keep, takeDraft: take, render } = loadKeeper(ls)
  keep({ chatId: 'bee', part: 'bee', text: 'carry me', files: [image('red.png')] }, ls)

  const setDrafts = []
  const attached = []
  const reopened = []
  const actions = {
    draftFiles: ids => ids.map(() => image('red.png')),
    restoreDraftFiles: () => ['draft-9'],
    releaseDraftFiles: () => assert.fail('should not release when waiting on frozen phase'),
    reopenPastes: (from, to) => reopened.push([from, to]),
  }
  const inputActions = {
    setDraft: text => setDrafts.push(text),
    addAttachments: ids => { attached.push(...ids); return true },
  }
  const state = { draft: '', attachmentIds: [], phase: 'sending' }
  const props = {
    sessionId: 'bee-2', inputActions, actions,
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
  }

  render(props)
  assert.deepEqual(setDrafts, [])
  assert.deepEqual(attached, [])
  const preserved = take({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, ls)
  assert.equal(preserved.text, 'carry me')
  assert.deepEqual(Array.from(preserved.files, item => item.file.name), ['red.png'])

  state.phase = 'plain'
  render(props)
  assert.deepEqual(setDrafts, ['carry me'])
  assert.deepEqual(attached, ['draft-9'])
  assert.deepEqual(reopened, [['bee', 'bee-2']])
})

test('DraftKeeper releases unattached drafts and preserves kept text/files if restore throws', () => {
  const ls = memoryStorage()
  const { keepDraft: keep, takeDraft: take, render, warnings } = loadKeeper(ls)
  keep({ chatId: 'bee', part: 'bee', text: 'keep me', files: [image('red.png')] }, ls)

  const released = []
  const actions = {
    draftFiles: () => [],
    restoreDraftFiles: () => ['draft-boom'],
    releaseDraftFiles: ids => released.push(...ids),
    reopenPastes: () => {},
  }
  const inputActions = {
    setDraft() {},
    addAttachments: () => { throw new Error('boom') },
  }
  render({
    sessionId: 'bee-2', inputActions, actions,
    useRoster: pick => pick(roster),
    useInput: pick => pick({ draft: '', attachmentIds: [], phase: 'plain' }),
  })

  assert.deepEqual(released, ['draft-boom'])
  assert.equal(warnings.length, 1)
  const stillKept = take({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, ls)
  assert.equal(stillKept.text, 'keep me')
  assert.deepEqual(Array.from(stillKept.files, item => item.file.name), ['red.png'])
})

test('pruning drops only the chats named, so another team\'s drafts in the same browser stay', () => {
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'this team', files: [] }, storage)
  keepDraft({ chatId: 'other-team-bot', part: 'x', text: 'another team', files: [] }, storage)
  pruneDrafts([], storage)
  pruneDrafts(['gone-bot'], storage)
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(STORAGE.drafts))).sort(), ['bee', 'other-team-bot'])
})

test('a paste card whose file the composer no longer has waits for it again', () => {
  const ui = createSource({ paste: {} })
  const actions = teamActions({ call: async () => ({}), after: value => value, partFor: id => id, roster: createSource({}), ui, live: createSource({}), cards: createSource({}), heldCards: createSource({}), turnClock: createSource({}), panelFolded: () => false })
  const kept = actions.addPaste('s1', 'kept text', 'Pasted text (9 characters).txt')
  const stale = actions.addPaste('s1', 'stale text', 'Pasted text (10 characters).txt')
  actions.linkPastes('s1', [{ blockId: kept, attachmentId: 'live' }, { blockId: stale, attachmentId: 'released' }])
  actions.unlinkPastes('s1', [stale])
  assert.deepEqual(ui.getSnapshot().paste.s1.map(block => [block.text, block.attachmentId]), [['kept text', 'live'], ['stale text', null]])
  const before = ui.getSnapshot()
  actions.unlinkPastes('s1', [stale])
  assert.equal(ui.getSnapshot(), before, 'nothing to change keeps the state')
})

test('DraftKeeper stops keeping a draft that is being sent, and keeps it again if the send fails', () => {
  const ls = memoryStorage()
  const { takeDraft: take, render } = loadKeeper(ls)
  const actions = {
    draftFiles: ids => ids.map(id => image(`${id}.png`)),
    restoreDraftFiles: () => [],
    releaseDraftFiles: () => {},
    reopenPastes: () => {},
  }
  const inputActions = { setDraft() {}, addAttachments: () => true }
  const state = { draft: 'look at this', attachmentIds: ['img'], phase: 'plain' }
  const props = { sessionId: 'bee-2', inputActions, actions, useRoster: pick => pick(roster), useInput: pick => pick(state) }
  render(props)
  assert.deepEqual(Array.from(take({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, ls).files, item => item.file.name), ['img.png'])

  // Send pressed; the composer closes before the Host answers: nothing comes back.
  state.phase = 'sending'
  render(props)
  // A plain copy: the keeper runs in its own vm context, whose objects are not this realm's.
  assert.deepEqual(JSON.parse(JSON.stringify(take({ chatId: 'bee', part: 'bee-3', text: '', attached: 0 }, ls))), { text: '', files: [] })

  // The send failed and the shell gave the draft back.
  state.phase = 'plain'
  render(props)
  const back = take({ chatId: 'bee', part: 'bee-3', text: '', attached: 0 }, ls)
  assert.equal(back.text, 'look at this')
  assert.deepEqual(Array.from(back.files, item => item.file.name), ['img.png'])
})

test('owned Classic Agent Sessions get stable draft keys and survive switches and pruning', () => {
  const classicRoster = {
    ...roster,
    agentOf: { 'classic-s1': 'agent-a' },
    agents: [{ id: 'agent-a', sessions: ['classic-s1', 'classic-s2'] }],
  }
  assert.deepEqual(chatOfSession(classicRoster, 'classic-s1'), { id: 'classic-s1', part: 'classic-s1' })
  assert.deepEqual(chatOfSession(classicRoster, 'classic-s2'), { id: 'classic-s2', part: 'classic-s2' })
  assert.equal(chatOfSession(classicRoster, 'unowned-session'), undefined)

  keepDraft({ chatId: 'classic-s1', part: 'classic-s1', text: 'draft one', files: [image('one.png')] }, storage)
  keepDraft({ chatId: 'classic-s2', part: 'classic-s2', text: 'draft two', files: [] }, storage)
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'bot draft', files: [] }, storage)
  const stored = JSON.parse(storage.getItem(STORAGE.drafts))
  assert.equal(stored['classic-s1'].text, 'draft one')
  assert.equal(stored['classic-s2'].text, 'draft two')
  assert.equal(stored.bee.text, 'bot draft')
  const back = takeDraft({ chatId: 'classic-s1', part: 'classic-s1', text: 'draft one', attached: 0 }, storage)
  assert.deepEqual(back.files.map(item => item.file.name), ['one.png'])

  pruneDrafts(['classic-s1'], storage)
  const afterPrune = JSON.parse(storage.getItem(STORAGE.drafts))
  assert.equal(afterPrune['classic-s1'], undefined)
  assert.equal(afterPrune['classic-s2'].text, 'draft two')
  assert.equal(afterPrune.bee.text, 'bot draft')
})

// Real DSH session + conversation fixtures matching SessionSnapshot and ChatSnapshot.
const chatSnapshot = (messages = []) => {
  const map = new Map()
  const order = []
  for (const [index, msg] of messages.entries()) {
    const key = `msg-${index + 1}`
    order.push(key)
    map.set(key, {
      kind: msg.kind ?? 'user',
      anchorSeq: msg.seq,
      data: {
        kind: msg.kind ?? 'user',
        ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
        seq: msg.seq,
        content: [{ type: 'text', text: msg.text }],
        source: { kind: 'user', ...(msg.rpcId !== undefined ? { rpcId: msg.rpcId } : {}) },
      },
    })
  }
  return { views: { get: target => (target === 'chat' ? { order, nodes: { get: k => map.get(k), values: () => [...map.values()] } } : undefined) } }
}

const sessionHooks = ({ session = { openState: 'open', pendingSubmissions: [] }, messages = [], nextStep = [] } = {}) => {
  const conv = { messages }
  const inbox = { 'next-step': nextStep }
  return {
    session,
    conv,
    inbox,
    useSession: pick => pick(session),
    useConversation: pick => pick(chatSnapshot(conv.messages)),
    useProjection: (key, pick) => {
      const value = key === 'inbox' ? inbox : undefined
      return typeof pick === 'function' ? pick(value) : value
    },
  }
}

test('DraftKeeper clears the sent text only after Host admission is confirmed (#1891)', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const actions = {
    draftFiles: () => [],
    restoreDraftFiles: () => [],
    releaseDraftFiles: () => {},
    reopenPastes: () => {},
  }
  const inputActions = { setDraft: text => setDrafts.push(text), addAttachments: () => true }
  const state = { draft: 'hello there', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks()
  const props = {
    sessionId: 'bee-2', inputActions, actions,
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
    useSession: host.useSession,
    useConversation: host.useConversation,
  }

  // The user types, sends, and leaves before the shell commits the emptied draft.
  render(props)
  state.phase = 'sending'
  render(props)

  // Returning while history is still loading waits without wiping or keeping stale text.
  state.phase = 'plain'
  host.session.openState = 'loading'
  remount(props)
  assert.deepEqual(setDrafts, [], 'waits for session history before deciding')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), {}, 'does not re-keep stale text while loading')

  // Host history opens with the admitted durable user message: now the stale draft clears.
  host.session.openState = 'open'
  host.conv.messages = [{ seq: 1, text: 'hello there' }]
  render(props)
  assert.deepEqual(setDrafts, [''], 'the admitted sent text is cleared from the box')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), {}, 'and it is not carried to a newer part')
})

test('DraftKeeper preserves an unsent draft when a mid-send navigation aborted or Host refused before admission (#2003 review)', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const state = { draft: '继续', attachmentIds: [], phase: 'plain', queue: [] }
  // Pre-existing turn already contains the same text at seq 2.
  const host = sessionHooks({ messages: [{ seq: 2, text: '继续' }] })
  const props = {
    sessionId: 'bee-2',
    inputActions: { setDraft: text => setDrafts.push(text), addAttachments: () => true },
    actions: { draftFiles: () => [], restoreDraftFiles: () => [], releaseDraftFiles: () => {}, reopenPastes: () => {} },
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
    useSession: host.useSession,
    useConversation: host.useConversation,
  }

  render(props)
  state.phase = 'sending'
  render(props)

  // User navigated away before Host accepted (aborted on scope disposal or refused):
  // no new pendingSubmission, queue item, or durable message above seq 2 exists.
  state.phase = 'plain'
  remount(props)
  assert.deepEqual(setDrafts, [], 'unconfirmed send must NOT wipe the unsent draft')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: '继续' } }, 'the unsent draft stays kept for retry')
})

test('DraftKeeper does not carry a sent text to the part the chat moved to', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const actions = {
    draftFiles: () => [],
    restoreDraftFiles: () => [],
    releaseDraftFiles: () => {},
    reopenPastes: () => {},
  }
  const inputActions = { setDraft: text => setDrafts.push(text), addAttachments: () => true }
  const state = { draft: 'hello there', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks()
  const props = {
    sessionId: 'bee-2', inputActions, actions,
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
    useSession: host.useSession,
    useConversation: host.useConversation,
  }

  remount(props)
  state.phase = 'sending'
  render(props)
  // The chat moved on to a newer part while the reply finished; its box starts empty.
  state.phase = 'plain'
  state.draft = ''
  const moved = { ...props, sessionId: 'bee-4', useRoster: pick => pick({ byId: { 'bee-4': { id: 'bee', sessionId: 'bee-4', parts: ['bee', 'bee-2'] } }, roomsById: {} }) }
  remount(moved)
  assert.deepEqual(setDrafts, [], 'the new part opens empty')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), {}, 'the sent text is gone for good')
})

test('DraftKeeper keeps a command draft even though its composer closed while it settled', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const actions = {
    draftFiles: () => [],
    restoreDraftFiles: () => [],
    releaseDraftFiles: () => {},
    reopenPastes: () => {},
  }
  const inputActions = { setDraft: text => setDrafts.push(text), addAttachments: () => true }
  const state = { draft: '/goal ship it', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks()
  const props = {
    sessionId: 'bee-2', inputActions, actions,
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
    useSession: host.useSession,
    useConversation: host.useConversation,
  }

  remount(props)
  state.phase = 'submitting'
  render(props)
  // A command is not a message that went out: the text stays the user's.
  state.phase = 'plain'
  remount(props)
  assert.deepEqual(setDrafts, [], 'the command text is not cleared')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: '/goal ship it' } })
})

// One visit of a composer: the shell mounts it for a chat, in a page that keeps its own
// memory while browser storage is shared by every tab.
const draftKeeperProps = (state, setDrafts, host = sessionHooks()) => ({
  sessionId: 'bee-2',
  inputActions: { setDraft: text => setDrafts.push(text), addAttachments: () => true },
  actions: { draftFiles: () => [], restoreDraftFiles: () => [], releaseDraftFiles: () => {}, reopenPastes: () => {} },
  useRoster: pick => pick(roster),
  useInput: pick => pick(state),
  useSession: host.useSession,
  useConversation: host.useConversation,
  useProjection: host.useProjection,
})

test("a send never clears another tab's draft, and each tab still clears its own admitted sent text (#2003 review)", () => {
  const ls = memoryStorage()
  const tabA = loadKeeper(ls)
  const tabB = loadKeeper(ls)
  const hostA = sessionHooks()
  const hostB = sessionHooks()
  const stateA = { draft: '继续', attachmentIds: [], phase: 'plain', queue: [] }
  const stateB = { draft: '继续', attachmentIds: [], phase: 'plain', queue: [] }
  const setA = []
  const setB = []
  const propsA = draftKeeperProps(stateA, setA, hostA)
  const propsB = draftKeeperProps(stateB, setB, hostB)

  // Tab A sends '继续' and leaves mid-send; Host admits it.
  tabA.render(propsA)
  stateA.phase = 'sending'
  tabA.render(propsA)
  hostA.conv.messages = [{ seq: 1, text: '继续' }]
  hostB.conv.messages = [{ seq: 1, text: '继续' }]

  // Tab B opens bee-2 and writes a fresh unsent draft with the same text '继续'.
  tabB.remount(propsB)
  assert.deepEqual(setB, [], "tab A's sent text does not clear tab B's draft")
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: '继续' } })

  // Tab A returns to bee-2: even though Tab A's earlier send was admitted, Tab B wrote
  // a fresh unsent draft for bee-2 in shared storage, so Tab A must NOT erase it.
  stateA.phase = 'plain'
  tabA.remount(propsA)
  assert.deepEqual(setA, [], "tab A returning must not erase tab B's fresh same-text draft")
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: '继续' } })

  // When no other tab wrote a fresh draft for bee-2, Tab A clears its own admitted sent text.
  setA.length = 0
  stateA.draft = '继续2'
  stateA.phase = 'plain'
  tabA.render(propsA)
  stateA.phase = 'sending'
  tabA.render(propsA)
  hostA.conv.messages = [{ seq: 1, text: '继续' }, { seq: 2, text: '继续2' }]
  stateA.phase = 'plain'
  tabA.remount(propsA)
  assert.deepEqual(setA, [''], 'tab A still clears its own admitted sent text when no other tab replaced it')
})

test("clearing a sent draft passes '' to takeDraft so an earlier part's waiting draft is carried instead of wiped (#2003 review)", () => {
  const ls = memoryStorage()
  const { keepDraft: keep, takeDraft: take, render, remount } = loadKeeper(ls)
  keep({ chatId: 'bee', part: 'bee', text: 'older unsent text', files: [image('red.png')] }, ls)

  const setDrafts = []
  const attached = []
  const reopened = []
  const state = { draft: 'look at this', attachmentIds: [], phase: 'sending', queue: [] }
  const host = sessionHooks()
  const props = {
    sessionId: 'bee-2',
    inputActions: {
      setDraft: (text) => { setDrafts.push(text); state.draft = text },
      addAttachments: (ids) => { attached.push(...ids); state.attachmentIds = [...ids]; return true },
    },
    actions: {
      draftFiles: ids => ids.map(() => image('red.png')),
      restoreDraftFiles: () => ['draft-7'],
      releaseDraftFiles: () => {},
      reopenPastes: (from, to) => reopened.push([from, to]),
    },
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
    useSession: host.useSession,
    useConversation: host.useConversation,
  }

  // Composer opens mid-send on bee-2: earlier part's draft in bee stays untouched.
  render(props)
  const preserved = take({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, ls)
  assert.equal(preserved.text, 'older unsent text', "the earlier part's draft is not dropped by the send")
  assert.deepEqual(Array.from(preserved.files, item => item.file.name), ['red.png'])

  // Composer leaves mid-send; Host admits 'look at this'; returning hands stale 'look at this' back.
  state.phase = 'plain'
  host.session.pendingSubmissions = [{ requestId: 'req-1', placement: 'transcript', time: 1, text: 'look at this', attachments: [] }]
  remount(props)
  assert.deepEqual(setDrafts, ['older unsent text'], 'replaces stale sent text with the earlier part draft')
  assert.deepEqual(attached, ['draft-7'])
  assert.deepEqual(reopened, [['bee', 'bee-2']])
  // Next render after restored draft lands must keep it under bee-2 instead of wiping it.
  render(props)
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'older unsent text' } })
})

test("a composer mounted mid-send leaves an earlier part's draft for the take when the send settles normally (#2003 review)", () => {
  const ls = memoryStorage()
  const { keepDraft: keep, takeDraft: take, render } = loadKeeper(ls)
  keep({ chatId: 'bee', part: 'bee', text: 'older unsent text', files: [image('red.png')] }, ls)

  const setDrafts = []
  const state = { draft: 'look at this', attachmentIds: [], phase: 'sending', queue: [] }
  const props = draftKeeperProps(state, setDrafts)

  render(props)
  const preserved = take({ chatId: 'bee', part: 'bee-2', text: '', attached: 0 }, ls)
  assert.equal(preserved.text, 'older unsent text', "the earlier part's draft is not dropped by the send")
  assert.deepEqual(Array.from(preserved.files, item => item.file.name), ['red.png'])

  // The send settles without handing its text back: the earlier draft is carried now.
  state.phase = 'plain'
  state.draft = ''
  render(props)
  assert.deepEqual(setDrafts, ['older unsent text'])
})

// A chat with two parallel Sessions: whichever one the user looks at is the chat's
// current part, as in the roster the client builds.
const parallelRoster = current => ({
  byId: {
    'bee-a': { id: 'bee', sessionId: current, parts: ['bee-a', 'bee-b'] },
    'bee-b': { id: 'bee', sessionId: current, parts: ['bee-a', 'bee-b'] },
  },
  roomsById: {},
})

const parallelProps = (session, state, setDrafts, host = sessionHooks()) => ({
  sessionId: session,
  inputActions: { setDraft: text => setDrafts.push(text), addAttachments: () => true },
  actions: { draftFiles: () => [], restoreDraftFiles: () => [], releaseDraftFiles: () => {}, reopenPastes: () => {} },
  useRoster: pick => pick(parallelRoster(session)),
  useInput: pick => pick(state),
  useSession: host.useSession,
  useConversation: host.useConversation,
})

test("another Session of the same chat does not take the sent text (#2003 review)", () => {
  const ls = memoryStorage()
  const page = loadKeeper(ls)
  const hostA = sessionHooks()
  const hostB = sessionHooks()
  const stateA = { draft: '继续', attachmentIds: [], phase: 'plain', queue: [] }
  const stateB = { draft: '继续', attachmentIds: [], phase: 'plain', queue: [] }
  const setA = []
  const setB = []
  const propsA = parallelProps('bee-a', stateA, setA, hostA)
  const propsB = parallelProps('bee-b', stateB, setB, hostB)

  // Session A is open and sends the text; Host queues it on A.
  page.render(propsA)
  stateA.phase = 'sending'
  page.render(propsA)
  stateA.queue = [{ id: 'q-1', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }]

  // The user switches to parallel Session B, whose unsent draft has the same text.
  page.remount(propsB)
  assert.deepEqual(setB, [], "Session A's sent text does not clear B's draft")

  // Clear B's draft before returning so B does not carry its text into A; A still
  // clears its own admitted sent text because B never consumed A's sent watch.
  stateB.draft = ''
  page.render(propsB)
  stateA.phase = 'plain'
  page.remount(propsA)
  assert.deepEqual(setA, [''], 'A still clears its own admitted sent text')
})

test("a different draft in another Session does not consume the sent text (#2003 review)", () => {
  const ls = memoryStorage()
  const page = loadKeeper(ls)
  const hostA = sessionHooks()
  const hostB = sessionHooks()
  const stateA = { draft: '继续', attachmentIds: [], phase: 'plain', queue: [] }
  const stateB = { draft: 'other', attachmentIds: [], phase: 'plain', queue: [] }
  const setA = []
  const setB = []
  const propsA = parallelProps('bee-a', stateA, setA, hostA)
  const propsB = parallelProps('bee-b', stateB, setB, hostB)

  page.render(propsA)
  stateA.phase = 'sending'
  page.render(propsA)
  hostA.conv.messages = [{ seq: 1, text: '继续' }]

  page.remount(propsB)
  assert.deepEqual(setB, [], "B's own draft is untouched")
  // Returning to A clears A's stale sent text and carries B's kept draft rather than
  // leaving A's sent text in the box (which would happen if B had consumed A's watch).
  stateA.phase = 'plain'
  page.remount(propsA)
  assert.deepEqual(setA, ['other'], "B did not consume A's admitted sent text")
})

test('isSentAdmitted normalizes quote-reply boundaries (blank lines and inline quote separator) without collapsing plain text (#2003 review)', () => {
  const baseline = captureAdmissionBaseline()
  // Single newline between quote and body vs DSH serializeDraftPrompt blank line.
  assert.equal(isSentAdmitted(
    { text: '> quote\nhello', baseline, admitted: false },
    { pendingSubmissions: [{ requestId: 'r1', text: '> quote\n\nhello' }] },
  ), true)
  // Inline QuoteNode clipboard projection (`> quote Please explain`) vs serialized `> quote\n\nPlease explain`.
  assert.equal(isSentAdmitted(
    { text: '> quote Please explain', baseline, admitted: false },
    { chat: chatSnapshot([{ seq: 1, text: '> quote\n\nPlease explain' }]).views.get('chat') },
  ), true)
  // Multi-line quote + intro + reply body across queue and next-step channels.
  assert.equal(isSentAdmitted(
    { text: 'intro\n> line 1\n> line 2\nPlease explain', baseline, admitted: false },
    { queue: [{ id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: 'intro\n\n> line 1\n> line 2\n\nPlease explain' }] }] },
  ), true)
  assert.equal(isSentAdmitted(
    { text: 'intro > line 1\n> line 2 Please explain', baseline, admitted: false },
    { nextStep: [{ id: 's1', source: { kind: 'user' }, content: [{ type: 'text', text: 'intro\n\n> line 1\n> line 2\n\nPlease explain' }] }] },
  ), true)
  // Plain text blank-line differences and mismatched replies must NOT falsely match.
  assert.equal(isSentAdmitted(
    { text: 'hello\nworld', baseline, admitted: false },
    { pendingSubmissions: [{ requestId: 'r2', text: 'hello\n\nworld' }] },
  ), false)
  assert.equal(isSentAdmitted(
    { text: 'hello world', baseline, admitted: false },
    { pendingSubmissions: [{ requestId: 'r3', text: 'hello\n\nworld' }] },
  ), false)
  assert.equal(isSentAdmitted(
    { text: '> quote\nhello', baseline, admitted: false },
    { pendingSubmissions: [{ requestId: 'r4', text: '> quote\n\nother' }] },
  ), false)
})

test('DraftKeeper clears an admitted quote+body reply even when editor draft and serialized prompt differ at the quote boundary (#2003 review)', () => {
  for (const draftText of ['> quoted text\nPlease explain', '> quoted text Please explain']) {
    const ls = memoryStorage()
    const { render, remount } = loadKeeper(ls)
    const setDrafts = []
    const state = { draft: draftText, attachmentIds: [], phase: 'plain', queue: [] }
    const host = sessionHooks()
    const props = draftKeeperProps(state, setDrafts, host)

    render(props)
    state.phase = 'sending'
    render(props)

    // Host serializes quote boundary with a blank line (`\n\n`).
    host.conv.messages = [{ seq: 1, text: '> quoted text\n\nPlease explain' }]
    state.phase = 'plain'
    remount(props)
    assert.deepEqual(setDrafts, [''], `must clear stale quote reply draft: ${JSON.stringify(draftText)}`)
    assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), {})
  }
})

test('DraftKeeper uses the pre-send baseline so fast local Host acceptance before the sending effect still clears on return (#2003 review)', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const state = { draft: 'fast local send', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks({ messages: [{ seq: 2, text: 'earlier' }] })
  const props = draftKeeperProps(state, setDrafts, host)

  // Plain render establishes pre-send baseline at seq 2.
  render(props)

  // Fast local Host admits seq 3 BEFORE DraftKeeper's 'sending' effect runs.
  state.phase = 'sending'
  host.conv.messages = [{ seq: 2, text: 'earlier' }, { seq: 3, text: 'fast local send' }]
  render(props)

  // User navigates away and later returns with stale sent text in editor.
  state.phase = 'plain'
  remount(props)
  assert.deepEqual(setDrafts, [''], 'fast local acceptance must not be absorbed into the send baseline')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), {})
})

test('DraftKeeper confirms steering admission via inbox next-step projection when pendingSubmissions already retired (#2003 review)', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const state = { draft: 'stop and check tests', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks({
    nextStep: [{ id: 'old-steer', source: { kind: 'user' }, content: [{ type: 'text', text: 'stop and check tests' }] }],
  })
  const props = draftKeeperProps(state, setDrafts, host)

  render(props)
  state.phase = 'sending'
  render(props)

  // Failed/aborted steer: only the pre-existing baseline next-step item exists -> must NOT clear.
  state.phase = 'plain'
  remount(props)
  assert.deepEqual(setDrafts, [], 'pre-existing next-step item must not falsely confirm a failed steer')

  // Retry steer: Host admits a new next-step item and retires pendingSubmissions before step completes.
  state.phase = 'sending'
  render(props)
  host.inbox['next-step'] = [
    ...host.inbox['next-step'],
    { id: 'new-steer', source: { kind: 'user' }, content: [{ type: 'text', text: 'stop and check tests' }] },
  ]
  state.phase = 'plain'
  remount(props)
  assert.deepEqual(setDrafts, [''], 'new inbox next-step item confirms steering admission and clears stale draft')
})

test('entering sending or dropPartDraft cancels a pending 300ms debounced draft write and syncs cross-tab hasLivePartDraft (#2003 review)', async () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls, { setTimeout, clearTimeout })
  const setDrafts = []
  const state = { draft: 'typed just before enter', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks()
  const props = draftKeeperProps(state, setDrafts, host)

  // Plain typing schedules a 300ms debounced write (not in storage yet).
  render(props)
  assert.equal(ls.getItem(STORAGE.drafts), null, 'debounced write should still be pending')

  // User presses Enter within 300ms -> must clear and cancel the debounce timer.
  state.phase = 'sending'
  render(props)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(ls.getItem(STORAGE.drafts), '{}', 'cancelled debounce timer must not resurrect the sent draft')

  // Another tab writes a fresh draft directly into shared storage while this tab's cache holds '{}'.
  ls.setItem(STORAGE.drafts, JSON.stringify({ bee: { part: 'bee-2', text: 'typed just before enter' } }))
  host.conv.messages = [{ seq: 1, text: 'typed just before enter' }]
  state.phase = 'plain'
  remount(props)
  assert.deepEqual(setDrafts, [], 'synced hasLivePartDraft must detect another tab writing a fresh draft')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'typed just before enter' } })

  // Direct dropPartDraft also cancels a pending 300ms debounced write for that part.
  const ls2 = memoryStorage()
  keepDraft({ chatId: 'bee', part: 'bee-2', text: 'debounced drop', files: [] }, ls2, { deferMs: 300 })
  dropPartDraft({ chatId: 'bee', part: 'bee-2' }, ls2)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(ls2.getItem(STORAGE.drafts), '{}')
})

test('clearing an admitted sent draft lands a rescued question-card draft cleanly without re-injecting the sent text (#2003 review)', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const consumed = []
  let rescuedMap = {}
  const state = { draft: 'sent message', attachmentIds: [], phase: 'plain', queue: [], occurrences: [] }
  const host = sessionHooks()
  const props = {
    sessionId: 'bee-2',
    inputActions: {
      setDraft: (text) => { setDrafts.push(text); state.draft = text },
      addAttachments: () => true,
    },
    actions: {
      draftFiles: () => [],
      restoreDraftFiles: () => [],
      releaseDraftFiles: () => {},
      reopenPastes: () => {},
      consumeRescuedDraft: (chatId, sessionId, text) => {
        consumed.push([chatId, sessionId, text])
        rescuedMap = {}
      },
    },
    useRoster: pick => pick(roster),
    useInput: pick => pick(state),
    useSession: host.useSession,
    useConversation: host.useConversation,
    useProjection: host.useProjection,
    useRescuedDrafts: pick => pick(rescuedMap),
  }

  render(props)
  state.phase = 'sending'
  render(props)

  // While away, Host admits the sent message and an interrupted question card rescues a draft.
  rescuedMap = { bee: 'rescued answer' }
  state.phase = 'plain'
  host.session.openState = 'loading'
  remount(props)
  assert.deepEqual(setDrafts, [], 'waits while session is loading before deciding')

  host.session.openState = 'open'
  host.conv.messages = [{ seq: 1, text: 'sent message' }]
  render(props)
  assert.deepEqual(setDrafts, ['rescued answer'], 'replaces stale sent text with only the rescued answer')
  assert.deepEqual(consumed, [['bee', 'bee-2', 'rescued answer']])
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'rescued answer' } })
})

test('maxUserSeqOf skips trailing synthetic user nodes without seq and works with plain iterables without Iterator#filter (#2003 review)', () => {
  const nodes = new Map([
    ['u1', { kind: 'user', anchorSeq: 4, data: { seq: 4, content: [{ type: 'text', text: 'durable' }] } }],
    ['u-opt', { kind: 'user', data: { content: [{ type: 'text', text: 'optimistic' }] } }],
  ])
  const chatWithTrailingOptimistic = { order: ['u1', 'u-opt'], nodes }
  assert.equal(maxUserSeqOf(chatWithTrailingOptimistic), 4)

  // Plain iterable (no `.filter` method, simulating Safari < 18.4 / older WebView).
  const plainIterable = {
    [Symbol.iterator]() {
      const list = [{ kind: 'user', anchorSeq: 6, data: { seq: 6, content: [{ type: 'text', text: 'hello' }] } }]
      let index = 0
      return { next: () => (index < list.length ? { value: list[index++], done: false } : { value: undefined, done: true }) }
    },
  }
  const chatWithPlainIterable = { nodes: { values: () => plainIterable } }
  assert.equal(maxUserSeqOf(chatWithPlainIterable), 6)
  assert.equal(isSentAdmitted(
    { text: 'hello', baseline: { maxUserSeq: 5, pendingIds: new Set(), queueIds: new Set() }, admitted: false },
    { chat: chatWithPlainIterable },
  ), true)
})

test('a pre-existing baseline-queued message draining into the transcript does not satisfy admission of an identical unsent retry (#2003 review)', () => {
  const baseline = captureAdmissionBaseline({
    chat: chatSnapshot([{ seq: 2, messageId: 'm-1', text: 'earlier' }]).views.get('chat'),
    pendingSubmissions: [{ requestId: 'rpc-pending', text: '继续' }],
    queue: [{ id: 'q-old', source: { kind: 'user', rpcId: 'rpc-old' }, content: [{ type: 'text', text: '继续' }] }],
  })
  const watch = { text: '继续', baseline, admitted: false }

  // 1) Real DSH path: baseline-queued item drains into transcript carrying its messageId / source.rpcId.
  assert.equal(isSentAdmitted(watch, {
    queue: [],
    chat: chatSnapshot([
      { seq: 2, messageId: 'm-1', text: 'earlier' },
      { seq: 8, messageId: 'q-old', rpcId: 'rpc-old', text: '继续' },
    ]).views.get('chat'),
  }), false, 'baseline-queued message moved into transcript must NOT confirm a new send')

  // Same check when only messageId or only rpcId is present, or when a baseline pendingSubmission enters queue/transcript.
  assert.equal(isSentAdmitted(watch, {
    queue: [],
    chat: chatSnapshot([{ seq: 8, messageId: 'q-old', text: '继续' }]).views.get('chat'),
  }), false, 'messageId alone excludes drained baseline queue item')
  assert.equal(isSentAdmitted(watch, {
    queue: [{ id: 'q-from-pending', source: { kind: 'user', rpcId: 'rpc-pending' }, content: [{ type: 'text', text: '继续' }] }],
  }), false, 'source.rpcId excludes baseline pendingSubmission moving into queue')
  assert.equal(isSentAdmitted(watch, {
    queue: [],
    chat: chatSnapshot([{ seq: 8, messageId: 'm-from-pending', rpcId: 'rpc-pending', text: '继续' }]).views.get('chat'),
  }), false, 'source.rpcId excludes baseline pendingSubmission moving into transcript')

  // 2) Synthetic/unidentified transcript node path (no messageId or rpcId): count-based guard blocks a single drain.
  assert.equal(isSentAdmitted(watch, {
    queue: [],
    chat: chatSnapshot([{ seq: 8, text: '继续' }]).views.get('chat'),
  }), false, 'single unidentified transcript node cannot confirm admission when one baseline-queued item drained')
  assert.equal(isSentAdmitted(watch, {
    queue: [],
    chat: chatSnapshot([{ seq: 8, text: '继续' }, { seq: 10, text: '继续' }]).views.get('chat'),
  }), true, 'second matching transcript node beyond drained baseline count confirms new send')

  // 3) Once a genuinely new message (distinct messageId) also arrives in transcript, admission is confirmed.
  assert.equal(isSentAdmitted(watch, {
    queue: [],
    chat: chatSnapshot([
      { seq: 8, messageId: 'q-old', rpcId: 'rpc-old', text: '继续' },
      { seq: 10, messageId: 'q-new', rpcId: 'rpc-new', text: '继续' },
    ]).views.get('chat'),
  }), true, 'distinct new messageId confirms admission even after old queued message drained')

  // 4) End-to-end DraftKeeper: aborted repeat send while baseline queued message drains preserves unsent retry draft.
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const state = {
    draft: '继续',
    attachmentIds: [],
    phase: 'plain',
    queue: [{ id: 'q-old', source: { kind: 'user', rpcId: 'rpc-old' }, content: [{ type: 'text', text: '继续' }] }],
  }
  const host = sessionHooks({ messages: [{ seq: 2, messageId: 'm-1', text: 'earlier' }] })
  const props = draftKeeperProps(state, setDrafts, host)

  render(props)
  state.phase = 'sending'
  render(props)

  // User leaves mid-send (aborted before admission); while away, q-old runs and enters the transcript at seq 8.
  state.phase = 'plain'
  state.queue = []
  host.conv.messages = [
    { seq: 2, messageId: 'm-1', text: 'earlier' },
    { seq: 8, messageId: 'q-old', rpcId: 'rpc-old', text: '继续' },
  ]
  remount(props)
  assert.deepEqual(setDrafts, [], 'unsent retry draft must NOT be wiped when only pre-existing queued message drained')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: '继续' } })
})

test('unrelated queue or transcript updates on an untouched empty composer do not erase another tab\'s saved draft (#2003 review)', async () => {
  const ls = memoryStorage()
  const storageListeners = []
  const fakeWindow = {
    addEventListener: (type, fn) => { if (type === 'storage') storageListeners.push(fn) },
    removeEventListener: () => {},
  }
  const tabA = loadKeeper(ls, { window: fakeWindow, setTimeout, clearTimeout })
  const tabB = loadKeeper(ls, { setTimeout, clearTimeout })
  const hostA = sessionHooks({ messages: [{ seq: 1, messageId: 'm-1', text: 'hi' }] })
  const hostB = sessionHooks({ messages: [{ seq: 1, messageId: 'm-1', text: 'hi' }] })
  const stateA = {
    draft: '',
    attachmentIds: [],
    phase: 'plain',
    queue: [{ id: 'q-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'queued work' }] }],
  }
  const stateB = { draft: 'Check the deployment notes', attachmentIds: [], phase: 'plain', queue: stateA.queue }
  const setA = []
  const setB = []
  const propsA = draftKeeperProps(stateA, setA, hostA)
  const propsB = draftKeeperProps(stateB, setB, hostB)

  // Tab A opens with an empty composer and settles.
  tabA.render(propsA)
  await new Promise(resolve => setTimeout(resolve, 350))

  // Tab B types and saves a fresh draft in shared storage; browser notifies Tab A via storage event.
  tabB.render(propsB)
  await new Promise(resolve => setTimeout(resolve, 350))
  const savedRaw = ls.getItem(STORAGE.drafts)
  assert.deepEqual(JSON.parse(savedRaw), { bee: { part: 'bee-2', text: 'Check the deployment notes' } })
  for (const fn of storageListeners) fn({ key: STORAGE.drafts, newValue: savedRaw })

  // In Tab A, user deletes the queued item and new host messages / steering / pendingSubmissions arrive
  // without ever editing Tab A's empty composer.
  stateA.queue = []
  hostA.conv.messages = [
    { seq: 1, messageId: 'm-1', text: 'hi' },
    { seq: 2, messageId: 'm-2', text: 'incoming message' },
  ]
  hostA.inbox['next-step'] = [{ id: 'st-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'steer' }] }]
  hostA.session.pendingSubmissions = [{ requestId: 'req-other', placement: 'transcript', time: 2, text: 'other', attachments: [] }]
  tabA.render(propsA)
  await new Promise(resolve => setTimeout(resolve, 350))

  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Check the deployment notes' } }, 'Tab B carry-over draft must survive Tab A queue/transcript updates')
  assert.equal(takeDraft({ chatId: 'bee', part: 'bee-3', text: '', attached: 0 }, ls).text, 'Check the deployment notes')
})

test('deferred restore after loading persists an unadmitted retry draft without needing another edit (#2003 review)', () => {
  const ls = memoryStorage()
  const { render, remount } = loadKeeper(ls)
  const setDrafts = []
  const state = { draft: 'retry me', attachmentIds: [], phase: 'plain', queue: [] }
  const host = sessionHooks()
  const props = draftKeeperProps(state, setDrafts, host)

  render(props)
  state.phase = 'sending'
  render(props)

  // Return while session is still loading, then open with NO admission (aborted send).
  state.phase = 'plain'
  host.session.openState = 'loading'
  remount(props)
  assert.deepEqual(setDrafts, [])
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), {})

  host.session.openState = 'open'
  render(props)
  assert.deepEqual(setDrafts, [], 'unadmitted retry draft stays in composer')
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'retry me' } }, 'deferred restore persists recovered retry draft')
})

test('deferred restore does not overwrite another tab\'s newer live draft when openState finishes loading (#2003 review)', async () => {
  const ls = memoryStorage()
  const tabA = loadKeeper(ls, { setTimeout, clearTimeout })
  const tabB = loadKeeper(ls, { setTimeout, clearTimeout })
  const setA = []
  const setB = []
  const stateA = { draft: 'Run the tests', attachmentIds: [], phase: 'plain', queue: [] }
  const stateB = { draft: 'Review the results', attachmentIds: [], phase: 'plain', queue: [] }
  const hostA = sessionHooks()
  const hostB = sessionHooks()
  const propsA = draftKeeperProps(stateA, setA, hostA)
  const propsB = draftKeeperProps(stateB, setB, hostB)

  // Tab A sends, switches away, and returns while session is still loading.
  tabA.render(propsA)
  stateA.phase = 'sending'
  tabA.render(propsA)
  stateA.phase = 'plain'
  hostA.session.openState = 'loading'
  tabA.remount(propsA)
  assert.deepEqual(setA, [])

  // While Tab A is loading, Tab B saves a newer draft for the same session.
  tabB.render(propsB)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } })

  // Tab A finishes loading with unchanged editor/projection values -> must preserve Tab B's draft.
  hostA.session.openState = 'open'
  tabA.render(propsA)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(setA, [])
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } })
})

test('direct remount on an already-open session does not overwrite another tab\'s newer live draft (#2003 review)', async () => {
  const ls = memoryStorage()
  const tabA = loadKeeper(ls, { setTimeout, clearTimeout })
  const tabB = loadKeeper(ls, { setTimeout, clearTimeout })
  const setA = []
  const setB = []
  const stateA = { draft: 'Run the tests', attachmentIds: [], phase: 'plain', queue: [] }
  const stateB = { draft: 'Review the results', attachmentIds: [], phase: 'plain', queue: [] }
  const hostA = sessionHooks({ openState: 'open' })
  const hostB = sessionHooks({ openState: 'open' })
  const propsA = draftKeeperProps(stateA, setA, hostA)
  const propsB = draftKeeperProps(stateB, setB, hostB)

  // Tab A sends and switches away.
  tabA.render(propsA)
  stateA.phase = 'sending'
  tabA.render(propsA)

  // Tab B saves a newer distinct draft for the same session.
  tabB.render(propsB)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } })

  // Tab A directly remounts onto the already-open session without editing -> must preserve Tab B's draft.
  stateA.phase = 'plain'
  tabA.remount(propsA)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(setA, [])
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } })

  // Once the user genuinely edits in Tab A, that new edit persists normally.
  stateA.draft = 'Updated locally in Tab A'
  tabA.render(propsA)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Updated locally in Tab A' } })
})

test('isSentAdmitted matches inline quote replies whose body contains whitespace-only lines (#2003 review)', () => {
  const baseline = captureAdmissionBaseline()
  // Inline quote followed by body containing a spaces-only line vs DSH serialized blank-line boundary.
  assert.equal(isSentAdmitted(
    { text: '> quote Explain\n \nMore', baseline, admitted: false },
    { pendingSubmissions: [{ requestId: 'r-ws-1', text: '> quote\n\nExplain\n \nMore' }] },
  ), true)
  assert.equal(isSentAdmitted(
    { text: '> quote\nExplain\n \nMore', baseline, admitted: false },
    { chat: chatSnapshot([{ seq: 1, messageId: 'm-ws-1', text: '> quote\n\nExplain\n \nMore' }]).views.get('chat') },
  ), true)
  // Distinct body whitespace must not falsely match.
  assert.equal(isSentAdmitted(
    { text: '> quote Explain\n\nMore', baseline, admitted: false },
    { pendingSubmissions: [{ requestId: 'r-ws-2', text: '> quote\n\nExplain\n \nMore' }] },
  ), false)
})

test('preserving another tab\'s live text draft still keeps this page\'s private attachment draft (#2003 review)', async () => {
  for (const mode of ['direct', 'deferred']) {
    const ls = memoryStorage()
    const tabA = loadKeeper(ls, { setTimeout, clearTimeout })
    const tabB = loadKeeper(ls, { setTimeout, clearTimeout })
    const setA = []
    const setB = []
    const restoredNames = []
    const localFile = image('local-image.png')
    const extraFile = image('extra-image.png')
    const fileMap = { 'att-1': localFile, 'att-2': extraFile }
    const stateA = { draft: 'Run the tests', attachmentIds: [], phase: 'plain', queue: [] }
    const stateB = { draft: 'Review the results', attachmentIds: [], phase: 'plain', queue: [] }
    const hostA = sessionHooks({ openState: 'open' })
    const hostB = sessionHooks({ openState: 'open' })
    const propsA = {
      ...draftKeeperProps(stateA, setA, hostA),
      actions: {
        draftFiles: ids => ids.map(id => fileMap[id]).filter(Boolean),
        restoreDraftFiles: (_sid, files) => {
          restoredNames.push(...files.map(file => file.name))
          return files.map((_file, idx) => `restored-${idx}`)
        },
        releaseDraftFiles: () => {},
        reopenPastes: () => {},
      },
    }
    const propsB = draftKeeperProps(stateB, setB, hostB)

    // Tab A starts a send, switches away, and Tab B saves a competing live text draft.
    tabA.render(propsA)
    stateA.phase = 'sending'
    tabA.render(propsA)

    tabB.render(propsB)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } })

    // Tab A returns with a local attachment while the box still holds the sent text.
    stateA.phase = 'plain'
    stateA.attachmentIds = ['att-1']
    if (mode === 'deferred') {
      hostA.session.openState = 'loading'
      tabA.remount(propsA)
      hostA.session.openState = 'open'
      tabA.render(propsA)
    } else {
      tabA.remount(propsA)
    }
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(setA, [], `${mode}: must not clear composer text`)
    assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } }, `${mode}: Tab B text stays intact`)

    // Adding a second attachment in Tab A without editing text updates private files only.
    stateA.attachmentIds = ['att-1', 'att-2']
    tabA.render(propsA)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(JSON.parse(ls.getItem(STORAGE.drafts)), { bee: { part: 'bee-2', text: 'Review the results' } }, `${mode}: attachment change does not overwrite Tab B text`)

    // Tab A switches away and remounts with empty attachments -> private attachments restore.
    stateA.attachmentIds = []
    tabA.remount(propsA)
    assert.deepEqual(restoredNames, ['local-image.png', 'extra-image.png'], `${mode}: private attachments survive competing Tab B text draft`)

    // Once restored attachment IDs land on that second remount (with either stale sent text or
    // an empty box in Tab A), Tab B's shared text draft must STILL remain intact.
    for (const secondMountDraft of ['Run the tests', '']) {
      stateA.draft = secondMountDraft
      stateA.attachmentIds = []
      tabA.remount(propsA)
      stateA.attachmentIds = ['restored-0', 'restored-1']
      tabA.render(propsA)
      await new Promise(resolve => setTimeout(resolve, 350))
      assert.deepEqual(
        JSON.parse(ls.getItem(STORAGE.drafts)),
        { bee: { part: 'bee-2', text: 'Review the results' } },
        `${mode} (second remount draft=${JSON.stringify(secondMountDraft)}): Tab B text stays intact`,
      )
    }
  }
})
