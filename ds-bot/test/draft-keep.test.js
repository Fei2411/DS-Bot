import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { chatOfSession, forgetKeptFiles, keepDraft, pruneDrafts, takeDraft } from '../src/client/draft-keep.js'
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
})


function loadKeeper(localStorage) {
  let cursor = 0
  const slots = []
  const pendingEffects = []
  const depsChanged = (prev, next) => prev === undefined || next === undefined || prev.length !== next.length || next.some((v, i) => !Object.is(v, prev[i]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'fragment',
    useRef: (init) => {
      const i = cursor++
      if (slots[i] === undefined) slots[i] = { current: init }
      return slots[i]
    },
    useEffect: (fn, deps) => {
      const i = cursor++
      const prev = slots[i]
      if (prev === undefined || depsChanged(prev.deps, deps)) {
        slots[i] = { deps }
        pendingEffects.push(fn)
      }
    },
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
  })
  const render = (props) => {
    cursor = 0
    pendingEffects.length = 0
    mod.exports.DraftKeeper(props)
    for (const fn of pendingEffects.splice(0)) fn()
  }
  return { ...mod.exports, render, warnings }
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
