import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { DEFAULT_SIDE_LAYOUT, SIDE_LAYOUTS, cleanSideLayout, effectiveSideLayout, initialSideLayout, isSideLayout } from '../src/shared/side-layout.js'

// ---- the rule -----------------------------------------------------------------------

test('a conversation draws in its own choice, else the layout it was made with, else docked', () => {
  assert.deepEqual(SIDE_LAYOUTS, ['docked', 'drawer', 'centered'])
  assert.equal(DEFAULT_SIDE_LAYOUT, 'docked')
  assert.equal(effectiveSideLayout({ sideLayout: 'centered', sideLayoutInitial: 'drawer' }), 'centered')
  assert.equal(effectiveSideLayout({ sideLayoutInitial: 'drawer' }), 'drawer')
  assert.equal(effectiveSideLayout({}), 'docked', 'a conversation that predates the setting stays docked')
  assert.equal(effectiveSideLayout(undefined), 'docked')
  assert.equal(effectiveSideLayout(null), 'docked')
})

test('a value outside the three layouts reads as none and falls through to the next rule', () => {
  for (const bad of ['grid', '', null, 3, {}, 'Docked', 'DRAWER']) assert.equal(isSideLayout(bad), false, String(bad))
  assert.equal(effectiveSideLayout({ sideLayout: 'grid', sideLayoutInitial: 'centered' }), 'centered')
  assert.equal(effectiveSideLayout({ sideLayout: 'grid', sideLayoutInitial: 'nope' }), 'docked')
})

test('a new conversation records the team default only when it is not the fallback', () => {
  assert.equal(initialSideLayout({ sideLayout: 'drawer' }), 'drawer')
  assert.equal(initialSideLayout({ sideLayout: 'centered' }), 'centered')
  assert.equal(initialSideLayout({ sideLayout: 'docked' }), undefined)
  assert.equal(initialSideLayout({}), undefined)
  assert.equal(initialSideLayout(undefined), undefined)
  assert.equal(initialSideLayout({ sideLayout: 'bogus' }), undefined)
})

test('a requested value is a layout or a clear, nothing else', () => {
  assert.deepEqual(cleanSideLayout('drawer'), { ok: true, value: 'drawer' })
  assert.deepEqual(cleanSideLayout(null), { ok: true, value: null })
  assert.deepEqual(cleanSideLayout(''), { ok: true, value: null })
  for (const bad of ['grid', 3, true, {}, [], 'Docked']) assert.deepEqual(cleanSideLayout(bad), { ok: false }, String(bad))
})

// ---- the host -----------------------------------------------------------------------

function start(saved, home = mkdtempSync(join(tmpdir(), 'ds-bot-layout-'))) {
  if (saved !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}-${Math.random().toString(36).slice(2, 6)}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { call, home, stop: async () => { await ctx.dispose() } }
}

const baseTeam = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Copy', instructions: '', createdAt: 2 },
  },
  rooms: {
    ga: { id: 'ga', sessionId: 'ga', name: 'Group A', named: true, members: ['chief', 'writer'], admin: 'chief', mode: 'admin', notice: '', createdAt: 3 },
    gb: { id: 'gb', sessionId: 'gb', name: 'Group B', named: true, members: ['chief', 'writer'], admin: 'chief', mode: 'admin', notice: '', createdAt: 4 },
  },
})

const botOf = (state, id) => state.bots.find(bot => bot.id === id)
const roomOf = (state, id) => state.rooms.find(room => room.id === id)
const stateOf = async call => (await call('state', {})).value

test('the team default is stored, cleared by docked or null, and refuses anything else', async (t) => {
  const { call, stop } = start(baseTeam())
  t.after(stop)
  assert.equal((await call('set-prefs', { sideLayout: 'centered' })).value.sideLayout, 'centered')
  assert.equal((await call('set-prefs', { sideLayout: 'drawer' })).value.sideLayout, 'drawer')
  assert.equal('sideLayout' in (await call('set-prefs', { sideLayout: 'docked' })).value, false)
  await call('set-prefs', { sideLayout: 'drawer' })
  assert.equal('sideLayout' in (await call('set-prefs', { sideLayout: null })).value, false)
  const refused = await call('set-prefs', { sideLayout: 'grid' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/invalid')
  assert.equal(refused.error.message, 'Side App layout must be docked, drawer or centered')
})

test('a refused team default leaves the other fields of the same save unsaved', async (t) => {
  const { call, stop } = start(baseTeam())
  t.after(stop)
  const refused = await call('set-prefs', { motion: 'lively', sideLayout: 'sideways' })
  assert.equal(refused.ok, false)
  assert.equal('motion' in (await stateOf(call)).prefs, false, 'a refused change is all or nothing')
})

test('a conversation made before the setting stays docked whatever the default is or becomes', async (t) => {
  const { call, stop } = start(baseTeam())
  t.after(stop)
  await call('set-prefs', { sideLayout: 'centered' })
  let state = await stateOf(call)
  for (const entry of [botOf(state, 'writer'), roomOf(state, 'ga'), roomOf(state, 'gb')]) {
    assert.equal(entry.sideLayout, undefined)
    assert.equal(entry.sideLayoutInitial, undefined)
  }
  await call('set-prefs', { sideLayout: 'drawer' })
  state = await stateOf(call)
  assert.equal(botOf(state, 'writer').sideLayoutInitial, undefined, 'the default is not read for an old conversation later')
})

test('group A docked, group B centered and a Bot as a drawer stay apart and survive a restart', async (t) => {
  const first = start(baseTeam())
  const { home } = first
  assert.equal((await first.call('set-flags', { id: 'ga', sideLayout: 'docked' })).ok, true)
  assert.equal((await first.call('set-flags', { id: 'gb', sideLayout: 'centered' })).ok, true)
  assert.equal((await first.call('set-flags', { id: 'writer', sideLayout: 'drawer' })).ok, true)
  let state = await stateOf(first.call)
  assert.equal(effectiveOf(state, 'ga'), 'docked')
  assert.equal(effectiveOf(state, 'gb'), 'centered')
  assert.equal(effectiveOf(state, 'writer'), 'drawer')
  assert.equal(effectiveOf(state, 'chief'), 'docked', 'a conversation nobody set is untouched')
  await first.stop()
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.rooms.gb.sideLayout, 'centered')
  const second = start(undefined, home)
  t.after(async () => { await second.stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  state = await stateOf(second.call)
  assert.equal(effectiveOf(state, 'ga'), 'docked')
  assert.equal(effectiveOf(state, 'gb'), 'centered')
  assert.equal(effectiveOf(state, 'writer'), 'drawer')
})

function effectiveOf(state, id) {
  return effectiveSideLayout(botOf(state, id) ?? roomOf(state, id))
}

test('a Bot and a group made under a default keep it, and a reset returns to it', async (t) => {
  const { call, stop } = start(baseTeam())
  t.after(stop)
  await call('set-prefs', { sideLayout: 'drawer' })
  const bot = await call('create-bot', { name: 'Drawer Bot', role: 'x', instructions: 'x', model: undefined })
  const room = await call('create-room', { members: ['chief', 'writer'], name: 'Drawer Room' })
  const made = { bot: bot.value?.id, room: room.value?.id }
  assert.ok(made.room, `the group was made: ${JSON.stringify(room)}`)
  assert.equal(roomOf(await stateOf(call), made.room).sideLayoutInitial, 'drawer')
  assert.equal(botOf(await stateOf(call), made.bot).sideLayoutInitial, 'drawer')
  await call('set-prefs', { sideLayout: 'centered' })
  assert.equal(effectiveOf(await stateOf(call), made.room), 'drawer', 'a later default does not move an existing conversation')
  await call('set-flags', { id: made.room, sideLayout: 'docked' })
  assert.equal(effectiveOf(await stateOf(call), made.room), 'docked')
  await call('set-flags', { id: made.room, sideLayout: null })
  assert.equal(effectiveOf(await stateOf(call), made.room), 'drawer', 'reset returns to the layout it was made with')
  assert.equal('sideLayout' in roomOf(await stateOf(call), made.room), false)
})

test('a conversation made while the default was docked stores nothing and resets to docked', async (t) => {
  const { call, stop } = start(baseTeam())
  t.after(stop)
  const room = await call('create-room', { members: ['chief', 'writer'], name: 'Plain Room' })
  assert.equal(room.ok, true)
  assert.equal('sideLayoutInitial' in roomOf(await stateOf(call), room.value.id), false)
  await call('set-flags', { id: room.value.id, sideLayout: 'centered' })
  await call('set-flags', { id: room.value.id, sideLayout: null })
  assert.equal(effectiveOf(await stateOf(call), room.value.id), 'docked')
})

test('an invalid layout for a conversation is refused and leaves its setting unchanged', async (t) => {
  const { call, stop } = start(baseTeam())
  t.after(stop)
  await call('set-flags', { id: 'gb', sideLayout: 'centered' })
  const refused = await call('set-flags', { id: 'gb', sideLayout: 'sideways' })
  assert.equal(refused.ok, false)
  assert.equal(roomOf(await stateOf(call), 'gb').sideLayout, 'centered')
  assert.equal((await call('set-flags', { id: 'nobody', sideLayout: 'drawer' })).ok, false)
})

test('stored layouts the host would refuse read as none when the team loads', async (t) => {
  const team = baseTeam()
  team.bots.writer.sideLayout = 'grid'
  team.bots.writer.sideLayoutInitial = 7
  team.rooms.ga.sideLayout = 'centered'
  team.rooms.gb.sideLayoutInitial = 'sideways'
  team.prefs = { sideLayout: 'diagonal' }
  const { call, stop, home } = start(team)
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const state = await stateOf(call)
  assert.equal(effectiveOf(state, 'writer'), 'docked')
  assert.equal(effectiveOf(state, 'ga'), 'centered', 'a valid one beside bad ones is kept')
  assert.equal(effectiveOf(state, 'gb'), 'docked')
  assert.equal('sideLayout' in state.prefs, false)
})
