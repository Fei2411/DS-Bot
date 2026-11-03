import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/permissions.js'

const PRESETS = { 'workspace-write': {}, 'danger-full-access': {} }
const SESSION_ONLY = ['auto']

function runtime({ presets = true, auto = false, fail = false, hold = false } = {}) {
  const writes = []
  const releases = []
  const bots = {}
  const control = { fail }
  const service = {
    catalog: () => ({ options: [...Object.keys(PRESETS), ...(auto ? SESSION_ONLY : [])].map(value => ({ value, name: value })), defaultOptions: [], defaultPreset: 'workspace-write' }),
    resolve: (name) => { if (!(name in PRESETS) && !(auto && SESSION_ONLY.includes(name))) throw new Error(`permission: unknown preset "${name}"`); return PRESETS[name] },
    set: (session, name) => { if (control.fail) throw new Error('permission: rejected'); writes.push(`${session}=${name}`) },
  }
  const ctx = { get: name => (presets && name === 'permissionPresets' ? service : undefined) }
  const rt = {
    ctx,
    chatOf: id => `${id}-chat`,
    groupSessionsOf: id => [`${id}-group`],
    groupOwners: new Map(),
    roomOf: () => undefined,
    botOf: id => bots[id],
    resolveAgent: sessionId => (hold ? new Promise((resolve, reject) => releases.push({ sessionId, resolve, reject })) : Promise.resolve({ session: sessionId })),
    warn() {},
  }
  install(rt)
  // With `hold`, every Session's agent resolves only when its index here is settled,
  // so an earlier request can be made to apply after a later one.
  const settle = async (index) => {
    const [{ sessionId, resolve }] = releases.splice(index, 1)
    resolve({ session: sessionId })
    await new Promise(done => setImmediate(done))
  }
  const drop = async (index) => {
    const [{ reject }] = releases.splice(index, 1)
    reject(new Error('permission: session went away'))
    await new Promise(done => setImmediate(done))
  }
  return { rt, writes, releases, bots, settle, drop, control }
}

test('a Bot\'s preset is set on its chat and its group Sessions', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', name: 'Ada' }
  await rt.setPermission(bot, 'danger-full-access')
  assert.equal(bot.permission, 'danger-full-access')
  assert.deepEqual(writes, ['b1-chat=danger-full-access', 'b1-group=danger-full-access'])
})

test('a fresh Session gets the Bot\'s preset, and a Bot without one keeps the default', async () => {
  const { rt, writes } = runtime()
  await rt.applyPermission({ id: 'b1' }, 'fresh')
  await rt.applyPermission({ id: 'b1', permission: 'workspace-write' }, 'fresh')
  assert.deepEqual(writes, ['fresh=workspace-write'])
})

test('an unknown preset is refused and the Bot keeps its own', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'everything'), /unknown preset/)
  assert.equal(bot.permission, 'workspace-write')
  assert.deepEqual(writes, [])
})

test('the catalog lists the presets DSH offers, or nothing without the presets service', () => {
  assert.deepEqual(runtime().rt.permissionCatalog(), { options: [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }], defaultPreset: 'workspace-write' })
  assert.equal(runtime({ presets: false }).rt.permissionCatalog(), undefined)
})

test('Auto review is not offered or kept as a Bot\'s preset', async () => {
  const { rt, writes } = runtime({ auto: true })
  assert.deepEqual(rt.permissionCatalog().options.map(option => option.value), ['workspace-write', 'danger-full-access'])
  const bot = { id: 'b1' }
  await assert.rejects(rt.setPermission(bot, 'auto'), /one Session only/)
  assert.equal(bot.permission, undefined)
  assert.deepEqual(writes, [])
})

test('a preset the Bot\'s own chat refuses is not kept', async () => {
  const { rt } = runtime({ fail: true })
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'danger-full-access'), /rejected/)
  assert.equal(bot.permission, 'workspace-write')
})

test('the last preset asked for wins when two Bot changes overlap', async () => {
  const { rt, writes, releases, settle } = runtime({ hold: true })
  const bot = { id: 'b1', name: 'Ada' }
  const first = rt.setPermission(bot, 'workspace-write')
  const second = rt.setPermission(bot, 'danger-full-access')
  assert.equal(releases.length, 2)
  await settle(1) // the later request applies to the chat, then to the group Session
  await settle(1)
  while (releases.length) await settle(0) // the earlier request writes nothing more
  await first
  await second
  assert.equal(bot.permission, 'danger-full-access')
  assert.deepEqual(writes, ['b1-chat=danger-full-access', 'b1-group=danger-full-access'])
})

test('a failed change does not roll back a newer one that already applied', async () => {
  const { rt, releases, settle, drop } = runtime({ hold: true })
  const bot = { id: 'b1', name: 'Ada', permission: 'workspace-write' }
  // Two windows ask for the same preset; the newer applies everywhere first.
  const first = rt.setPermission(bot, 'danger-full-access')
  const second = rt.setPermission(bot, 'danger-full-access')
  assert.equal(releases.length, 2)
  await settle(1) // the newer request applies to the chat, then to the group Session
  await settle(1)
  await second
  const refused = assert.rejects(first, /went away/)
  await drop(0) // the older request's apply resolves only now, and fails
  await refused
  assert.equal(bot.permission, 'danger-full-access')
})

test('a failed change rolls back to the last applied preset, not to a failed request', async () => {
  const { rt, releases, settle, drop, control } = runtime({ hold: true })
  const bot = { id: 'b1', name: 'Ada', permission: 'workspace-write' }
  const first = rt.setPermission(bot, 'danger-full-access')
  const second = rt.setPermission(bot, 'danger-full-access')
  const firstFails = assert.rejects(first, /went away/)
  await drop(0) // the superseded request fails and leaves the field to the newer one
  await firstFails
  control.fail = true
  const secondFails = assert.rejects(second, /rejected/)
  while (releases.length) await settle(0) // the newest one fails too and rolls back
  await secondFails
  assert.equal(bot.permission, 'workspace-write')
})

test('a superseded change leaves no Session on a preset that lost', async () => {
  const { rt, writes, releases, settle, control } = runtime({ hold: true })
  const bot = { id: 'b1', name: 'Ada' }
  const first = rt.setPermission(bot, 'workspace-write')
  await settle(0) // the older request sets the chat, then waits on the group Session
  const second = rt.setPermission(bot, 'danger-full-access')
  assert.equal(releases.length, 2)
  await settle(0) // the older request's group apply resolves: a newer one owns it now
  control.fail = true
  const refused = assert.rejects(second, /rejected/)
  await settle(0) // the newer request's chat apply fails and rolls the field back
  control.fail = false
  while (releases.length) await settle(0) // the rollback puts the restored preset back
  await refused
  await first
  assert.equal(bot.permission, 'workspace-write')
  assert.deepEqual(writes, ['b1-chat=workspace-write', 'b1-chat=workspace-write', 'b1-group=workspace-write'])
})

test('the last preset asked for wins when two group changes overlap', async () => {
  const { rt, writes, releases, bots, settle } = runtime({ hold: true })
  bots.b1 = { id: 'b1', name: 'Ada' }
  bots.b2 = { id: 'b2', name: 'Ben' }
  const room = { name: 'Ops', sessions: { b1: 's1', b2: 's2' } }
  const first = rt.setRoomPermission(room, 'workspace-write')
  const second = rt.setRoomPermission(room, 'danger-full-access')
  assert.equal(releases.length, 2)
  await settle(1) // the later request reaches s1, then s2, before the earlier one does
  await settle(1)
  await settle(0) // the earlier request applies last and must not win
  await settle(0)
  await first
  await second
  assert.equal(room.permission, 'danger-full-access')
  assert.equal(writes.length, 4)
  assert.ok(writes.every(write => write.endsWith('=danger-full-access')))
})
