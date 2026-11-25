import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service, symbols as cordisSymbols } from '@deepseek-ai/cordis'
import { install as installSteer } from '../src/host/steer.js'
import { install as installTurns } from '../src/host/turns.js'

test('real Cordis Service proxy: turns.js prompt wrapper unwraps target and restores cleanly on plugin unload', async (t) => {
  class RealSessionController extends Service {
    constructor(ctx) {
      super(ctx, 'sessionController')
      this.calls = []
    }
    async prompt(request) {
      this.calls.push(request.requestId)
      if (request.fail) {
        const err = new Error('session busy')
        err.code = 'session/agent-busy'
        err.details = { reason: 'provider timeout' }
        throw err
      }
      return { accepted: true }
    }
  }

  const root = new Context()
  await root.plugin(RealSessionController)
  t.after(() => root.fiber.dispose())

  const rawTarget = root.sessionController[cordisSymbols.original]
  assert.ok(rawTarget instanceof RealSessionController)
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false)

  const failures = []
  const makeRt = ctx => ({
    ctx,
    state: { bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, views: {}, prefs: {} },
    chatOwners: new Map([['dm-a', 'a']]),
    groupOwners: new Map(),
    taskOwners: new Map(),
    botOf: id => (id === 'a' ? { id: 'a', name: 'Chief', sessionId: 'dm-a' } : undefined),
    roomOf: () => undefined,
    selfOf: id => (id === 'dm-a' ? 'a' : undefined),
    isBotSession: id => id === 'dm-a',
    noteFailure: entry => failures.push(entry),
    redactSecrets: value => value,
    warn: () => {},
  })

  const fiber1 = root.plugin({
    name: 'turns-reload-1',
    inject: ['sessionController'],
    apply(ctx) { installTurns(makeRt(ctx)) },
  })
  await fiber1
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), true)

  await assert.rejects(
    root.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r1', fail: true }),
    /provider timeout/,
  )
  assert.equal(failures.length, 1)

  await fiber1.dispose()
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false, 'prompt wrapper must be deleted on plugin unload')
  assert.equal(rawTarget.prompt, RealSessionController.prototype.prompt)

  // Reinstall once more to confirm no stacking or leaked listener.
  const fiber2 = root.plugin({
    name: 'turns-reload-2',
    inject: ['sessionController'],
    apply(ctx) { installTurns(makeRt(ctx)) },
  })
  await fiber2
  await root.sessionController.prompt({ sessionId: 'dm-a', requestId: 'r2' })
  await fiber2.dispose()
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false)
  assert.deepEqual(rawTarget.calls, ['r1', 'r2'])
})

test('real Cordis Service proxy: turns.js + steer.js installed in one plugin fiber restore prompt cleanly on LIFO unload', async (t) => {
  class RealSessionController extends Service {
    constructor(ctx) {
      super(ctx, 'sessionController')
      this.calls = []
    }
    async prompt(request) {
      this.calls.push(request.requestId)
      return { accepted: true }
    }
    async updateQueue(request) {
      return { updated: request.sessionId }
    }
  }

  const root = new Context()
  await root.plugin(RealSessionController)
  t.after(() => root.fiber.dispose())

  const rawTarget = root.sessionController[cordisSymbols.original]
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false)
  assert.equal(Object.hasOwn(rawTarget, 'updateQueue'), false)

  const makeRt = ctx => ({
    ctx,
    state: { bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, views: {}, prefs: {} },
    chatOwners: new Map([['dm-a', 'a']]),
    groupOwners: new Map(),
    taskOwners: new Map(),
    botOf: id => (id === 'a' ? { id: 'a', name: 'Chief', sessionId: 'dm-a' } : undefined),
    chatOf: id => (id === 'a' ? 'dm-a' : undefined),
    roomOf: () => undefined,
    selfOf: id => (id === 'dm-a' ? 'a' : undefined),
    isBotSession: id => id === 'dm-a',
    readOnly: () => undefined,
    noteFailure: () => {},
    redactSecrets: value => value,
    warn: () => {},
  })

  // Matches ds-bot/index.js MODULES order: turns installs before steer in one fiber.
  const fiber1 = root.plugin({
    name: 'turns-and-steer-1',
    inject: ['sessionController'],
    apply(ctx) {
      const rt = makeRt(ctx)
      installTurns(rt)
      installSteer(rt)
    },
  })
  await fiber1
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), true)
  assert.equal(Object.hasOwn(rawTarget, 'updateQueue'), true)

  await root.sessionController.prompt({ sessionId: 'dm-a', requestId: 'c1', mode: 'steer' })
  await fiber1.dispose()
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false, 'LIFO unload must delete both steer and turns prompt wrappers')
  assert.equal(Object.hasOwn(rawTarget, 'updateQueue'), false)
  assert.equal(rawTarget.prompt, RealSessionController.prototype.prompt)
  assert.equal(rawTarget.updateQueue, RealSessionController.prototype.updateQueue)

  // Reinstall and dispose again to confirm clean reload.
  const fiber2 = root.plugin({
    name: 'turns-and-steer-2',
    inject: ['sessionController'],
    apply(ctx) {
      const rt = makeRt(ctx)
      installTurns(rt)
      installSteer(rt)
    },
  })
  await fiber2
  await root.sessionController.prompt({ sessionId: 'dm-a', requestId: 'c2', mode: 'steer' })
  await fiber2.dispose()
  assert.equal(Object.hasOwn(rawTarget, 'prompt'), false)
  assert.equal(rawTarget.prompt, RealSessionController.prototype.prompt)
  assert.deepEqual(rawTarget.calls, ['c1', 'c2'])
})
