import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createApiRoutes } from '../src/host/api/routes.js'

function harness(t) {
  const bot = { id: 'b1', name: 'Worker', instructions: 'Internal instructions' }
  const rt = {
    home: '/unused', ctx: {}, state: { bots: { b1: bot }, rooms: {} },
    botOf: () => bot, chatOf: () => undefined, live: new Map(), isMain: () => false,
    workDirOf: () => '/private/host/workspace',
  }
  const principal = {
    targetScope: 'selected', hasScope: scope => scope === 'read',
    assertBotAccess: () => ({ ok: true }),
    canAccessBot: id => id === 'b1', canAccessRoom: id => id === 'r1',
  }
  const routes = createApiRoutes(rt, { auth: {}, runs: {}, sseClients: new Set() })
  t.after(() => routes.dispose())
  return { rt, principal, routes }
}

test('Bot detail omits host paths and reserves instructions for team managers', t => {
  const { routes, principal } = harness(t)
  const read = routes.service.getBot(principal, 'b1')
  assert.equal(Object.hasOwn(read, 'workDir'), false)
  assert.equal(Object.hasOwn(read, 'instructions'), false)
  const managed = routes.service.getBot({ ...principal, hasScope: () => true }, 'b1')
  assert.equal(managed.instructions, 'Internal instructions')
  assert.equal(Object.hasOwn(managed, 'workDir'), false)
})

test('restricted event streams omit untargeted records from live delivery and replay', async t => {
  const { rt, principal, routes } = harness(t)
  const stream = async targetScope => {
    const req = new EventEmitter()
    req.method = 'GET'
    req.headers = { 'last-event-id': 'ev_1' }
    let text = ''
    const res = { writeHead() {}, write(chunk) { text += chunk }, end() {} }
    t.after(() => req.emit('close'))
    await routes.handleV1(req, res, new URL('http://localhost/v1/events/stream'), { ...principal, targetScope }, {})
    return () => text
  }
  rt.apiEmitGlobal('seed', {})
  rt.apiEmitGlobal('untargeted-replay', {})
  rt.apiEmitGlobal('allowed-replay', { botId: 'b1' })
  rt.apiEmitGlobal('denied-replay', { botId: 'b2' })
  const restricted = await stream('selected')
  const broad = await stream('all_public')
  rt.apiEmitGlobal('untargeted-live', {})
  rt.apiEmitGlobal('allowed-live', { roomId: 'r1' })
  rt.apiEmitGlobal('denied-live', { roomId: 'r2' })
  for (const event of ['untargeted-replay', 'untargeted-live']) {
    assert.equal(restricted().includes(`event: ${event}`), false)
    assert.equal(broad().includes(`event: ${event}`), true)
  }
  for (const event of ['allowed-replay', 'allowed-live']) assert.ok(restricted().includes(`event: ${event}`))
  for (const event of ['denied-replay', 'denied-live']) assert.equal(restricted().includes(`event: ${event}`), false)
})
