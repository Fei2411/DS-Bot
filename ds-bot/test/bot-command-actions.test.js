import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The client module imports the icon set (a React module) and the interface copy; bundle
// it with a React stand-in, as the composer's own client tests do.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/command-actions.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? { createElement: () => null } : {}),
})
const { installCommandActions, commandEntries, SCHEDULED_TASK } = module.exports

const bot = { id: 'a', name: 'A' }
const room = { id: 'r1', name: 'G', members: ['a'], admin: 'a' }
const rosterOf = () => ({
  getSnapshot: () => ({
    byId: { a: bot, 'a-part': bot },
    roomsById: { r1: room, 'r1-part': room },
  }),
})

const calls = []
const actions = {
  openSettings: (...args) => calls.push(['settings', ...args]),
  composeGoal: id => calls.push(['goal', id]),
}

test('the scheduled-task action exists for a Bot chat and a group chat, and for nothing else', () => {
  const { contributions, decorations } = commandEntries({ roster: rosterOf(), actions })
  assert.equal(contributions.length, 1)
  assert.equal(decorations.length, 1)
  const [schedule] = contributions
  assert.equal(schedule.name, SCHEDULED_TASK)
  assert.equal(schedule.available({ sessionId: 'a' }), true)
  assert.equal(schedule.available({ sessionId: 'a-part' }), true)
  assert.equal(schedule.available({ sessionId: 'r1' }), true)
  assert.equal(schedule.available({ sessionId: 'r1-part' }), true)
  assert.equal(schedule.available({ sessionId: 'plain-dsh-agent' }), false)
  assert.equal(typeof schedule.label(), 'string')
  assert.equal(typeof schedule.description(), 'string')
})

test('picking the scheduled-task action opens this chat\u2019s scheduled tasks', () => {
  calls.length = 0
  const { contributions } = commandEntries({ roster: rosterOf(), actions })
  contributions[0].ui.run({ sessionId: 'a' })
  contributions[0].ui.run({ sessionId: 'r1' })
  assert.deepEqual(calls, [['settings', 'schedules', 'a'], ['settings', 'schedules', 'r1']])
})

test('a bare /goal in a group chat opens the group goal, and a Bot chat is left to the host', () => {
  calls.length = 0
  const { decorations } = commandEntries({ roster: rosterOf(), actions })
  const [goal] = decorations
  assert.equal(goal.name, 'goal')
  assert.equal(goal.available({ sessionId: 'r1' }), true)
  assert.equal(goal.available({ sessionId: 'r1-part' }), true)
  assert.equal(goal.available({ sessionId: 'a' }), false)
  goal.ui.run({ sessionId: 'r1' })
  assert.deepEqual(calls, [['goal', 'r1']])
})

test('the install registers one contribution and one decoration with the command surface', () => {
  const registrations = []
  const ctx = {
    inject(services, callback) {
      assert.equal(services.length, 1)
      assert.equal(services[0], 'commandUi')
      const scope = {
        effect: execute => execute(),
        commandUi: {
          register: contribution => { registrations.push(['register', contribution.name]); return () => {} },
          decorate: decoration => { registrations.push(['decorate', decoration.name]); return () => {} },
        },
      }
      callback(scope)
      return { dispose() {} }
    },
  }
  installCommandActions(ctx, { roster: rosterOf(), actions })
  assert.deepEqual(registrations, [['register', 'scheduled-task'], ['decorate', 'goal']])
})
