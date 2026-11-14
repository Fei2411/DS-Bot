import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const dsBotDir = resolve(import.meta.dirname, '..')
const harnessResolve = pathToFileURL(join(dsBotDir, 'test', 'harness-resolve.mjs')).href

const spawnNode = (args, { env = process.env, onChild, stdio = ['ignore', 'pipe', 'pipe'] } = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(process.execPath, args, {
    cwd: dsBotDir,
    env,
    stdio,
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  if (onChild) onChild(child)
  child.on('error', rejectRun)
  child.on('close', (code, signal) => resolveRun({
    code,
    signal,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  }))
})

test('node --test --test-force-exit does not drop results before child-v8 exits', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-1550-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const testFile = join(dir, 'many.test.mjs')
  const runnerFile = join(dir, 'runner.mjs')
  const count = 500
  writeFileSync(testFile, [
    "import { test } from 'node:test'",
    'setInterval(() => {}, 1000)',
    `for (let i = 1; i <= ${count}; i++) test(\`t-\${i}-\${'a'.repeat(200)}\`, () => {})`,
    '',
  ].join('\n'))
  writeFileSync(runnerFile, [
    "import { run } from 'node:test'",
    'let passed = 0',
    'let failed = 0',
    'const stream = run({',
    `  files: [${JSON.stringify(testFile)}],`,
    '  forceExit: true,',
    '  timeout: 120000,',
    `  execArgv: ['--import', ${JSON.stringify(harnessResolve)}],`,
    '})',
    "stream.on('test:pass', (e) => { if (e.nesting === 0) passed++ })",
    "stream.on('test:fail', (e) => { if (e.nesting === 0) failed++; process.exitCode = 1 })",
    "stream.on('test:stderr', (e) => process.stderr.write(e.message))",
    "stream.on('end', () => console.log(JSON.stringify({ passed, failed })))",
    'stream.resume()',
    '',
  ].join('\n'))

  // Strip parent test runner context so each spawned runner owns its own child-v8 tree.
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT

  const runs = await Promise.all(
    Array.from({ length: 16 }, () => spawnNode([runnerFile], { env: childEnv })),
  )
  for (let i = 0; i < runs.length; i++) {
    const res = runs[i]
    assert.equal(res.code, 0, `run ${i} stderr: ${res.stderr}`)
    const { passed, failed } = JSON.parse(res.stdout.trim())
    assert.equal(failed, 0)
    assert.equal(passed, count, `run ${i} dropped ${count - passed} of ${count} test results`)
  }
})

test('child-v8 process.exit flushes large stdout and stderr write queues and keeps exit code', async () => {
  const payloadBytes = 256 * 1024
  const childEnv = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }

  const script = `
    setInterval(() => {}, 1000)
    process.stdout.write('O'.repeat(${payloadBytes}))
    process.stderr.write('E'.repeat(${payloadBytes}))
    process.exit(7)
  `
  const res = await spawnNode(['--import', harnessResolve, '--input-type=module', '-e', script], { env: childEnv })
  assert.equal(res.code, 7)
  assert.equal(res.stdout.length, payloadBytes)
  assert.equal(res.stderr.length, payloadBytes)
})

test('child-v8 process.exit preserves process.exitCode when called with no arguments and validates code', async () => {
  const childEnv = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }

  const exitCodeRes = await spawnNode(['--import', harnessResolve, '--input-type=module', '-e', `
    process.exitCode = 5
    process.stdout.write('queued-line\\n')
    process.exit()
  `], { env: childEnv })
  assert.equal(exitCodeRes.code, 5)
  assert.equal(exitCodeRes.stdout, 'queued-line\n')

  const invalidRes = await spawnNode(['--import', harnessResolve, '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    assert.throws(() => process.exit('bad'), { code: 'ERR_INVALID_ARG_TYPE' })
    assert.throws(() => process.exit(1.5), { code: 'ERR_OUT_OF_RANGE' })
    process.exit(4)
    process.exit(9)
  `], { env: childEnv })
  assert.equal(invalidRes.code, 4)
})

test('child-v8 process.exit handles broken stdout pipe without crashing on unhandled EPIPE', async () => {
  const childEnv = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }
  const res = await spawnNode(['--import', harnessResolve, '--input-type=module', '-e', `
    process.stdout.write('ready\\n')
    process.stdin.once('data', () => {
      process.stdout.write('X'.repeat(128 * 1024))
      process.stderr.write('still-flushed\\n')
      process.exit(0)
    })
  `], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    onChild: (child) => {
      child.stdout.once('data', () => {
        child.stdout.destroy()
        child.stdin.end('go\n')
      })
    },
  })
  assert.equal(res.code, 0)
  assert.equal(res.stderr, 'still-flushed\n')
})

test('non-test process keeps synchronous process.exit semantics', async () => {
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT

  const res = await spawnNode(['--import', harnessResolve, '--input-type=module', '-e', `
    process.exit(0)
    process.stderr.write('must-not-run\\n')
  `], { env: childEnv })
  assert.equal(res.code, 0)
  assert.equal(res.stderr, '')
})
