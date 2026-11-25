import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { LogFile, logNames } from '../src/logs.mjs'

const revision = process.argv[2] ?? '888302fa'
const source = execFileSync('git', ['show', `${revision}:app/src/logs.mjs`])
const { LogFile: WholeFileLog } = await import(`data:text/javascript;base64,${source.toString('base64')}`)
const warmups = 3
const runs = 21
const paths = logNames()
const cases = [
  ['256 KiB', 256 * 1024, 200, 1, 180],
  ['2 MiB', 2 * 1024 * 1024, 200, 1, 180],
  ['2 MiB', 2 * 1024 * 1024, 5000, 1, 180],
  ['2 × 2 MiB', 2 * 1024 * 1024, 5000, 2, 640],
]

function fixture(bytes, width, file) {
  const prefix = `2026-11-24T00:00:00.000Z [engine] file ${file} 中文🙂 `
  const line = prefix + 'x'.repeat(width - Buffer.byteLength(prefix) - 2) + '\r\n'
  return 'x'.repeat(bytes % width) + line.repeat(Math.floor(bytes / width))
}

function time(log, count) {
  const start = performance.now()
  log.tail(count)
  return performance.now() - start
}

function stats(samples) {
  const sorted = samples.sort((a, b) => a - b)
  return [sorted[Math.floor(runs / 2)], sorted[Math.ceil(runs * 0.9) - 1]]
}

console.log(`Baseline ${revision}; ${warmups} warmups and ${runs} runs each; Node ${process.version} on ${process.platform}/${process.arch}`)
console.log('| File size | Lines | Before median (ms) | Before p90 (ms) | After median (ms) | After p90 (ms) | Median speedup |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
for (const [size, bytes, count, files, width] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tail-bench-'))
  try {
    for (let file = 0; file < files; file += 1) {
      writeFileSync(join(dir, paths[file]), fixture(bytes, width, file))
    }
    const logs = [new WholeFileLog({ dir }), new LogFile({ dir })]
    assert.deepEqual(logs[1].tail(count), logs[0].tail(count))
    const timings = [[], []]
    for (let run = -warmups; run < runs; run += 1) {
      for (const index of run % 2 === 0 ? [0, 1] : [1, 0]) {
        const elapsed = time(logs[index], count)
        if (run >= 0) timings[index].push(elapsed)
      }
    }
    const [before, after] = timings.map(stats)
    const columns = [...before, ...after].map(value => value.toFixed(3))
    console.log(`| ${size} | ${count} | ${columns.join(' | ')} | ${(before[0] / after[0]).toFixed(1)}× |`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
