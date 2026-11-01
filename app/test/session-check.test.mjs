import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { HostProcess } from '../src/host-process.mjs'
import { CHECK_PROFILE } from '../src/profile.mjs'
import { unreadableSessions } from '../src/session-check.mjs'

const named = (name, message) => Object.assign(new Error(message), { name })

describe('unreadableSessions', () => {
  test('names only the Sessions that a newer DSH wrote, and closes every handle it opens', async () => {
    const closed = []
    const failures = {
      newer: named('SessionFormatUnsupportedError', 'unknown to this harness'),
      damaged: named('SessionPersistenceCorruptionError', 'damaged frame'),
    }
    const persistence = {
      open: async (id, access) => {
        assert.equal(access, 'read')
        if (id === 'gone') throw named('SessionPersistenceNotFoundError', 'no such Session')
        return {
          read: async () => { if (failures[id]) throw failures[id] },
          close: async () => { closed.push(id) },
        }
      },
    }
    assert.deepEqual(await unreadableSessions(persistence, ['fine', 'newer', 'damaged', 'gone']), ['newer'])
    assert.deepEqual(closed, ['fine', 'newer', 'damaged'])
  })
})

// The first-run check's own Host on two Sessions in its log format: one that it reads, and
// one with a required record that it does not know.
describe('the first-run check', () => {
  let home, unreadable
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-check-'))
    const log = (id, events) => {
      const header = { type: 'session', version: 4, id, createdAt: Date.now(), isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
      const file = join(home, 'sessions', '_no-cwd', id, 'session.v4.jsonl.zstd')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.concat([header, ...events].map(row => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`)))))
    }
    log('session-known', [])
    log('session-newer', [{ type: 'future/feature', seq: 0, time: Date.now(), data: {} }])
    const list = join(home, 'check.json')
    writeFileSync(list, JSON.stringify(['session-known', 'session-newer']))
    const cwd = join(home, 'profiles', CHECK_PROFILE)
    mkdirSync(cwd, { recursive: true })
    const app = dirname(dirname(fileURLToPath(import.meta.url)))
    const check = new HostProcess({
      entry: join(app, 'src', 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, DS_BOT_CHECK: list },
      pnpm: join(app, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'), onFailure: () => {},
    }, 'darwin') // Exercise the Electron/Node-mode launch without a packaged runtime.
    try {
      ({ unreadable } = await check.start())
    } finally {
      await check.stop()
    }
  }, { timeout: 180_000 })
  after(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  test('reports the Session with a record that this DSH does not know', () => {
    assert.deepEqual(unreadable, ['session-newer'])
  })
})
