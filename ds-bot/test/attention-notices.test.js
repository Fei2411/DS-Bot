import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function bench(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-attention-'))
  const home = join(root, 'home'); const work = join(root, 'work')
  mkdirSync(home); mkdirSync(work)
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['chief'], bots: {
    chief: { id: 'chief', name: 'Chief', instructions: '', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', instructions: '', workDir: work, createdAt: 2 },
  }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} }))
  const ctx = fakeContext()
  let sequence = 0
  const agents = new Map()
  ctx.workspaceRegistry = { get: () => ({ path: work }), resolveByPath: async () => ({ id: 'team' }), create: async () => ({ id: 'team', path: work }), archiveSession: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { flush: async () => true }
  ctx.sessionController = { create: async () => ({ sessionId: `session-${++sequence}` }), selectModel: async () => {},
    async resolveAgent(id) {
      if (!agents.has(id)) agents.set(id, { ...ctx.scopeAgent(id), session: { id, header: { id, cwd: work }, requestHeader: () => ({ config: {} }), deriveMessages: () => [] },
        inbox: { nextStep: [], nextTurn: [], remove: () => true }, followup: () => {}, cancel: () => {} })
      return { agent: agents.get(id) }
    } }
  const listening = new Set(process.listeners('message'))
  const rt = createRuntime(ctx, { home, memory: false, learning: false })
  await rt.load()
  rt.eventsBackwards = async function* () {}
  // The desktop notices ride on the Host IPC, which only a desktop Host process has.
  const sent = []
  process.env.DS_BOT_APP = '1'
  process.connected = true
  const originalSend = process.send
  process.send = message => { sent.push(message) }
  t.after(async () => {
    delete process.env.DS_BOT_APP
    delete process.connected
    if (originalSend === undefined) delete process.send
    else process.send = originalSend
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const tool = async (name, args, sessionId, callId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId, concludeTurn() {} })
  const event = async (id, type, data, seq = 1) => {
    const { agent } = await ctx.sessionController.resolveAgent(id)
    for (const listener of ctx.listeners.get('session/event')) await listener(agent.session, { type, data, seq, time: Date.now() })
  }
  const attention = () => sent.filter(message => message.type === 'ds-bot:attention')
  // The app's answer arrives on the Host's IPC channel; only the listener this runtime added gets it.
  const answer = message => {
    for (const listener of process.listeners('message')) if (!listening.has(listener)) listener(message)
  }
  const results = () => sent.filter(message => message.type === 'ds-bot:attention-result')
  return { rt, ctx, sent, attention, results, answer, tool, event }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const textOf = message => message.content.map(part => part.text).join('')

test('a question card, a view card, a secret card and an approval each notify the desktop once', async t => {
  const b = await bench(t)
  await b.ctx.emitAsync('agent/created', { agent: b.ctx.scopeAgent('writer') })
  await b.tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, 'writer', 'call-q')
  let notices = b.attention()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, 'question')
  assert.equal(notices[0].id, b.rt.state.questions.writer.id)
  assert.equal(notices[0].botId, 'writer')
  assert.equal(notices[0].sessionId, 'writer')
  assert.equal(notices[0].name, 'Writer')

  await b.tool('show_view', { title: 'Pick', view: { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] } }, 'writer', 'call-v')
  notices = b.attention()
  assert.equal(notices.length, 2)
  assert.equal(notices[1].kind, 'view')
  assert.equal(notices[1].id, b.rt.state.views.writer.id)

  await b.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'test' }, 'writer', 'call-s')
  notices = b.attention()
  assert.equal(notices.length, 3)
  assert.equal(notices[2].kind, 'secret')
  assert.equal(notices[2].id, b.rt.state.secretRequests.writer[0].id)

  const waiting = b.ctx.listeners.get('approval/request')[0](
    { agent: { session: { id: 'writer' } }, toolName: 'bash', reason: 'clean the folder', callId: 'call-a' }, () => 'from-dsh')
  notices = b.attention()
  assert.equal(notices.length, 4)
  assert.equal(notices[3].kind, 'approval')
  assert.equal(notices[3].botId, 'writer')
  assert.equal(notices[3].sessionId, 'writer')
  assert.equal(notices[3].roomId, undefined)
  await waiting
  assert.equal(b.attention().length, 4)
})

test('a failed user turn notifies a failure even after an earlier turn completed, and repeats only per turn', async t => {
  const b = await bench(t)
  await b.event('writer', 'turn/start', { turn: 6 })
  await b.event('writer', 'user/message', { source: { kind: 'user' } }, 4)
  await b.event('writer', 'assistant/message', { message: { content: [{ type: 'text', text: 'All done' }] } })
  await b.event('writer', 'turn/end', { turn: 6, reason: { kind: 'completed' } })
  assert.equal(b.rt.state.completions.length, 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(b.sent.filter(message => message.type === 'ds-bot:completion').length, 1)
  // The next user turn fails although the earlier one already consumed the pending completion.
  await b.event('writer', 'turn/start', { turn: 7 })
  await b.event('writer', 'user/message', { source: { kind: 'user' } }, 5)
  await b.event('writer', 'assistant/message', { message: { content: [{ type: 'text', text: 'Working on it' }] } })
  await b.event('writer', 'turn/end', { turn: 7, reason: { kind: 'error', error: { code: 'AUTH', message: 'key rejected' } } })
  const notices = b.attention()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, 'failure')
  assert.equal(notices[0].id, 'fail:writer:7')
  assert.equal(b.rt.state.completions.length, 1)
  assert.equal(b.sent.filter(message => message.type === 'ds-bot:completion').length, 1)
  // The same turn failing twice notifies once; the retry turn gets its own notice.
  await b.event('writer', 'turn/end', { turn: 7, reason: { kind: 'error', error: { code: 'AUTH', message: 'key rejected' } } })
  assert.equal(b.attention().length, 1)
  await b.event('writer', 'turn/start', { turn: 8 })
  await b.event('writer', 'user/message', { source: { kind: 'user' } }, 6)
  await b.event('writer', 'turn/end', { turn: 8, reason: { kind: 'error', error: { code: 'AUTH', message: 'key rejected' } } })
  assert.equal(b.attention().length, 2)
  assert.equal(b.attention()[1].id, 'fail:writer:8')
})

test('a pending secret card blocks the completion notice of the turn that asked for it', async t => {
  const b = await bench(t)
  await b.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'test' }, 'writer', 'call-s')
  await b.event('writer', 'turn/start', { turn: 3 })
  await b.event('writer', 'user/message', { source: { kind: 'user' } }, 7)
  await b.event('writer', 'assistant/message', { message: { content: [{ type: 'text', text: 'The card is on screen.' }] } })
  await b.event('writer', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  assert.equal(b.rt.state.completions.length, 0)
  assert.equal(b.sent.some(message => message.type === 'ds-bot:completion'), false)
  const secrets = Object.values(b.rt.state.secretRequests ?? {}).flat()
  assert.equal(secrets.some(request => request.status === 'pending'), true)
})

test('an internal exchange turn fails quietly and attention ignores the completion switch', async t => {
  const b = await bench(t)
  await b.event('writer', 'turn/start', { turn: 1 })
  await b.event('writer', 'user/message', { source: { kind: 'bot', role: 'request', senderSessionId: 'chief' } })
  await b.event('writer', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'key rejected' } } })
  assert.equal(b.attention().length, 0)
  b.rt.botOf('writer').notifyCompletion = false
  await b.tool('ask_user', { question: 'Still there?', options: [{ label: 'Yes' }, { label: 'No' }] }, 'writer', 'call-q2')
  assert.equal(b.attention().length, 1)
  assert.equal(b.sent.some(message => message.type === 'ds-bot:completion'), false)
})

test('a group member approval names the tool and the reason, and a notice answer decides it', async t => {
  const b = await bench(t)
  b.rt.groupOwners.set('member-1', { botId: 'writer', roomId: 'room1' })
  const waiting = b.ctx.listeners.get('approval/request')[0](
    { agent: { session: { id: 'member-1' } }, toolName: 'bash', reason: 'clean the folder', callId: 'call-a' }, () => 'from-dsh')
  const notice = b.attention().at(-1)
  assert.equal(notice.kind, 'approval')
  assert.equal(notice.roomId, 'room1')
  assert.equal(notice.tool, 'bash')
  assert.equal(notice.reason, 'clean the folder')
  b.answer({ type: 'ds-bot:attention-answer', id: notice.id, kind: 'approval', choice: 'reject' })
  assert.equal(await waiting, 'rejected')
  await settle()
  assert.deepEqual(b.results(), [{ type: 'ds-bot:attention-result', id: notice.id, ok: true }])
})

test('a question carries its options, and a notice answer reaches the Bot once as the user’s answer', async t => {
  const b = await bench(t)
  await b.ctx.emitAsync('agent/created', { agent: b.ctx.scopeAgent('writer') })
  await b.tool('ask_user', { question: 'Which one?', detail: 'Pick one', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], allowCustom: true }, 'writer', 'call-q')
  const card = b.rt.state.questions.writer
  const notice = b.attention().at(-1)
  assert.equal(notice.kind, 'question')
  assert.equal(notice.question, 'Which one?')
  assert.equal(notice.detail, 'Pick one')
  assert.deepEqual(notice.options, ['A', 'B', 'C'])
  assert.equal(notice.multiSelect, false)
  assert.equal(notice.allowCustom, true)
  const { agent } = await b.ctx.sessionController.resolveAgent('writer')
  const followups = []
  agent.followup = message => followups.push(message)
  b.answer({ type: 'ds-bot:attention-answer', id: card.id, kind: 'question', sessionId: 'writer', selected: ['B'], custom: '' })
  await settle()
  assert.equal(b.rt.state.questions.writer, undefined)
  assert.equal(followups.length, 1)
  assert.match(textOf(followups[0]), /"selected":\["B"\]/)
  b.answer({ type: 'ds-bot:attention-answer', id: card.id, kind: 'question', sessionId: 'writer', selected: ['A'] })
  await settle()
  assert.equal(followups.length, 1)
  assert.deepEqual(b.results(), [
    { type: 'ds-bot:attention-result', id: card.id, ok: true },
    { type: 'ds-bot:attention-result', id: card.id, ok: false, error: 'This question is no longer open' },
  ])
})

test('a typed answer from a notice is sent as the user wrote it, and an empty one is refused', async t => {
  const b = await bench(t)
  await b.ctx.emitAsync('agent/created', { agent: b.ctx.scopeAgent('writer') })
  await b.tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], allowCustom: true }, 'writer', 'call-q')
  const card = b.rt.state.questions.writer
  const { agent } = await b.ctx.sessionController.resolveAgent('writer')
  const followups = []
  agent.followup = message => followups.push(message)
  b.answer({ type: 'ds-bot:attention-answer', id: card.id, kind: 'question', sessionId: 'writer', selected: [], custom: '' })
  await settle()
  assert.equal(followups.length, 0)
  assert.equal(b.rt.state.questions.writer?.id, card.id)
  assert.deepEqual(b.results().at(-1), { type: 'ds-bot:attention-result', id: card.id, ok: false, error: 'Nothing to send' })
  b.answer({ type: 'ds-bot:attention-answer', id: card.id, kind: 'question', sessionId: 'writer', selected: [], custom: 'None of these' })
  await settle()
  assert.equal(followups.length, 1)
  assert.match(textOf(followups[0]), /"custom":"None of these"/)
})

test('a notice answer for a card that cannot be answered from a notice is refused', async t => {
  const b = await bench(t)
  b.answer({ type: 'ds-bot:attention-answer', id: 'v1', kind: 'view', sessionId: 'writer' })
  await settle()
  assert.deepEqual(b.results(), [{ type: 'ds-bot:attention-result', id: 'v1', ok: false, error: 'This card cannot be answered from a notice' }])
})
