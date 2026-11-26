import assert from 'node:assert/strict'
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { captureStdio, LogFile, logNames, redactor, rotate, shouldRotate, splitLines, tailLines } from '../src/logs.mjs'

const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-logs-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
  return dir
}
const at = () => new Date('2026-10-28T08:00:00.000Z')

// The CI user of the onboarding acceptance has a space and Chinese in its name.
const windows = redactor({ home: 'C:\\Users\\测试 用户', platform: 'win32' })

// The whole-file tail from 888302fa, independent of the bounded reader and tailLines.
function wholeFileTail(dir, count) {
  if (count <= 0) return []
  const chunks = []
  let total = 0
  for (const name of ['main.log', 'main.1.log', 'main.2.log']) {
    let text
    try { text = readFileSync(join(dir, name), 'utf8') } catch { break }
    const lines = text.split(/\r?\n/u)
    if (lines.at(-1) === '') lines.pop()
    const tail = lines.slice(-(count - total))
    chunks.push(tail)
    total += tail.length
    if (total >= count) break
  }
  return chunks.reverse().flat().slice(-count).map(windows)
}

test('the launch token, API keys and the sign-in callback do not reach the log', () => {
  assert.equal(windows('GET http://127.0.0.1:52817/?token=Zm9v.YmFy&x=1'), 'GET http://127.0.0.1:52817/?token=<hidden>&x=1')
  assert.equal(windows('access_token=abc refresh_Token=def'), 'access_token=<hidden> refresh_Token=<hidden>')
  // The mock model's keys and the three DeepSeek-shaped ones of the acceptance.
  for (const key of ['sk-test-ok', 'sk-test-bad', 'sk-test-empty', `sk-${'0123456789abcdef'.repeat(2).slice(0, 28)}0001`, `sk-${'a'.repeat(28)}0401`, `sk-${'b'.repeat(28)}0000`]) {
    assert.equal(windows(`key "${key}" saved`), 'key "sk-<hidden>" saved')
  }
  assert.equal(windows('GET /oauth/callback?code=abc&state=def 302'), 'GET /oauth/callback?<hidden> 302')
  assert.equal(windows('Authorization: Bearer eyJh.eyJz.c2ln'), 'Authorization: Bearer <hidden>')
})

test('the home folder becomes %USERPROFILE% in every spelling', () => {
  assert.equal(windows('data C:\\Users\\测试 用户\\.ds-bot'), 'data %USERPROFILE%\\.ds-bot')
  assert.equal(windows('url file:///c:/users/测试 用户/DS Bot'), 'url file:///%USERPROFILE%/DS Bot')
  assert.equal(windows('{"dataDir":"C:\\\\Users\\\\测试 用户\\\\.ds-bot"}'), '{"dataDir":"%USERPROFILE%\\\\.ds-bot"}')
  assert.equal(windows('cwd C:\\Users\\测试 用户'), 'cwd %USERPROFILE%')
  // Another user whose name starts the same way is not this one.
  assert.equal(windows('C:\\Users\\测试 用户2\\x'), 'C:\\Users\\测试 用户2\\x')
  const posix = redactor({ home: '/home/Alice', platform: 'linux' })
  assert.equal(posix('/home/Alice/.ds-bot and file:///home/Alice'), '~/.ds-bot and file://~')
  assert.equal(posix('/home/Alicey/x /HOME/Alice'), '/home/Alicey/x /HOME/Alice')
  assert.equal(redactor({ home: '/', platform: 'linux' })('/usr/bin'), '/usr/bin')
})

test('redaction keeps ordinary words and can run twice', () => {
  assert.equal(windows('desk-top task-runner risk-free'), 'desk-top task-runner risk-free')
  const line = 'GET /oauth/callback?code=1 ?token=2 sk-test-ok Bearer x C:\\Users\\测试 用户\\a'
  assert.equal(windows(windows(line)), windows(line))
})

test('output splits into whole lines; the rest waits', () => {
  assert.deepEqual(splitLines('', 'one\r\ntwo\nthr'), { lines: ['one', 'two'], rest: 'thr' })
  assert.deepEqual(splitLines('thr', 'ee\n'), { lines: ['three'], rest: '' })
  const long = 'x'.repeat(9000)
  assert.deepEqual(splitLines('', long), { lines: [long], rest: '' })
  assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c'])
})

test('a write that would pass 2 MB goes into a fresh file, three files at most', (t) => {
  assert.equal(shouldRotate(0, 5 * 1024 * 1024), false)
  assert.equal(shouldRotate(2 * 1024 * 1024 - 10, 10), false)
  assert.equal(shouldRotate(2 * 1024 * 1024 - 10, 11), true)
  assert.deepEqual(logNames(), ['main.log', 'main.1.log', 'main.2.log'])
  const dir = folder(t)
  writeFileSync(join(dir, 'main.log'), 'newest\n')
  writeFileSync(join(dir, 'main.1.log'), 'older\n')
  writeFileSync(join(dir, 'main.2.log'), 'oldest\n')
  rotate(dir)
  assert.deepEqual(readdirSync(dir).sort(), ['main.1.log', 'main.2.log'])
  assert.equal(readFileSync(join(dir, 'main.1.log'), 'utf8'), 'newest\n')
  assert.equal(readFileSync(join(dir, 'main.2.log'), 'utf8'), 'older\n')
})

test('the log rotates by size and its tail reads across the files', (t) => {
  const dir = folder(t)
  const log = new LogFile({ dir, limit: 400, redact: windows, now: at })
  for (let index = 0; index < 40; index += 1) log.write('main', `line ${String(index)} C:\\Users\\测试 用户\n`)
  log.write('engine', 'partial')
  log.close()
  assert.deepEqual(readdirSync(dir).sort(), ['main.1.log', 'main.2.log', 'main.log'])
  for (const name of logNames()) assert.ok(readFileSync(join(dir, name)).length <= 400, name)
  const last = readFileSync(join(dir, 'main.log'), 'utf8').trim().split('\n').at(-1)
  assert.equal(last, '2026-10-28T08:00:00.000Z [engine] partial')
  const tail = log.tail(12)
  assert.equal(tail.length, 12)
  assert.equal(tail.at(-2), '2026-10-28T08:00:00.000Z [main] line 39 %USERPROFILE%')
  assert.ok(tail.every(line => !line.includes('测试')))
})

test('the backward tail matches whole-file reads across UTF-8, CRLF and rotations', (t) => {
  const dir = folder(t)
  const log = new LogFile({ dir, redact: windows })
  const names = ['main.log', 'main.1.log', 'main.2.log']
  const block = 16 * 1024
  // The final read starts inside the emoji in the first line, and at LF in the second.
  const cases = [
    [`before\n文🙂${'a'.repeat(block - 6)}\nend`, 'old\r\n', 'oldest'],
    [`before\r\n${'文'.repeat(block - 1)}\r\n${'b'.repeat(block - 1)}`, '', 'old\n'],
    ['\n\r\n', 'older without LF', 'oldest\n'],
    ['', 'older without LF', 'oldest\n'],
    ['new without LF', undefined, 'unreachable\n'],
    [undefined, 'unreachable\n'],
    ['', Buffer.from([0xf0, 0x9f, 0x0a, 0x80]), 'old\n'],
  ]
  let seed = 91
  const next = max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 8) % max
  }
  const bodies = ['', '中🙂', 'x\ry', 'token=mock', 'é', 'C:\\Users\\测试 用户\\file']
  const endings = ['\n', '\r\n', '']
  for (let index = 0; index < 40; index += 1) {
    cases.push(names.map(() => Array.from({ length: next(35) }, () =>
      bodies[next(bodies.length)].repeat(next(80)) + endings[next(endings.length)]).join('')))
  }
  for (const [index, files] of cases.entries()) {
    for (const [file, name] of names.entries()) {
      const path = join(dir, name)
      if (files[file] === undefined) rmSync(path, { force: true })
      else writeFileSync(path, files[file])
    }
    for (const count of [0, 1, 2, 5, 20, 200]) {
      assert.deepEqual(log.tail(count), wholeFileTail(dir, count), `fixture ${index}, count ${count}`)
    }
  }
})

test('the tail reads only a suffix of a large rotation, even on short reads', (t) => {
  const dir = folder(t)
  const newest = join(dir, 'main.log')
  const rotation = join(dir, 'main.1.log')
  writeFileSync(newest, 'newest\n')
  writeFileSync(rotation, 'old padding\n'.repeat(160000) + '文🙂\r\nolder\n')
  writeFileSync(join(dir, 'main.2.log'), 'unneeded\n')

  const open = t.mock.method(fs, 'openSync')
  const readFile = t.mock.method(fs, 'readFileSync')
  const read = fs.readSync
  const reads = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    read(fd, buffer, offset, Math.min(length, 1024), position))
  syncBuiltinESMExports()
  t.after(() => {
    for (const spy of [open, readFile, reads]) spy.mock.restore()
    syncBuiltinESMExports()
  })

  assert.deepEqual(new LogFile({ dir }).tail(3), ['文🙂', 'older', 'newest'])
  assert.equal(readFile.mock.callCount(), 0)
  assert.deepEqual(open.mock.calls.map(call => call.arguments[0]), [newest, rotation])
  const bytes = reads.mock.calls.map(call => call.result).reduce((sum, size) => sum + size, 0)
  assert.ok(bytes > 0 && bytes <= 32 * 1024, `read ${bytes} bytes`)
  const offsets = reads.mock.calls.map(call => call.arguments[4])
  assert.ok(offsets.slice(1).every(position => position >= 1800000))
})

test('a concurrent truncate retries the newest log once and still reads the rotations', async (t) => {
  const retained = 'retained\n'
  const cases = [
    ['reads the new tail after one truncate', [retained.length], ['oldest', 'older', 'retained']],
    ['uses the rotations after a second truncate', [32 * 1024, 0], ['oldest', 'older']],
  ]
  for (const [name, sizes, expected] of cases) {
    await t.test(name, (t) => {
      const dir = folder(t)
      const newest = join(dir, 'main.log')
      writeFileSync(newest, retained + 'x'.repeat(64 * 1024))
      writeFileSync(join(dir, 'main.1.log'), 'older\n')
      writeFileSync(join(dir, 'main.2.log'), 'oldest\n')

      let newestFd
      let readingNewest = false
      let attempts = 0
      const open = fs.openSync
      const opens = t.mock.method(fs, 'openSync', (path, flags, ...args) => {
        const fd = open(path, flags, ...args)
        if (flags === 'r') {
          readingNewest = path === newest
          if (readingNewest) newestFd = fd
        }
        return fd
      })
      const stat = fs.fstatSync
      const stats = t.mock.method(fs, 'fstatSync', (fd) => {
        const snapshot = stat(fd)
        if (readingNewest) {
          const size = sizes[attempts++]
          if (size !== undefined) fs.truncateSync(newest, size)
        }
        return snapshot
      })
      syncBuiltinESMExports()
      t.after(() => {
        for (const spy of [opens, stats]) spy.mock.restore()
        syncBuiltinESMExports()
      })

      assert.deepEqual(new LogFile({ dir }).tail(3), expected)
      assert.equal(attempts, 2)
      assert.throws(() => stat(newestFd), { code: 'EBADF' })
    })
  }
})

test('the lines of a chunk go to disk in one write, cut where the file rotates', (t) => {
  const dir = folder(t)
  const writes = t.mock.method(fs, 'writeSync')
  syncBuiltinESMExports()
  t.after(() => { writes.mock.restore(); syncBuiltinESMExports() })
  // Each line is 44 bytes: 9 fit under 400, the tenth goes into a fresh file.
  const line = index => `2026-10-28T08:00:00.000Z [engine] line ${String(index).padStart(2, '0')}\n`
  const log = new LogFile({ dir, limit: 400, redact: windows, now: at })
  log.write('engine', 'line 00\nline 01\nline 02\n')
  assert.equal(writes.mock.callCount(), 1)
  log.write('engine', Array.from({ length: 12 }, (_, index) => `line ${String(index + 3).padStart(2, '0')}\n`).join(''))
  assert.equal(writes.mock.callCount(), 3)
  log.close()
  assert.equal(readFileSync(join(dir, 'main.1.log'), 'utf8'), Array.from({ length: 9 }, (_, index) => line(index)).join(''))
  assert.equal(readFileSync(join(dir, 'main.log'), 'utf8'), Array.from({ length: 6 }, (_, index) => line(index + 9)).join(''))
})

test('a short write still puts every line of the chunk on disk', (t) => {
  const dir = folder(t)
  const write = fs.writeSync
  const writes = t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
    // A string write has no offset; cut it the same way as a buffer write.
    const buffer = typeof data === 'string' ? Buffer.from(data) : data
    const start = typeof data === 'string' ? 0 : offset
    return write(fd, buffer, start, Math.min(typeof data === 'string' ? buffer.length : length, 10))
  })
  syncBuiltinESMExports()
  t.after(() => { writes.mock.restore(); syncBuiltinESMExports() })
  const log = new LogFile({ dir, redact: windows, now: at })
  log.write('engine', 'line 00\nline 01\nline 02\n')
  log.close()
  const line = index => `2026-10-28T08:00:00.000Z [engine] line ${String(index).padStart(2, '0')}\n`
  assert.equal(readFileSync(join(dir, 'main.log'), 'utf8'), [0, 1, 2].map(line).join(''))
})

test('a log that cannot be written does not stop the app', (t) => {
  const dir = folder(t)
  const blocked = join(dir, 'file')
  writeFileSync(blocked, '')
  const log = new LogFile({ dir: join(blocked, 'logs'), now: at })
  log.write('main', 'lost\n')
  assert.deepEqual(log.tail(5), [])
  assert.equal(existsSync(join(blocked, 'logs')), false)
})

test('the console goes on as before and into the log', (t) => {
  const dir = folder(t)
  const log = new LogFile({ dir, redact: windows, now: at })
  const seen = []
  const stream = { write: (chunk) => { seen.push(String(chunk)); return true } }
  const raw = captureStdio(log, { stdout: stream })
  stream.write('hello sk-test-ok\n')
  stream.write(Buffer.from('bytes\n'))
  raw.stdout('only the console\n')
  log.close()
  assert.deepEqual(seen, ['hello sk-test-ok\n', 'bytes\n', 'only the console\n'])
  assert.equal(readFileSync(join(dir, 'main.log'), 'utf8'), '2026-10-28T08:00:00.000Z [main] hello sk-<hidden>\n2026-10-28T08:00:00.000Z [main] bytes\n')
})

test('a console whose reader went away fails its writes quietly (#2171)', async (t) => {
  const dir = folder(t)
  const log = new LogFile({ dir, now: at })
  t.after(() => { log.close() })
  // Like stdout on a pipe nobody reads any more: the write fails later, as an 'error' event.
  const stream = new Writable({ write: (chunk, encoding, done) => { done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) } })
  const uncaught = []
  const record = (error) => { uncaught.push(error) }
  process.on('uncaughtException', record)
  t.after(() => { process.off('uncaughtException', record) })
  captureStdio(log, { stdout: stream })
  stream.write('Checking for update\n')
  stream.write('Checking for update\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stream.destroyed, true)
  assert.deepEqual(uncaught, [])
  assert.match(readFileSync(join(dir, 'main.log'), 'utf8'), /\[main\] Checking for update\n/)
})

test('write(..., { redacted: true }) skips redundant redaction and tail(0) returns empty', (t) => {
  const dir = folder(t)
  let redactCalls = 0
  const spy = (text) => { redactCalls += 1; return windows(text) }
  const log = new LogFile({ dir, redact: spy, now: at })
  log.write('engine', 'plain line 1\nplain line 2\n', { redacted: true })
  assert.equal(redactCalls, 0, 'pre-redacted lines skip redactor during write')
  assert.equal(log.redact('GET /?token=secret'), 'GET /?token=<hidden>')
  assert.deepEqual(log.tail(0), [])
  log.close()
})
