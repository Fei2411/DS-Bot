import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApiRoutes } from '../src/host/api/routes.js'
import { API_ACTOR } from '../src/host/roster.js'

test('team management accepts only safe fields and always supplies a non-user actor', async t => {
  const bot = { id: 'b1', name: 'Worker' }
  const room = { id: 'r1', name: 'Team', members: ['b1'] }
  const calls = []
  const rt = {
    ctx: {}, state: { bots: { b1: bot }, rooms: { r1: room } }, home: '/unused',
    botOf: id => id === bot.id ? bot : undefined,
    roomOf: id => id === room.id ? room : undefined,
    chatOf: () => undefined, live: new Map(), isMain: () => false,
    bootstrap: async () => {},
    resolveModel: async model => model,
    engineOf: model => model.startsWith('local/') ? 'local' : 'model',
    engineOfBot: value => value.model?.startsWith('local/') ? 'local' : 'model',
    createBot: async (...args) => { calls.push(args); return { ...bot, ...args[0] } },
    updateBot: async (...args) => { calls.push(args); return { ...bot, ...args[1] } },
    updateRoom: async (...args) => { calls.push(args); return { room: { ...room, ...args[1] } } },
  }
  const principal = {
    hasScope: () => true,
    assertBotAccess: () => ({ ok: true }), assertRoomAccess: () => ({ ok: true }),
    canAccessBot: () => true,
  }
  const routes = createApiRoutes(rt, { auth: {}, runs: {}, sseClients: new Set() })
  t.after(() => routes.dispose())
  const operations = [
    body => routes.service.createBot(principal, body),
    body => routes.service.updateBot(principal, bot.id, body),
    body => routes.service.updateGroup(principal, room.id, body),
  ]
  for (const field of ['permission', 'browserGrants', 'workDir', 'changeEngine', 'engine', 'computer', 'private', 'admin', 'unknown', 'section', 'sectionId']) {
    for (const operation of operations) {
      await assert.rejects(() => operation({ [field]: false }), error => error.status === 400 && error.message.includes(field))
    }
  }
  assert.equal(calls.length, 0)
  const profile = { name: 'Renamed', role: 'Dev', instructions: 'Be helpful', color: 'deepseek', avatar: { shape: 'whale' }, model: 'mock/fast', effort: 'high' }
  await operations[0](profile)
  await operations[1](profile)
  await operations[2]({ name: 'Renamed team', notice: 'Welcome', mode: 'everyone', members: ['b1'], add: [], remove: [] })
  assert.deepEqual(calls[0], [profile, API_ACTOR])
  assert.deepEqual(calls[1], [bot.id, profile, API_ACTOR])
  assert.equal(calls[2][2], API_ACTOR)
  for (const operation of operations) await operation({})
  for (const operation of operations.slice(0, 2)) {
    await assert.rejects(() => operation({ model: 'local/agent' }), error => error.status === 400 && error.message.includes('model'))
  }
  bot.model = 'local/agent'
  await operations[1]({ model: 'local/other', effort: 'low' })
  await assert.rejects(() => operations[1]({ model: null }), error => error.status === 400)
  await assert.rejects(() => operations[1]({ model: 'mock/fast' }), error => error.status === 400)
})
