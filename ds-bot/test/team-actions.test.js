import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'
import { sectionFoldWrites, teamActions } from '../src/client/team-actions.js'

// The requests the actions send, and how many of them read the team again after.
function bench() {
  const sent = []
  let pulls = 0
  const call = async (name, body) => { sent.push([name, body]); return { ok: name } }
  const after = promise => promise.then((value) => { pulls++; return value })
  const ui = createSource({ settings: null, menu: 'open', palette: null, newChat: null })
  const actions = teamActions({ call, after, partFor: id => id, roster: createSource({}), ui })
  return { actions, sent, ui, pulls: () => pulls }
}

test('rapid section folds save in order, keeping the latest intent visible until it settles', async () => {
  const roster = createSource({ sections: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], revision: 1 })
  const ui = createSource({})
  const writes = [Promise.withResolvers(), Promise.withResolvers()]
  const sent = []
  const foldWrites = sectionFoldWrites()
  const actions = teamActions({
    roster, ui,
    call: (name, body) => { sent.push([name, body]); return writes[sent.length - 1].promise },
    after: () => assert.fail('folding should not pull the roster again'),
    foldWrites,
  })
  const first = actions.saveSection({ id: 'one', collapsed: true })
  const second = actions.saveSection({ id: 'one', collapsed: false })
  assert.deepEqual(ui.getSnapshot().sectionFolds, { one: false })
  await Promise.resolve()
  assert.deepEqual(sent, [['section-save', { id: 'one', collapsed: true, withRevision: true }]])

  const latestSections = [{ id: 'one', name: 'Renamed' }, { id: 'two', name: 'Two', collapsed: true }]
  roster.set({ sections: latestSections, revision: 2 })
  writes[0].resolve({ section: { id: 'one', name: 'One', collapsed: true }, revision: 3 })
  await first
  assert.deepEqual(ui.getSnapshot().sectionFolds, { one: false })
  assert.deepEqual(sent[1], ['section-save', { id: 'one', collapsed: false, withRevision: true }])
  writes[1].reject(new Error('save failed'))
  await assert.rejects(second, /save failed/)
  assert.deepEqual(ui.getSnapshot().sectionFolds, {})
  assert.deepEqual(roster.getSnapshot(), {
    sections: [{ id: 'one', name: 'Renamed', collapsed: true }, latestSections[1]], revision: 2,
  })
  assert.deepEqual(foldWrites.reconcile(latestSections, 2), roster.getSnapshot().sections)
  assert.equal(foldWrites.reconcile(latestSections, 3), latestSections)
})

test('section edits other than a standalone fold still refresh the roster', async () => {
  const { actions, sent, pulls } = bench()
  await actions.saveSection({})
  await actions.saveSection({ id: 'one', name: 'Renamed', collapsed: true })
  await actions.saveSection({ id: 'one', color: null })
  assert.deepEqual(sent, [
    ['section-save', {}],
    ['section-save', { id: 'one', name: 'Renamed', collapsed: true }],
    ['section-save', { id: 'one', color: null }],
  ])
  assert.equal(pulls(), 3)
})

test('ChatGPT uses only account endpoints, never provider keys or relay credentials', async () => {
  const { actions, sent } = bench()
  await actions.chatgpt()
  await actions.chatgptSignIn({ consent: true })
  await actions.chatgptCancel()
  await actions.chatgptSignOut()
  await actions.chatgptModels()
  assert.deepEqual(sent, [
    ['chatgpt', undefined],
    ['chatgpt-sign-in', { consent: true }],
    ['chatgpt-cancel', undefined],
    ['chatgpt-sign-out', undefined],
    ['chatgpt-models', undefined],
  ])
})

test('every window reaches the host model providers, and key changes read the team again', async () => {
  const { actions, sent, pulls } = bench()
  await actions.providers()
  await actions.setProviderKey('deepseek-official', 'sk-test-ok')
  await actions.setProviderKey('deepseek-official', null)
  await actions.addProvider({ provider: 'router', key: 'k' })
  await actions.providerModels({ baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: '' })
  await actions.removeProvider('router')
  assert.deepEqual(sent, [
    ['providers', undefined],
    ['provider-key', { provider: 'deepseek-official', value: 'sk-test-ok' }],
    ['provider-key', { provider: 'deepseek-official', value: null }],
    ['provider-add', { provider: 'router', key: 'k' }],
    ['provider-models', { baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: '' }],
    ['provider-remove', { provider: 'router' }],
  ])
  // Reads (the list and a model discovery) leave the team as it is.
  assert.equal(pulls(), 4)
})

test('capability choices send the channel mode and refresh the roster after saving', async () => {
  const { actions, sent, pulls } = bench()
  await actions.setBotCapability('chief', 'echo', true)
  await actions.setBotCapability('chief', 'echo', true, 'catalog')
  await actions.setBotCapability('chief', 'echo', false)
  assert.deepEqual(sent, [
    ['bot-capability', { botId: 'chief', name: 'echo', attached: true, mode: 'always' }],
    ['bot-capability', { botId: 'chief', name: 'echo', attached: true, mode: 'catalog' }],
    ['bot-capability', { botId: 'chief', name: 'echo', attached: false, mode: 'always' }],
  ])
  assert.equal(pulls(), 3)
})

test('Retry after a failed turn asks the host to resume the Bot, with nothing but its id', async () => {
  const { actions, sent, pulls } = bench()
  await actions.resume('chief')
  assert.deepEqual(sent, [['resume', { botId: 'chief' }]])
  assert.equal(pulls(), 1)
})

test('openModels opens DS Bot settings on the Models page and closes the menus', () => {
  const { actions, ui } = bench()
  actions.openModels()
  assert.deepEqual(ui.getSnapshot().settings, { page: 'models', id: null })
  assert.equal(ui.getSnapshot().menu, null)
  actions.openSettings()
  assert.deepEqual(ui.getSnapshot().settings, { page: 'general', id: null })
})

test('the details status line asks the host for one Bot\'s current part', async () => {
  const { actions, sent, pulls } = bench()
  await actions.runStats('chief')
  assert.deepEqual(sent, [['run-stats', { botId: 'chief' }]])
  // A read: it does not pull the whole team again.
  assert.equal(pulls(), 0)
})

test('computerAppAnswer refreshes team state and approval island stays mutually exclusive with goal panels (#1623)', async () => {
  const { actions, sent, ui, pulls } = bench()
  await actions.computerAppAnswer('ask-1', 'once')
  assert.deepEqual(sent, [['computer-app-answer', { id: 'ask-1', answer: 'once' }]])
  assert.equal(pulls(), 1)
  actions.composeGoal('r1')
  assert.equal(ui.getSnapshot().goalCompose, 'r1')
  assert.equal(ui.getSnapshot().approvalOpen, null)
  actions.toggleApproval('r1')
  assert.equal(ui.getSnapshot().approvalOpen, 'r1')
  assert.equal(ui.getSnapshot().goalOpen, null)
  assert.equal(ui.getSnapshot().goalCompose, null)
  actions.toggleGoal('r1')
  assert.equal(ui.getSnapshot().goalOpen, 'r1')
  assert.equal(ui.getSnapshot().approvalOpen, null)
})

// A card from an earlier part reopens only after the host proves it again for that part.
function sideAppBench(call) {
  const roster = createSource({ byId: { bot1: { id: 'bot1' } }, roomsById: {}, sideChats: {} })
  const ui = createSource({ details: null, view: 'details', fileTabs: {}, fileTab: null, panelYield: false })
  const actions = teamActions({ call, after: promise => promise, partFor: id => id, roster, ui, panelFolded: () => false })
  return { actions, ui }
}
const card = { v: 1, app: 'reader', sessionId: 'old-part', workspaceTag: 'tag', displayPath: 'docs/a.md' }

test('a reopened card asks the host to prove its own conversation before the tab takes focus', async () => {
  const sent = []
  const { actions, ui } = sideAppBench(async (name, body) => { sent.push([name, body]); return { ok: true } })
  await actions.openSideApp('bot1', card, { reopen: true })
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'side-app-open')
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), { app: 'reader', sessionId: 'old-part', file: { app: 'reader', displayPath: 'docs/a.md', workspaceTag: 'tag' } })
  assert.equal(ui.getSnapshot().view, 'reader')
})

test('a refused reopen leaves the panel and its tabs exactly as they were', async () => {
  const refuse = async () => { throw Object.assign(new Error('The working folder changed'), { code: 'bot/workspace-changed' }) }
  const { actions, ui } = sideAppBench(refuse)
  const before = ui.getSnapshot()
  await assert.rejects(actions.openSideApp('bot1', card, { reopen: true }), { code: 'bot/workspace-changed' })
  assert.equal(ui.getSnapshot(), before, 'no tab was added or focused')
})

test('a live open and a reader link do not wait on the extra check', async () => {
  const sent = []
  const { actions } = sideAppBench(async (name) => { sent.push(name); return {} })
  await actions.openSideApp('bot1', card, { auto: true })
  await actions.openSideApp('bot1', { ...card, displayPath: 'docs/b.md' })
  assert.deepEqual(sent, [])
})
test('draftInsert targets the current part through partFor', () => {
  const ui = createSource({ draft: null })
  const actions = teamActions({
    call: async () => ({}), after: promise => promise,
    partFor: id => (id === 'old-part' ? 'current-part' : id),
    roster: createSource({}), ui,
  })
  actions.draftInsert('old-part', ' revise this ')
  assert.equal(ui.getSnapshot().draft.sessionId, 'current-part')
  assert.equal(ui.getSnapshot().draft.text, ' revise this ')
})
