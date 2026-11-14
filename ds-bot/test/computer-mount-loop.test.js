// Real DSH loop + tool/prompt contract tests for Computer Use mount/save timing (#1412).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { install as installComputer } from '../src/host/computer/index.js'
import { output } from '../src/host/tools.js'

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

async function bootHarness({ enabled = true, externalProvider = false, delayedTool = false } = {}) {
  const root = new Context()
  await mountAgentLoopTestDependencies(root)

  const seen = []
  class MockAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
    }
    async *stream(req) {
      const systemBlocks = (req.messages ?? [])
        .filter(msg => msg.role === 'system')
        .flatMap(msg => (msg.content ?? []).map(part => part.text ?? ''))
        .join('\n')
      seen.push({
        sessionId: String(req.sessionId),
        tools: (req.tools ?? []).map(tool => tool.name).sort(),
        system: systemBlocks,
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['mock'], new MockAdapter())
  await mountAgentLoopTestHarness(root)

  const mountGate = Promise.withResolvers()
  const toolGate = Promise.withResolvers()
  if (!delayedTool) toolGate.resolve()

  const makeRegistry = () => (ctx) => {
    let providerName
    ctx.provide('computerUse', {
      get providerName() { return providerName },
      register(name) {
        providerName = name
        return () => { providerName = undefined }
      },
    })
  }

  const makeProvider = (withDelayedTool = false) => {
    const plugin = (ctx) => {
      ctx.effect(() => {
        const disposers = [
          ctx.computerUse.register('cua-macos'),
          ctx.systemPrompt.section({ name: 'computer-use:macos', order: 500, text: 'USE MACOS CUA' }),
        ]
        if (!withDelayedTool) {
          disposers.push(ctx.tools.register(defineTool({
            name: 'cua',
            description: 'Operate desktop apps',
            parameters: {},
            output,
            async execute() { return 'ok' },
          })))
        } else {
          void toolGate.promise.then(() => {
            disposers.push(ctx.tools.register(defineTool({
              name: 'cua',
              description: 'Operate desktop apps',
              parameters: {},
              output,
              async execute() { return 'ok' },
            })))
          })
        }
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      })
    }
    plugin.inject = ['computerUse', 'tools', 'systemPrompt']
    return plugin
  }

  if (externalProvider) {
    await root.plugin(makeRegistry()).await()
    await root.plugin(makeProvider(delayedTool)).await()
  }

  root.provide('loader', {
    async import(name) {
      if (name === '@deepseek-ai/dsh-computer-use') return makeRegistry()
      await mountGate.promise
      return makeProvider(delayedTool)
    },
  })

  const state = { bots: {}, rooms: {}, computer: { enabled } }
  const savedListeners = new Set()
  const rt = {
    ctx: root,
    state,
    load: async () => {},
    save: async () => {
      for (const listener of [...savedListeners]) await listener()
    },
    onSaved: (listener) => {
      savedListeners.add(listener)
      return () => savedListeners.delete(listener)
    },
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    selfOf: id => id,
    isBotSession: id => Boolean(state.bots[id]),
    chatOwners: new Map(),
    warn: () => {},
    redactSecrets: text => text,
  }

  installComputer(rt)

  const runTurn = async (agent, text = 'hi') => {
    const done = new Promise((resolve) => {
      const dispose = root.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') {
          dispose()
          resolve()
        }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await done
    const lastSystem = agent.session.snapshotEvents()
      .filter(event => event.type === 'system/message')
      .map(event => (event.data?.message?.content ?? []).map(part => part.text ?? '').join(''))
      .at(-1) ?? ''
    return {
      ...seen.at(-1),
      sessionSystem: lastSystem,
    }
  }

  return { root, rt, state, mountGate, toolGate, runTurn }
}

test('bot created while provider mounts receives cua tools once ready, even if state saves after mount', async (t) => {
  const { root, rt, state, mountGate, runTurn } = await bootHarness({ enabled: true })
  t.after(async () => root.fiber.dispose())

  await tick(20)
  assert.equal(rt.computerStatus().state, 'loading')

  // Bot A completes save before mount finishes and runs Turn 1 while still loading.
  const agentA = await root.agentLoop.create(SessionId('bot-a'), { provider: 'mock', model: 'm' })
  state.bots['bot-a'] = { id: 'bot-a', name: 'BotA' }
  await rt.save()
  const turnA1 = await runTurn(agentA, 'before ready')
  assert.deepEqual(turnA1.tools, [])

  // Bot B starts createSession during mount, then mount finishes BEFORE state.bots['bot-b'] is saved.
  const agentB = await root.agentLoop.create(SessionId('bot-b'), { provider: 'mock', model: 'm' })
  await tick(15)
  mountGate.resolve()
  await tick(30)
  assert.equal(rt.computerStatus().state, 'ready')

  state.bots['bot-b'] = { id: 'bot-b', name: 'BotB' }
  await rt.save()

  const turnA2 = await runTurn(agentA, 'after ready')
  assert.deepEqual(turnA2.tools, ['computer_handoff', 'cua'])
  assert.match(turnA2.sessionSystem, /USE MACOS CUA/)
  assert.match(turnA2.sessionSystem, /## Using the computer/)

  const turnB1 = await runTurn(agentB, 'born across mount')
  assert.deepEqual(turnB1.tools, ['computer_handoff', 'cua'])
  assert.match(turnB1.sessionSystem, /USE MACOS CUA/)
  assert.match(turnB1.sessionSystem, /## Using the computer/)
})

test('bot created after provider is ready lifts initial deny when buildBot saves after agent/created', async (t) => {
  const { root, rt, state, mountGate, runTurn } = await bootHarness({ enabled: true })
  t.after(async () => root.fiber.dispose())

  mountGate.resolve()
  await tick(30)
  assert.equal(rt.computerStatus().state, 'ready')

  // Mimic roster.buildBot: createSession emits agent/created + resolves before state.bots[id] + rt.save().
  const agent = await root.agentLoop.create(SessionId('bot-late'), { provider: 'mock', model: 'm' })
  await tick(15)
  state.bots['bot-late'] = { id: 'bot-late', name: 'BotLate' }
  await rt.save()

  const turn = await runTurn(agent, 'check tools')
  assert.deepEqual(turn.tools, ['computer_handoff', 'cua'])
  assert.match(turn.sessionSystem, /USE MACOS CUA/)
  assert.match(turn.sessionSystem, /## Using the computer/)
})

test('off bots and plain sessions on our provider stay masked when computer tools register after deny', async (t) => {
  const { root, rt, state, mountGate, toolGate, runTurn } = await bootHarness({ enabled: true, delayedTool: true })
  t.after(async () => root.fiber.dispose())

  mountGate.resolve()
  await tick(30)
  assert.equal(rt.computerStatus().state, 'ready')

  // Both agents enter 'deny' mode before `cua` finishes registering.
  state.bots['bot-off'] = { id: 'bot-off', name: 'BotOff', computer: { level: 'off' } }
  await rt.save()
  const offAgent = await root.agentLoop.create(SessionId('bot-off'), { provider: 'mock', model: 'm' })
  const plainAgent = await root.agentLoop.create(SessionId('plain-1'), { provider: 'mock', model: 'm' })
  await tick(15)

  // Now `cua` registers asynchronously and emits tools/change.
  toolGate.resolve()
  await tick(30)

  const offTurn = await runTurn(offAgent, 'off check')
  assert.deepEqual(offTurn.tools, [])
  assert.doesNotMatch(offTurn.sessionSystem, /USE MACOS CUA/)
  assert.doesNotMatch(offTurn.sessionSystem, /## Using the computer/)

  const plainTurn = await runTurn(plainAgent, 'plain check')
  assert.deepEqual(plainTurn.tools, [])
  assert.doesNotMatch(plainTurn.sessionSystem, /USE MACOS CUA/)
  assert.doesNotMatch(plainTurn.sessionSystem, /## Using the computer/)
})

test('disposing a superseded agent does not strip computer tools from its replacement', async (t) => {
  const { root, rt, state, mountGate, runTurn } = await bootHarness({ enabled: true })
  t.after(async () => root.fiber.dispose())

  mountGate.resolve()
  await tick(30)
  state.bots['bot-swap'] = { id: 'bot-swap', name: 'BotSwap' }
  await rt.save()

  const oldAgent = { session: { id: 'bot-swap' }, id: 'bot-swap', ctx: root.extend() }
  const newAgent = await root.agentLoop.create(SessionId('bot-swap'), { provider: 'mock', model: 'm' })
  await tick(15)

  // Old agent disposes after newAgent already took over the session id in `applied`.
  root.emit('agent/disposed', { agent: oldAgent })
  await tick(15)

  const turn = await runTurn(newAgent, 'still have tools')
  assert.deepEqual(turn.tools, ['computer_handoff', 'cua'])
})

test('refreshComputer prefers live registry agent when an undisposed old agent shares the same session id', async (t) => {
  const { root, rt, state, mountGate, runTurn } = await bootHarness({ enabled: true })
  t.after(async () => root.fiber.dispose())

  mountGate.resolve()
  await tick(30)
  state.bots['bot-replace-off'] = { id: 'bot-replace-off', name: 'BotReplaceOff', computer: { level: 'off' } }
  await rt.save()

  // Old undisposed agent occupies `applied` first, while `agents.list()` later lists `newAgent` for the same id.
  const oldAgent = { session: { id: 'bot-replace-off' }, id: 'bot-replace-off', ctx: root.extend() }
  root.emit('agent/created', { agent: oldAgent })
  await tick(15)

  const newAgent = await root.agentLoop.create(SessionId('bot-replace-off'), { provider: 'mock', model: 'm' })
  // Refresh synchronously before `newAgent`'s async `agent/created` overwrites `applied`,
  // while `oldAgent` is still undisposed in `applied` and `agents.list()` holds `newAgent`.
  await rt.save()
  await tick(15)
  root.emit('agent/disposed', { agent: oldAgent })
  await tick(15)

  const turn = await runTurn(newAgent, 'must stay masked')
  assert.deepEqual(turn.tools, [])
})

test('plain DSH session keeps external computer provider tools when DS Bot switch is off', async (t) => {
  const { root, rt, runTurn } = await bootHarness({ enabled: false, externalProvider: true })
  t.after(async () => root.fiber.dispose())

  await tick(20)
  assert.equal(rt.computerStatus().state, 'off')
  const plainAgent = await root.agentLoop.create(SessionId('plain-ext'), { provider: 'mock', model: 'm' })
  await tick(15)

  const turn = await runTurn(plainAgent, 'external check')
  assert.deepEqual(turn.tools, ['cua'])
  assert.match(turn.sessionSystem, /USE MACOS CUA/)
  assert.doesNotMatch(turn.sessionSystem, /## Using the computer/)
})
