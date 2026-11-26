import assert from 'node:assert/strict'
import { test } from 'node:test'
import { takePairingFragment } from './pair-fragment.ts'
import * as storage from '../storage.web.ts'
import { downloadFile } from './file-download.web.ts'
import { shareFile } from './share-file.web.ts'
import { ensureUnlock } from './gate.web.ts'
import { phoneName } from '../phone-name.ts'

test('device names support a browser without native platform constants', () => {
  assert.equal(phoneName('web'), 'Web browser')
  assert.equal(phoneName('android', { Manufacturer: 'Maker', Model: 'Phone' }), 'Maker Phone')
  assert.equal(phoneName('android', {}), 'Android phone')
  assert.equal(phoneName('ios', { interfaceIdiom: 'pad' }), 'iPad')
  assert.equal(phoneName('ios', {}), 'iPhone')
})

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
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const encrypted = storage.createEncryptedStorage(localStorage, async () => key)
  assert.equal(key.extractable, false)
  await assert.rejects(crypto.subtle.exportKey('raw', key))
  assert.equal(await encrypted.getItemAsync('key'), null)
  await encrypted.setItemAsync('key', 'value')
  assert.equal(values.get('key')!.includes('value'), false)
  assert.equal(await encrypted.getItemAsync('key'), 'value')
  await encrypted.deleteItemAsync('key')
  assert.equal(await encrypted.getItemAsync('key'), null)
  t.mock.method(localStorage, 'setItem', () => { throw new Error('quota') })
  await assert.rejects(encrypted.setItemAsync('key', 'value'), /quota/)
  await ensureUnlock('state')
})

test('web storage refuses plaintext, missing or changed keys, tampering and swapped records', async () => {
  const values = new Map<string, string>()
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  let key: CryptoKey | undefined = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const encrypted = storage.createEncryptedStorage(store, async () => key)
  for (const old of ['plaintext', '{"privateKey":"old-key"}', 'null', '{"version":1}']) {
    values.set('identity', old)
    assert.equal(await encrypted.getItemAsync('identity'), null)
  }
  await encrypted.setItemAsync('identity', '')
  assert.equal(await encrypted.getItemAsync('identity'), '')
  await encrypted.setItemAsync('identity', 'private-key')
  const original = values.get('identity')!
  await encrypted.setItemAsync('identity', 'private-key')
  assert.notEqual(values.get('identity'), original)
  values.set('other', original)
  assert.equal(await encrypted.getItemAsync('other'), null)
  const envelope = JSON.parse(original)
  values.set('identity', JSON.stringify({ ...envelope, ciphertext: 'AAAA' }))
  assert.equal(await encrypted.getItemAsync('identity'), null)
  values.set('identity', original)
  const savedKey = key
  key = undefined
  assert.equal(await encrypted.getItemAsync('identity'), null)
  await assert.rejects(encrypted.setItemAsync('new', 'value'), /key storage failed/)
  key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  assert.equal(await encrypted.getItemAsync('identity'), null)
  key = savedKey
  assert.equal(await encrypted.getItemAsync('identity'), 'private-key')
  const reopened = storage.createEncryptedStorage(store, async () => savedKey)
  assert.equal(await reopened.getItemAsync('identity'), 'private-key')
  const broken = storage.createEncryptedStorage(store, async () => { throw new Error('IndexedDB unavailable') })
  await assert.rejects(broken.getItemAsync('identity'), /IndexedDB unavailable/)
  await assert.rejects(broken.setItemAsync('new', 'value'), /IndexedDB unavailable/)
})

test('overlapping web storage writes and deletes finish in call order per key', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  for (const last of ['set', 'delete']) {
    const values = new Map<string, string>()
    const store = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value) }, removeItem: (name: string) => { values.delete(name) } }
    const delayed = Promise.withResolvers<CryptoKey>()
    let loads = 0
    const encrypted = storage.createEncryptedStorage(store, async () => ++loads === 1 ? delayed.promise : key)
    const completed: string[] = []
    const first = encrypted.setItemAsync('identity', 'old').then(() => { completed.push('first') })
    const second = (last === 'set' ? encrypted.setItemAsync('identity', 'new') : encrypted.deleteItemAsync('identity')).then(() => { completed.push('second') })
    await Promise.resolve()
    assert.equal(loads, 1)
    await encrypted.setItemAsync('other', 'independent')
    assert.deepEqual(completed, [])
    delayed.resolve(key)
    await Promise.all([first, second])
    assert.deepEqual(completed, ['first', 'second'])
    assert.equal(await encrypted.getItemAsync('identity'), last === 'set' ? 'new' : null)
    assert.equal(await encrypted.getItemAsync('other'), 'independent')
  }
})

test('web storage queues reads too, and a failed mutation does not block later calls', async () => {
  const values = new Map<string, string>()
  let fail = false
  const store = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { if (fail) { fail = false; throw new Error('quota') }; values.set(name, value) },
    removeItem: (name: string) => { values.delete(name) },
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const encrypted = storage.createEncryptedStorage(store, async () => key)
  assert.deepEqual(await Promise.all([
    encrypted.setItemAsync('key', 'one'), encrypted.getItemAsync('key'),
    encrypted.setItemAsync('key', 'two'), encrypted.getItemAsync('key'),
    encrypted.deleteItemAsync('key'), encrypted.getItemAsync('key'),
  ]), [undefined, 'one', undefined, 'two', undefined, null])
  fail = true
  const failed = encrypted.setItemAsync('key', 'lost')
  const retry = encrypted.setItemAsync('key', 'saved')
  await assert.rejects(failed, /quota/)
  await retry
  assert.equal(await encrypted.getItemAsync('key'), 'saved')
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
