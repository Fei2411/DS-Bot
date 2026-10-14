import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/permissions.js'

const PRESETS = { 'workspace-write': {}, 'danger-full-access': {} }
const SESSION_ONLY = ['auto']

function runtime({ presets = true, auto = false, fail = false } = {}) {
  const writes = []
  const service = {
    catalog: () => ({ options: [...Object.keys(PRESETS), ...(auto ? SESSION_ONLY : [])].map(value => ({ value, name: value })), defaultOptions: [], defaultPreset: 'workspace-write' }),
    resolve: (name) => { if (!(name in PRESETS) && !(auto && SESSION_ONLY.includes(name))) throw new Error(`permission: unknown preset "${name}"`); return PRESETS[name] },
    set: (session, name) => { if (fail) throw new Error('permission: rejected'); writes.push(`${session}=${name}`) },
  }
  const ctx = { get: name => (presets && name === 'permissionPresets' ? service : undefined) }
  const rt = {
    ctx,
    chatOf: id => `${id}-chat`,
    groupSessionsOf: id => [`${id}-group`],
    groupOwners: new Map(),
    roomOf: () => undefined,
    resolveAgent: async sessionId => ({ session: sessionId }),
    warn() {},
  }
  install(rt)
  return { rt, writes }
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
