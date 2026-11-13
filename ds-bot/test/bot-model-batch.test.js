import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SKIP_LOCAL_AGENT, SKIP_UNAVAILABLE, planModelChange, runModelChange, summarizeModelChange } from '../src/client/bot-model-batch.js'

// #1502: one place to move several Bots to the same model. A Bot's run mode is its own
// property, so a Bot on a local agent keeps it and is reported instead of being moved
// onto a DS Bot model.

const MODELS = [
  { ref: 'official/flash', name: 'Flash' },
  { ref: 'official/pro', name: 'Pro' },
]
const bot = (id, model, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), model, ...extra })

test('every eligible Bot changes to the picked model', async () => {
  const calls = []
  const results = await runModelChange({
    bots: [bot('chief', 'official/pro'), bot('writer', undefined)],
    ref: 'official/flash', models: MODELS,
    updateBot: async (id, patch) => { calls.push([id, patch]) },
  })
  assert.deepEqual(calls, [['chief', { model: 'official/flash' }], ['writer', { model: 'official/flash' }]])
  assert.deepEqual(results.map(entry => entry.status), ['updated', 'updated'])
  assert.deepEqual(summarizeModelChange(results), { total: 2, updated: 2, unchanged: 0, skipped: 0, failed: 0 })
})

test('one failed Bot does not stop the rest and keeps its error', async () => {
  const results = await runModelChange({
    bots: [bot('a', 'official/pro'), bot('b', 'official/pro'), bot('c', 'official/pro')],
    ref: 'official/flash', models: MODELS,
    updateBot: async (id) => { if (id === 'b') throw new Error('The model is not available') },
  })
  assert.deepEqual(results.map(entry => entry.status), ['updated', 'failed', 'updated'])
  assert.equal(results[1].message, 'The model is not available')
  assert.deepEqual(summarizeModelChange(results), { total: 3, updated: 2, unchanged: 0, skipped: 0, failed: 1 })
})

test('a Bot on a local agent is skipped and never sent a DS Bot model', async () => {
  const calls = []
  const results = await runModelChange({
    bots: [bot('claude', 'local-claude-code/default'), bot('chief', 'official/pro')],
    ref: 'official/flash', models: MODELS,
    updateBot: async (id) => { calls.push(id) },
  })
  assert.deepEqual(calls, ['chief'])
  assert.deepEqual(results.map(entry => [entry.status, entry.reason]), [['skipped', SKIP_LOCAL_AGENT], ['updated', undefined]])
})

test('a model no longer served is skipped for every Bot and touches none', async () => {
  const calls = []
  const results = await runModelChange({
    bots: [bot('chief', 'official/pro'), bot('writer', undefined)],
    ref: 'official/gone', models: MODELS,
    updateBot: async () => { calls.push(1) },
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(results.map(entry => [entry.status, entry.reason]), [['skipped', SKIP_UNAVAILABLE], ['skipped', SKIP_UNAVAILABLE]])
  assert.deepEqual(summarizeModelChange(results), { total: 2, updated: 0, unchanged: 0, skipped: 2, failed: 0 })
})

test('a Bot already on the model is neither changed nor counted as skipped', async () => {
  const calls = []
  const results = await runModelChange({
    bots: [bot('chief', 'official/flash')], ref: 'official/flash', models: MODELS,
    updateBot: async (id) => { calls.push(id) },
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(results.map(entry => entry.status), ['unchanged'])
})

test('a Bot that last ran on the model keeps it', () => {
  const plan = planModelChange([{ id: 'x', name: 'X', appliedModel: 'official/pro' }], 'official/pro', MODELS)
  assert.deepEqual(plan.map(entry => entry.action), ['keep'])
})
