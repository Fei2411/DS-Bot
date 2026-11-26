import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uploadReleaseAssets } from '../scripts/release-upload.mjs'

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

test('uploadReleaseAssets fails with file detail after exhausting retries', async () => {
  await assert.rejects(
    () => uploadReleaseAssets('v0.3.11', ['bad.zip'], {
      concurrency: 1,
      retryDelaysMs: [10],
      log: () => {},
      sleepImpl: async () => {},
      runImpl: async () => ({ code: 1, signal: null, stderr: 'HTTP 504' }),
    }),
    /failed bad\.zip after 2 attempts \(exit 1: HTTP 504\)/u,
  )
})
