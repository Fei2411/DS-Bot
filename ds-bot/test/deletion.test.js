import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { monitorDecision } from '../src/host/automations.js'
import { completionReady } from '../src/host/completions.js'
import { previewOf } from '../src/client/text.js'
import { fakeContext } from './fake-ctx.js'

async function bench(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-lifecycle-'))
  const home = join(root, 'home'); const work = join(root, 'work')
  mkdirSync(home); mkdirSync(work)
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['chief'], bots: {
    chief: { id: 'chief', name: 'Chief', instructions: '', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', instructions: '', workDir: work, createdAt: 2 },
    reader: { id: 'reader', name: 'Reader', instructions: '', createdAt: 3 },
  }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} }))
  const tasks = new Map(); let sequence = 0
  const schedule = {
    async create(sessionId, request) {
      const id = `task-${++sequence}`
      const record = { id, title: request.title, prompt: request.prompt, kind: request.every_seconds ? 'every' : 'at', everySeconds: request.every_seconds, scheduledAt: request.at ?? new Date(Date.now() + request.every_seconds * 1000).toISOString() }
      tasks.set(id, { ...record, sessionId, status: 'active' }); return record
    },
    async catalog() { return [...tasks.values()] },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId) },
    async delete({ id, sessionId }) { if (tasks.get(id)?.sessionId === sessionId) tasks.delete(id); return { id, deleted: true } },
  }
  const ctx = fakeContext({ services: { schedule } })
  const agents = new Map(); const archived = []
  ctx.workspaceRegistry = { get: () => ({ path: work }), resolveByPath: async () => ({ id: 'team' }), create: async () => ({ id: 'team', path: work }),
    async archiveSession(id) { archived.push(id); for (const task of [...tasks.values()]) if (task.sessionId === id) tasks.delete(task.id) } }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { flush: async () => true }
  ctx.sessionController = { create: async () => ({ sessionId: `session-${++sequence}` }), selectModel: async () => {},
    async resolveAgent(id) {
      if (!agents.has(id)) agents.set(id, { ...ctx.scopeAgent(id), session: { id, header: { id, cwd: work }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
        inbox: { nextStep: [], nextTurn: [], remove: () => true }, followup: () => {}, cancel: () => {} })
      return { agent: agents.get(id) }
    } }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = value => { if (value.path === '/api/bot') route = value; return register(value) }
  const rt = createRuntime(ctx, { home, memory: false, learning: false, ...config })
  await rt.load()
  rt.eventsBackwards = async function* () { yield { type: 'turn/end', data: { turn: 1 } } }
  const call = async (endpoint, payload = {}) => {
    return (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  }
  const event = async (id, type, data, seq = 1) => {
    const { agent } = await ctx.sessionController.resolveAgent(id)
    for (const listener of ctx.listeners.get('session/event')) await listener(agent.session, { type, data, seq, time: Date.now() })
  }
  const settle = async check => {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
    throw new Error('Lifecycle operation did not settle')
  }
  t.after(async () => { await ctx.dispose(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, root, work, home, tasks, schedule, agents, archived, call, event, settle }
}


test('raw deletion is refused and changed resources invalidate the confirmation', async t => {
  const b = await bench(t)
  assert.equal((await b.call('delete-bot', { id: 'writer' })).error.code, 'bot/confirmation-required')
  const before = (await b.call('delete-preview', { id: 'writer' })).value
  await b.schedule.create('writer', { title: 'New task', prompt: 'Check', every_seconds: 60 })
  const rejected = await b.call('delete-confirm', { id: 'writer', token: before.token, tasks: 'delete', files: [] })
  assert.match(rejected.error.message, /Resources changed/)
  assert.ok(b.rt.botOf('writer')); assert.equal(b.tasks.size, 1)
  const preview = (await b.call('delete-preview', { id: 'writer' })).value
  assert.equal((await b.call('delete-confirm', { id: 'writer', token: preview.token, tasks: 'delete', files: [] })).ok, true)
  assert.equal(b.rt.botOf('writer'), undefined); assert.equal(b.tasks.size, 0)
})

test('a failed transfer keeps the Bot; retry removes the original without copying twice', async t => {
  const b = await bench(t)
  await b.schedule.create('writer', { title: 'Check', prompt: 'Read', every_seconds: 60 })
  const remove = b.schedule.delete
  b.schedule.delete = async () => { throw new Error('storage busy') }
  let preview = await b.rt.deletionPreview('writer')
  await assert.rejects(() => b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'transfer', target: 'reader', files: [] }), /storage busy/)
  assert.ok(b.rt.botOf('writer')); assert.equal(b.tasks.size, 2)
  b.schedule.delete = remove
  preview = await b.rt.deletionPreview('writer')
  await b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'transfer', target: 'reader', files: [] })
  assert.equal(b.tasks.size, 1); assert.equal([...b.tasks.values()][0].sessionId, 'reader')
})

test('new chat work and receiver permission changes invalidate a deletion preview', async t => {
  const b = await bench(t)
  let preview = await b.rt.deletionPreview('writer')
  await b.event('writer', 'user/message', { source: { kind: 'user' } })
  await assert.rejects(() => b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'delete', files: [] }), /Resources changed/)
  preview = await b.rt.deletionPreview('writer')
  b.rt.botOf('reader').permission = 'restricted'
  await assert.rejects(() => b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'transfer', target: 'reader', files: [] }), /Resources changed/)
  assert.ok(b.rt.botOf('writer'))
})

test('only verified newly created files can be recycled and restored without overwriting', async t => {
  const b = await bench(t)
  const { agent } = await b.ctx.sessionController.resolveAgent('writer')
  const path = join(b.work, 'report.txt')
  const exec = { name: 'write', arguments: { file_path: path }, agent }
  const run = b.ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), async () => { await writeFile(path, 'Report'); return { isError: false, value: 'ok' } })
  await run()
  let preview = await b.rt.deletionPreview('writer')
  assert.equal(preview.files[0].cleanable, true)
  const file = preview.files[0]
  await assert.rejects(() => b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'delete', files: ['../unsafe'] }), /verified new files/)
  preview = await b.rt.deletionPreview('writer')
  await b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'delete', files: [file.id] })
  assert.throws(() => readFileSync(path), /ENOENT/)
  writeFileSync(path, 'User replacement')
  await assert.rejects(() => b.rt.restoreArtifact({ botId: 'writer', fileId: file.id }), /EEXIST/)
  rmSync(path)
  await b.rt.restoreArtifact({ botId: 'writer', fileId: file.id })
  assert.equal(readFileSync(path, 'utf8'), 'Report')
})


test('a transferred monitor keeps deduplication but receives a fresh isolated Session', async t => {
  const b = await bench(t)
  await b.rt.createMonitor({ target: 'writer', title: 'Inbox', prompt: 'Watch', when: { kind: 'every', minutes: 1 } })
  const original = Object.values(b.rt.state.automations)[0]
  original.baselined = true; original.seen = ['old', 'new']
  original.runs = [{ id: 'old-run', sessionId: original.sessionId, status: 'no_change' }]
  b.schedule.history = async () => ({ records: [{ messageId: 'receipt', prompt: 'Watch' }] })
  const preview = await b.rt.deletionPreview('writer')
  const result = await b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'transfer', target: 'reader', files: [] })
  const transferred = Object.values(b.rt.state.automations).find(task => task.botId === 'reader')
  assert.notEqual(transferred.sessionId, original.sessionId)
  assert.equal(transferred.baselined, true); assert.deepEqual(transferred.seen, ['old', 'new'])
  assert.deepEqual(transferred.runs, original.runs)
  assert.equal(original.disabled, true)
  assert.equal(b.rt.selfOf(transferred.sessionId), 'reader')
  assert.ok(b.archived.includes(original.sessionId))
  assert.equal(b.tasks.size, 1)
  assert.equal(Object.values(result.progress.tasks)[0].records[0].messageId, 'receipt')
})


test('shared and externally changed files cannot be selected for cleanup', async t => {
  const b = await bench(t)
  const path = join(b.work, 'shared.txt')
  const invoke = async (botId, name, action) => {
    const { agent } = await b.ctx.sessionController.resolveAgent(botId)
    const exec = { name, arguments: { file_path: path }, agent }
    await b.ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), async () => { await action(); return { isError: false } })()
  }
  await invoke('writer', 'write', () => writeFile(path, 'Created'))
  assert.equal((await b.rt.deletionPreview('writer')).files[0].cleanable, true)
  await writeFile(path, 'External edit')
  assert.equal((await b.rt.deletionPreview('writer')).files[0].cleanable, false)
  await invoke('writer', 'write', () => writeFile(path, 'Bot version'))
  await invoke('reader', 'read', async () => {})
  const preview = await b.rt.deletionPreview('writer')
  assert.equal(preview.files[0].cleanable, false)
  await assert.rejects(() => b.rt.deletionExecute({ id: 'writer', token: preview.token, tasks: 'delete', files: [preview.files[0].id] }), /verified new files/)
  assert.equal(readFileSync(path, 'utf8'), 'Bot version')
})
