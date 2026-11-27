// Deterministic, size-balanced sharded runner for ds-bot unit tests.
// Usage: node scripts/run-tests-shard.mjs --shard <index>/<total> [--concurrency <n>] [--timeout <ms>] [--list] [-- <extra node --test args>]
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONCURRENCY = 2
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Parse a 1-based shard specifier like "1/4".
 * @param {string} raw
 * @returns {{ index: number, total: number }}
 */
export function parseShardSpec(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Missing shard specifier; expected <index>/<total> (for example 1/4)')
  }
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/u.exec(raw)
  if (match === null) {
    throw new Error(`Invalid shard specifier "${raw}"; expected <index>/<total> (for example 1/4)`)
  }
  const index = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error(`Invalid shard total "${match[2]}"; must be a positive integer`)
  }
  if (!Number.isSafeInteger(index) || index < 1 || index > total) {
    throw new Error(`Invalid shard index "${match[1]}"; must be between 1 and ${String(total)}`)
  }
  return { index, total }
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Partition test entries into `total` deterministic, weight-balanced buckets using LPT scheduling.
 * Each entry may be a filename string or `{ file, size }`.
 * @param {Array<string | { file: string, size?: number }>} entries
 * @param {number} total
 * @returns {string[][]}
 */
export function partitionTestFiles(entries, total) {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error(`Invalid shard total ${String(total)}`)
  }
  const normalized = entries.map((entry) => {
    if (typeof entry === 'string') return { file: entry, size: 1 }
    const size = Number.isFinite(entry?.size) && entry.size >= 0 ? entry.size : 1
    return { file: String(entry.file), size }
  })
  normalized.sort((a, b) => (b.size - a.size) || compareAscii(a.file, b.file))

  const buckets = Array.from({ length: total }, () => ({ weight: 0, files: [] }))
  for (const item of normalized) {
    let best = 0
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i].weight < buckets[best].weight) best = i
    }
    buckets[best].files.push(item.file)
    buckets[best].weight += item.size
  }

  return buckets.map(bucket => bucket.files.sort(compareAscii))
}

/**
 * Select the files belonging to 1-based shard `index` of `total`.
 */
export function selectShardFiles(entries, index, total) {
  const { index: validIndex, total: validTotal } = parseShardSpec(`${String(index)}/${String(total)}`)
  return partitionTestFiles(entries, validTotal)[validIndex - 1]
}

export function discoverTopLevelTests(testDir = join(PLUGIN_ROOT, 'test')) {
  const entries = readdirSync(testDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => ({
      file: `test/${entry.name}`,
      size: statSync(join(testDir, entry.name)).size,
    }))
  entries.sort((a, b) => compareAscii(a.file, b.file))
  return entries
}

export function parseCliArgs(argv, env = process.env) {
  let shardRaw = env.TEST_SHARD || ''
  let concurrency = DEFAULT_CONCURRENCY
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let listOnly = false
  const extraArgs = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      extraArgs.push(...argv.slice(i + 1))
      break
    }
    if (arg === '--list') {
      listOnly = true
    } else if (arg === '--shard') {
      shardRaw = argv[++i] ?? ''
    } else if (arg.startsWith('--shard=')) {
      shardRaw = arg.slice('--shard='.length)
    } else if (arg === '--concurrency') {
      concurrency = Number(argv[++i])
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = Number(arg.slice('--concurrency='.length))
    } else if (arg === '--timeout') {
      timeoutMs = Number(argv[++i])
    } else if (arg.startsWith('--timeout=')) {
      timeoutMs = Number(arg.slice('--timeout='.length))
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  const { index, total } = parseShardSpec(shardRaw)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency: ${String(concurrency)}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Invalid timeout: ${String(timeoutMs)}`)
  }
  return { index, total, concurrency, timeoutMs, listOnly, extraArgs }
}

function main(argv) {
  let opts
  try {
    opts = parseCliArgs(argv)
  } catch (err) {
    console.error(`run-tests-shard: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  const allTests = discoverTopLevelTests()
  const selected = selectShardFiles(allTests, opts.index, opts.total)
  if (opts.listOnly) {
    for (const file of selected) process.stdout.write(`${file}\n`)
    return
  }

  console.error(
    `run-tests-shard: shard ${String(opts.index)}/${String(opts.total)} — running ${String(selected.length)}/${String(allTests.length)} test files (concurrency=${String(opts.concurrency)}, timeout=${String(opts.timeoutMs)}ms)`,
  )
  if (selected.length === 0) return

  const nodeArgs = [
    '--import', './test/harness-resolve.mjs',
    '--test',
    `--test-concurrency=${String(opts.concurrency)}`,
    `--test-timeout=${String(opts.timeoutMs)}`,
    '--test-force-exit',
    ...opts.extraArgs,
    ...selected,
  ]
  const res = spawnSync(process.execPath, nodeArgs, {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
  })
  if (res.error) {
    console.error(`run-tests-shard: failed to spawn node: ${res.error.message}`)
    process.exit(1)
  }
  if (res.signal) {
    console.error(`run-tests-shard: terminated by signal ${res.signal}`)
    process.exit(1)
  }
  process.exit(res.status ?? 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
