import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'
import { install } from '../src/host/groups.js'
import { install as installDelivery } from '../src/host/delivery.js'
import { qqRequestId, qqReplyOf, qqReplyChat } from '../src/shared/qq-reply.js'

const reply = (messageId, senderId) => ({ connectionId: 'im_one', chatKey: 'g1', kind: 'group', messageId, senderId })
const requestId = (messageId, senderId) => qqRequestId('im_one', {
  chat: { key: 'g1', kind: 'group' }, messageId, sender: { id: senderId },
}, 'test-nonce')

test('QQ request sources round-trip without confusing old IDs or other listeners', () => {
  const source = { rpcId: requestId('message-a', 'alice') }
  const anchor = qqReplyOf(source)
  assert.deepEqual(anchor, reply('message-a', 'alice'))
  assert.equal(qqReplyOf({ rpcId: 'im:qq:old-uuid' }), undefined)
  assert.equal(qqReplyOf({ rpcId: 'im:qq:e30:nonce' }), undefined)
  assert.equal(qqReplyOf({ rpcId: 'web-request' }), undefined)
  assert.equal(qqReplyOf({ rpcId: `im:qq:${Buffer.from('null').toString('base64url')}:nonce` }), undefined)
  const chat = { kind: 'group', title: 'Group' }
  assert.deepEqual(qqReplyChat({ id: 'im_one', platform: 'qq' }, 'g1', chat, anchor).replyTo, { messageId: 'message-a', senderId: 'alice' })
  for (const [conn, key, kind] of [
    [{ id: 'im_other', platform: 'qq' }, 'g1', 'group'],
    [{ id: 'im_one', platform: 'qq' }, 'g2', 'group'],
    [{ id: 'im_one', platform: 'qq' }, 'g1', 'direct'],
    [{ platform: 'telegram' }, 'g1', 'group'],
  ]) assert.equal(qqReplyChat(conn, key, { kind }, anchor).replyTo, undefined)
})

test('delivery preserves QQ context together with the abandoned-wait options', async () => {
  const messages = []
  const agent = { session: {}, followup: message => messages.push(message) }
  const rt = {
    ctx: { sessionController: { resolveAgent: async () => ({ agent }) }, sessions: { flush: async () => {} } },
    state: { exchanges: [] }, botOf: id => id === 'recipient' ? { id } : undefined,
    roomOf: () => undefined, chatOf: id => id, hideBotUnusedTools() {}, ensureCapabilities: async () => {},
  }
  installDelivery(rt)
  const qqReply = reply('message-a', 'alice')
  await rt.deliver({ toId: 'recipient', fromName: 'Former sender', role: 'reply', text: 'No reply came back', abandoned: true, recordExchange: false, qqReply })
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /Waiting given up · Former sender/)
  assert.equal(messages[0].source.senderName, 'Former sender')
  assert.equal(messages[0].source.abandoned, true)
  assert.deepEqual(messages[0].source.qqReply, qqReply)
  assert.deepEqual(rt.state.exchanges, [], 'a synthetic wait result is not recorded as a new exchange')
})

test('a group member keeps its QQ reply source when a second question joins the running round', async (t) => {
  const bot = { id: 'bot', name: 'Bot' }
  const room = { id: 'room', name: 'Room', members: ['bot'], admin: 'bot', mode: 'admin', sessions: { bot: 'member-session' }, seen: {}, log: [], seq: 0 }
  const agent = { id: 'room-session', inbox: { nextStep: [], nextTurn: [], remove(id) {
    const index = this.nextTurn.findIndex(message => message.id === id)
    if (index < 0) return false
    this.nextTurn.splice(index, 1)
    return true
  } } }
  const deliveries = []
  const lines = []
  const disposers = []
  const warnings = []
  const rt = {
    ctx: { effect: fn => disposers.push(fn()), on() {} }, home: '/tmp/unused-qq-reply-test', teamTools: [],
    botOf: id => id === 'bot' ? bot : undefined,
    roomOf: id => ['room', 'room-session'].includes(id) ? room : undefined,
    sessionOfRoom: () => 'room-session', isAdminOf: (_room, id) => id === 'bot',
    groupOwners: new Map([['member-session', { botId: 'bot', roomId: 'room' }]]),
    roomWaiters: new Map(), roomProgress: new Map(), live: new Map(),
    roomInbox: new Map([['room', [{ text: 'question A', qqReply: reply('message-a', 'alice') }]]]),
    load: async () => {}, save: async () => {}, ensureCapabilities: async () => {}, resolveAgent: async () => agent,
    warn: (...args) => warnings.push(args), deliver: async data => deliveries.push(data),
  }
  install(rt)
  rt.onRoomLine((_room, line) => lines.push(line))
  const controller = new AbortController()
  const tool = rt.teamTools.find(item => item.name === 'group_relay')
  const work = tool.execute({}, { agent, callId: 'test-call', signal: controller.signal })
  t.after(async () => {
    controller.abort()
    await work.catch(() => {})
    for (const dispose of disposers.reverse()) await dispose?.()
  })
  for (let i = 0; i < 10 && deliveries.length < 1; i++) await tick()
  assert.equal(deliveries[0]?.qqReply?.messageId, 'message-a')
  agent.inbox.nextTurn.push({ id: 'B', source: { kind: 'user', rpcId: requestId('message-b', 'bob') }, content: [{ type: 'text', text: 'question B' }] })
  rt.nudgeRoom('room')
  await tick()
  await tick()
  const first = rt.roomWaiters.get(deliveries[0].exchangeId)
  first.say('progress A')
  first.resolve('final A')
  for (let i = 0; i < 10 && deliveries.length < 2; i++) await tick()
  assert.equal(deliveries[1]?.qqReply?.messageId, 'message-b')
  const second = rt.roomWaiters.get(deliveries[1].exchangeId)
  second.say('progress B')
  second.resolve('final B')
  await work
  const responses = lines.filter(line => line.botId)
  assert.equal(responses.length, 4)
  for (const line of responses) assert.equal(line.qqReply?.messageId, line.text.endsWith('A') ? 'message-a' : 'message-b')
  assert.deepEqual(warnings, [])
})
