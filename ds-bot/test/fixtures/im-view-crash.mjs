import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../../index.js'
import { adapters } from '../../src/host/im/platforms/index.js'
import { fakeContext } from '../fake-ctx.js'

const [home, mode] = process.argv.slice(2)
writeFileSync(join(home, 'state.json'), JSON.stringify({
  version: 1, mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
}))
const prompts = []
const agent = {
  id: 'a', session: { id: 'a', requestHeader: () => undefined },
  followup() {}, cancel() {}, inbox: { nextStep: [], nextTurn: [], remove: () => false }, async whenIdle() {},
}
const ctx = fakeContext()
Object.assign(ctx, {
  llm: { listProviders: () => [] },
  workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
  sessionController: {
    prompt: async request => { prompts.push(request); return { ok: true } },
    resolveAgent: async () => ({ agent }), selectModel: async () => {},
  },
  sessions: { flush: async () => {} },
})
let handlers
let delivery
let conn
const report = () => process.send({ ...delivery, connId: conn.id })
adapters.telegram = {
  async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
  connect(fields, env, next) {
    handlers = next
    handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
    return {
      async send(chat, body) {
        const code = /Card (V\d+)/.exec(body.text)?.[1]
        if (code !== undefined) {
          let persisted
          try { persisted = JSON.parse(readFileSync(join(home, 'im', `${conn.id}.json`), 'utf8')) } catch {}
          delivery = { code, viewId: rt.state.views.a.id, persisted }
          if (mode === 'open') {
            report()
            await new Promise(() => {})
          }
        }
        return { messageId: mode === 'complete-no-id' ? undefined : '1' }
      },
      async edit() {}, async typing() {}, stop() {},
    }
  },
}
const rt = createRuntime(ctx, { home })
conn = await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'fake-token' } })
rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'User', at: 1 })
await rt.save()
const message = text => handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct' }, sender: { id: 'u1' }, text })
await message('form please')
for (const [type, data] of [
  ['turn/start', { turn: 1 }],
  ['user/message', { source: { kind: 'user', rpcId: prompts.at(-1).requestId }, content: [{ type: 'text', text: 'form please' }] }],
]) {
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) listener({ id: 'a' }, { type, data, time: Date.now() })
  }
}
await rt.teamTools.find(tool => tool.name === 'show_view').execute({ view: {
  type: 'form', id: 'details', fields: [{ id: 'name', label: 'Name' }],
} }, { agent, concludeTurn() {} })
while (delivery === undefined) await delay(1)
if (mode.startsWith('complete')) {
  let persisted
  do {
    await delay(1)
    persisted = JSON.parse(readFileSync(join(home, 'im', `${conn.id}.json`), 'utf8'))
  } while (persisted.cards[`v:${delivery.viewId}`][0].delivered !== true)
  delivery.persisted = persisted
  report()
}
if (mode === 'settled') {
  await message(`!card ${delivery.code}\n1: First`)
  report()
}
setInterval(() => {}, 1000)
