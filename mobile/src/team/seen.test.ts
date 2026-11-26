import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createSeenStore, type SeenStorage } from './seen.ts'

function createMemoryStorage(initial: Record<string, string> = {}): SeenStorage & { raw: Map<string, string>; writes: number } {
  const raw = new Map<string, string>(Object.entries(initial))
  return {
    raw,
    writes: 0,
    async getItem(key) {
      return raw.get(key) ?? null
    },
    async setItem(key, value) {
      this.writes += 1
      raw.set(key, value)
    },
  }
}

test('persists seenAt across app restarts so read bots and rooms stay read (#1588)', async () => {
  const disk = createMemoryStorage()
  const boot1 = createSeenStore(disk)
  await boot1.loadSeen()

  assert.equal(boot1.isUnread('host-a', 'b-chief', 1_700_000_001_000, false), true)
  assert.equal(boot1.isUnread('host-a', 'r-launch', 1_700_000_002_000, false), true)

  await boot1.markSeen('host-a', 'b-chief', 1_700_000_001_000)
  await boot1.markSeen('host-a', 'r-launch', 1_700_000_002_000)

  assert.equal(boot1.isUnread('host-a', 'b-chief', 1_700_000_001_000, false), false)
  assert.equal(boot1.isUnread('host-a', 'r-launch', 1_700_000_002_000, false), false)

  // Simulate killing and restarting the app against the same persisted SecureStore.
  const boot2 = createSeenStore(disk)
  await boot2.loadSeen()

  assert.equal(boot2.seenAt('host-a', 'b-chief'), 1_700_000_001_000)
  assert.equal(boot2.seenAt('host-a', 'r-launch'), 1_700_000_002_000)
  assert.equal(boot2.isUnread('host-a', 'b-chief', 1_700_000_001_000, false), false)
  assert.equal(boot2.isUnread('host-a', 'r-launch', 1_700_000_002_000, false), false)

  // Only a newer host message triggers the unread dot again.
  assert.equal(boot2.isUnread('host-a', 'b-chief', 1_700_000_001_001, false), true)
  assert.equal(boot2.isUnread('host-a', 'b-chief', 1_700_000_001_001, true), false)
})

test('App.tsx awaits loadSeen() during Boot before mounting the shell', () => {
  const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  assert.match(appSource, /loadSeen\(\)\.finally\(\(\) => setSeenReady\(true\)\)/)
  assert.match(appSource, /!seenReady/)
})

test('isolates seenAt per paired computer so shared bot or room IDs never collide', async () => {
  const disk = createMemoryStorage()
  const store = createSeenStore(disk)
  await store.loadSeen()

  await store.markSeen('host-a', 'b-chief', 2000)
  await store.markSeen('host-a', 'r-daily', 2500)

  assert.equal(store.isUnread('host-a', 'b-chief', 2000, false), false)
  assert.equal(store.isUnread('host-b', 'b-chief', 1500, false), true)
  assert.equal(store.isUnread('host-b', 'r-daily', 1500, false), true)

  await store.markSeen('host-b', 'b-chief', 1500)

  const restarted = createSeenStore(disk)
  await restarted.loadSeen()
  assert.equal(restarted.seenAt('host-a', 'b-chief'), 2000)
  assert.equal(restarted.seenAt('host-b', 'b-chief'), 1500)
  assert.equal(restarted.isUnread('host-b', 'b-chief', 1800, false), true)
  assert.equal(restarted.isUnread('host-a', 'b-chief', 1800, false), false)
})

test('markSeen before loadSeen resolves merges monotonically without wiping existing disk entries', async () => {
  let releaseRead!: (value: string | null) => void
  const underlying = new Map<string, string>([
    ['dsbot.seenAt', JSON.stringify({ 'host-a': { 'b-chief': 1000, 'b-writer': 1500 } })],
  ])
  const delayedStorage: SeenStorage = {
    getItem() {
      return new Promise(resolve => { releaseRead = resolve })
    },
    async setItem(key, value) {
      underlying.set(key, value)
    },
  }

  const store = createSeenStore(delayedStorage)
  const loading = store.loadSeen()
  // User opens b-chief (with newer message at 2000) and b-coder while loadSeen is still in flight.
  const writing = Promise.all([
    store.markSeen('host-a', 'b-chief', 2000),
    store.markSeen('host-a', 'b-coder', 2100),
  ])

  releaseRead(underlying.get('dsbot.seenAt') ?? null)
  await Promise.all([loading, writing])

  assert.equal(store.seenAt('host-a', 'b-chief'), 2000)
  assert.equal(store.seenAt('host-a', 'b-writer'), 1500)
  assert.equal(store.seenAt('host-a', 'b-coder'), 2100)

  const afterRestart = createSeenStore({
    async getItem(key) { return underlying.get(key) ?? null },
    async setItem(key, value) { underlying.set(key, value) },
  })
  await afterRestart.loadSeen()
  assert.equal(afterRestart.seenAt('host-a', 'b-chief'), 2000)
  assert.equal(afterRestart.seenAt('host-a', 'b-writer'), 1500)
  assert.equal(afterRestart.seenAt('host-a', 'b-coder'), 2100)
})

test('ignores corrupted or unscoped legacy JSON without crashing and notifies subscribers on changes', async () => {
  const disk = createMemoryStorage({ 'dsbot.seenAt': '{not-json' })
  const broken = createSeenStore(disk)
  await broken.loadSeen()
  assert.equal(broken.seenAt('host-a', 'b-1'), 0)

  // Legacy flat numeric entries from pre-fix builds are ignored so they cannot bleed across computers.
  const legacyDisk = createMemoryStorage({ 'dsbot.seenAt': JSON.stringify({ 'b-1': 9999 }) })
  const legacy = createSeenStore(legacyDisk)
  let notifications = 0
  const unsub = legacy.subscribe(() => { notifications += 1 })
  await legacy.loadSeen()
  assert.equal(legacy.seenAt('host-a', 'b-1'), 0)
  assert.equal(notifications, 0)

  const v0 = legacy.version()
  await legacy.markSeen('host-a', 'b-1', 5000)
  assert.equal(notifications, 1)
  assert.equal(legacy.version(), v0 + 1)

  // Non-advancing timestamp does not trigger extra writes or notifications.
  const writesBefore = legacyDisk.writes
  await legacy.markSeen('host-a', 'b-1', 4000)
  assert.equal(notifications, 1)
  assert.equal(legacyDisk.writes, writesBefore)
  unsub()
})

test('retries failed storage write when markSeen is called again with the same timestamp', async () => {
  const raw = new Map<string, string>()
  let failNextWrite = true
  const flakyStorage: SeenStorage = {
    async getItem(key) {
      return raw.get(key) ?? null
    },
    async setItem(key, value) {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('transient SecureStore failure')
      }
      raw.set(key, value)
    },
  }

  const store = createSeenStore(flakyStorage)
  await store.loadSeen()
  await store.markSeen('host-a', 'b-chief', 2000)
  assert.equal(raw.has('dsbot.seenAt'), false)

  // Reopening the same chat reports the same timestamp and retries persistence.
  await store.markSeen('host-a', 'b-chief', 2000)
  const restarted = createSeenStore(flakyStorage)
  await restarted.loadSeen()
  assert.equal(restarted.seenAt('host-a', 'b-chief'), 2000)
  assert.equal(restarted.isUnread('host-a', 'b-chief', 2000, false), false)
})
