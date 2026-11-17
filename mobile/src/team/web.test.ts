import assert from 'node:assert/strict'
import { test } from 'node:test'
import { takePairingFragment } from './pair-fragment.ts'
import * as storage from '../storage.web.ts'
import { downloadFile } from './file-download.web.ts'
import { shareFile } from './share-file.web.ts'
import { ensureUnlock } from './gate.web.ts'

function browserGlobal(t: { after: (fn: () => void) => void }, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  })
}

test('pair fragments are decoded and removed, including malformed links', () => {
  const urls: string[] = []
  const history = { state: { keep: true }, replaceState(state: unknown, _: string, url: string) { assert.deepEqual(state, this.state); urls.push(url) } }
  const location = { hash: '#pair=' + encodeURIComponent('dsbot://pair?code=abc'), pathname: '/web/', search: '?lang=en' }
  assert.equal(takePairingFragment(location, history), 'dsbot://pair?code=abc')
  assert.deepEqual(urls, ['/web/?lang=en'])
  assert.equal(takePairingFragment({ ...location, hash: '#pair=%ZZ' }, history), '')
  assert.equal(takePairingFragment({ ...location, hash: '#pair=' }, history), '')
  assert.equal(takePairingFragment({ ...location, hash: '#other' }, history), undefined)
  assert.equal(urls.length, 3)
})

test('web storage persists, deletes, and surfaces storage failures', async t => {
  const values = new Map<string, string>()
  browserGlobal(t, 'localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  assert.equal(await storage.getItemAsync('key'), null)
  await storage.setItemAsync('key', 'value')
  assert.equal(await storage.getItemAsync('key'), 'value')
  await storage.deleteItemAsync('key')
  assert.equal(await storage.getItemAsync('key'), null)
  t.mock.method(localStorage, 'setItem', () => { throw new Error('quota') })
  await assert.rejects(storage.setItemAsync('key', 'value'), /quota/)
  await ensureUnlock('secret-set')
})

test('web downloads assemble chunks, handle empty files and refuse failed transfers', async () => {
  let calls = 0
  const saved = await downloadFile(async (_, payload) => {
    const offset = (payload as { offset: number }).offset
    calls++
    return { bytes: btoa(offset === 0 ? 'hello ' : 'world'), nextOffset: offset === 0 ? 6 : 11, version: 'one', done: offset !== 0, name: '../hello.txt', mime: 'text/plain' }
  }, {})
  try {
    assert.equal(calls, 2)
    assert.equal(saved.name, '.._hello.txt')
    assert.equal(await (await fetch(saved.uri)).text(), 'hello world')
  } finally { URL.revokeObjectURL(saved.uri) }
  const empty = await downloadFile(async () => ({ bytes: '', done: true, nextOffset: 0 }), {})
  try { assert.equal((await (await fetch(empty.uri)).blob()).size, 0) } finally { URL.revokeObjectURL(empty.uri) }
  await assert.rejects(downloadFile(async () => { throw new Error('offline') }, {}), /offline/)
  await assert.rejects(downloadFile(async () => ({ bytes: '', done: false, nextOffset: 0 }), {}), /no longer available/)
})

test('web sharing clicks a download link and schedules URL cleanup', async t => {
  const events: string[] = []
  const link = { href: '', download: '', click: () => { events.push('click') }, remove: () => { events.push('remove') } }
  browserGlobal(t, 'document', { createElement: () => link, body: { appendChild: () => { events.push('append') } } })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout)
  t.mock.method(URL, 'revokeObjectURL', (uri: string) => { events.push(uri) })
  await shareFile({ uri: 'blob:file', name: 'file.txt', mime: 'text/plain' })
  assert.equal(link.download, 'file.txt')
  assert.equal(link.href, 'blob:file')
  assert.deepEqual(events, ['append', 'click', 'remove', 'blob:file'])
})
