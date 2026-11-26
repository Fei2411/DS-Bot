import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { uploadReleaseAssets } from '../scripts/release-upload.mjs'

const script = fileURLToPath(new URL('../scripts/release-upload.mjs', import.meta.url))

test('uploadReleaseAssets uploads files concurrently up to the configured limit', async () => {
  let active = 0
  let peak = 0
  const uploaded = []
  await uploadReleaseAssets('v0.3.11', ['a.exe', 'b.zip', 'c.zip', 'd.deb', 'e.apk', 'f.yml'], {
    concurrency: 3,
    retryDelaysMs: [],
    log: () => {},
    runImpl: async (tag, file) => {
      assert.equal(tag, 'v0.3.11')
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
      uploaded.push(file)
      return { code: 0, signal: null, stderr: '' }
    },
  })
  assert.equal(peak, 3)
  assert.deepEqual(uploaded.sort(), ['a.exe', 'b.zip', 'c.zip', 'd.deb', 'e.apk', 'f.yml'])
})

test('uploadReleaseAssets rejects invalid concurrency', async () => {
  for (const bad of [0, -1, Number.NaN, 1.5]) {
    await assert.rejects(
      () => uploadReleaseAssets('v0.3.11', ['a.exe'], { concurrency: bad, runImpl: async () => ({ code: 0, signal: null, stderr: '' }) }),
      /positive integer/u,
    )
  }
})

test('uploadReleaseAssets retries transient upload errors and succeeds', async () => {
  const attempts = new Map()
  const delays = []
  await uploadReleaseAssets('v0.3.11', ['a.exe', 'b.zip'], {
    concurrency: 2,
    retryDelaysMs: [100, 200],
    log: () => {},
    sleepImpl: async (ms) => { delays.push(ms) },
    runImpl: async (_tag, file) => {
      const count = (attempts.get(file) ?? 0) + 1
      attempts.set(file, count)
      if (file === 'b.zip' && count === 1) return { code: 1, signal: null, stderr: 'HTTP 502' }
      return { code: 0, signal: null, stderr: '' }
    },
  })
  assert.equal(attempts.get('a.exe'), 1)
  assert.equal(attempts.get('b.zip'), 2)
  assert.deepEqual(delays, [100])
})

test('uploadReleaseAssets does not retry when a child is terminated by signal', async () => {
  let calls = 0
  await assert.rejects(
    () => uploadReleaseAssets('v0.3.11', ['killed.zip'], {
      concurrency: 1,
      retryDelaysMs: [100, 200],
      log: () => {},
      sleepImpl: async () => { throw new Error('must not sleep after signal') },
      runImpl: async () => {
        calls += 1
        return { code: null, signal: 'SIGTERM', stderr: '' }
      },
    }),
    /terminated \(signal SIGTERM\)/u,
  )
  assert.equal(calls, 1)
})

test('uploadReleaseAssets aborts sibling retry sleeps when another worker fails', async () => {
  let aborted = false
  const started = Date.now()
  await assert.rejects(
    () => uploadReleaseAssets('v0.3.11', ['fatal.zip', 'retryable.zip', 'never.zip'], {
      concurrency: 2,
      retryDelaysMs: [30_000],
      log: () => {},
      runImpl: async (_tag, file) => {
        if (file === 'fatal.zip') return { code: null, signal: 'SIGKILL', stderr: '' }
        return { code: 1, signal: null, stderr: 'HTTP 502' }
      },
      sleepImpl: (ms, signal) => new Promise((done) => {
        if (signal.aborted) { aborted = true; done(); return }
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); done() }, { once: true })
      }),
    }),
    /fatal\.zip terminated/u,
  )
  assert.equal(aborted, true)
  assert.ok(Date.now() - started < 5_000, 'should abort sibling retry sleep immediately')
})

test('uploadReleaseAssets fails with file detail after exhausting retries', async () => {
  await assert.rejects(
    () => uploadReleaseAssets('v0.3.11', ['bad.zip'], {
      concurrency: 1,
      retryDelaysMs: [10],
      log: () => {},
      sleepImpl: async () => {},
      runImpl: async () => ({ code: 1, signal: null, stderr: 'HTTP 504' }),
    }),
    /failed bad\.zip after 2\/2 attempts \(exit 1: HTTP 504\)/u,
  )
})

test('CLI validates arguments and invokes gh release upload --clobber for each file', { skip: process.platform === 'win32' }, (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-release-upload-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })

  const missingArgs = spawnSync(process.execPath, [script, 'v0.3.11'], { encoding: 'utf8' })
  assert.equal(missingArgs.status, 2)

  const badConcurrency = spawnSync(process.execPath, [script, 'v0.3.11', 'a.zip'], {
    encoding: 'utf8',
    env: { ...process.env, DS_BOT_UPLOAD_CONCURRENCY: '0' },
  })
  assert.equal(badConcurrency.status, 2)

  const logFile = join(work, 'gh.log')
  const binDir = join(work, 'bin')
  const fakeGh = join(binDir, 'gh')
  const fileA = join(work, 'DS-Bot-0.3.11-win-x64.exe')
  const fileB = join(work, 'DS-Bot-0.3.11-android.apk')
  writeFileSync(fileA, 'win')
  writeFileSync(fileB, 'apk')
  spawnSync('mkdir', ['-p', binDir])
  writeFileSync(fakeGh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexit 0\n`)
  chmodSync(fakeGh, 0o755)

  const ok = spawnSync(process.execPath, [script, 'v0.3.11', fileA, fileB], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`, DS_BOT_UPLOAD_CONCURRENCY: '2' },
  })
  assert.equal(ok.status, 0, ok.stderr)
  const calls = readFileSync(logFile, 'utf8').trim().split('\n').sort()
  assert.deepEqual(calls, [
    `release upload v0.3.11 ${fileA} --clobber`,
    `release upload v0.3.11 ${fileB} --clobber`,
  ].sort())
})
