import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { backfillRoomLog } from '../src/host/group-log.js'

const line = (seq, text) => ({ seq, who: 'User', text })

const runtime = (home, lines, { readOnly = false } = {}) => ({
  home,
  readOnly: () => (readOnly ? { reason: 'test' } : undefined),
  recentGroupLines: async () => lines,
  warn: () => {},
})

const fileOf = (home, room) => join(home, 'group-logs', `${room}.jsonl`)
const read = (home, room) => {
  try {
    return readFileSync(fileOf(home, room), 'utf8')
  } catch {
    return ''
  }
}

const within = async fn => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-group-log-'))
  try {
    return await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('the room log that predates the group log is copied once', async () => {
  await within(async home => {
    const rt = runtime(home, [line(1, 'one'), line(2, 'two'), line(3, 'three')])
    assert.equal(await backfillRoomLog(rt, 'r1'), 3)
    assert.deepEqual(read(home, 'r1').trim().split('\n').map(row => JSON.parse(row).seq), [1, 2, 3])
    assert.equal(await backfillRoomLog(rt, 'r1'), 0)
    assert.equal(read(home, 'r1').trim().split('\n').length, 3)
  })
})

test('a line already in the group log is not written twice', async () => {
  await within(async home => {
    mkdirSync(join(home, 'group-logs'), { recursive: true })
    writeFileSync(fileOf(home, 'r1'), `${JSON.stringify(line(1, 'one'))}\n`, 'utf8')
    const rt = runtime(home, [line(1, 'one'), line(2, 'two')])
    assert.equal(await backfillRoomLog(rt, 'r1'), 1)
    assert.deepEqual(read(home, 'r1').trim().split('\n').map(row => JSON.parse(row).seq), [1, 2])
  })
})

test('a read-only plugin writes nothing', async () => {
  await within(async home => {
    const rt = runtime(home, [line(1, 'one')], { readOnly: true })
    assert.equal(await backfillRoomLog(rt, 'r1'), 0)
    assert.equal(read(home, 'r1'), '')
  })
})

test('a group with no lines, or a room that is gone, writes nothing', async () => {
  await within(async home => {
    assert.equal(await backfillRoomLog(runtime(home, []), 'r1'), 0)
    assert.equal(await backfillRoomLog(runtime(home, [line(1, 'one')]), undefined), 0)
    assert.equal(read(home, 'r1'), '')
  })
})

test('an unreadable group log is reported, not swallowed into a partial copy', async () => {
  await within(async home => {
    const rt = runtime(home, [line(1, 'one')])
    rt.recentGroupLines = async () => {
      throw new Error('gone')
    }
    assert.equal(await backfillRoomLog(rt, 'r1'), 0)
    assert.equal(read(home, 'r1'), '')
  })
})
