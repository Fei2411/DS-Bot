import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { createRuntime } from '../index.js'
import { MAX_AVATAR_IMAGE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

// A group photo goes in through the group tools the way a Bot's own photo goes in
// through update_bot: a local path or a data URL, the same formats and the same limit.

const photo = pixel => `data:image/png;base64,${PNG.sync.write({ width: 1, height: 1, data: Buffer.from(pixel) }).toString('base64')}`

function start({ saved, home: reuse } = {}) {
  const home = reuse ?? mkdtempSync(join(tmpdir(), 'ds-bot-group-avatar-'))
  if (saved !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = name => rt.teamTools.find(entry => entry.name === name)
  const dispose = () => ctx.dispose()
  const stop = async () => {
    await dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, tool, rt, stop, dispose, home }
}

const baseTeam = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Copy', instructions: '', createdAt: 2 },
    editor: { id: 'editor', sessionId: 'editor', name: 'Editor', role: 'Video', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', sessionId: 'r1', name: 'Video Room', named: true, members: ['chief', 'writer', 'editor'], admin: 'chief', mode: 'admin', notice: '', createdAt: 4 },
  },
})

const mainExec = { agent: { id: 'chief', session: { id: 'chief' } } }
const savedAvatar = (home, id) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[id].avatar

test('create_group stores the photo it is given', async (t) => {
  const { call, tool, stop, home } = start({ saved: baseTeam() })
  t.after(stop)
  const image = photo([0, 0, 255, 255])
  const out = await tool('create_group').execute({ members: ['Writer'], name: 'Photo Room', avatar: image }, mainExec)
  assert.match(out, /Created group "Photo Room"/)
  const room = (await call('state', {})).value.rooms.find(entry => entry.name === 'Photo Room')
  assert.deepEqual(room.avatar, { image })
  assert.deepEqual(savedAvatar(home, room.id), { image })
})

// A group made without a photo keeps the member portraits it draws now.
test('create_group without a photo leaves the group without one', async (t) => {
  const { call, tool, stop } = start({ saved: baseTeam() })
  t.after(stop)
  await tool('create_group').execute({ members: ['Writer'], name: 'Plain Room' }, mainExec)
  const room = (await call('state', {})).value.rooms.find(entry => entry.name === 'Plain Room')
  assert.equal(room.avatar, undefined)
})

test('update_group replaces, keeps, and clears the group photo', async (t) => {
  const { tool, stop, home } = start({ saved: baseTeam() })
  t.after(stop)
  const first = photo([0, 0, 255, 255])
  assert.match(await tool('update_group').execute({ group: 'Video Room', avatar: first }, mainExec), /updated the avatar/)
  assert.deepEqual(savedAvatar(home, 'r1'), { image: first })

  // Another edit leaves the photo alone: unset means unchanged, as on a Bot.
  await tool('update_group').execute({ group: 'Video Room', name: 'Video Team' }, mainExec)
  assert.deepEqual(savedAvatar(home, 'r1'), { image: first })

  const second = photo([255, 0, 0, 255])
  await tool('update_group').execute({ group: 'Video Team', avatar: second }, mainExec)
  assert.deepEqual(savedAvatar(home, 'r1'), { image: second })

  // An empty string removes it, and a second removal reports no change.
  assert.match(await tool('update_group').execute({ group: 'Video Team', avatar: '' }, mainExec), /removed the avatar/)
  assert.equal(savedAvatar(home, 'r1'), undefined)
  assert.match(await tool('update_group').execute({ group: 'Video Team', avatar: '' }, mainExec), /Nothing changed/)
})

// The checks are the ones a Bot's photo gets, so an image that fails there fails here
// too, and the group keeps the name and photo it had.
test('a photo the tools cannot read leaves the group unchanged', async (t) => {
  const { tool, stop, home } = start({ saved: baseTeam() })
  t.after(stop)
  const image = photo([0, 0, 255, 255])
  await tool('update_group').execute({ group: 'Video Room', avatar: image }, mainExec)
  for (const bad of [
    'https://example.test/photo.png',
    'data:image/png;base64,bm90IGFuIGltYWdl',
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    `data:image/png;base64,${'A'.repeat(MAX_AVATAR_IMAGE)}`,
  ]) {
    const out = await tool('update_group').execute({ group: 'Video Room', name: 'Renamed', avatar: bad }, mainExec)
    assert.match(out, /Could not update "Video Room"/, bad.slice(0, 40))
    const room = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1
    assert.equal(room.name, 'Video Room', 'the rename did not land either')
    assert.deepEqual(room.avatar, { image })
  }
})

// The photo rides on the group, so it is still there when the host starts again.
test('a group photo survives a restart', async (t) => {
  const first = start({ saved: baseTeam() })
  const image = photo([0, 255, 0, 255])
  await first.tool('update_group').execute({ group: 'Video Room', avatar: image }, mainExec)
  const { home } = first
  await first.dispose()
  const second = start({ home })
  t.after(async () => { await second.stop() })
  const room = (await second.call('state', {})).value.rooms.find(entry => entry.id === 'r1')
  assert.deepEqual(room.avatar, { image })
})
