import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freePriority, groupsFor, readMode, surfaceGroups, writeMode } from '../src/client/surface.js'
import { STORAGE } from '../src/client/storage.js'

test('Bot mode mounts both groups; Agent mode mounts neither', () => {
  assert.deepEqual(groupsFor({ mode: 'bot' }), { shell: true, conversation: true })
  assert.deepEqual(groupsFor({ mode: 'bot', plain: false }), { shell: true, conversation: true })
  assert.deepEqual(groupsFor({ mode: 'agent' }), { shell: false, conversation: false })
  assert.deepEqual(groupsFor({ mode: 'agent', plain: true }), { shell: false, conversation: false })
})

test('a plain Bot-mode view keeps the shell but drops the conversation', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', plain: true }), { shell: true, conversation: false })
})

test('the saved surface mode survives reloads and defaults to bot', () => {
  const store = new Map()
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: key => store.delete(key),
  }
  assert.equal(readMode(storage), 'bot')
  writeMode('agent', storage)
  assert.equal(readMode(storage), 'agent')
  writeMode('bot', storage)
  assert.equal(readMode(storage), 'bot')
  store.set(STORAGE.surface, 'nonsense')
  assert.equal(readMode(storage), 'bot')
})

const recordingGroups = (log, { failing = null } = {}) => {
  const entry = name => () => () => {
    log.push(name)
    if (name === failing) throw new Error(`could not release ${name}`)
  }
  return surfaceGroups({
    shell: () => { log.push('install shell'); return [entry('shell styles'), entry('shell theme')] },
    conversation: () => { log.push('install conversation'); return [entry('conversation styles'), entry('conversation tokens'), entry('conversation cells')] },
  })
}

test('switching to Agent mode withdraws the conversation before the shell, last entry first', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log)
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['install shell', 'install conversation'])
  log.length = 0
  groups.reconcile(groupsFor({ mode: 'agent' }))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles'])
})

test('a throwing disposer does not stop the rest, and the group can be installed again', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log, { failing: 'conversation tokens' })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  assert.doesNotThrow(() => groups.reconcile(groupsFor({ mode: 'agent' })))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles'])
  assert.equal(warn.mock.callCount(), 1)
  log.length = 0
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['install shell', 'install conversation'])
})

test('unloading the plugin disposes every group even when a disposer throws', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log, { failing: 'conversation cells' })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  assert.doesNotThrow(() => groups.dispose())
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles'])
  log.length = 0
  groups.dispose()
  assert.deepEqual(log, [])
})

test('a group whose install throws stays unmounted and is tried again', (t) => {
  t.mock.method(console, 'warn', () => {})
  let attempts = 0
  const groups = surfaceGroups({
    shell: () => [() => () => {}],
    conversation: () => [() => { attempts += 1; if (attempts === 1) throw new Error('slot refused'); return () => {} }],
  })
  assert.doesNotThrow(() => groups.reconcile(groupsFor({ mode: 'bot' })))
  groups.reconcile(groupsFor({ mode: 'bot', plain: true }))
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.equal(attempts, 2)
})

// 公开#149: another plugin held a cell at the same priority, so one step of the
// conversation group threw after the styles, the header and the chat cells were on.
test('a group whose step throws takes back the steps before it, so Agent mode leaves nothing behind', (t) => {
  t.mock.method(console, 'warn', () => {})
  const live = new Set()
  const mount = name => () => { live.add(name); return () => live.delete(name) }
  const collide = () => { throw new Error('single slot "conversation.input.model" already has a registration at priority -10') }
  const errors = []
  const groups = surfaceGroups({
    shell: () => [mount('shell styles')],
    conversation: () => [mount('conversation css'), mount('HeaderPill'), mount('chat.node cells'), collide, mount('bot-plus')],
  }, { onError: (group, error) => errors.push([group, error.message]) })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual([...live], ['shell styles'])
  assert.deepEqual(errors.map(([group]) => group), ['conversation'])
  groups.reconcile(groupsFor({ mode: 'agent' }))
  assert.deepEqual([...live], [])
})

test('a shell that cannot go on keeps the conversation group off too', (t) => {
  t.mock.method(console, 'warn', () => {})
  const live = new Set()
  const mount = name => () => { live.add(name); return () => live.delete(name) }
  const groups = surfaceGroups({
    shell: () => [mount('shell styles'), () => { throw new Error('slot refused') }],
    conversation: () => [mount('conversation css')],
  })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual([...live], [])
})

test('remount takes a mounted group off and installs it again', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log)
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  groups.remount('shell', groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles', 'install shell', 'install conversation'])
  log.length = 0
  // Without a wanted set remount falls back to the last reconciled one.
  groups.remount('shell')
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles', 'install shell', 'install conversation'])
  log.length = 0
  // A group the surface does not want stays off — remount only retries mounts.
  groups.reconcile(groupsFor({ mode: 'agent' }))
  log.length = 0
  groups.remount('shell', groupsFor({ mode: 'agent' }))
  assert.deepEqual(log, [])
  groups.dispose()
})

// A withdraw that throws on the way down does not strand the conversation
// group: the remount still takes the shell off and puts both back.
test('a failed shell withdraw does not strand the conversation group', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log, { failing: 'shell theme' })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  groups.remount('shell', groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles', 'install shell', 'install conversation'])
  groups.dispose()
})

test('a shadow goes below every entry of its cell, so a same-priority plugin does not block it', () => {
  const entry = options => ({ options })
  assert.equal(freePriority([], { priority: -100 }), -100)
  assert.equal(freePriority([entry({}), entry({ priority: -10 })], { priority: -100 }), -100)
  assert.equal(freePriority([entry({}), entry({ priority: -100 })], { priority: -100 }), -101)
  assert.equal(freePriority([entry({ priority: -200 })], { priority: -100 }), -201)
  // Keyed and list cells: only the same key or id share the cell.
  assert.equal(freePriority([entry({ key: 'tool-call', priority: -100 }), entry({ key: 'user', priority: -300 })], { key: 'tool-call', priority: -100 }), -101)
  assert.equal(freePriority([entry({ id: 'usage', priority: -100 })], { id: 'activity', priority: -100 }), -100)
  assert.equal(freePriority([entry({ priority: -100 })], {}), undefined)
})

test('readMode falls back to bot when storage throws', () => {
  assert.equal(readMode({ getItem: () => { throw new Error('denied') } }), 'bot')
})
