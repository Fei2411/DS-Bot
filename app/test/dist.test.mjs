import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dist, gatewayFailure } from '../scripts/dist.mjs'

// Lines from failed CI package jobs (Test runs 42574687266, 42571945674 and 42462758816).
const ELECTRON_BUILDER_504 = [
  '  • downloaded      label=electron progress=100%',
  '  ⨯ Response code 504 (Gateway Time-out)  failedTask=build stackTrace=HTTPError: Response code 504 (Gateway Time-out)',
  '    at Request._onResponseBase (/home/runner/work/DS-Bot/DS-Bot/app/node_modules/app-builder-lib/node_modules/got/dist/source/core/index.js:913:31)',
].join('\n')
const APPIMAGE_504 = '  ⨯ failed to build AppImage  error=Response code 504 (Gateway Time-out)'
const RUNTIME_504 = '  ⨯ primary runtime download: 504 https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-apple-darwin-install_only_stripped.tar.gz  failed'

test('a download answered with a gateway error counts as a failure to retry', () => {
  assert.match(gatewayFailure(ELECTRON_BUILDER_504), /^⨯ Response code 504 \(Gateway Time-out\)/u)
  assert.match(gatewayFailure(APPIMAGE_504), /failed to build AppImage/u)
  assert.match(gatewayFailure(RUNTIME_504), /^⨯ primary runtime download: 504 https:/u)
  assert.ok(gatewayFailure('  ⨯ Response code 429 (Too Many Requests)'))
})

test('a build that fails on its own is not retried', () => {
  assert.equal(gatewayFailure('  ⨯ Response code 404 (Not Found)'), undefined)
  assert.equal(gatewayFailure('  ⨯ primary runtime download: 404 https://example.invalid/a.tar.gz'), undefined)
  assert.equal(gatewayFailure('This Node runs on arm64, so npm installed arm64 native modules, and an x64 app with them would not start.'), undefined)
  // A path or a size that contains 504 is not an answer.
  assert.equal(gatewayFailure('  • building        target=zip arch=x64 file=dist-pack/DS-Bot-0.3.504-mac-x64.zip'), undefined)
})

test('only the error that ended the build counts, not an attempt retried before it', () => {
  // prepare-runtime.mjs warns for each attempt it retries, then the build ends on the last answer.
  const url = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-apple-darwin-install_only_stripped.tar.gz'
  const output = [
    `primary runtime download: attempt 1/4 failed: Error: primary runtime download: 504 ${url}; retrying in 5000 ms`,
    `primary runtime download: attempt 2/4 failed, giving up: Error: primary runtime download: 404 ${url}`,
    `  ⨯ primary runtime download: 404 ${url}  failed`,
  ].join('\n')
  assert.equal(gatewayFailure(output), undefined)
  // Retried 504s that end on a 504 still count.
  assert.match(gatewayFailure(output.replace(/404/gu, '504')), /^⨯ primary runtime download: 504 /u)
  // A warning alone, without the error that ended the build, does not.
  assert.equal(gatewayFailure(output.split('\n')[0]), undefined)
})

/**
 * A runner that plays back the given results.
 * @param {{ code: number | null, signal?: NodeJS.Signals | null, output?: string }[]} results - One per run.
 */
function playback(results) {
  const runs = []
  return {
    runs,
    runImpl: async (args) => {
      runs.push(args)
      const result = results[runs.length - 1]
      return { signal: null, output: '', ...result }
    },
  }
}

test('a gateway error runs the build again after a wait, until it succeeds', async () => {
  const { runs, runImpl } = playback([{ code: 1, output: ELECTRON_BUILDER_504 }, { code: 1, output: RUNTIME_504 }, { code: 0 }])
  const waits = []
  const lines = []
  const ended = await dist(['--publish', 'never'], { runImpl, sleepImpl: async (ms) => { waits.push(ms) }, retryDelaysMs: [10, 20, 30], log: (line) => { lines.push(line) } })
  assert.deepEqual(ended, { code: 0, signal: null })
  assert.equal(runs.length, 3)
  assert.deepEqual(runs[2], ['--publish', 'never'])
  assert.deepEqual(waits, [10, 20])
  assert.match(lines[0], /^dist: attempt 1\/4 failed on a download: ⨯ Response code 504/u)
})

test('the build stops after the last retry and keeps its exit code', async () => {
  const { runs, runImpl } = playback(Array.from({ length: 3 }, () => ({ code: 7, output: APPIMAGE_504 })))
  const lines = []
  const ended = await dist([], { runImpl, sleepImpl: async () => {}, retryDelaysMs: [1, 1], log: (line) => { lines.push(line) } })
  assert.deepEqual(ended, { code: 7, signal: null })
  assert.equal(runs.length, 3)
  assert.match(lines.at(-1), /^dist: attempt 3\/3 failed on a download, giving up:/u)
})

test('a build that fails on its own or is stopped ends at once', async () => {
  for (const result of [{ code: 1, output: '  ⨯ Cannot find module' }, { code: null, signal: 'SIGINT', output: ELECTRON_BUILDER_504 }]) {
    const { runs, runImpl } = playback([result])
    const ended = await dist([], { runImpl, sleepImpl: async () => { assert.fail('no wait') }, log: () => {} })
    assert.equal(runs.length, 1)
    assert.equal(ended.code, result.code)
  }
})

test('npm run dist goes through the retrying script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts.dist, 'node scripts/dist.mjs')
})
