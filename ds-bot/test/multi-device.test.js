import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createCodeStore, hashToken, newToken, tokenMatches } from '../src/host/multi-device/pairing.js'
import { checkCommand } from '../src/host/multi-device/policy.js'
import { createRegistry, nodeName } from '../src/host/multi-device/registry.js'
import { createHub } from '../src/host/multi-device/hub.js'
import { createWorker } from '../src/host/multi-device/worker.js'
import { deviceTools } from '../src/host/multi-device/tools.js'
import { fakeContext } from './fake-ctx.js'

const folder = name => mkdtempSync(join(tmpdir(), `dsb-lan-${name}-`))

async function until(check, { timeout = 8000, step = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error(`${what} did not happen within ${timeout} ms`)
}

async function bench(t, { name = 'test-node' } = {}) {
  const hub = createHub({ dataDir: folder('hub'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const { code } = hub.issueCode()
  const worker = createWorker({
    hubUrl: hub.url,
    dataDir: folder('worker'),
    name,
    code,
    log: () => {},
    reconnectMs: 50,
    maxReconnectMs: 200,
    heartbeatMs: 1000,
  })
  t.after(() => worker.stop())
  await worker.start()
  await worker.connected({ timeoutMs: 5000 })
  await until(() => hub.isOnline(worker.nodeId), { what: 'the node to come online' })
  return { hub, worker }
}

async function pairDevice(hub, { code, name = 'win-pc', hostname: machine = 'WIN-PC' } = {}) {
  const response = await fetch(`${hub.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device: { name, os: 'win32', arch: 'x64', hostname: machine, agentVersion: 'test' } }),
  })
  return { status: response.status, body: await response.json() }
}

test('a pairing code pairs one device and then is gone', () => {
  let at = 1_000
  const codes = createCodeStore({ now: () => at, code: () => '123456' })
  const issued = codes.issue()
  assert.equal(issued.code, '123456')
  assert.equal(codes.redeem('123456'), true)
  assert.equal(codes.redeem('123456'), false)
  assert.equal(codes.redeem(undefined), false)
})

test('a pairing code expires', () => {
  let at = 1_000
  const codes = createCodeStore({ now: () => at, ttlMs: 1_000, code: () => '654321' })
  codes.issue()
  at += 1_001
  assert.equal(codes.redeem('654321'), false)
})

test('the registry stores only a hash of the device token', () => {
  const registry = createRegistry({ dataDir: folder('registry'), log: () => {} })
  const token = newToken()
  const node = registry.add({ name: 'Windows PC', token, os: 'win32', hostname: 'WIN-PC' })
  assert.equal(node.name, 'windows-pc')
  assert.equal(node.tokenHash, hashToken(token))
  assert.equal(tokenMatches(token, node.tokenHash), true)
  assert.equal(tokenMatches(`${token}x`, node.tokenHash), false)
  const saved = readFileSync(registry.file, 'utf8')
  assert.equal(saved.includes(token), false)
  assert.equal(registry.findByToken(token)?.id, node.id)
  assert.equal(registry.find('Windows PC')?.id, node.id)
  assert.equal(nodeName('***'), 'device')
})

test('pairing refuses a code the hub did not issue', async t => {
  const hub = createHub({ dataDir: folder('hub-bad-code'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const { status, body } = await pairDevice(hub, { code: '000000' })
  assert.equal(status, 403)
  assert.match(body.error, /invalid|expired/)
  assert.deepEqual(hub.nodes(), [])
})

test('pairing registers the node and the code cannot be used twice', async t => {
  const hub = createHub({ dataDir: folder('hub-pair'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const { code } = hub.issueCode()
  const first = await pairDevice(hub, { code })
  assert.equal(first.status, 200)
  assert.equal(first.body.nodeName, 'win-pc')
  assert.equal(typeof first.body.token, 'string')
  assert.equal(hub.nodes().length, 1)
  assert.equal(hub.nodes()[0].online, false)
  const second = await pairDevice(hub, { code })
  assert.equal(second.status, 403)
  assert.equal(hub.nodes().length, 1)
})

test('an unpaired device is refused on every endpoint that needs a device', async t => {
  const hub = createHub({ dataDir: folder('hub-auth'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const stream = await fetch(`${hub.url}/stream`, { headers: { authorization: 'Bearer nope' } })
  assert.equal(stream.status, 401)
  const heartbeat = await fetch(`${hub.url}/heartbeat`, { method: 'POST', headers: { authorization: 'Bearer nope' } })
  assert.equal(heartbeat.status, 401)
  const result = await fetch(`${hub.url}/result`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'tk_1', exitCode: 0 }),
  })
  assert.equal(result.status, 401)
})

test('the admin endpoints need the admin token', async t => {
  const hub = createHub({ dataDir: folder('hub-admin'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  assert.equal((await fetch(`${hub.url}/admin/nodes`)).status, 401)
  assert.equal((await fetch(`${hub.url}/admin/nodes`, { headers: { 'x-admin-token': 'wrong' } })).status, 401)
  const ok = await fetch(`${hub.url}/admin/nodes`, { headers: { 'x-admin-token': hub.adminToken } })
  assert.equal(ok.status, 200)
  assert.deepEqual((await ok.json()).nodes, [])
})

test('a task runs on the paired node and its output comes back', async t => {
  const { hub } = await bench(t)
  const task = hub.dispatch({ node: 'test-node', argv: ['echo', 'hello', 'lan'] })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.exitCode, 0)
  assert.equal(done.result.stdout, 'hello lan\n')
  assert.equal(done.result.stderr, '')
})

test('hostname runs on the node and returns that machine name', async t => {
  const { hub, worker } = await bench(t)
  const task = hub.dispatch({ node: worker.nodeId, argv: ['hostname'] })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.exitCode, 0)
  assert.notEqual(done.result.stdout.trim(), '')
  assert.equal(done.nodeName, 'test-node')
})

test('a command outside the allowlist is refused by the node', async t => {
  const { hub } = await bench(t)
  const task = hub.dispatch({ node: 'test-node', argv: ['rm', '-rf', '/'] })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'rejected')
  assert.equal(done.result.exitCode, 126)
  assert.match(done.result.stderr, /not allowed/)
})

test('an argument that would turn into a shell expression is refused', async t => {
  const { hub } = await bench(t)
  for (const argv of [['hostname', '$(id)'], ['./hostname'], ['/bin/hostname']]) {
    const task = hub.dispatch({ node: 'test-node', argv })
    const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
    assert.equal(done.state, 'rejected', `expected ${argv.join(' ')} to be refused`)
  }
})

test('echo passes text through without a shell', async t => {
  const { hub } = await bench(t)
  const task = hub.dispatch({ node: 'test-node', argv: ['echo', 'ok; rm -rf /'] })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.stdout, 'ok; rm -rf /\n')
})

test('a task waits in the queue while its node is offline and runs when it connects', async t => {
  const hub = createHub({ dataDir: folder('hub-queue'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const { code } = hub.issueCode()
  const worker = createWorker({ hubUrl: hub.url, dataDir: folder('worker-queue'), name: 'late-node', code, log: () => {}, reconnectMs: 50 })
  t.after(() => worker.stop())
  await worker.pair()
  const task = hub.dispatch({ node: 'late-node', argv: ['echo', 'queued'] })
  assert.equal(task.state, 'queued')
  assert.equal(hub.nodes()[0].online, false)
  await worker.start()
  const done = await hub.waitForTask(task.id, { timeoutMs: 8000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.stdout, 'queued\n')
})

test('a node reconnects after its stream drops and runs the next task', async t => {
  const { hub, worker } = await bench(t)
  hub.dropStream(worker.nodeId)
  await until(() => hub.isOnline(worker.nodeId), { what: 'the node to reconnect' })
  const task = hub.dispatch({ node: worker.nodeId, argv: ['echo', 'again'] })
  const done = await hub.waitForTask(task.id, { timeoutMs: 8000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.stdout, 'again\n')
})

test('tasks dispatched together run one after another', async t => {
  const { hub } = await bench(t)
  const sent = ['one', 'two', 'three'].map(word => hub.dispatch({ node: 'test-node', argv: ['echo', word] }))
  assert.equal(hub.task(sent[0].id).state, 'sent')
  assert.equal(hub.task(sent[2].id).state, 'queued')
  const done = await Promise.all(sent.map(task => hub.waitForTask(task.id, { timeoutMs: 8000 })))
  assert.deepEqual(done.map(task => task.result.stdout), ['one\n', 'two\n', 'three\n'])
})

test('a task never leaves the queue for a name that has not paired', async t => {
  const hub = createHub({ dataDir: folder('hub-nonode'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  assert.throws(() => hub.dispatch({ node: 'ghost', argv: ['echo', 'x'] }), /no paired node/)
  assert.throws(() => hub.dispatch({ node: 'ghost', argv: [] }), /no paired node|argv/)
})

test('the policy list the CLI prints names every allowed program', () => {
  assert.deepEqual(checkCommand(['echo', 'x', 'y']), { ok: true, program: 'echo', args: ['x', 'y'], builtin: true })
  assert.equal(checkCommand([]).ok, false)
  assert.equal(checkCommand(['echo', 'a'.repeat(201)]).ok, false)
  assert.equal(checkCommand(['uname', '-a']).ok, true)
  assert.equal(checkCommand(['whoami', '-x']).ok, false)
})

const tool = (tools, name) => tools.find(entry => entry.name === name)

test('the Bot tools list a machine, run a command there and read the task', async t => {
  const { hub } = await bench(t)
  const tools = deviceTools({ hub, sharedOrigin: () => 'http://127.0.0.1:3080' })

  const listed = await tool(tools, 'list_devices').execute({}, {})
  assert.match(listed, /1 paired machine, 1 online/)
  assert.match(listed, /test-node \(online\)/)
  assert.match(listed, /hostname, whoami, uname, echo/)
  assert.match(listed, /http:\/\/127\.0\.0\.1:3080/)

  const run = await tool(tools, 'run_on_device').execute({ node: 'test-node', argv: ['echo', 'from the tool'] }, {})
  assert.match(run, /^\[test-node\] echo from the tool — done, exit 0/)
  assert.match(run, /from the tool/)

  const task = hub.dispatch({ node: 'test-node', argv: ['echo', 'later'] })
  await hub.waitForTask(task.id, { timeoutMs: 5000 })
  const read = await tool(tools, 'device_task').execute({ task_id: task.id }, {})
  assert.match(read, /later/)
  assert.match(await tool(tools, 'device_task').execute({ task_id: 'tk_missing' }, {}), /No task/)
})

test('the Bot tools refuse an offline machine and a command outside the allowlist', async t => {
  const { hub } = await bench(t)
  const tools = deviceTools({ hub })
  assert.match(await tool(tools, 'run_on_device').execute({ node: 'ghost', argv: ['echo', 'x'] }, {}), /No machine named ghost/)
  assert.match(
    await tool(tools, 'run_on_device').execute({ node: 'test-node', argv: ['rm', '-rf', '/'] }, {}),
    /Not run: program is not allowed: rm/,
  )

  const lonely = createHub({ dataDir: folder('hub-offline'), host: '127.0.0.1', port: 0, log: () => {} })
  await lonely.start()
  t.after(() => lonely.stop())
  const { code } = lonely.issueCode()
  await pairDevice(lonely, { code, name: 'far-pc' })
  const offline = deviceTools({ hub: lonely })
  const listed = await tool(offline, 'list_devices').execute({}, {})
  assert.match(listed, /far-pc \(offline\)/)
  assert.match(
    await tool(offline, 'run_on_device').execute({ node: 'far-pc', argv: ['echo', 'x'] }, {}),
    /far-pc is offline .* did not run/,
  )
})

test('the Bot tools say so when the hub did not start', async t => {
  const blocker = createServer(() => {})
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => blocker.close(resolve)))
  const port = blocker.address().port
  const hub = createHub({ dataDir: folder('hub-busy'), host: '127.0.0.1', port, log: () => {} })
  t.after(() => hub.stop())
  const ready = hub.start().then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))
  const tools = deviceTools({ hub, ready })
  assert.match(await tool(tools, 'list_devices').execute({}, {}), /The LAN hub is not running on this machine/)
})

test('the plugin starts the hub and serves the device tools to the team', async t => {
  const ctx = fakeContext()
  const rt = createRuntime(ctx, {
    home: folder('plugin-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('plugin-data'), name: 'office-mac' },
  })
  t.after(async () => {
    await rt.multiDeviceHub.stop()
    await ctx.dispose()
  })
  const started = await rt.multiDeviceReady
  assert.equal(started.ok, true)
  const names = rt.teamTools.map(entry => entry.name)
  for (const name of ['list_devices', 'run_on_device', 'device_task', 'device_pairing_code']) assert.ok(names.includes(name), name)
  assert.match(rt.multiDeviceHub.url, /^http:\/\/127\.0\.0\.1:\d+$/)

  const worker = createWorker({
    hubUrl: rt.multiDeviceHub.url,
    dataDir: folder('plugin-worker'),
    name: 'win-pc',
    code: rt.multiDeviceHub.issueCode().code,
    log: () => {},
    reconnectMs: 50,
    maxReconnectMs: 200,
  })
  t.after(() => worker.stop())
  await worker.start()
  await worker.connected({ timeoutMs: 5000 })
  await until(() => rt.multiDeviceHub.isOnline(worker.nodeId), { what: 'the plugin hub to see the node' })

  const run = await tool(rt.teamTools, 'run_on_device').execute({ node: 'win-pc', argv: ['echo', 'hello from the tool'] }, {})
  assert.match(run, /hello from the tool/)
  const pairing = await tool(rt.teamTools, 'device_pairing_code').execute({}, {})
  assert.match(pairing, /npm run lan:worker -- --hub http:\/\/127\.0\.0\.1:\d+ --code \d{6}/)

  // The default profile keeps the hub off: no listener, no tools.
  const plainCtx = fakeContext()
  const plain = createRuntime(plainCtx, { home: folder('plain-home') })
  t.after(() => plainCtx.dispose())
  assert.equal(plain.multiDeviceEnabled, false)
  assert.equal(plain.teamTools.some(entry => entry.name === 'list_devices'), false)
})
