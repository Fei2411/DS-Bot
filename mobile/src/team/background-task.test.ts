import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'
import { deviceIdFor, generateKeyPair, sealPushEnvelope } from '../../../link/src/index.ts'

let hooks: ReturnType<typeof registerHooks> | undefined
let bgMod: typeof import('./background-task.ts')

const phoneKeys = generateKeyPair()
const hostKeys = generateKeyPair()
const rogueKeys = generateKeyPair()
const hostDeviceId = deviceIdFor(hostKeys.publicKey)

interface BgMocks {
  appState: string
  foregroundOnline: boolean
  prefs: Record<string, string>
  savedCursor: { boot: string; seq: number } | null
  savedCursors: { hostId: string; boot: string; seq: number }[]
  delivered: { notice: any; options: any }[]
  statusTexts: string[]
  openImpl: () => Promise<any>
  callBotImpl: (client: any, endpoint: string, payload: any) => Promise<any>
}

const mocks: BgMocks = {
  appState: 'background',
  foregroundOnline: false,
  prefs: { notifyEnabled: 'on', notifyBgMode: 'periodic' },
  savedCursor: null,
  savedCursors: [],
  delivered: [],
  statusTexts: [],
  openImpl: async () => ({
    onClose: () => () => {},
    onEvent: () => () => {},
    close: async () => {},
  }),
  callBotImpl: async () => ({}),
}

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === 'react-native'
        || specifier === '../connection.ts'
        || specifier === '../store.ts'
        || specifier === '../ui/i18n.ts'
        || specifier === './notice-cursor-store.ts'
        || specifier === './notification-bridge.ts'
        || specifier === './notifications-native'
      ) {
        return { url: `mock:bg:${specifier}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:bg:react-native') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const Platform = { OS: 'android' }
            export const AppState = { get currentState() { return globalThis.__bgMocks.appState } }
          `,
        }
      }
      if (url === 'mock:bg:../connection.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const openLink = () => globalThis.__bgMocks.openImpl()
            export const callBot = (...args) => globalThis.__bgMocks.callBotImpl(...args)
          `,
        }
      }
      if (url === 'mock:bg:../store.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const readPrefs = async () => ({ ...globalThis.__bgMocks.prefs })
            export const loadIdentity = async () => globalThis.__bgIdentity
            export const loadComputer = async () => globalThis.__bgComputer
            export const listComputers = async () => ({ activeId: globalThis.__bgComputer.hostDeviceId, computers: [globalThis.__bgComputer] })
          `,
        }
      }
      if (url === 'mock:bg:../ui/i18n.ts') {
        return { format: 'module', shortCircuit: true, source: `export const setLang = () => {}; export const t = (s) => s` }
      }
      if (url === 'mock:bg:./notice-cursor-store.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const loadNoticeCursor = async () => globalThis.__bgMocks.savedCursor
            export const saveNoticeCursor = async (hostId, boot, seq) => {
              globalThis.__bgMocks.savedCursor = { boot, seq }
              globalThis.__bgMocks.savedCursors.push({ hostId, boot, seq })
            }
          `,
        }
      }
      if (url === 'mock:bg:./notification-bridge.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const isForegroundLinkOnline = () => globalThis.__bgMocks.foregroundOnline
            export const deliverSystemNotice = async (notice, options) => {
              globalThis.__bgMocks.delivered.push({ notice, options })
              return true
            }
          `,
        }
      }
      if (url === 'mock:bg:./notifications-native') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const onStopKeepalive = () => () => {}
            export const updateBackgroundStatusText = async (text) => { globalThis.__bgMocks.statusTexts.push(text) }
          `,
        }
      }
      return nextLoad(url, context)
    },
  })
  ;(globalThis as any).__bgMocks = mocks
  ;(globalThis as any).__bgIdentity = {
    deviceId: deviceIdFor(phoneKeys.publicKey),
    publicKey: phoneKeys.publicKey,
    privateKey: phoneKeys.privateKey,
    accessToken: 'tok',
  }
  ;(globalThis as any).__bgComputer = {
    server: 'wss://relay.example.com',
    hostDeviceId,
    hostKey: hostKeys.publicKey,
    name: 'Studio Mac',
  }
  bgMod = await import('./background-task.ts')
})

after(() => {
  hooks?.deregister()
  delete (globalThis as any).__bgMocks
  delete (globalThis as any).__bgIdentity
  delete (globalThis as any).__bgComputer
})

function resetMocks() {
  bgMod.stopHeadlessKeepalive()
  mocks.appState = 'background'
  mocks.foregroundOnline = false
  mocks.prefs = { notifyEnabled: 'on', notifyBgMode: 'periodic' }
  mocks.savedCursor = null
  mocks.savedCursors = []
  mocks.delivered = []
  mocks.statusTexts = []
}

test('push wakeup delivers host-authenticated E2E notices and drops forged envelopes', async () => {
  resetMocks()
  const valid = sealPushEnvelope(
    hostKeys.privateKey,
    hostKeys.publicKey,
    phoneKeys.publicKey,
    {
      boot: 'boot-9',
      hostName: 'Studio Mac',
      notice: { seq: 12, kind: 'approval', botId: 'b1', name: 'Chief', text: 'run test', time: Date.now() },
    },
  )
  await bgMod.runBackgroundTask({ kind: 'push', rawPayload: JSON.stringify(valid) })
  assert.equal(mocks.delivered.length, 1)
  assert.equal(mocks.delivered[0].notice.seq, 12)
  assert.equal(mocks.delivered[0].options.boot, 'boot-9')

  // Forged envelope signed with rogue host key claiming the paired hostDeviceId must be dropped.
  const rogue = sealPushEnvelope(
    rogueKeys.privateKey,
    rogueKeys.publicKey,
    phoneKeys.publicKey,
    {
      boot: 'boot-9',
      hostName: 'Fake',
      notice: { seq: 13, kind: 'approval', botId: 'b1', name: 'Evil', text: 'bad', time: Date.now() },
    },
  )
  const forged = { ...rogue, h: hostDeviceId }
  await bgMod.runBackgroundTask({ kind: 'push', rawPayload: JSON.stringify(forged) })
  assert.equal(mocks.delivered.length, 1)
})

test('periodic sync delivers retained notices after host restart and skips when foreground link is active', async () => {
  resetMocks()
  mocks.savedCursor = { boot: 'boot-old', seq: 5 }
  let opened = 0
  mocks.openImpl = async () => {
    opened += 1
    return { onClose: () => () => {}, onEvent: () => () => {}, close: async () => {} }
  }
  mocks.callBotImpl = async (_client, endpoint) => {
    if (endpoint === 'hello') return { api: 1, boot: 'boot-new', seq: 2 }
    if (endpoint === 'notices') {
      return {
        boot: 'boot-new',
        seq: 2,
        reset: true,
        notices: [
          { seq: 1, kind: 'message', botId: 'b1', name: 'Chief', text: 'Back online' },
          { seq: 2, kind: 'approval', botId: 'b1', name: 'Chief', text: 'Approve deploy' },
        ],
      }
    }
    return {}
  }

  await bgMod.runBackgroundTask({ kind: 'sync' })
  assert.equal(opened, 1)
  assert.equal(mocks.delivered.length, 2)
  assert.equal(mocks.delivered[1].options.boot, 'boot-new')
  assert.equal(mocks.savedCursor?.boot, 'boot-new')
  assert.equal(mocks.savedCursor?.seq, 2)

  // When UI is in foreground or foreground link is online, periodic sync must not open a second socket.
  mocks.foregroundOnline = true
  await bgMod.runBackgroundTask({ kind: 'sync' })
  assert.equal(opened, 1)

  mocks.foregroundOnline = false
  mocks.appState = 'active'
  await bgMod.runBackgroundTask({ kind: 'sync' })
  assert.equal(opened, 1)
})

test('keepalive handles early socket close and stopHeadlessKeepalive during handshake without hanging', async () => {
  resetMocks()
  mocks.prefs = { notifyEnabled: 'on', notifyBgMode: 'instant' }
  mocks.savedCursor = { boot: 'boot-1', seq: 1 }

  let closeHandler: (() => void) | undefined
  let closeCalls = 0
  mocks.openImpl = async () => ({
    onClose(fn: () => void) { closeHandler = fn; return () => { closeHandler = undefined } },
    onEvent() { return () => {} },
    async close() { closeCalls += 1 },
  })
  mocks.callBotImpl = async (_client, endpoint) => {
    if (endpoint === 'hello') {
      // Socket closes BEFORE hello returns and BEFORE await closed is reached!
      closeHandler?.()
      bgMod.stopHeadlessKeepalive()
      return { api: 1, boot: 'boot-1', seq: 1 }
    }
    return { boot: 'boot-1', seq: 1, reset: false, notices: [] }
  }

  const finished = await Promise.race([
    bgMod.runBackgroundTask({ kind: 'keepalive' }).then(() => 'exited'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 300)),
  ])
  assert.equal(finished, 'exited', 'keepalive must not hang when closed/aborted during handshake')
  assert.ok(closeCalls >= 1)
})
