import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApiAuth } from '../src/host/api/auth.js'
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

test('group membership edits authorize every supplied Bot against the token targets', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-members-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const bots = {
    b1: { id: 'b1', name: 'Allowed' }, b2: { id: 'b2', name: 'Hidden public' },
    bp: { id: 'bp', name: 'Private', private: true },
  }
  const room = { id: 'r1', name: 'Group', members: ['b1'] }
  const calls = []
  const rt = {
    home, ctx: {}, state: { bots, rooms: { r1: room } },
    botOf: id => bots[id], roomOf: id => id === 'r1' ? room : undefined,
    updateRoom: async (...args) => { calls.push(args); return { room } },
  }
  const auth = createApiAuth(rt)
  const { token } = auth.createToken({
    name: 'Selected manager', scopes: ['team:manage'], confirmHighRisk: true,
    targetScope: 'selected', botIds: ['b1'], roomIds: ['r1'],
  })
  const { token: principal } = await auth.authenticate({
    url: '/', headers: { host: 'localhost', authorization: `Bearer ${token}` }, socket: { remoteAddress: 'local' },
  })
  assert.ok(principal)
  const routes = createApiRoutes(rt, { auth, runs: {}, sseClients: new Set() })
  t.after(() => routes.dispose())
  for (const field of ['members', 'add', 'remove']) {
    for (const id of ['b2', 'bp', 'Hidden public', 'Private']) {
      await assert.rejects(routes.service.updateGroup(principal, 'r1', { [field]: [id] }), error => [403, 404].includes(error.status))
    }
    for (const value of ['b1', null, [null], [42], [{}], ['']]) {
      await assert.rejects(routes.service.updateGroup(principal, 'r1', { [field]: value }), { status: 400 })
    }
  }
  assert.equal(calls.length, 0)
  for (const field of ['members', 'add', 'remove']) {
    await routes.service.updateGroup(principal, 'r1', { [field]: ['Allowed'] })
    assert.deepEqual(calls.at(-1), ['r1', { [field]: ['b1'] }, API_ACTOR])
    await routes.service.updateGroup(principal, 'r1', { [field]: [] })
  }
  await routes.service.updateGroup(principal, 'r1', {})
  const confirmed = auth.createToken({
    name: 'Private manager', scopes: ['team:manage'], confirmHighRisk: true,
    targetScope: 'selected', botIds: ['b1'], roomIds: ['r1'], privateBotIds: ['bp'], confirmPrivate: true,
  })
  const { token: privatePrincipal } = await auth.authenticate({
    url: '/', headers: { host: 'localhost', authorization: `Bearer ${confirmed.token}` }, socket: { remoteAddress: 'local' },
  })
  for (const field of ['members', 'add']) {
    await assert.rejects(routes.service.updateGroup(privatePrincipal, 'r1', { [field]: ['bp'] }), { status: 403 })
  }
  room.members = ['b1', 'b2', 'bp']
  for (const members of [['b1'], []]) {
    await routes.service.updateGroup(principal, 'r1', { members })
    assert.deepEqual(calls.at(-1)[1].members, [...members, 'b2', 'bp'])
  }
  const before = calls.length
  for (const id of ['b2', 'bp']) {
    await assert.rejects(routes.service.updateGroup(principal, 'r1', { remove: [id] }), error => [403, 404].includes(error.status))
  }
  assert.equal(calls.length, before)
})
