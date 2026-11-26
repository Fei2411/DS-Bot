import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { install as installFeed } from '../src/host/feed.js'
import { install as installFolders } from '../src/host/folders.js'
import { install as installWorkspacePanel } from '../src/host/workspace-panel.js'
import { parseXlsxBuffer } from '../src/host/xlsx-preview.js'

function createRuntime(rootDir, { dshHome, workspaceChanges, subprocess, bots, liveSessions, chatOwners } = {}) {
  const localFeedEvents = []
  const sharedFeedEvents = []
  const services = new Map()
  if (workspaceChanges) services.set('workspaceChanges', workspaceChanges)
  if (subprocess) services.set('subprocess', subprocess)
  const botMap = bots ?? { b1: { id: 'b1', name: 'Chief', sessionId: 'b1' } }
  const chatMap = chatOwners ?? new Map(Object.values(botMap).map(b => [b.sessionId ?? b.id, b.id]))
  const ctx = {
    get: name => services.get(name),
    workspaceRegistry: {
      get: id => (id === 'ws-1' ? { id: 'ws-1', path: rootDir, title: 'Team' } : undefined),
      list: () => [{ id: 'ws-1', path: rootDir, title: 'Team' }],
    },
    sessions: { get: id => liveSessions?.get(id) },
    on: () => () => {},
    effect: () => () => {},
    connection: { fetch: { register: () => () => {} } },
  }
  const rt = {
    ctx,
    config: {},
    dshHome: dshHome ?? mkdtempSync(join(tmpdir(), 'dsb-dsh-')),
    home: join(dshHome ?? tmpdir(), 'bot'),
    state: { revision: 1, workspaceId: 'ws-1', bots: botMap, rooms: {} },
    load: async () => {},
    onSaved: () => () => {},
    botOf: id => botMap[id],
    selfOf: id => chatMap.get(id),
    chatOwners: chatMap,
    roomOf: () => undefined,
    groupOwners: new Map(),
    taskOwners: new Map(),
    pastOwners: new Map(),
    publishFeed: (event, data) => sharedFeedEvents.push({ event, data }),
    publishLocalFeed: (event, data) => localFeedEvents.push({ event, data }),
  }
  installFolders(rt)
  installWorkspacePanel(rt)
  return { rt, localFeedEvents, sharedFeedEvents }
}

test('workspace-list and workspace-read enforce containment, skip symlink cycles & escapes, preserve whitespace paths, and classify formats', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-work-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsb-wp-out-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  mkdirSync(join(workDir, 'src'), { recursive: true })
  mkdirSync(join(workDir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(workDir, 'README.md'), '# Workspace\nHello world\n')
  writeFileSync(join(workDir, 'src', 'index.js'), 'export const x = 1\n')
  writeFileSync(join(workDir, 'data.csv'), 'name,score\nAlice,10\n')
  writeFileSync(join(workDir, 'page.html'), '<h1>Safe</h1><script>alert(1)</script>')
  writeFileSync(join(workDir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  writeFileSync(join(workDir, 'doc.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'))
  writeFileSync(join(workDir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 4]))
  writeFileSync(join(workDir, '.env.local'), 'SECRET=1\n')
  writeFileSync(join(workDir, 'spaced.txt '), 'trailing-space-file')
  writeFileSync(join(outsideDir, 'secret.txt'), 'top-secret')
  try {
    symlinkSync(join(outsideDir, 'secret.txt'), join(workDir, 'escape-link.txt'))
    symlinkSync(workDir, join(workDir, 'cycle-to-root'))
    symlinkSync(join(workDir, 'src'), join(workDir, 'src', 'cycle-self'))
  } catch { /* Windows without symlink privilege */ }

  const { rt } = createRuntime(workDir, { dshHome })

  const rootList = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: '' })
  const names = rootList.entries.map(e => e.name)
  assert.equal(rootList.entries[0].kind, 'dir', 'folders sort before files')
  assert.ok(names.includes('src'))
  assert.ok(names.includes('README.md'))
  assert.ok(names.includes('spaced.txt '))
  assert.equal(names.includes('node_modules'), false, 'node_modules hidden by default')
  assert.equal(names.includes('.env.local'), false, 'dotfiles hidden by default')
  assert.equal(names.includes('escape-link.txt'), false, 'escaping symlink omitted from listing')
  assert.equal(names.includes('cycle-to-root'), false, 'cyclic directory symlink omitted from listing')

  const srcList = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: 'src' })
  assert.equal(srcList.entries.some(e => e.name === 'cycle-self'), false, 'nested cyclic dir symlink omitted')

  const hiddenList = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: '', includeHidden: true })
  assert.ok(hiddenList.entries.some(e => e.name === '.env.local'))

  const spaced = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'spaced.txt ' })
  assert.equal(spaced.text, 'trailing-space-file', 'paths with trailing whitespace must not be trimmed')

  const md = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'README.md' })
  assert.equal(md.kind, 'markdown')
  assert.match(md.text, /# Workspace/)

  const code = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'src/index.js' })
  assert.equal(code.kind, 'code')
  assert.equal(code.language, 'javascript')

  const csv = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'data.csv' })
  assert.equal(csv.kind, 'table')
  assert.equal(csv.delimiter, ',')

  const html = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'page.html' })
  assert.equal(html.kind, 'html')

  const img = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'pixel.png' })
  assert.equal(img.kind, 'image')
  assert.equal(img.mime, 'image/png')
  assert.ok(img.base64.length > 0)

  const pdf = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'doc.pdf' })
  assert.equal(pdf.kind, 'pdf')
  assert.equal(pdf.mime, 'application/pdf')

  const bin = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'blob.bin' })
  assert.equal(bin.kind, 'binary')

  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: '../secret.txt' }), { code: 'bot/refused' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: join(outsideDir, 'secret.txt') }), { code: 'bot/refused' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'README.md\0.txt' }), { code: 'bot/invalid' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'does-not-exist.md' }), { code: 'bot/not-found' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'escape-link.txt' }), { code: 'bot/refused' })
})

test('workspace-list inspects eight entries at a time and keeps readdir order for name ties', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-par-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })
  for (let i = 0; i < 36; i++) writeFileSync(join(workDir, `file-${String(i).padStart(2, '0')}.txt`), 'x'.repeat(i))
  for (let i = 0; i < 4; i++) mkdirSync(join(workDir, `dir-${i}`))
  // Equal under the listing's base-sensitivity compare, so their order comes from readdir.
  for (const name of ['cafe.md', 'caf\u00e9.md', 'resume.txt', 'r\u00e9sum\u00e9.txt']) writeFileSync(join(workDir, name), name)
  writeFileSync(join(workDir, '.hidden'), '')

  const { realpath } = fsp
  // The listing resolves through fs/promises, which expands Windows 8.3 short names that realpathSync keeps.
  const realWork = await realpath(workDir)
  let started = 0
  let inspecting = 0
  let peak = 0
  fsp.realpath = async (path, ...rest) => {
    if (dirname(String(path)) !== realWork) return realpath(path, ...rest)
    inspecting++
    peak = Math.max(peak, inspecting)
    // Each lookup takes less time than the one started before it, so lookups finish out of order.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 45 - started++)))
    try { return await realpath(path, ...rest) } finally { inspecting-- }
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.realpath = realpath
    syncBuiltinESMExports()
  })

  const { rt } = createRuntime(workDir, { dshHome })
  const list = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: '' })

  const expected = readdirSync(workDir, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  assert.deepEqual(list.entries.map(e => e.name), expected.map(e => e.name))
  const { mtimeMs, ...row } = list.entries.find(e => e.name === 'file-07.txt')
  assert.deepEqual(row, { name: 'file-07.txt', path: 'file-07.txt', kind: 'file', size: 7, ext: '.txt' })
  assert.equal(Number.isInteger(mtimeMs), true)
  assert.equal(list.truncated, false)
  assert.equal(peak, 8)
})

test('workspace-list keeps the first 500 sorted entries of a large folder', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-big-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })
  for (let i = 0; i < 520; i++) writeFileSync(join(workDir, `f-${String(i).padStart(3, '0')}.txt`), '')
  for (let i = 0; i < 3; i++) mkdirSync(join(workDir, `z-dir-${i}`))

  const { rt } = createRuntime(workDir, { dshHome })
  const list = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: '' })
  assert.equal(list.truncated, true)
  assert.equal(list.entries.length, 500)
  assert.deepEqual(list.entries.slice(0, 4).map(e => e.name), ['z-dir-0', 'z-dir-1', 'z-dir-2', 'f-000.txt'])
  assert.equal(list.entries.at(-1).name, 'f-496.txt')
})

test('workspace-list leaves out folder junctions inside and outside the workspace', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-jn-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsb-wp-jn-out-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })
  mkdirSync(join(workDir, 'inside'))
  writeFileSync(join(workDir, 'inside', 'a.txt'), 'a')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
  // Junctions need no privilege on Windows; elsewhere the type is ignored and a folder symlink is made.
  symlinkSync(join(workDir, 'inside'), join(workDir, 'inside-junction'), 'junction')
  symlinkSync(outsideDir, join(workDir, 'outside-junction'), 'junction')
  symlinkSync(join(workDir, 'inside'), join(workDir, 'inside', 'loop-junction'), 'junction')

  const { rt } = createRuntime(workDir, { dshHome })
  const root = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: '' })
  assert.deepEqual(root.entries.map(e => [e.name, e.path, e.kind]), [['inside', 'inside', 'dir']])
  const inside = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: 'inside' })
  assert.deepEqual(inside.entries.map(e => [e.name, e.path, e.kind]), [['a.txt', 'inside/a.txt', 'file']])
  await assert.rejects(() => rt.workspaceEndpoint('list', { sessionId: 'b1', path: 'outside-junction' }), { code: 'bot/refused' })
})

test('resolveWorkspaceRoot resolves rolled-over Bot segments, live working_directory subfolders, and refuses inData roots', async (t) => {
  const teamDir = mkdtempSync(join(tmpdir(), 'dsb-wp-team-'))
  const botDir = mkdtempSync(join(tmpdir(), 'dsb-wp-bot-'))
  const subDir = join(botDir, 'frontend')
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-dsh2-'))
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(teamDir, 'team.txt'), 'team')
  writeFileSync(join(botDir, 'bot.txt'), 'bot')
  writeFileSync(join(subDir, 'sub.txt'), 'sub')
  t.after(() => {
    rmSync(teamDir, { recursive: true, force: true })
    rmSync(botDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  const liveSessions = new Map()
  liveSessions.set('seg-live', { id: 'seg-live', header: { cwd: subDir } })
  liveSessions.set('seg-in-data', { id: 'seg-in-data', header: { cwd: dshHome } })

  const { rt } = createRuntime(teamDir, {
    dshHome,
    bots: {
      b1: { id: 'b1', name: 'Coder', sessionId: 'seg-2', workDir: botDir },
    },
    chatOwners: new Map([['seg-2', 'b1'], ['seg-live', 'b1']]),
    liveSessions,
  })

  // Rolled-over segment (`seg-2 !== b1`) without live session must open `bot.workDir`, not team workspace.
  const rolled = await rt.workspaceEndpoint('list', { sessionId: 'seg-2', path: '' })
  assert.equal(rolled.root, await rt.real(botDir))
  assert.ok(rolled.entries.some(e => e.name === 'bot.txt'))

  // Live session moved via `working_directory` into `frontend/` must prefer live cwd over `bot.workDir`.
  const live = await rt.workspaceEndpoint('list', { sessionId: 'seg-live', path: '' })
  assert.equal(live.root, await rt.real(subDir))
  assert.ok(live.entries.some(e => e.name === 'sub.txt'))

  // A session pointing into protected DSH data must be refused.
  await assert.rejects(() => rt.workspaceEndpoint('list', { sessionId: 'seg-in-data', path: '' }), { code: 'bot/refused' })

  // Stale expectedRoot must be rejected with bot/stale when working_directory moved in place.
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'seg-live', path: 'sub.txt', expectedRoot: botDir }), { code: 'bot/stale' })

  // If config.workspace is an ancestor containing dshHome, files inside dshHome remain strictly refused.
  const parentDir = mkdtempSync(join(tmpdir(), 'dsb-wp-anc-'))
  const nestedDsh = join(parentDir, '.dsh')
  mkdirSync(join(nestedDsh, 'bot'), { recursive: true })
  writeFileSync(join(nestedDsh, 'bot', 'secrets.json'), '{"k":"v"}')
  t.after(() => rmSync(parentDir, { recursive: true, force: true }))
  const ctxAnc = {
    get: () => undefined,
    workspaceRegistry: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined },
  }
  const rtAnc = {
    ctx: ctxAnc,
    config: { workspace: parentDir },
    dshHome: nestedDsh,
    home: join(nestedDsh, 'bot'),
    state: { revision: 1, bots: {}, rooms: {} },
    load: async () => {},
    botOf: () => undefined,
    selfOf: () => undefined,
    roomOf: () => undefined,
    groupOwners: new Map(),
    taskOwners: new Map(),
    pastOwners: new Map(),
  }
  installFolders(rtAnc)
  installWorkspacePanel(rtAnc)
  await assert.rejects(() => rtAnc.workspaceEndpoint('read', { sessionId: '', path: '.dsh/bot/secrets.json' }), { code: 'bot/refused' })
})

test('workspace-changes delegates to ctx.workspaceChanges with a valid AbortSignal and reports bot/stale when disposed', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-chg-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-chg-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  let receivedSignal
  const workspaceChanges = {
    summary: (sid, seq) => (sid === 'b1' && seq === 12 ? {
      turn: 2,
      cwd: workDir,
      total: 1,
      added: 3,
      deleted: 1,
      files: [{ path: 'src/a.js', display: 'src/a.js', added: 3, deleted: 1 }],
    } : undefined),
    diff: async (sid, seq, index, signal) => {
      // Mirrors real DSH `dsh-workspace-changes` calling `AbortSignal.any([signal, ...])`.
      assert.ok(signal instanceof AbortSignal, 'diff must always receive a valid AbortSignal')
      receivedSignal = signal
      return sid === 'b1' && seq === 12 && index === 0 ? {
        kind: 'text',
        path: 'src/a.js',
        display: 'src/a.js',
        before: true,
        after: true,
        coarse: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-const a = 1', '+const a = 2', '+export default a'] }],
      } : undefined
    },
  }

  const { rt } = createRuntime(workDir, { dshHome, workspaceChanges })
  const summary = await rt.workspaceEndpoint('changes', { sessionId: 'b1', seq: 12 })
  assert.equal(summary.total, 1)
  assert.equal(summary.files[0].index, 0)
  const diff = await rt.workspaceEndpoint('changes', { sessionId: 'b1', seq: 12, index: 0 })
  assert.equal(diff.kind, 'text')
  assert.equal(diff.hunks.length, 1)
  assert.ok(receivedSignal instanceof AbortSignal)

  await assert.rejects(() => rt.workspaceEndpoint('changes', { sessionId: 'b1', seq: 999 }), { code: 'bot/stale' })
})

test('terminal endpoints preserve scrubbedParentEnv, publish only to local feed (never taps), handle abort, and dispose cleanly', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-term-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-term-dsh-'))
  const prevSecret = process.env.OPENAI_API_KEY
  const prevDsBot = process.env.DS_BOT_TEST_MARKER
  process.env.OPENAI_API_KEY = 'sk-must-not-leak'
  process.env.DS_BOT_TEST_MARKER = 'internal-only'
  t.after(() => {
    if (prevSecret === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevSecret
    if (prevDsBot === undefined) delete process.env.DS_BOT_TEST_MARKER
    else process.env.DS_BOT_TEST_MARKER = prevDsBot
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  const written = []
  const resized = []
  let terminated = 0
  let resolveDone
  let capturedSpec
  const output = new PassThrough()
  const subprocess = {
    spawnTerminal: async (spec) => {
      capturedSpec = spec
      assert.equal(spec.terminalType, 'xterm-256color')
      return {
        pid: 12345,
        output,
        done: new Promise(resolve => { resolveDone = resolve }),
        write: async data => { written.push(data) },
        resize: async (cols, rows) => { resized.push([cols, rows]) },
        terminate: async () => { terminated += 1; resolveDone?.({ exitCode: 0 }) },
      }
    },
  }

  const { rt, localFeedEvents, sharedFeedEvents } = createRuntime(workDir, { dshHome, subprocess })
  const opened = await rt.terminalEndpoint('open', { sessionId: 'b1', cols: 100, rows: 30 })
  assert.equal(opened.pty, true)
  // Must NOT re-inject ambient secrets via spec.env, and MUST tombstone DS_BOT_* keys.
  assert.equal(Object.hasOwn(capturedSpec.env, 'OPENAI_API_KEY'), false, 'credentials must never be passed in spec.env')
  assert.equal(Object.hasOwn(capturedSpec.env, 'DS_BOT_TEST_MARKER'), true)
  assert.equal(capturedSpec.env.DS_BOT_TEST_MARKER, undefined, 'DS_BOT_* keys must be tombstoned')

  // Multi-byte UTF-8 split across two chunks must decode cleanly via StringDecoder.
  const utf8 = Buffer.from('你好终端$ ', 'utf8')
  output.write(utf8.subarray(0, 4))
  output.write(utf8.subarray(4))
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(localFeedEvents.some(e => e.event === 'terminal' && e.data.id === opened.id && e.data.chunk.includes('你好终端$ ')), true)
  assert.equal(sharedFeedEvents.length, 0, 'terminal output must never go to shared remote feed')

  await rt.terminalEndpoint('input', { id: opened.id, data: 'ls\r' })
  assert.deepEqual(written, ['ls\r'])
  await rt.terminalEndpoint('resize', { id: opened.id, cols: 120, rows: 40 })
  assert.deepEqual(resized, [[120, 40]])

  // Aborted open must terminate any late handle and not leak into `terminals`.
  const abortController = new AbortController()
  let abortedTerminated = 0
  const abortSubprocess = {
    spawnTerminal: async () => {
      abortController.abort()
      return {
        pid: 99999,
        output: new PassThrough(),
        done: new Promise(() => {}),
        write: async () => {},
        resize: async () => {},
        terminate: async () => { abortedTerminated += 1 },
      }
    },
  }
  const { rt: rtAbort } = createRuntime(workDir, { dshHome, subprocess: abortSubprocess })
  await assert.rejects(() => rtAbort.terminalEndpoint('open', { sessionId: 'b1' }, abortController.signal), { code: 'bot/aborted' })
  assert.equal(abortedTerminated, 1)
  assert.equal((await rtAbort.terminalEndpoint('list')).length, 0)

  const listed = await rt.terminalEndpoint('list')
  assert.equal(listed.length, 1)
  assert.match(listed[0].snapshot, /你好终端\$/)

  await rt.terminalDispose()
  assert.equal(terminated, 1)
  assert.equal((await rt.terminalEndpoint('list')).length, 0)
  await assert.rejects(() => rt.terminalEndpoint('open', { sessionId: 'b1' }), { code: 'bot/refused' })
})

test('feed.js publishLocalFeed never notifies remote feedTap / subscribeFeed listeners', () => {
  const ctx = {
    on: () => () => {},
    effect: () => () => {},
    connection: { fetch: { register: () => () => {} } },
  }
  const rt = {
    ctx,
    state: { revision: 3 },
    onSaved: () => () => {},
    selfOf: () => undefined,
    chatOwners: new Map(),
  }
  installFeed(rt)
  const tapSeen = []
  rt.feedTap((event, data) => tapSeen.push({ event, data }))
  rt.publishLocalFeed('terminal', { id: 't1', chunk: 'local-only' })
  rt.publishFeed('live', { ok: true })
  assert.equal(tapSeen.some(e => e.event === 'terminal'), false)
  assert.equal(tapSeen.some(e => e.event === 'live'), true)
})

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, raw] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    locals.push(lfh, nameBuf, comp)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(0, 8)
    cdh.writeUInt16LE(8, 10)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(comp.length, 20)
    cdh.writeUInt32LE(data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30)
    cdh.writeUInt16LE(0, 32)
    cdh.writeUInt32LE(offset, 42)
    centrals.push(cdh, nameBuf)
    offset += lfh.length + nameBuf.length + comp.length
  }
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

test('workspace-watch debounces events, ignores .git/node_modules, bounds watches, and cleans up on unwatch/dispose', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-watch-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-watch-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })
  mkdirSync(join(workDir, 'src'), { recursive: true })

  const watchers = []
  const { rt, localFeedEvents, sharedFeedEvents } = createRuntime(workDir, { dshHome })
  rt.workspaceWatchDebounceMs = 20
  rt.watchWorkspaceDir = (dir, opts, onEvent) => {
    const entry = { dir, opts, onEvent, closed: false, close() { this.closed = true } }
    watchers.push(entry)
    return entry
  }

  const started = await rt.workspaceEndpoint('watch', { sessionId: 'b1' })
  assert.ok(started.watchId)
  assert.equal(watchers.length, 1)

  // Ignored paths (.git, node_modules, .DS_Store) emit nothing.
  watchers[0].onEvent('change', '.git/HEAD')
  watchers[0].onEvent('change', 'node_modules/pkg/index.js')
  watchers[0].onEvent('change', '.DS_Store')
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(localFeedEvents.length, 0)

  // Rapid bursts coalesce into a single debounced local-only `workspace-changed` event.
  watchers[0].onEvent('rename', 'src/a.js')
  watchers[0].onEvent('change', 'src/b.js')
  watchers[0].onEvent('change', 'README.md')
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(localFeedEvents.length, 1)
  assert.equal(localFeedEvents[0].event, 'workspace-changed')
  assert.deepEqual(localFeedEvents[0].data.paths.sort(), ['README.md', 'src/a.js', 'src/b.js'])
  assert.equal(sharedFeedEvents.length, 0, 'workspace-changed stays local-only')

  // Unwatch closes watcher and stops further events.
  const removed = await rt.workspaceEndpoint('unwatch', { watchId: started.watchId })
  assert.equal(removed.removed, true)
  assert.equal(watchers[0].closed, true)

  // Opening more than 8 watches evicts the oldest, and terminalDispose closes all remaining watchers.
  for (let i = 0; i < 10; i += 1) {
    await rt.workspaceEndpoint('watch', { sessionId: 'b1' })
  }
  const openCount = watchers.filter(w => !w.closed).length
  assert.equal(openCount, 8)
  await rt.terminalDispose()
  assert.equal(watchers.every(w => w.closed), true)
})

test('workspace-open enforces containment and dispatches reveal/open actions', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-open-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsb-wp-open-out-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-open-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })
  writeFileSync(join(workDir, 'doc.txt'), 'hello')
  writeFileSync(join(outsideDir, 'secret.txt'), 'nope')

  const opened = []
  const { rt } = createRuntime(workDir, { dshHome })
  rt.openWorkspacePath = async (spec) => { opened.push(spec) }

  const revealed = await rt.workspaceEndpoint('open', { sessionId: 'b1', path: 'doc.txt', action: 'reveal' })
  assert.equal(revealed.ok, true)
  const launched = await rt.workspaceEndpoint('open', { sessionId: 'b1', path: 'doc.txt', action: 'open' })
  assert.equal(launched.ok, true)
  assert.equal(opened.length, 2)
  assert.equal(opened[0].action, 'reveal')
  assert.equal(opened[1].action, 'open')
  assert.equal(opened[0].isDirectory, false)

  await assert.rejects(() => rt.workspaceEndpoint('open', { sessionId: 'b1', path: '../secret.txt', action: 'reveal' }), { code: 'bot/refused' })
  await assert.rejects(() => rt.workspaceEndpoint('open', { sessionId: 'b1', path: join(outsideDir, 'secret.txt'), action: 'open' }), { code: 'bot/refused' })
  await assert.rejects(() => rt.workspaceEndpoint('open', { sessionId: 'b1', path: 'doc.txt', action: 'delete' }), { code: 'bot/invalid' })
})

test('parseXlsxBuffer and workspace-read decode multi-sheet .xlsx workbooks with shared strings, dates, formulas, and merges', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-xlsx-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-xlsx-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  const xlsxBuf = buildZip({
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Summary" sheetId="1" r:id="rId1"/>
          <sheet name="Notes" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
      </Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
        <si><t>Budget &amp; Plan</t></si>
        <si><r><t>Rich </t></r><r><t>Label</t></r></si>
        <si><t>Second sheet</t></si>
      </sst>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <cellXfs count="2">
          <xf numFmtId="0"/>
          <xf numFmtId="14"/>
        </cellXfs>
      </styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="C1" t="s"><v>1</v></c>
          </row>
          <row r="2">
            <c r="A2"><v>42</v></c>
            <c r="B2"><f>A2*2</f><v>84</v></c>
            <c r="C2" s="1"><v>45658</v></c>
            <c r="D2" t="e"><v>#DIV/0!</v></c>
          </row>
        </sheetData>
        <mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
      </worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1"><c r="A1" t="s"><v>2</v></c></row>
        </sheetData>
      </worksheet>`,
  })

  const parsed = parseXlsxBuffer(xlsxBuf)
  assert.equal(parsed.sheets.length, 2)
  assert.equal(parsed.sheets[0].name, 'Summary')
  assert.equal(parsed.sheets[0].rows[0][0].v, 'Budget & Plan')
  assert.equal(parsed.sheets[0].rows[0][2].v, 'Rich Label')
  assert.deepEqual(parsed.sheets[0].merges, [{ r1: 0, c1: 0, r2: 0, c2: 1 }])
  assert.deepEqual(parsed.sheets[0].rows[1][0], { v: '42', num: true })
  assert.deepEqual(parsed.sheets[0].rows[1][1], { v: '84', f: '=A2*2', num: true })
  assert.equal(parsed.sheets[0].rows[1][2].v, '2025-01-01')
  assert.deepEqual(parsed.sheets[0].rows[1][3], { v: '#DIV/0!', err: true })
  assert.equal(parsed.sheets[1].name, 'Notes')
  assert.equal(parsed.sheets[1].rows[0][0].v, 'Second sheet')

  writeFileSync(join(workDir, 'budget.xlsx'), xlsxBuf)
  const { rt } = createRuntime(workDir, { dshHome })
  const read = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'budget.xlsx' })
  assert.equal(read.kind, 'spreadsheet')
  assert.equal(read.sheets.length, 2)
  assert.equal(read.sheets[0].name, 'Summary')
})
