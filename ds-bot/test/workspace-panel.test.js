import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { install as installFolders } from '../src/host/folders.js'
import { install as installWorkspacePanel } from '../src/host/workspace-panel.js'

function createRuntime(rootDir, { dshHome, workspaceChanges, subprocess } = {}) {
  const feedEvents = []
  const services = new Map()
  if (workspaceChanges) services.set('workspaceChanges', workspaceChanges)
  if (subprocess) services.set('subprocess', subprocess)
  const ctx = {
    get: name => services.get(name),
    workspaceRegistry: {
      get: id => (id === 'ws-1' ? { id: 'ws-1', path: rootDir, title: 'Team' } : undefined),
      list: () => [{ id: 'ws-1', path: rootDir, title: 'Team' }],
    },
    sessions: { get: () => undefined },
  }
  const rt = {
    ctx,
    config: {},
    dshHome: dshHome ?? mkdtempSync(join(tmpdir(), 'dsb-dsh-')),
    home: join(dshHome ?? tmpdir(), 'bot'),
    state: { workspaceId: 'ws-1', bots: { b1: { id: 'b1', name: 'Chief', sessionId: 'b1' } }, rooms: {} },
    load: async () => {},
    botOf: id => (id === 'b1' ? rt.state.bots.b1 : undefined),
    roomOf: () => undefined,
    pastOwners: new Map(),
    publishFeed: (event, data) => feedEvents.push({ event, data }),
  }
  installFolders(rt)
  installWorkspacePanel(rt)
  return { rt, feedEvents }
}

test('workspace-list and workspace-read enforce containment, skip symlink escapes, and classify formats', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-work-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsb-wp-out-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  mkdirSync(join(workDir, 'src'))
  mkdirSync(join(workDir, '.git'))
  mkdirSync(join(workDir, 'node_modules'))
  writeFileSync(join(workDir, '.env'), 'SECRET=1\n')
  writeFileSync(join(workDir, 'README.md'), '# Hello\n\nWorld\n')
  writeFileSync(join(workDir, 'data.csv'), 'name,score\nAlice,95\n')
  writeFileSync(join(workDir, 'page.html'), '<h1>Safe</h1><script>alert(1)</script>')
  writeFileSync(join(workDir, 'src', 'index.js'), 'export const x = 42\n')
  writeFileSync(join(workDir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  writeFileSync(join(workDir, 'doc.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'))
  writeFileSync(join(workDir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 4]))
  writeFileSync(join(outsideDir, 'secret.txt'), 'outside-secret')
  try {
    symlinkSync(join(outsideDir, 'secret.txt'), join(workDir, 'escape-link.txt'))
  } catch { /* symlink unsupported on some Windows setups */ }

  const { rt } = createRuntime(workDir, { dshHome })

  // Default listing hides dotfiles, .git, node_modules, and escaping symlinks; folders sort first.
  const listing = await rt.workspaceEndpoint('list', { sessionId: 'b1' })
  assert.equal(listing.path, '')
  assert.equal(listing.entries[0].kind, 'dir')
  assert.equal(listing.entries[0].name, 'src')
  const names = listing.entries.map(e => e.name)
  assert.ok(names.includes('README.md'))
  assert.ok(!names.includes('.env'))
  assert.ok(!names.includes('.git'))
  assert.ok(!names.includes('node_modules'))
  assert.ok(!names.includes('escape-link.txt'), 'escaping symlink must not appear in listing')

  // includeHidden reveals .env while still excluding escaping symlinks.
  const withHidden = await rt.workspaceEndpoint('list', { sessionId: 'b1', includeHidden: true })
  assert.ok(withHidden.entries.some(e => e.name === '.env'))
  assert.ok(!withHidden.entries.some(e => e.name === 'escape-link.txt'))

  // Subdirectory listing and multi-format classification.
  const sub = await rt.workspaceEndpoint('list', { sessionId: 'b1', path: 'src' })
  assert.deepEqual(sub.entries.map(e => e.path), ['src/index.js'])

  const md = await rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'README.md' })
  assert.equal(md.kind, 'markdown')
  assert.match(md.text, /# Hello/)

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

  // Containment: ../ traversal (existing and nonexistent), outside absolute path, escaping symlink, and NUL byte are all refused.
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: '../secret.txt' }), { code: 'bot/refused' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: join(outsideDir, 'secret.txt') }), { code: 'bot/refused' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'README.md\0.txt' }), { code: 'bot/invalid' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'does-not-exist.md' }), { code: 'bot/not-found' })
  await assert.rejects(() => rt.workspaceEndpoint('read', { sessionId: 'b1', path: 'escape-link.txt' }), { code: 'bot/refused' })
})

test('workspace-changes delegates to ctx.workspaceChanges and reports bot/stale when disposed', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-chg-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-chg-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  const workspaceChanges = {
    summary: (sid, seq) => (sid === 'b1' && seq === 12 ? {
      turn: 2,
      cwd: workDir,
      total: 1,
      added: 3,
      deleted: 1,
      files: [{ path: 'src/a.js', display: 'src/a.js', added: 3, deleted: 1 }],
    } : undefined),
    diff: async (sid, seq, index) => (sid === 'b1' && seq === 12 && index === 0 ? {
      kind: 'text',
      path: 'src/a.js',
      display: 'src/a.js',
      before: true,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-const a = 1', '+const a = 2', '+export default a'] }],
    } : undefined),
  }

  const { rt } = createRuntime(workDir, { dshHome, workspaceChanges })
  const summary = await rt.workspaceEndpoint('changes', { sessionId: 'b1', seq: 12 })
  assert.equal(summary.total, 1)
  assert.equal(summary.files[0].index, 0)
  const diff = await rt.workspaceEndpoint('changes', { sessionId: 'b1', seq: 12, index: 0 })
  assert.equal(diff.kind, 'text')
  assert.equal(diff.hunks.length, 1)

  await assert.rejects(() => rt.workspaceEndpoint('changes', { sessionId: 'b1', seq: 999 }), { code: 'bot/stale' })
})

test('terminal endpoints use DSH subprocess.spawnTerminal when available and dispose cleanly', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsb-wp-term-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsb-wp-term-dsh-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  const written = []
  const resized = []
  let terminated = 0
  let resolveDone
  const output = new PassThrough()
  const subprocess = {
    spawnTerminal: async (spec) => {
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

  const { rt, feedEvents } = createRuntime(workDir, { dshHome, subprocess })
  const opened = await rt.terminalEndpoint('open', { sessionId: 'b1', cols: 100, rows: 30 })
  assert.equal(opened.pty, true)
  output.write('ready$ ')
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(feedEvents.some(e => e.event === 'terminal' && e.data.id === opened.id && e.data.chunk.includes('ready$')), true)
  await rt.terminalEndpoint('input', { id: opened.id, data: 'ls\n' })
  assert.deepEqual(written, ['ls\n'])
  await rt.terminalEndpoint('resize', { id: opened.id, cols: 120, rows: 40 })
  assert.deepEqual(resized, [[120, 40]])

  const listed = await rt.terminalEndpoint('list')
  assert.equal(listed.length, 1)
  assert.match(listed[0].snapshot, /ready\$/)

  await rt.terminalDispose()
  assert.equal(terminated, 1)
  assert.equal((await rt.terminalEndpoint('list')).length, 0)
  await assert.rejects(() => rt.terminalEndpoint('open', { sessionId: 'b1' }), { code: 'bot/refused' })
})
