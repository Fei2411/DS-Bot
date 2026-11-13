import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/agent-commands.js'

// A small host `commands` registry with the same contract the real one gives the
// shield: global definitions, per-agent scoped definitions that shadow them, a merged
// list(agent), find/execute, and a `commands/change` event on every registration.
function world({ config = {} } = {}) {
  let dshRuns = 0
  const global = new Map()
  const scoped = new Map()
  const listeners = new Map()
  const agents = []
  const emit = (event, payload) => { for (const listener of listeners.get(event) ?? []) listener(payload) }
  const notify = () => emit('commands/change', {})
  const effective = (sessionId) => {
    const map = new Map(global)
    for (const [name, definition] of scoped.get(sessionId) ?? []) map.set(name, definition)
    return map
  }
  const registerGlobal = (name) => {
    global.set(name, { name, description: `global ${name}`, handler: () => { dshRuns += 1; return { kind: 'success', text: 'DSH ran' } } })
    notify()
  }
  const service = {
    list: agent => [...effective(agent.session.id).values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    find: (agent, name) => effective(agent.session.id).get(name),
    async execute(agent, line) {
      const at = line.indexOf(' ')
      const name = (at === -1 ? line : line.slice(0, at)).replace(/^\//, '')
      const rawInput = at === -1 ? '' : line.slice(at)
      const definition = effective(agent.session.id).get(name)
      if (definition === undefined) return undefined
      return { result: await definition.handler({ rawInput }) }
    },
  }
  // The child context a plugin mounted under an agent's context gets. The shield reads
  // the service through reflection (`get`), as it does in the real host.
  const childOf = (sessionId) => {
    const commands = {
      list: agent => service.list(agent),
      find: (agent, name) => service.find(agent, name),
      register(definition) {
        const map = scoped.get(sessionId) ?? new Map()
        if (map.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        map.set(definition.name, definition)
        scoped.set(sessionId, map)
        notify()
        return () => { map.delete(definition.name); notify() }
      },
    }
    return { commands, get: name => (name === 'commands' ? commands : undefined) }
  }
  const ctx = {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    get: name => (name === 'commands' ? service : name === 'agents' ? { list: () => agents } : undefined),
  }
  const saved = []
  const rt = {
    ctx,
    config,
    onSaved: listener => { saved.push(listener); return () => {} },
    saved,
    chatOwners: new Map(),
    rooms: new Map(),
    roomOf: id => rt.rooms.get(id),
    warn: (...args) => rt.warnings.push(args.join(' ')),
    warnings: [],
  }
  const agent = (sessionId) => {
    const entry = {
      session: { id: sessionId },
      ctx: {
        plugin(definition) {
          definition.apply(childOf(sessionId))
          return { dispose() { /* the agent scope disposes the fiber */ } }
        },
      },
    }
    agents.push(entry)
    return entry
  }
  return { ctx, rt, service, registerGlobal, emit, agent, agents, runs: () => dshRuns }
}

test('the shield shadows every command a Bot sees and refuses a typed command with its arguments', () => {
  const w = world()
  install(w.rt)
  w.rt.chatOwners.set('a', 'a')
  w.registerGlobal('plan')
  w.registerGlobal('compact')
  const a = w.agent('a')
  w.emit('agent/created', { agent: a })

  assert.equal(w.service.find(a, 'plan').description, 'Not available in a Bot chat — use the Bot’s own controls')
  assert.equal(w.service.list(a).length, 2, 'every command the Bot sees has a shadow')
  return w.service.execute(a, '/plan 明天上线').then(({ result }) => {
    assert.equal(result.kind, 'error')
    assert.match(result.text, /DSH \/plan command does not run in a Bot's chat/)
    assert.equal(w.runs(), 0, 'the DSH handler never ran')
  })
})

test('one Bot\u2019s shadow stays out of another Bot\u2019s commands', async () => {
  const w = world()
  install(w.rt)
  w.rt.chatOwners.set('a', 'a').set('b', 'b')
  w.registerGlobal('plan')
  const a = w.agent('a')
  const b = w.agent('b')
  // Only a's agent is mounted, so only a is shadowed; b's scope is untouched.
  w.emit('agent/created', { agent: a })
  assert.match(w.service.find(a, 'plan').description, /Not available/)
  assert.equal(w.service.find(b, 'plan').description, 'global plan')
  const { result } = await w.service.execute(b, '/plan 明天上线')
  assert.equal(result.kind, 'success')
  assert.equal(w.runs(), 1, 'the other Bot still runs the DSH command')
})

test('a group chat\u2019s own Session is covered and its /goal points at the group goal', async () => {
  const w = world()
  install(w.rt)
  w.rt.rooms.set('r1', { id: 'r1' })
  w.registerGlobal('goal')
  const room = w.agent('r1')
  w.emit('agent/created', { agent: room })
  assert.match(w.service.find(room, 'goal').description, /group chat/)
  const { result } = await w.service.execute(room, '/goal 明天上线')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Use the group Goal in the group details panel instead/)
  assert.equal(w.runs(), 0)
})

test('a command registered after the agent is covered by the next commands/change', async () => {
  const w = world()
  install(w.rt)
  w.rt.chatOwners.set('a', 'a')
  w.registerGlobal('plan')
  const a = w.agent('a')
  w.emit('agent/created', { agent: a })
  w.registerGlobal('model')
  assert.match(w.service.find(a, 'model').description, /Not available/)
  const { result } = await w.service.execute(a, '/model cheap')
  assert.equal(result.kind, 'error')
  assert.equal(w.runs(), 0)
})

test('a Bot whose agent arrives before its state entry gets the shield on the next save', async () => {
  const w = world()
  install(w.rt)
  w.registerGlobal('plan')
  const a = w.agent('a')
  // The agent is created first, like a Bot created a moment ago: the state does not know
  // the chat yet, so the shield mounts and registers nothing.
  w.emit('agent/created', { agent: a })
  assert.equal(w.service.find(a, 'plan').description, 'global plan')
  // The Bot is saved; the shield re-checks and registers its shadows.
  w.rt.chatOwners.set('a', 'a')
  for (const listener of w.rt.saved) listener()
  assert.match(w.service.find(a, 'plan').description, /Not available/)
  const { result } = await w.service.execute(a, '/plan 明天上线')
  assert.equal(result.kind, 'error')
  assert.equal(w.runs(), 0)
})

test('the shield switch turns it off and leaves the DSH commands alone', async () => {
  const w = world({ config: { commandShield: false } })
  install(w.rt)
  w.rt.chatOwners.set('a', 'a')
  w.registerGlobal('plan')
  const a = w.agent('a')
  w.emit('agent/created', { agent: a })
  assert.equal(w.service.find(a, 'plan').description, 'global plan')
  const { result } = await w.service.execute(a, '/plan 明天上线')
  assert.equal(result.kind, 'success')
  assert.equal(w.runs(), 1)
})
