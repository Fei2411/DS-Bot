import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
import { buildOpenOsCommand, install as installWorkspacePanel, openOsPath } from '../src/host/workspace-panel.js'
import { parseXlsxBuffer } from '../src/host/xlsx-preview.js'

function createRuntime(rootDir, { dshHome, workspaceChanges, subprocess, bots, liveSessions, chatOwners, extraRt } = {}) {
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
    ...(extraRt ?? {}),
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

  const firstEvent = localFeedEvents.find(e => e.event === 'terminal' && e.data.id === opened.id)
  assert.equal(firstEvent.data.start, 1)
  assert.equal(firstEvent.data.end, firstEvent.data.parts.at(-1).seq)
  const readAll = await rt.terminalEndpoint('read', { id: opened.id, after: 0 })
  assert.equal(readAll.truncated, false)
  assert.equal(readAll.end, firstEvent.data.end)
  assert.match(readAll.chunk, /你好终端\$/)
  const readHeld = await rt.terminalEndpoint('read', { id: opened.id, after: readAll.end })
  assert.equal(readHeld.chunk, '')

  // A fixed-size part never cuts an astral surrogate pair in half.
  const beforeAstral = readAll.end
  output.write(`${'a'.repeat(4095)}😀z`)
  await new Promise(resolve => setTimeout(resolve, 40))
  const astral = await rt.terminalEndpoint('read', { id: opened.id, after: beforeAstral })
  assert.equal(astral.parts[0].text.length, 4095)
  assert.equal(astral.parts.map(part => part.text).join(''), `${'a'.repeat(4095)}😀z`)

  // Scrollback trimming drops whole numbered parts. A client behind the trim hears that
  // honestly; one at the exact retained boundary still reads every later part once.
  for (let index = 0; index < 18; index += 1) output.write(`${'x'.repeat(4090)}${index}\n`)
  await new Promise(resolve => setTimeout(resolve, 60))
  const trimmed = await rt.terminalEndpoint('read', { id: opened.id, after: 0 })
  assert.equal(trimmed.truncated, true)
  assert.equal(trimmed.parts[0].seq, trimmed.start)
  assert.ok(trimmed.start > 1)
  const exact = await rt.terminalEndpoint('read', { id: opened.id, after: trimmed.start - 1 })
  assert.equal(exact.truncated, false)
  assert.equal(exact.parts[0].seq, trimmed.start)
  const withPositions = await rt.terminalEndpoint('list', { positions: { [opened.id]: trimmed.start - 1 } })
  assert.equal(withPositions[0].truncated, false)
  assert.equal(withPositions[0].parts[0].seq, trimmed.start)
  assert.equal(withPositions[0].snapshot, undefined)
  const unseen = await rt.terminalEndpoint('list', { positions: {} })
  assert.equal(unseen[0].snapshot, undefined)
  assert.equal(unseen[0].chunk, undefined)
  assert.ok(Array.isArray(unseen[0].parts))

  // Exit is part of the catch-up state even when its live event was not received.
  resolveDone({ exitCode: 7 })
  await new Promise(resolve => setTimeout(resolve, 20))
  const afterExit = await rt.terminalEndpoint('read', { id: opened.id, after: trimmed.end })
  assert.equal(afterExit.exited, true)
  assert.equal(afterExit.exitCode, 7)

  const listed = await rt.terminalEndpoint('list')
  assert.equal(listed.length, 1)
  assert.match(listed[0].snapshot, /x{20}/)
  assert.equal(listed[0].start, trimmed.start)
  assert.equal(listed[0].end, trimmed.end)

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

  // Opening multiple watch sessions on the same canonical folder shares ONE underlying OS watcher (ref-counted).
  const sharedA = await rt.workspaceEndpoint('watch', { sessionId: 'b1' })
  const sharedB = await rt.workspaceEndpoint('watch', { sessionId: 'b1' })
  const openShared = watchers.filter(w => !w.closed)
  assert.equal(openShared.length, 1, 'same canonical folder must share one ref-counted OS watcher')
  await rt.workspaceEndpoint('unwatch', { watchId: sharedA.watchId })
  assert.equal(openShared[0].closed, false, 'unwatching one session keeps shared OS watcher alive')
  await rt.workspaceEndpoint('unwatch', { watchId: sharedB.watchId })
  assert.equal(openShared[0].closed, true, 'unwatching last session closes shared OS watcher')

  // Opening more than 8 watch sessions evicts the oldest, and terminalDispose closes all remaining watchers.
  for (let i = 0; i < 10; i += 1) {
    await rt.workspaceEndpoint('watch', { sessionId: 'b1' })
  }
  await rt.terminalDispose()
  assert.equal(watchers.every(w => w.closed), true)
})

test('workspace-watch never passes recursive:true on Linux, falls back to polling on ENOSPC, supports overflow/orphan cleanup, and awaits mid-flight dispose', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-linux-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-linux-dsh-'))
  mkdirSync(join(workDir, 'src'), { recursive: true })
  writeFileSync(join(workDir, 'a.txt'), 'v1')
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  // 1. Linux watches root + expanded dirs without recursive:true.
  const linuxWatches = []
  const { rt: rtLinux, localFeedEvents: linuxEvents } = createRuntime(workDir, { dshHome })
  rtLinux.watchPlatform = 'linux'
  rtLinux.workspaceWatchDebounceMs = 20
  rtLinux.watchWorkspaceDir = (dir, opts, onEvent) => {
    assert.equal(Boolean(opts?.recursive), false, 'Linux must never pass recursive:true to fs.watch')
    const w = { dir, opts, onEvent, closed: false, close() { this.closed = true } }
    linuxWatches.push(w)
    return w
  }
  const wLinux = await rtLinux.workspaceEndpoint('watch', { sessionId: 'b1', dirs: ['src', '.git'] })
  assert.equal(wLinux.mode, 'dirs')
  assert.equal(wLinux.recursive, false)
  assert.equal(linuxWatches.length, 2, 'watches root and expanded src only (skips ignored .git)')
  // Overflow (> 64 distinct paths) sets overflow: true in the debounced payload.
  for (let i = 0; i < 70; i += 1) linuxWatches[0].onEvent('change', `f-${i}.txt`)
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(linuxEvents.length, 1)
  assert.equal(linuxEvents[0].data.overflow, true)
  assert.equal(linuxEvents[0].data.paths.length, 64)
  await rtLinux.terminalDispose()
  assert.equal(linuxWatches.every(w => w.closed), true)

  // 2. ENOSPC falls back to bounded polling and detects file creation.
  const { rt: rtPoll, localFeedEvents: pollEvents } = createRuntime(workDir, { dshHome })
  rtPoll.watchPlatform = 'linux'
  rtPoll.workspaceWatchDebounceMs = 20
  rtPoll.workspaceWatchPollMs = 30
  rtPoll.watchWorkspaceDir = () => {
    const err = new Error('System limit for number of file watchers reached')
    err.code = 'ENOSPC'
    throw err
  }
  const wPoll = await rtPoll.workspaceEndpoint('watch', { sessionId: 'b1' })
  assert.equal(wPoll.mode, 'poll')
  writeFileSync(join(workDir, 'created-by-poll.txt'), 'hello')
  await new Promise(resolve => setTimeout(resolve, 110))
  assert.equal(pollEvents.some(e => e.event === 'workspace-changed'), true, 'polling fallback emits workspace-changed')
  await rtPoll.terminalDispose()

  // 3. Orphan grace cleanup closes watches once local SSE client count drops to 0.
  const orphanWatchers = []
  let localClients = 1
  const clientListeners = new Set()
  const { rt: rtOrphan } = createRuntime(workDir, {
    dshHome,
    extraRt: {
      workspaceWatchOrphanGraceMs: 30,
      localFeedClientCount: () => localClients,
      onLocalFeedClients: (fn) => { clientListeners.add(fn); return () => clientListeners.delete(fn) },
    },
  })
  rtOrphan.watchWorkspaceDir = (dir, opts, onEvent) => {
    const w = { dir, opts, onEvent, closed: false, close() { this.closed = true } }
    orphanWatchers.push(w)
    return w
  }
  await rtOrphan.workspaceEndpoint('watch', { sessionId: 'b1' })
  assert.equal(orphanWatchers.length, 1)
  assert.equal(orphanWatchers[0].closed, false)
  localClients = 0
  for (const fn of clientListeners) fn(0)
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(orphanWatchers[0].closed, true, 'orphaned watches close after grace period when no local SSE clients remain')
  await rtOrphan.terminalDispose()

  // 4. Mid-await terminalDispose leaks zero watchers even if resolveWorkspaceRoot is slow.
  const raceWatchers = []
  const { rt: rtRace } = createRuntime(workDir, { dshHome })
  const origReal = rtRace.real
  let releaseReal
  rtRace.real = async (p) => {
    await new Promise((resolve) => { releaseReal = resolve })
    return origReal(p)
  }
  rtRace.watchWorkspaceDir = (dir, opts, onEvent) => {
    const w = { dir, opts, onEvent, closed: false, close() { this.closed = true } }
    raceWatchers.push(w)
    return w
  }
  const watchPending = rtRace.workspaceEndpoint('watch', { sessionId: 'b1' })
  await new Promise(resolve => setTimeout(resolve, 10))
  const disposePending = rtRace.terminalDispose()
  releaseReal()
  await assert.rejects(() => watchPending, { code: 'bot/refused' })
  await disposePending
  assert.equal(raceWatchers.length, 0, 'disposed runtime must never create late OS watchers')
  // 5. Linux per-dir transient errors (ENOENT/EACCES) skip that subdir without downgrading healthy watchers to poll.
  mkdirSync(join(workDir, 'good'), { recursive: true })
  mkdirSync(join(workDir, 'unreadable'), { recursive: true })
  const partialWatchers = []
  const { rt: rtPartial } = createRuntime(workDir, { dshHome })
  rtPartial.watchPlatform = 'linux'
  rtPartial.watchWorkspaceDir = (dir, opts, onEvent) => {
    if (dir.endsWith('unreadable')) {
      const err = new Error('permission denied')
      err.code = 'EACCES'
      throw err
    }
    const w = { dir, opts, onEvent, closed: false, close() { this.closed = true } }
    partialWatchers.push(w)
    return w
  }
  const wPartial = await rtPartial.workspaceEndpoint('watch', { sessionId: 'b1', dirs: ['unreadable', 'good'] })
  assert.equal(wPartial.mode, 'dirs', 'single subdir EACCES must keep healthy Linux dir watchers instead of downgrading to poll')
  assert.equal(partialWatchers.length, 2, 'root + healthy subdir watchers stay active')
  assert.equal(partialWatchers.every(w => !w.closed), true)
  await rtPartial.terminalDispose()
  assert.equal(partialWatchers.every(w => w.closed), true)

  // 6. Existing-session reuse checks disposed/closed state after awaiting syncDirsForRoot.
  const { rt: rtReuse } = createRuntime(workDir, { dshHome })
  rtReuse.watchPlatform = 'linux'
  rtReuse.watchWorkspaceDir = (dir, opts, onEvent) => ({ dir, opts, onEvent, closed: false, close() { this.closed = true } })
  const firstReuse = await rtReuse.workspaceEndpoint('watch', { sessionId: 'b1' })
  assert.ok(firstReuse.watchId)
  const origReuseInData = rtReuse.inData
  let holdSync
  let enteredSync = false
  rtReuse.inData = async (p) => {
    if (p.endsWith('good') && !enteredSync) {
      enteredSync = true
      await new Promise((resolve) => { holdSync = resolve })
    }
    return origReuseInData(p)
  }
  const reusePending = rtReuse.workspaceEndpoint('watch', { sessionId: 'b1', watchId: firstReuse.watchId, dirs: ['good'] })
  await new Promise(resolve => setTimeout(resolve, 15))
  const reuseDispose = rtReuse.terminalDispose()
  holdSync?.()
  const reuseRes = await reusePending
  await reuseDispose
  assert.equal(reuseRes.watchId, null)
  assert.equal(reuseRes.mode, 'closed')

  // 7. Bounded poll-mode stat caps entries per directory and sets overflow: true on changes in large folders.
  const bigDir = mkdtempSync(join(tmpdir(), 'dsb-wp-pollcap-'))
  t.after(() => rmSync(bigDir, { recursive: true, force: true }))
  for (let i = 0; i < 8; i += 1) writeFileSync(join(bigDir, `item-${i}.txt`), 'v1')
  const { rt: rtCap, localFeedEvents: capEvents } = createRuntime(bigDir, { dshHome })
  rtCap.watchPlatform = 'linux'
  rtCap.workspaceWatchDebounceMs = 20
  rtCap.workspaceWatchPollMs = 30
  rtCap.workspaceWatchPollMaxEntries = 4
  rtCap.watchWorkspaceDir = () => {
    const err = new Error('inotify limit reached')
    err.code = 'ENOSPC'
    throw err
  }
  const wCap = await rtCap.workspaceEndpoint('watch', { sessionId: 'b1' })
  assert.equal(wCap.mode, 'poll')
  writeFileSync(join(bigDir, 'item-0.txt'), 'v2-changed')
  await new Promise(resolve => setTimeout(resolve, 110))
  const capEvent = capEvents.find(e => e.event === 'workspace-changed')
  assert.ok(capEvent, 'bounded poll still detects file change')
  assert.equal(capEvent.data.overflow, true, 'poll exceeding max entries marks overflow: true')
  await rtCap.terminalDispose()
})

test('buildOpenOsCommand safely formats Windows reveal/open commands, scrubs sensitive env, and openOsPath checks exit status', async (t) => {
  const prevSecret = process.env.DEEPSEEK_API_KEY
  const prevToken = process.env.DS_BOT_TEST_TOKEN
  process.env.DEEPSEEK_API_KEY = 'sk-must-not-leak'
  process.env.DS_BOT_TEST_TOKEN = 'tok-must-not-leak'
  t.after(() => {
    if (prevSecret === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevSecret
    if (prevToken === undefined) delete process.env.DS_BOT_TEST_TOKEN
    else process.env.DS_BOT_TEST_TOKEN = prevToken
  })

  const reveal = buildOpenOsCommand('C:\\Users\\Alice, Bob\\100% #1\\doc.txt', 'reveal', false, 'win32')
  assert.equal(reveal.command, 'explorer.exe')
  assert.equal(reveal.options.windowsVerbatimArguments, true)
  assert.equal(reveal.allowExit1, true)
  assert.deepEqual(reveal.args, ['/select,"C:\\Users\\Alice, Bob\\100% #1\\doc.txt"'])
  assert.equal(reveal.options.env.DEEPSEEK_API_KEY, undefined, 'sensitive env vars scrubbed from launcher')

  const openWin = buildOpenOsCommand('C:\\Users\\Alice\\100% #1 [draft]\\doc.txt', 'open', false, 'win32')
  assert.equal(openWin.command, 'powershell.exe')
  assert.equal(openWin.waitForExit, true)
  assert.equal(openWin.options.windowsHide, true)
  assert.notEqual(openWin.options.detached, true, 'powershell launcher should not set detached:true alongside windowsHide:true')
  assert.equal(openWin.options.env.DSB_OPEN_TARGET, 'C:\\Users\\Alice\\100% #1 [draft]\\doc.txt')
  assert.equal(openWin.options.env.DEEPSEEK_API_KEY, undefined)
  assert.equal(openWin.options.env.DS_BOT_TEST_TOKEN, undefined)
  assert.ok(openWin.args.includes('-NoProfile') && openWin.args.includes('-NonInteractive'))
  const openWinCmd = openWin.args[openWin.args.indexOf('-Command') + 1]
  assert.ok(openWinCmd.includes('Test-Path -LiteralPath $p'))
  assert.ok(openWinCmd.includes('Invoke-Item -LiteralPath $p -ErrorAction Stop'))
  assert.ok(openWinCmd.includes('[Console]::Error.WriteLine'))
  assert.ok(openWinCmd.includes('exit 1'))
  assert.equal(openWinCmd.includes('"'), false, '-Command script avoids double quotes that powershell.exe strips')
  assert.equal(openWinCmd.includes('Start-Process -LiteralPath'), false, 'must never use invalid Start-Process -LiteralPath')
  assert.notEqual(
    openWinCmd.replace('Invoke-Item -LiteralPath $p -ErrorAction Stop', 'Invoke-Item -LiteralPath $p -WhatIf -ErrorAction Stop'),
    openWinCmd,
  )
  assert.notEqual(
    openWinCmd.replace(/if \(\[string\]::IsNullOrEmpty\(\$p\)[^}]+\};\s*/, ''),
    openWinCmd,
  )

  const revealMac = buildOpenOsCommand('/tmp/a b.txt', 'reveal', false, 'darwin')
  assert.equal(revealMac.command, 'open')
  assert.deepEqual(revealMac.args, ['-R', '/tmp/a b.txt'])

  // openOsPath rejects with captured stderr on non-zero exit instead of silently resolving true on spawn.
  await assert.rejects(
    () => openOsPath('/tmp/demo.txt', 'open', false, {
      platform: 'win32',
      spawnFn: () => spawn(process.execPath, ['-e', 'process.stderr.write("cannot bind parameter\\n"); process.exit(1)'], { stdio: ['ignore', 'ignore', 'pipe'] }),
    }),
    /cannot bind parameter/,
  )

  // Exit 0 resolves cleanly.
  assert.equal(
    await openOsPath('/tmp/demo.txt', 'open', false, {
      platform: 'win32',
      spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'pipe'] }),
    }),
    true,
  )

  // Windows explorer.exe exit 1 with empty stderr resolves cleanly (known Explorer shell handoff code).
  assert.equal(
    await openOsPath('C:\\demo.txt', 'reveal', false, {
      platform: 'win32',
      spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: ['ignore', 'ignore', 'pipe'] }),
    }),
    true,
  )

  // Long-running Linux xdg-open detaches cleanly once settleMs elapses.
  let longChild = null
  t.after(() => { try { longChild?.kill() } catch { /* already exited */ } })
  assert.equal(
    await openOsPath('/tmp/demo.txt', 'open', false, {
      platform: 'linux',
      settleMs: 30,
      spawnFn: () => {
        longChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'ignore', 'pipe'] })
        return longChild
      },
    }),
    true,
  )
})

test('Windows PowerShell open command validates real cmdlet parameter binding and literal paths on win32', { skip: process.platform !== 'win32' }, async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-ps-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const weirdPath = join(workDir, '100% #1 [test], copy.txt')
  writeFileSync(weirdPath, 'hello')

  const spec = buildOpenOsCommand(weirdPath, 'open', false, 'win32')
  const cmd = spec.args[spec.args.indexOf('-Command') + 1]
  assert.ok(cmd && cmd.includes('Invoke-Item'))

  // 1. Validate PowerShell AST syntax & real Get-Command parameter binding for Test-Path and Invoke-Item.
  const verifyScript = [
    '$errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($env:DSB_CMD, [ref]$null, [ref]$errors)',
    'if ($errors.Count -gt 0) { throw ($errors | Out-String) }',
    '$invokeMeta = Get-Command Invoke-Item -ErrorAction Stop',
    "if (-not $invokeMeta.Parameters.ContainsKey('LiteralPath')) { throw 'Invoke-Item missing -LiteralPath' }",
    '$testMeta = Get-Command Test-Path -ErrorAction Stop',
    "if (-not $testMeta.Parameters.ContainsKey('LiteralPath')) { throw 'Test-Path missing -LiteralPath' }",
  ].join('; ')
  execFileSync(spec.command, ['-NoProfile', '-NonInteractive', '-Command', verifyScript], {
    env: { ...spec.options.env, DSB_CMD: cmd },
    stdio: 'pipe',
    windowsHide: true,
  })

  // 2. Run the production command structure with -WhatIf against an existing weird-char file: must exit 0.
  const whatIfCmd = cmd.replace(
    'Invoke-Item -LiteralPath $p -ErrorAction Stop',
    'Invoke-Item -LiteralPath $p -WhatIf -ErrorAction Stop',
  )
  assert.notEqual(whatIfCmd, cmd)
  const whatIfRes = spawnSync(spec.command, ['-NoProfile', '-NonInteractive', '-Command', whatIfCmd], {
    env: spec.options.env,
    windowsHide: true,
    encoding: 'utf8',
  })
  assert.equal(
    whatIfRes.status,
    0,
    `Expected -WhatIf success on existing file, got status=${whatIfRes.status} signal=${whatIfRes.signal} stderrLen=${(whatIfRes.stderr ?? '').length} stderr=${JSON.stringify(whatIfRes.stderr)} stdout=${JSON.stringify(whatIfRes.stdout)}`,
  )

  // 3. Real openOsPath against a missing file must reject with readable PowerShell stderr and non-zero exit.
  const missingPath = join(workDir, 'missing [100%] #1.txt')
  const diag = { exitCode: undefined, signal: undefined, stderrBytes: 0, stderr: '', elapsedMs: 0 }
  const startedAt = Date.now()
  let missingErr = null
  try {
    await openOsPath(missingPath, 'open', false, {
      spawnFn: (command, args, options) => {
        const child = spawn(command, args, options)
        child.stderr?.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
          diag.stderrBytes += Buffer.byteLength(text)
          diag.stderr += text
        })
        child.once('close', (code, signal) => {
          diag.exitCode = code
          diag.signal = signal
          diag.elapsedMs = Date.now() - startedAt
        })
        return child
      },
    })
  } catch (error) {
    missingErr = error
  }
  assert.ok(
    missingErr instanceof Error,
    `Expected openOsPath to reject on missing file; diagnostics: ${JSON.stringify(diag)}`,
  )
  assert.equal(
    diag.exitCode,
    1,
    `Expected exitCode=1 on missing file; diagnostics: ${JSON.stringify(diag)} error=${missingErr.message}`,
  )
  assert.match(
    missingErr.message,
    /Cannot find path|ItemNotFound|Failed to open path/i,
    `Unexpected openOsPath error; diagnostics: ${JSON.stringify(diag)} error=${missingErr.message}`,
  )
  assert.equal(
    /CLIXML|<Objs\b/i.test(missingErr.message),
    false,
    `Expected readable UI error without CLIXML; got: ${missingErr.message}`,
  )
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

  const parsed = await parseXlsxBuffer(xlsxBuf)
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

test('parseXlsxBuffer handles hostile and edge-case OOXML workbooks safely via streaming saxes parser', async () => {
  // 1. Self-closing <row/>, phonetic <rPh> stripping, empty styled cell <c r="Z1000" s="1"/>, relative ./ target, duplicate merges.
  const edgeXlsx = buildZip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="JP" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="./worksheets/sheet1.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Tokyo</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2" ht="20"/>
      <row r="3"><c r="A3" t="inlineStr"><is><t>After self-closing row</t><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></is></c><c r="Z1000" s="1"/></row>
    </sheetData><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A1:B1"/></mergeCells></worksheet>`,
  })
  const edge = await parseXlsxBuffer(edgeXlsx)
  assert.equal(edge.sheets[0].rows[0][0].v, 'Tokyo', 'phonetic <rPh> text must be stripped')
  assert.equal(edge.sheets[0].rows[2][0].v, 'After self-closing row', 'self-closing <row/> must not eat subsequent rows')
  assert.equal(edge.sheets[0].colCount, 2, 'empty styled cell Z1000 must not inflate visible columns past A1:B1 merge')
  assert.equal(edge.sheets[0].totalCols, 2, 'empty styled cell Z1000 must not inflate totalCols or trigger false truncation')
  assert.equal(edge.sheets[0].truncatedCols, false)
  assert.equal(edge.sheets[0].merges.length, 1, 'duplicate mergeCells are deduplicated')

  // 2. Many sheets (> 20) sets truncatedSheets + totalSheets.
  const manyFiles = {
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${Array.from({ length: 24 }, (_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: 24 }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  }
  for (let i = 1; i <= 24; i += 1) {
    manyFiles[`xl/worksheets/sheet${i}.xml`] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sheet ${i}</t></is></c></row></sheetData></worksheet>`
  }
  const many = await parseXlsxBuffer(buildZip(manyFiles))
  assert.equal(many.sheets.length, 20)
  assert.equal(many.totalSheets, 24)
  assert.equal(many.truncatedSheets, true)

  // 3. Repeated shared strings hitting workbook text budget sets truncatedText: true instead of unbounded JSON.
  const bigStr = 'X'.repeat(4000)
  const bombCells = []
  for (let r = 1; r <= 50; r += 1) {
    let rowXml = `<row r="${r}">`
    for (let c = 0; c < 20; c += 1) {
      const col = String.fromCharCode(65 + c)
      rowXml += `<c r="${col}${r}" t="s"><v>0</v></c>`
    }
    rowXml += '</row>'
    bombCells.push(rowXml)
  }
  const repeatXlsx = buildZip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${bigStr}</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${bombCells.join('')}</sheetData></worksheet>`,
  })
  const repeatParsed = await parseXlsxBuffer(repeatXlsx)
  assert.equal(repeatParsed.truncatedText, true, 'repeated shared strings must hit workbook text cap')
  assert.equal(repeatParsed.sheets[0].truncatedText, true)

  // 4. Deeply nested unclosed XML (50k tags) fails fast (< 100ms) instead of hanging.
  const deepXml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + '<row>'.repeat(50_000)
  const deepZip = buildZip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Bad" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': deepXml,
  })
  const t0 = performance.now()
  await assert.rejects(() => parseXlsxBuffer(deepZip), /nesting depth|XML/i)
  assert.ok(performance.now() - t0 < 200, 'deep XML nesting must abort fast')

  // 5. Malformed XML rejects explicitly via saxes strict mode.
  const malformedZip = buildZip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Bad" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"></c></row></sheetData></worksheet>`,
  })
  await assert.rejects(() => parseXlsxBuffer(malformedZip), /malformed|XML|tag/i)

  // 6. Oversized sharedStrings.xml throws explicitly rather than silently blanking every cell.
  const hugeSst = Buffer.alloc(8 * 1024, 0x20)
  hugeSst.write('<sst><si><t>A</t></si>', 0)
  hugeSst.write('</sst>', hugeSst.length - 6)
  const hugeSstZip = buildZip({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/sharedStrings.xml': hugeSst,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
  })
  await assert.rejects(() => parseXlsxBuffer(hugeSstZip, { maxEntryBytes: 4096 }), /size limit/i)

  // 7. Zip bomb whose DEFLATE payload inflates past declared uncompressed size rejects explicitly.
  const bombPayload = Buffer.alloc(64 * 1024, 0x41)
  const tampered = buildZip({
    'xl/workbook.xml': bombPayload,
    'xl/_rels/workbook.xml.rels': '<Relationships/>',
  })
  // Tamper the central directory & local header declared uncompressed size to 100 bytes.
  const cdSig = tampered.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  tampered.writeUInt32LE(100, 22)
  tampered.writeUInt32LE(100, cdSig + 24)
  await assert.rejects(() => parseXlsxBuffer(tampered), /zip entry|size|XML/i)

  // 8. Valid OOXML workbooks with alternate relationship namespace prefixes (transitional + strict) decode cleanly.
  const altPrefixZip = buildZip({
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:strict="http://purl.oclc.org/ooxml/officeDocument/relationships"
        xmlns:other="http://example.com/unrelated">
        <x:sheets>
          <x:sheet name="Q1" sheetId="1" other:id="wrong" rel:id="rId1"/>
          <x:sheet name="Strict" sheetId="2" strict:id="rId2"/>
        </x:sheets>
      </x:workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/custom-a.xml"/>
        <Relationship Id="rId2" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet" Target="worksheets/custom-b.xml"/>
      </Relationships>`,
    'xl/worksheets/custom-a.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Alt Prefix OK</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/custom-b.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Strict NS OK</t></is></c></row></sheetData></worksheet>`,
  })
  const altParsed = await parseXlsxBuffer(altPrefixZip)
  assert.equal(altParsed.sheets.length, 2)
  assert.equal(altParsed.sheets[0].name, 'Q1')
  assert.equal(altParsed.sheets[0].rows[0][0].v, 'Alt Prefix OK')
  assert.equal(altParsed.sheets[1].name, 'Strict')
  assert.equal(altParsed.sheets[1].rows[0][0].v, 'Strict NS OK')
})
