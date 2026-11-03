import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listedOpener } from '../src/client/open-listed.js'

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

const rig = (list) => {
  const opened = []
  let refreshes = 0
  const show = listedOpener({ list, open: id => opened.push(id), refresh: () => { refreshes += 1 }, current: () => mainViewOf(list) })
  return { show, opened, refreshes: () => refreshes }
}

test('a listed Session opens at once and no refresh is asked for', () => {
  const { show, opened, refreshes } = rig(store(['a']))
  show('a')
  assert.deepEqual(opened, ['a'])
  assert.equal(refreshes(), 0)
})

test('an unlisted Session opens when the list reaches it, only once', () => {
  const list = store()
  const { show, opened, refreshes } = rig(list)
  show('a')
  assert.deepEqual(opened, [])
  assert.equal(refreshes(), 1)
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

test('cancel drops a pending wait without changing the current navigation', () => {
  const list = store()
  const { show, opened, refreshes } = rig(list)
  show('a')
  show.cancel()
  list.set('a')
  assert.deepEqual(opened, [])
  assert.equal(refreshes(), 1)
})
