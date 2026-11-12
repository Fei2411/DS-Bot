import assert from 'node:assert/strict'
import { test } from 'node:test'
import { optimistic, withWrites } from './optimistic.ts'
import type { TeamState } from '../connection.ts'

const team: TeamState = {
  revision: 7,
  bots: [
    { id: 'b1', name: 'Chief', color: '#111111', effort: 'medium', workDir: '/work/a', capabilities: ['shell'] },
    { id: 'b2', name: 'Coder', capabilities: [] },
  ],
  rooms: [
    { id: 'r1', name: 'Standup', members: ['b1', 'b2'] },
    { id: 'r2', name: 'Quiet', members: ['b2'] },
  ],
  mainBotIds: ['b1'],
  mainBotId: 'b1',
}

test('update-bot shallow-merges the patch into that bot', () => {
  const next = optimistic(team, 'update-bot', { id: 'b1', color: '#abcdef', name: 'Boss' })!
  assert.equal(next.bots[0].color, '#abcdef')
  assert.equal(next.bots[0].name, 'Boss')
  assert.equal(next.bots[0].effort, 'medium')
  assert.equal(next.bots[1].name, 'Coder')
  assert.equal(team.bots[0].color, '#111111')
})

test('update-bot clears effort on null and workDir on empty', () => {
  const next = optimistic(team, 'update-bot', { id: 'b1', effort: null, workDir: '' })!
  assert.equal('effort' in next.bots[0], false)
  assert.equal('workDir' in next.bots[0], false)
})

test('update-bot replaces the whole avatar object', () => {
  const next = optimistic({ ...team, bots: [{ ...team.bots[0], avatar: { shape: 'star', image: 'data:x' } }, team.bots[1]] }, 'update-bot', { id: 'b1', avatar: { shape: 'moon' } })!
  assert.deepEqual(next.bots[0].avatar, { shape: 'moon' })
})

test('set-main adds and removes in mainBotIds and keeps mainBotId', () => {
  const added = optimistic(team, 'set-main', { id: 'b2', main: true })!
  assert.deepEqual(added.mainBotIds, ['b1', 'b2'])
  assert.equal(added.mainBotId, 'b1')
  const removed = optimistic(added, 'set-main', { id: 'b1', main: false })!
  assert.deepEqual(removed.mainBotIds, ['b2'])
  assert.equal(removed.mainBotId, 'b2')
  const none = optimistic(removed, 'set-main', { id: 'b2', main: false })!
  assert.deepEqual(none.mainBotIds, [])
  assert.equal(none.mainBotId, null)
})

test('bot-capability adds and removes the name in that bot', () => {
  const added = optimistic(team, 'bot-capability', { botId: 'b2', name: 'shell', attached: true })!
  assert.deepEqual(added.bots[1].capabilities, ['shell'])
  const removed = optimistic(team, 'bot-capability', { botId: 'b1', name: 'shell', attached: false })!
  assert.deepEqual(removed.bots[0].capabilities, [])
})

test('update-room shallow-merges the patch into that room', () => {
  const next = optimistic(team, 'update-room', { id: 'r1', name: 'Daily', notice: 'Bring updates' })!
  assert.equal(next.rooms![0].name, 'Daily')
  assert.equal(next.rooms![0].notice, 'Bring updates')
  assert.deepEqual(next.rooms![0].members, ['b1', 'b2'])
  assert.equal(next.rooms![1].name, 'Quiet')
})

test('unknown ids, unknown endpoints and an empty team change nothing', () => {
  assert.equal(optimistic(team, 'update-bot', { id: 'ghost', color: '#000000' }), team)
  assert.equal(optimistic(team, 'set-main', { id: 'ghost', main: true }), team)
  assert.equal(optimistic(team, 'bot-capability', { botId: 'ghost', name: 'shell', attached: true }), team)
  assert.equal(optimistic(team, 'update-room', { id: 'ghost', name: 'x' }), team)
  assert.equal(optimistic(team, 'delete-bot', { id: 'b1' }), team)
  assert.equal(optimistic(null, 'update-bot', { id: 'b1' }), null)
})

test('a stale read keeps the guess of a write still in flight', () => {
  const stale = { ...team, bots: [{ ...team.bots[0], permission: 'workspace-write' }, team.bots[1]] }
  const next = withWrites(stale, [{ endpoint: 'update-bot', payload: { id: 'b1', permission: 'read-only' } }])
  assert.equal(next.bots[0].permission, 'read-only')
  assert.equal(withWrites(stale, []), stale)
})

test('switching to a computer with a lower revision clears the old team and accepts the new state', async () => {
  const { registerHooks } = await import('node:module')
  let states: any[] = []
  let refs: { current: any }[] = []
  let callbacks: { fn: unknown; deps?: unknown[] }[] = []
  let effects: { deps?: unknown[]; cleanup?: () => void }[] = []
  let cursor = 0
  let refCursor = 0
  let cbCursor = 0
  let effectCursor = 0
  let pendingEffects: (() => void)[] = []
  const closed: string[] = []
  const sent: { host: string; endpoint: string; payload: unknown; state?: unknown }[] = []
  const byHost: Record<string, TeamState> = {
    'host-a': { revision: 10, bots: [{ id: 'a1', name: 'Alpha' }] },
    'host-b': { revision: 2, bots: [{ id: 'b1', name: 'Beta' }] },
  }

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react' || specifier === 'react-native' || specifier === '../connection.ts' || specifier === './gate.ts' || specifier === '../ui/i18n.ts') {
        return { url: `mock:${specifier}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:react') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const useState = globalThis.__linkTestHooks.useState
            export const useRef = globalThis.__linkTestHooks.useRef
            export const useCallback = globalThis.__linkTestHooks.useCallback
            export const useEffect = globalThis.__linkTestHooks.useEffect
          `,
        }
      }
      if (url === 'mock:react-native') {
        return { format: 'module', shortCircuit: true, source: `export const AppState = { addEventListener: () => ({ remove() {} }) }` }
      }
      if (url === 'mock:../connection.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const openLink = globalThis.__linkTestHooks.openLink
            export const callBot = globalThis.__linkTestHooks.callBot
            export const callBotState = globalThis.__linkTestHooks.callBotState
          `,
        }
      }
      if (url === 'mock:./gate.ts') {
        return { format: 'module', shortCircuit: true, source: `export const ensureUnlock = async () => {}` }
      }
      if (url === 'mock:../ui/i18n.ts') {
        return { format: 'module', shortCircuit: true, source: `export const t = (s) => s` }
      }
      return nextLoad(url, context)
    },
  })

  ;(globalThis as any).__linkTestHooks = {
    useState(init: unknown) {
      const idx = cursor++
      if (!(idx in states)) states[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (next: unknown) => { states[idx] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next }
      return [states[idx], set]
    },
    useRef(init: unknown) {
      const idx = refCursor++
      if (!(idx in refs)) refs[idx] = { current: init }
      return refs[idx]
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const idx = cbCursor++
      const prev = callbacks[idx]
      const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps![i]))
      if (changed) callbacks[idx] = { fn, deps }
      return callbacks[idx].fn
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const idx = effectCursor++
      const prev = effects[idx]
      const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps![i]))
      if (changed) {
        effects[idx] = { deps, cleanup: prev?.cleanup }
        pendingEffects.push(() => {
          prev?.cleanup?.()
          const cleanup = fn()
          effects[idx] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
      }
    },
    openLink: async (computer: { hostDeviceId: string }) => ({
      host: computer.hostDeviceId,
      onEvent() {},
      onClose() {},
      close: async () => { closed.push(computer.hostDeviceId) },
      probe() {},
    }),
    callBot: async (client: { host: string }, endpoint: string, payload: unknown) => {
      sent.push({ host: client.host, endpoint, payload })
      if (endpoint === 'state') return byHost[client.host]
      if (endpoint === 'hello') return { api: 1, capabilities: [], boot: `boot-${client.host}`, seq: 0 }
      if (endpoint === 'notices') return { reset: false }
      return {}
    },
    callBotState: async (client: { host: string }, endpoint: string, payload: unknown, state: unknown) => {
      sent.push({ host: client.host, endpoint, payload, state })
      return { value: true, state: { ...byHost[client.host], revision: byHost[client.host].revision + 1 } }
    },
  }

  try {
    const { useTeamLink } = await import('./link.ts')
    const identity = { deviceId: 'p1', publicKey: 'k', privateKey: 's', accessToken: 't' }
    const render = (computer: any) => {
      for (let pass = 0; pass < 3; pass += 1) {
        cursor = 0; refCursor = 0; cbCursor = 0; effectCursor = 0; pendingEffects = []
        const out = useTeamLink(computer, identity)
        if (pendingEffects.length === 0) return out
        for (const run of pendingEffects) run()
      }
      cursor = 0; refCursor = 0; cbCursor = 0; effectCursor = 0; pendingEffects = []
      return useTeamLink(computer, identity)
    }

    const compA = { server: 's', hostDeviceId: 'host-a', hostKey: 'ka', name: 'A' }
    const compB = { server: 's', hostDeviceId: 'host-b', hostKey: 'kb', name: 'B' }

    render(compA)
    await new Promise(resolve => setTimeout(resolve, 20))
    const onA = render(compA)
    assert.equal(onA.team?.revision, 10)
    assert.equal(onA.team?.bots[0].name, 'Alpha')

    // Switch to computer B whose revision (2) is lower than computer A's (10).
    cursor = 0; refCursor = 0; cbCursor = 0; effectCursor = 0; pendingEffects = []
    const beforeEffects = useTeamLink(compB, identity)
    assert.equal(beforeEffects.team, null)
    for (const run of pendingEffects) run()
    await new Promise(resolve => setTimeout(resolve, 20))
    const onB = render(compB)
    assert.equal(closed.includes('host-a'), true)
    assert.equal(onB.team?.revision, 2)
    assert.equal(onB.team?.bots[0].name, 'Beta')

    await onB.call('update-bot', { id: 'b1', name: 'Beta 2' })
    const writeCall = sent.findLast(entry => entry.endpoint === 'update-bot')
    assert.equal(writeCall?.host, 'host-b')
    assert.equal((writeCall?.state as { since?: number })?.since, 2)
  } finally {
    for (const effect of effects) effect?.cleanup?.()
    hooks.deregister()
    delete (globalThis as any).__linkTestHooks
  }
})

