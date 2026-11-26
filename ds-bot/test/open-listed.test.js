import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OPENING_FAIL_MS, listedOpener } from '../src/client/open-listed.js'

const store = (ids = []) => {
  const listeners = new Set()
  const snapshot = { byId: {} }
  const notify = () => { for (const fn of listeners) fn() }
  const put = (id, main) => { snapshot.byId[id] = main ? { id, retainedBy: { mainView: 1 } } : { id } }
  for (const id of ids) put(id)
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (id) => { put(id); notify() },
    setMain: (id) => { for (const row of Object.values(snapshot.byId)) delete row.retainedBy; put(id, true); notify() },
  }
}

const mainViewOf = list => Object.values(list.getSnapshot().byId).find(row => (row?.retainedBy?.mainView ?? 0) > 0)?.id

// Every wait gets a timer the test runs itself, so a wait that would fire after ten
// seconds never holds the test process open.
const rig = (list, { gone } = {}) => {
  const opened = []
  const began = []
  const finished = []
  const failed = []
  const failReasons = []
  const timers = []
  let refreshes = 0
  const show = listedOpener({
    list, open: id => opened.push(id), refresh: () => { refreshes += 1 }, current: () => mainViewOf(list),
    begin: id => began.push(id), done: id => finished.push(id), fail: (id, reason) => { failed.push(id); failReasons.push(reason) }, gone,
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer },
    clear: () => {},
  })
  const lastTimer = () => timers.at(-1)
  return { show, opened, began, finished, failed, failReasons, refreshCount: () => refreshes, lastTimer }
}

test('a listed Session opens at once and no refresh is asked for', () => {
  const { show, opened, refreshCount } = rig(store(['a']))
  show('a')
  assert.deepEqual(opened, ['a'])
  assert.equal(refreshCount(), 0)
})

test('an unlisted Session opens when the list reaches it, only once', () => {
  const list = store()
  const { show, opened, refreshCount } = rig(list)
  show('a')
  assert.deepEqual(opened, [])
  assert.equal(refreshCount(), 1)
  list.set('a')
  assert.deepEqual(opened, ['a'])
  list.set('b')
  assert.deepEqual(opened, ['a'])
})

test('a newer navigation drops the wait for the old one', () => {
  const list = store(['b'])
  const { show, opened } = rig(list)
  show('a')
  show('b')
  assert.deepEqual(opened, ['b'])
  list.set('a')
  assert.deepEqual(opened, ['b'])
})

test('two waits in a row keep only the last one', () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a')
  show('b')
  list.set('a')
  list.set('b')
  assert.deepEqual(opened, ['b'])
})

test('a navigation elsewhere drops the wait', () => {
  const list = store(['x'])
  list.setMain('x')
  const { show, opened } = rig(list)
  show('a')
  list.setMain('y')
  list.set('a')
  assert.deepEqual(opened, [])
})

test('a wait is reported from the moment the Session is missing', () => {
  const list = store(['bot-1'])
  const { show, opened, began, finished } = rig(list)
  show('bot-2')
  assert.deepEqual(began, ['bot-2'])
  assert.deepEqual(finished, [])
  assert.deepEqual(opened, [])
  list.set('bot-2')
  assert.deepEqual(opened, ['bot-2'])
  assert.deepEqual(finished, ['bot-2'])
})

test('a listed Session opens without reporting a wait', () => {
  const { show, began, finished } = rig(store(['bot-1']))
  show('bot-1')
  assert.deepEqual(began, [])
  assert.deepEqual(finished, [])
})

test('a newer navigation ends the wait it took over', () => {
  const list = store(['bot-1'])
  const { show, began, finished } = rig(list)
  show('bot-2')
  show('bot-1')
  assert.deepEqual(began, ['bot-2'])
  assert.deepEqual(finished, ['bot-2'])
})

test('a Session that never arrives ends as a failure instead of covering forever (#1929)', () => {
  const list = store()
  const { show, opened, failed, failReasons, finished, lastTimer } = rig(list)
  show('bot-2')
  assert.equal(OPENING_FAIL_MS, 10_000)
  assert.equal(lastTimer().ms, OPENING_FAIL_MS)
  lastTimer().fn()
  assert.deepEqual(failed, ['bot-2'])
  assert.deepEqual(failReasons, ['timeout'])
  // The failure keeps the caller's card up; the wait is not also reported as done.
  assert.deepEqual(finished, [])
  assert.deepEqual(opened, [])
})

test('a Session that arrives before the deadline opens, and a late timer cannot fail it', () => {
  const list = store()
  const { show, opened, failed, lastTimer } = rig(list)
  show('bot-2')
  const timer = lastTimer()
  list.set('bot-2')
  timer.fn()
  assert.deepEqual(opened, ['bot-2'])
  assert.deepEqual(failed, [])
})

test('a Session the roster already knows is gone fails at once, without a refresh', () => {
  const list = store()
  const { show, began, failed, failReasons, refreshCount } = rig(list, { gone: target => target === 'bot-2' })
  show('bot-2')
  assert.deepEqual(began, ['bot-2'])
  assert.deepEqual(failed, ['bot-2'])
  assert.deepEqual(failReasons, ['missing'])
  assert.equal(refreshCount(), 0)
})

test('a newer navigation lifts the failure card', () => {
  const list = store(['bot-1'])
  const { show, opened, failed, finished, lastTimer } = rig(list)
  show('bot-2')
  lastTimer().fn()
  assert.deepEqual(failed, ['bot-2'])
  show('bot-1')
  assert.deepEqual(finished, ['bot-2'])
  assert.deepEqual(opened, ['bot-1'])
})

test('external shell navigation lifts a failed card and unsubscribes', () => {
  const list = store(['bot-1'])
  list.setMain('bot-1')
  const { show, opened, failed, finished, lastTimer } = rig(list, { gone: target => target === 'bot-gone' })

  // Timeout failure: unrelated list updates keep the card, external mainView change lifts it.
  show('bot-2')
  lastTimer().fn()
  assert.deepEqual(failed, ['bot-2'])
  assert.deepEqual(finished, [])
  list.set('bot-3')
  assert.deepEqual(finished, [])
  list.setMain('bot-3')
  assert.deepEqual(finished, ['bot-2'])
  assert.deepEqual(opened, [])
  // Once dismissed, a late arrival must neither open nor call done again.
  list.set('bot-2')
  assert.deepEqual(opened, [])
  assert.deepEqual(finished, ['bot-2'])

  // Immediate gone failure also keeps observing external mainView navigation.
  show('bot-gone')
  assert.deepEqual(failed, ['bot-2', 'bot-gone'])
  list.setMain('bot-1')
  assert.deepEqual(finished, ['bot-2', 'bot-gone'])
  list.set('bot-gone')
  assert.deepEqual(opened, [])
  assert.deepEqual(finished, ['bot-2', 'bot-gone'])
})

test('a Session that arrives late after failure lifts the card and opens once', () => {
  const list = store(['bot-1'])
  list.setMain('bot-1')
  const { show, opened, failed, finished, lastTimer } = rig(list)
  show('bot-2')
  lastTimer().fn()
  assert.deepEqual(failed, ['bot-2'])
  assert.deepEqual(finished, [])
  list.set('bot-2')
  assert.deepEqual(finished, ['bot-2'])
  assert.deepEqual(opened, ['bot-2'])
  list.set('bot-3')
  assert.deepEqual(finished, ['bot-2'])
  assert.deepEqual(opened, ['bot-2'])
})

test('re-requesting a failed target starts a fresh retry instead of staying locked', () => {
  const list = store(['bot-1'])
  list.setMain('bot-1')
  const { show, opened, began, failed, finished, refreshCount, lastTimer } = rig(list)
  show('bot-2')
  assert.equal(refreshCount(), 1)
  lastTimer().fn()
  assert.deepEqual(failed, ['bot-2'])
  // Clicking the same Bot again retries the wait and asks for a fresh list.
  show('bot-2')
  assert.deepEqual(finished, ['bot-2'])
  assert.deepEqual(began, ['bot-2', 'bot-2'])
  assert.equal(refreshCount(), 2)
  list.set('bot-2')
  assert.deepEqual(opened, ['bot-2'])
  assert.deepEqual(finished, ['bot-2', 'bot-2'])
})

test('repeating the same unlisted target keeps the wait steady without flashing', () => {
  const list = store(['bot-1'])
  list.setMain('bot-1')
  const { show, opened, began, finished, refreshCount } = rig(list)
  show('bot-2')
  show('bot-2')
  show('bot-2')
  assert.deepEqual(began, ['bot-2'])
  assert.deepEqual(finished, [])
  assert.equal(refreshCount(), 1)
  list.set('bot-2')
  assert.deepEqual(opened, ['bot-2'])
  assert.deepEqual(finished, ['bot-2'])
})

test('requesting the already-active session does not reopen it', () => {
  const list = store(['bot-1'])
  list.setMain('bot-1')
  const { show, opened, began, refreshCount } = rig(list)
  show('bot-1')
  assert.deepEqual(opened, [])
  assert.deepEqual(began, [])
  assert.equal(refreshCount(), 0)
})

test('clearing the old main view while waiting for a fresh part keeps the wait alive', () => {
  const list = store(['part-1'])
  list.setMain('part-1')
  const { show, opened, began, finished } = rig(list)
  show('part-2')
  assert.deepEqual(began, ['part-2'])
  assert.deepEqual(finished, [])
  // Archiving part-1 clears mainView before part-2 arrives in the list.
  delete list.getSnapshot().byId['part-1']
  list.set('unrelated')
  assert.deepEqual(finished, [])
  assert.deepEqual(opened, [])
  list.set('part-2')
  assert.deepEqual(opened, ['part-2'])
  assert.deepEqual(finished, ['part-2'])
})
