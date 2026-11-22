import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

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

test('the reference picker opens in its own mode and the pick goes back to the composer', () => {
  const { actions, ui } = bench()
  // The shell's own search still opens with the typed character as its query.
  actions.openPalette('k')
  assert.equal(ui.getSnapshot().palette.query, 'k')
  assert.equal(ui.getSnapshot().palette.mode, null)
  // "+ → Reference a chat" opens the palette in reference mode, owned by the composer.
  actions.openPalette({ mode: 'reference', owner: 'chief' })
  const palette = ui.getSnapshot().palette
  assert.equal(palette.mode, 'reference')
  assert.equal(palette.owner, 'chief')
  assert.equal(palette.query, '')
  // A pick is handed to that Session; the palette keeps its own exit timer.
  actions.pickChatReference({ owner: 'chief', target: 'king', label: 'Chat with King' })
  const ref = ui.getSnapshot().chatRef
  assert.deepEqual([ref.owner, ref.target, ref.label], ['chief', 'king', 'Chat with King'])
  assert.equal(typeof ref.token, 'number')
  assert.notEqual(ui.getSnapshot().palette, null)
  // A malformed pick does nothing.
  const before = ui.getSnapshot().chatRef
  actions.pickChatReference({ owner: 'chief' })
  assert.equal(ui.getSnapshot().chatRef, before)
  // The composer clears exactly the pick it consumed.
  actions.clearChatReference(ref.token + 1)
  assert.equal(ui.getSnapshot().chatRef, before)
  actions.clearChatReference(ref.token)
  assert.equal(ui.getSnapshot().chatRef, null)
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
