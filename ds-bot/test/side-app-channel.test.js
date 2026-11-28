import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The endpoints wired into POST /api/bot, exercised through the real channel with a
// real state file: open registration rides the state answer, consumption is claimed
// once, and reads re-authorize against the Session's working root.
function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-side-channel-'))
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-side-work-')))
  t.after(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    revision: 1,
    bots: { b1: { id: 'b1', sessionId: 's1', name: 'Writer', instructions: '', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const ctx = fakeContext({ services: { workspaceRegistry: { get: () => undefined, list: () => [] } } })
  // folders.js reads the registry as a direct property, not through ctx.get.
  ctx.workspaceRegistry = { get: () => undefined, list: () => [] }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path === '/api/bot') route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  rt.resolveAgent = async id => ({ id, session: { id, header: { cwd: root } } })
  rt.sessionFolder = session => (session?.id === 's1' ? root : undefined)
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const write = (rel, text) => {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return path
  }
  t.after(async () => { await ctx.dispose() })
  return { rt, call, write, root }
}

const openCanvas = (rt, path, root) => rt.teamTools.find(tool => tool.name === 'open_canvas').execute({ path }, { agent: { id: 's1', session: { id: 's1', header: { cwd: root } } }, callId: 'c1' })

test('a tool call leaves a consumable open in the state answer, claimed exactly once', async (t) => {
  const { rt, call, write, root } = start(t)
  write('draft.html', '<h1>hi</h1>')
  await rt.load()
  const text = await openCanvas(rt, 'draft.html', root)
  assert.match(text, /Canvas opened for draft\.html/)
  const state = (await call('state')).value
  assert.equal(state.sideAppOpens.s1.displayPath, 'draft.html')
  assert.equal(state.sideAppOpens.s1.app, 'canvas')
  const openId = state.sideAppOpens.s1.openId
  assert.equal((await call('side-app-opened', { openId })).value.consumed, true)
  assert.equal((await call('side-app-opened', { openId })).value.consumed, false)
  assert.equal((await call('state')).value.sideAppOpens.s1, undefined)
})

test('side-app-read serves workspace text through the channel and refuses escapes', async (t) => {
  const { rt, call, write, root } = start(t)
  write('docs/guide.md', '# Guide\n\nbody')
  await rt.load()
  const text = await rt.teamTools.find(tool => tool.name === 'open_reader').execute({ path: 'docs/guide.md' }, { agent: { id: 's1', session: { id: 's1', header: { cwd: root } } }, callId: 'c1' })
  const descriptor = JSON.parse(text.split('\n')[0])
  const file = { app: descriptor.app, sessionId: 's1', displayPath: descriptor.displayPath, workspaceTag: descriptor.workspaceTag }
  const read = (await call('side-app-read', { file })).value
  assert.equal(read.kind, 'text')
  assert.equal(read.text, '# Guide\n\nbody')
  assert.deepEqual((await call('side-app-read', { file, knownRevision: read.revision })).value, { kind: 'unchanged', revision: read.revision })
  const escape = (await call('side-app-read', { file: { ...file, displayPath: '../outside.md' } }))
  assert.equal(escape.ok, false)
  assert.equal(escape.error.code, 'bot/forbidden')
  const wrong = (await call('side-app-read', { file: { ...file, workspaceTag: 'wrong' } }))
  assert.equal(wrong.error.code, 'bot/workspace-changed')
})

test('the five side-app endpoints are readable while another host owns the team', async (t) => {
  const { rt, call, write, root } = start(t)
  write('draft.html', '<h1>hi</h1>')
  await rt.load()
  const text = await openCanvas(rt, 'draft.html', root)
  const descriptor = JSON.parse(text.split('\n')[0])
  const file = { app: 'canvas', sessionId: 's1', displayPath: descriptor.displayPath, workspaceTag: descriptor.workspaceTag }
  // A second dsh holding the lock turns this host read-only; reads must still work,
  // exactly as markdown-image does.
  rt.readOnly = () => 'Another DeepSeek Harness is using this team'
  const read = await call('side-app-read', { file })
  assert.equal(read.ok, true, `read-only host must still serve reads: ${read.error?.message}`)
  const preview = await call('side-app-preview', { file })
  assert.equal(preview.ok, true)
  assert.equal((await call('side-app-diff', { file, revision: preview.value.previewRevision })).value.kind, 'unavailable')
  assert.equal((await call('side-app-open', { file, app: 'canvas' })).ok, true)
  assert.equal((await call('side-app-opened', { openId: 'none' })).value.consumed, false)
})

test('preview issues a ticketed frame and diff answers unavailable without a base', async (t) => {
  const { rt, call, write, root } = start(t)
  write('page/draft.html', '<h1>hi</h1>')
  await rt.load()
  const text = await openCanvas(rt, 'page/draft.html', root)
  const descriptor = JSON.parse(text.split('\n')[0])
  const file = { app: 'canvas', sessionId: 's1', displayPath: descriptor.displayPath, workspaceTag: descriptor.workspaceTag }
  const preview = (await call('side-app-preview', { file })).value
  assert.equal(preview.kind, 'preview')
  assert.match(preview.frameUrl, /^\/api\/bot-canvas\/[A-Za-z0-9_-]+\/draft\.html$/)
  assert.equal((await call('side-app-diff', { file, revision: preview.previewRevision })).value.kind, 'unavailable')
})

test('a remote state answer carries no sideAppOpens descriptors', async (t) => {
  const { rt, call, write, root } = start(t)
  write('draft.html', '<h1>hi</h1>')
  await rt.load()
  await openCanvas(rt, 'draft.html', root)
  const local = (await call('state')).value
  assert.equal(local.sideAppOpens.s1.displayPath, 'draft.html', 'the local computer still receives the live open')
  const remote = await rt.channelCall('state', {}, undefined, true)
  assert.equal(remote.ok, true, remote.error?.message)
  assert.equal(remote.value.sideAppOpens, undefined, 'phone and relay payloads never carry file paths of pending opens')
})
