import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Chief (Main) and Writer in Ops; Writer and Editor in Desk; Diary is a private Bot.
const team = ({ questions = {}, views = {} } = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Editor', role: 'Edit', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Diary', role: 'Notes', sessionId: 'd', createdAt: 4, instructions: 'Keep the diary of the user.', private: true },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {} },
    r2: { id: 'r2', name: 'Desk', members: ['b', 'c'], mode: 'everyone', named: true, sessions: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions,
  views,
  prefs: {},
  revision: 0,
})

const card = (askedAt) => ({ id: 'q1', question: 'Which name?', options: [{ label: 'Lookout' }], multiSelect: false, askedAt })

async function start(cards) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-list-bots-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team(cards)))
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  rt = createRuntime(ctx, { home })
  const list = (args, sessionId) => rt.teamTools.find(d => d.name === 'list_bots').execute(args, { agent: { id: sessionId } })
  // Loading once fills the Session-owner indexes the tools look callers up in.
  await list({}, 'a')
  return { list, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

test('a waiting card says how long it has waited', async (t) => {
  const now = Date.now()
  const { list, stop } = await start({
    questions: { b: card(now - 3 * DAY - MINUTE), c: card(now - 5 * MINUTE) },
    views: { b: { id: 'v1', title: 'Pick', view: {}, askedAt: now - 2 * HOUR - MINUTE } },
  })
  t.after(stop)
  const out = await list({}, 'a')
  assert.match(out, /- Writer \(Write\)\n {2}now: idle; a question card in its own chat has waited for the user's answer for 3 days; a view card in its own chat has waited for the user's answer for 2 hours\n/)
  assert.match(out, /- Editor \(Edit\)\n {2}now: idle; a question card in its own chat has waited for the user's answer for 5 min\n/)
})

test('one hour and one day read in the singular, and a new card in less than a minute', async (t) => {
  const now = Date.now()
  const { list, stop } = await start({ questions: { b: card(now - HOUR - MINUTE), c: card(now - DAY - MINUTE) }, views: { c: { id: 'v1', title: 'Pick', view: {}, askedAt: now } } })
  t.after(stop)
  const out = await list({}, 'a')
  assert.match(out, /Writer[^\n]*\n {2}now: idle; a question card in its own chat has waited for the user's answer for 1 hour\n/)
  assert.match(out, /Editor[^\n]*\n {2}now: idle; a question card in its own chat has waited for the user's answer for 1 day; a view card in its own chat has waited for the user's answer for less than a minute\n/)
})

test('without a filter list_bots lists the whole team and every group the caller can see', async (t) => {
  const { list, stop } = await start()
  t.after(stop)
  assert.equal(await list({}, 'c'), [
    'Bots:',
    '- Chief (Boss, Main Bot)\n  now: idle',
    '- Writer (Write)\n  now: idle',
    '- Editor (Edit, you)',
    '- Diary (Notes, private Bot, closed to other Bots)',
    '',
    'Group chats:',
    '- "Desk" — members: Writer, Editor (you); every member replies in turn',
  ].join('\n'))
})

test('bot lists only that Bot and the groups it is in that the caller can see', async (t) => {
  const { list, stop } = await start()
  t.after(stop)
  assert.equal(await list({ bot: 'Writer' }, 'c'), [
    'Bots:',
    '- Writer (Write)\n  now: idle',
    '',
    'Group chats:',
    '- "Desk" — members: Writer, Editor (you); every member replies in turn',
  ].join('\n'))
  const chief = await list({ bot: '@writer' }, 'a')
  assert.match(chief, /- "Ops" — /)
  assert.match(chief, /- "Desk" — /)
  assert.equal(await list({ bot: 'Chief' }, 'c'), 'Bots:\n- Chief (Boss, Main Bot)\n  now: idle\n\nGroup chats: Chief is in none you can see.')
})

test('group lists only its members and that group', async (t) => {
  const { list, stop } = await start()
  t.after(stop)
  assert.equal(await list({ group: 'Desk' }, 'a'), [
    'Bots:',
    '- Writer (Write)\n  now: idle',
    '- Editor (Edit)\n  now: idle',
    '',
    'Group chats:',
    '- "Desk" — members: Writer, Editor; every member replies in turn',
  ].join('\n'))
})

test('bot and group together list that member and that group, and refuse a Bot outside it', async (t) => {
  const { list, stop } = await start()
  t.after(stop)
  assert.equal(await list({ bot: 'Writer', group: 'Ops' }, 'a'), [
    'Bots:',
    '- Writer (Write)\n  now: idle',
    '',
    'Group chats:',
    '- "Ops" — members: Chief (admin) (you), Writer; plain messages go to the admin first',
  ].join('\n'))
  assert.equal(await list({ bot: 'Editor', group: 'Ops' }, 'a'), 'Editor is not in group "Ops". Members: Chief, Writer')
})

test('an unknown name, or a group the caller cannot see, gets a plain answer with the valid names', async (t) => {
  const { list, stop } = await start()
  t.after(stop)
  assert.equal(await list({ bot: 'Nobody' }, 'a'), 'No Bot named Nobody. Team: Chief, Writer, Editor, Diary')
  assert.equal(await list({ group: 'Nowhere' }, 'a'), 'No group chat called "Nowhere" that you can see. Groups: "Ops", "Desk".')
  assert.equal(await list({ group: 'Ops' }, 'c'), 'No group chat called "Ops" that you can see. Groups: "Desk".')
})

test('a private Bot stays closed to other Bots when it is asked for by name', async (t) => {
  const { list, stop } = await start({ questions: { d: card(Date.now() - DAY) } })
  t.after(stop)
  const others = await list({ bot: 'Diary' }, 'b')
  assert.equal(others, 'Bots:\n- Diary (Notes, private Bot, closed to other Bots)\n\nGroup chats: Diary is in none you can see.')
  const own = await list({ bot: 'Diary' }, 'd')
  assert.match(own, /- Diary \(Notes, private, you\) — Keep the diary of the user\./)
  assert.doesNotMatch(await list({ group: 'Desk' }, 'b'), /Diary/)
})
