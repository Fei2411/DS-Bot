import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

// How a Bot writes is one team setting; a Bot may override it, and the section sits
// before its own instructions so the style shapes the whole answer.
test('the prompt carries the team reply style, and a Bot may pick its own', (t) => {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.', replyStyle: 'formal' }],
  ])
  const state = { prefs: {} }
  install({
    ctx,
    state,
    selfOf: id => id,
    botOf: id => bots.get(id),
    roomOf: () => undefined,
    isMain: id => id === 'main',
  })
  t.after(() => ctx.dispose())
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  assert.match(prompt('main'), /## How you write\nWrite like a teammate texting/)
  const formal = prompt('worker')
  assert.match(formal, /## How you write\nWrite plain professional prose/)
  assert.ok(formal.indexOf('## How you write') < formal.indexOf('Check files.'))
  state.prefs.replyStyle = 'concise'
  assert.match(prompt('main'), /## How you write\nLead with the conclusion, then at most two sentences/)
  assert.match(prompt('worker'), /## How you write\nWrite plain professional prose/)
})
