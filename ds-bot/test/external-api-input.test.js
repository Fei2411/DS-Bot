import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createApiRoutes } from '../src/host/api/routes.js'

function harness(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-api-input-'))
  const calls = []
  const bot = { id: 'b1', name: 'Worker' }
  const room = { id: 'r1', name: 'Team', members: [] }
  const rt = {
    home, ctx: {}, state: { bots: { b1: bot }, rooms: { r1: room } },
    botOf: () => bot, roomOf: () => room,
    chatPage: async (...args) => { calls.push(args); return { items: [] } },
    mobileEndpoint: async (...args) => { calls.push(args); return { items: [] } },
    goalControl: async (...args) => { calls.push(args); return {} },
    goalDraft: async (...args) => { calls.push(args); return {} },
  }
  const principal = {
    keyId: 'test', hasScope: () => true,
    assertBotAccess: () => ({ ok: true }), assertRoomAccess: () => ({ ok: true }),
  }
  const routes = createApiRoutes(rt, { auth: {}, runs: {}, sseClients: new Set() })
  t.after(() => { routes.dispose(); rmSync(home, { recursive: true, force: true }) })
  const request = async (path, body, type = 'application/json') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))])
    req.method = body === undefined ? 'GET' : 'POST'
    req.headers = { 'content-type': type }
    const res = { writeHead(status) { this.status = status }, end(data) { this.data = JSON.parse(data) } }
    await routes.handleV1(req, res, new URL(path, 'http://localhost'), principal, {})
    return res.data
  }
  return { routes, principal, calls, request }
}

test('API rejects malformed path escapes and invalid cursors before history dispatch', async t => {
  const { request, calls } = harness(t)
  for (const path of ['/v1/bots/%zz', '/v1/groups/%E0%A4%A/messages']) {
    await assert.rejects(() => request(path), error => error.status === 400)
  }
  for (const target of ['bots/b1', 'groups/r1']) {
    for (const cursor of ['', '{', 'null', '1', '"text"', '[]', '{}', '{"part":-1}', '{"part":0,"beforeSeq":"x"}', '{"part":0,"extra":1}']) {
      await assert.rejects(() => request(`/v1/${target}/messages?cursor=${encodeURIComponent(cursor)}`), error => error.status === 400)
    }
    await request(`/v1/${target}/messages?cursor=${encodeURIComponent('{"part":0,"beforeSeq":12}')}`)
    await request(`/v1/${target}/messages`)
  }
  assert.equal(calls.length, 4)
})

test('goal controls accept only supported fields and typed values', async t => {
  const { routes, principal, calls } = harness(t)
  for (const body of [{}, { action: 'start' }, { action: 'draft', text: '' }, { action: 'pause', goalId: 'g', stopWork: 'true' }, { action: 'resume', goalId: 'g', stopWork: true }, { action: 'stop', goalId: 'g', actorId: 'user' }]) {
    await assert.rejects(() => routes.service.controlGroupGoal(principal, 'r1', body), error => error.status === 400)
  }
  assert.equal(calls.length, 0)
  for (const body of [{ action: 'draft', text: 'Ship it' }, { action: 'pause', goalId: 'g', stopWork: true }, { action: 'resume', goalId: 'g' }, { action: 'stop', goalId: 'g' }, { action: 'clear', goalId: 'g' }]) {
    await routes.service.controlGroupGoal(principal, 'r1', body)
  }
  assert.equal(calls.length, 5)
  assert.deepEqual(calls[0][2], { via: 'api' }, 'goalDraft passes via: api')
  assert.deepEqual(calls[2][2], { via: 'api' }, 'goalControl resume passes via: api')
})

test('upload image MIME comes from bytes, never client declarations', async t => {
  const { request } = harness(t)
  for (const [hex, mime] of [
    ['89504e470d0a1a0a', 'image/png'], ['ffd8ff', 'image/jpeg'],
    ['474946383961', 'image/gif'], ['524946460000000057454250', 'image/webp'],
    ['68656c6c6f', 'application/octet-stream'],
  ]) {
    const bytes = Buffer.from(hex, 'hex')
    const json = await request('/v1/uploads', { name: 'image.png', mime: 'image/png', data: bytes.toString('base64') })
    assert.equal(json.mime, mime)
    const raw = await request('/v1/uploads', bytes, 'image/jpeg')
    assert.equal(raw.mime, mime)
  }
})
