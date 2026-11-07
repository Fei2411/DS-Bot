import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import {
  LABEL, WINDOWS_TASK, daemonCommand, daemonFile, daemonFileContent, daemonStatus,
  installDaemon, uninstallDaemon,
} from '../src/host/multi-device/daemon.js'
import { createCodeStore, hashToken, newToken, tokenMatches } from '../src/host/multi-device/pairing.js'
import { checkCommand, classifyCommand } from '../src/host/multi-device/policy.js'
import { MAX_FILE_BYTES, resolveNodePath } from '../src/host/multi-device/protocol.js'
import { bestDevice, hintOs } from '../src/host/multi-device/select.js'
import { createRegistry, nodeName } from '../src/host/multi-device/registry.js'
import { createHub } from '../src/host/multi-device/hub.js'
import { createWorker } from '../src/host/multi-device/worker.js'
import { deviceTools } from '../src/host/multi-device/tools.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

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
  const workerDir = folder('worker')
  const worker = createWorker({
    hubUrl: hub.url,
    dataDir: workerDir,
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
  return { hub, worker, workerDir }
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

test('removing a node drops its token and cancels what it still owes', async t => {
  const hub = createHub({ dataDir: folder('hub-remove'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  const paired = await pairDevice(hub, { code: hub.issueCode().code, name: 'gone-pc' })
  const task = hub.dispatch({ node: paired.body.nodeId, argv: ['echo', 'x'] })
  assert.equal(hub.removeNode(paired.body.nodeId), true)
  assert.deepEqual(hub.nodes(), [])
  assert.equal(hub.removeNode('gone-pc'), false)
  assert.equal(hub.task(task.id).state, 'cancelled')
  const heartbeat = await fetch(`${hub.url}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${paired.body.token}` },
  })
  assert.equal(heartbeat.status, 401)
})

test('the admin API removes a node by name', async t => {
  const hub = createHub({ dataDir: folder('hub-admin-remove'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  t.after(() => hub.stop())
  await pairDevice(hub, { code: hub.issueCode().code, name: 'old-pc' })
  const removed = await fetch(`${hub.url}/admin/nodes/old-pc`, {
    method: 'DELETE',
    headers: { 'x-admin-token': hub.adminToken },
  })
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).nodes, [])
  assert.equal(hub.nodes().length, 0)
  const again = await fetch(`${hub.url}/admin/nodes/old-pc`, {
    method: 'DELETE',
    headers: { 'x-admin-token': hub.adminToken },
  })
  assert.equal(again.status, 404)
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

test('a risky command is refused by the node when it was not approved', async t => {
  const { hub } = await bench(t)
  const task = hub.dispatch({ node: 'test-node', argv: ['rm', '-rf', '/'] })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'rejected')
  assert.equal(done.result.exitCode, 126)
  assert.match(done.result.stderr, /approval/)
})

test('a program path and a bad argument are refused instead of taking a shortcut', async t => {
  const { hub } = await bench(t)
  for (const argv of [['./hostname'], ['/bin/hostname'], ['hostname', '$(id)']]) {
    let task
    try {
      task = hub.dispatch({ node: 'test-node', argv })
    } catch (error) {
      assert.match(error.message, /bare name|control character/, `expected ${argv.join(' ')} to be refused`)
      continue
    }
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

test('the Bot tools refuse an offline machine and a command that needs approval', async t => {
  const { hub } = await bench(t)
  const tools = deviceTools({ hub })
  assert.match(await tool(tools, 'run_on_device').execute({ node: 'ghost', argv: ['echo', 'x'] }, {}), /No machine named ghost/)
  assert.match(
    await tool(tools, 'run_on_device').execute({ node: 'test-node', argv: ['rm', '-rf', '/'] }, {}),
    /no approval card here/,
  )
  assert.match(
    await tool(tools, 'run_on_device').execute({ node: 'test-node', argv: ['/bin/hostname'] }, {}),
    /Not run: program must be a bare name/,
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
    await rt.multiDeviceHub?.stop()
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
  await plain.multiDeviceReady
  assert.equal(plain.multiDeviceEnabled, false)
  assert.equal(plain.teamTools.some(entry => entry.name === 'list_devices'), false)
  assert.equal(plain.multiDeviceStatus().available, true)
})

test('the Devices switch starts the hub and its off state survives a restart', async t => {
  const home = folder('switch-home')
  const config = { home, multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('switch-data'), name: 'switch-mac' } }
  const ctx = fakeContext()
  const rt = createRuntime(ctx, config)
  t.after(() => ctx.dispose())
  await rt.multiDeviceReady
  assert.equal(rt.multiDeviceEnabled, true)
  assert.ok(tool(rt.teamTools, 'list_devices'))

  const off = await rt.multiDeviceSetEnabled(false)
  assert.equal(off.enabled, false)
  assert.equal(off.hub.state, 'off')
  assert.equal(rt.multiDeviceEnabled, false)
  assert.equal(rt.state.multiDevice.enabled, false)
  assert.equal(tool(rt.teamTools, 'list_devices'), undefined)
  await ctx.dispose()

  // A restart reads the saved off state, not the profile default, so the hub stays down.
  const againCtx = fakeContext()
  const again = createRuntime(againCtx, config)
  t.after(() => againCtx.dispose())
  await again.multiDeviceReady
  assert.equal(again.multiDeviceEnabled, false)
  assert.equal(again.teamTools.some(entry => entry.name === 'list_devices'), false)

  const on = await again.multiDeviceSetEnabled(true)
  assert.equal(on.enabled, true)
  assert.equal(on.hub.state, 'listening')
  assert.match(on.hub.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(tool(again.teamTools, 'list_devices'))
})

test('the Devices status lists the machines and the pairing command removes one', async t => {
  const ctx = fakeContext()
  const rt = createRuntime(ctx, {
    home: folder('devices-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('devices-data'), name: 'devices-mac' },
  })
  t.after(() => ctx.dispose())
  await rt.multiDeviceReady
  await pairDevice(rt.multiDeviceHub, { code: rt.multiDeviceHub.issueCode().code, name: 'win-pc', hostname: 'WIN-PC' })

  const status = rt.multiDeviceStatus()
  assert.equal(status.available, true)
  assert.equal(status.enabled, true)
  assert.equal(status.hub.state, 'listening')
  assert.match(status.hub.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.deepEqual(status.policy, ['hostname', 'whoami', 'uname', 'echo (built in)', 'pwd', 'ls', 'dir'])
  assert.equal(status.nodes.length, 1)
  assert.equal(status.nodes[0].name, 'win-pc')
  assert.equal(status.nodes[0].hostname, 'WIN-PC')
  assert.equal(status.nodes[0].online, false)

  const pairing = rt.multiDevicePairingCode()
  assert.match(pairing.code, /^\d{6}$/)
  assert.match(pairing.command, /^npm run lan:worker -- --hub http:\/\/127\.0\.0\.1:\d+ --code \d{6} --name other-pc$/)

  const removed = await rt.multiDeviceRemoveNode('win-pc')
  assert.deepEqual(removed.nodes, [])
})

test('a profile with multiDevice false keeps the switch unavailable', async t => {
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home: folder('off-home'), multiDevice: false })
  t.after(() => ctx.dispose())
  await rt.multiDeviceReady
  const status = rt.multiDeviceStatus()
  assert.equal(status.available, false)
  assert.equal(status.enabled, false)
  await assert.rejects(rt.multiDeviceSetEnabled(true), /multiDevice: false/)
})

// --- Task kinds beyond a read-only command (issue #966, part 1) ---

test('a command outside the read-only list is classified as needing approval', () => {
  assert.equal(classifyCommand(['pwd']).safe, true)
  assert.equal(classifyCommand(['ls', '-la']).safe, true)
  assert.equal(classifyCommand(['node', '--version']).safe, false)
  assert.equal(classifyCommand(['/bin/rm', '-rf', '/']).ok, false)
  assert.equal(classifyCommand(['hostname', '$(id)']).safe, false)
})

test('device_read_file returns text from the worker workspace', async t => {
  const { hub, workerDir } = await bench(t)
  const workspace = join(workerDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'notes.txt'), 'hello from the node\n')
  const task = hub.dispatch({ node: 'test-node', kind: 'read_file', path: 'notes.txt' })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.file.encoding, 'utf8')
  assert.equal(done.result.file.mime, 'text/plain')
  assert.equal(done.result.file.data, 'hello from the node\n')
  assert.equal(done.result.file.size, 20)
})

test('device_read_file caps the bytes it reads and marks the file truncated', async t => {
  const { hub, workerDir } = await bench(t)
  const workspace = join(workerDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 10))
  const task = hub.dispatch({ node: 'test-node', kind: 'read_file', path: 'big.txt', maxBytes: 100 })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.result.file.data.length, 100)
  assert.equal(done.result.file.size, MAX_FILE_BYTES + 10)
  assert.equal(done.result.file.truncated, true)
})

test('a binary file comes back as base64 with its type', async t => {
  const { hub, workerDir } = await bench(t)
  const workspace = join(workerDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'pixel.png'), Buffer.from([0, 1, 2, 255]))
  const task = hub.dispatch({ node: 'test-node', kind: 'read_file', path: 'pixel.png' })
  const done = await hub.waitForTask(task.id, { timeoutMs: 5000 })
  assert.equal(done.result.file.encoding, 'base64')
  assert.equal(done.result.file.mime, 'image/png')
  assert.equal(Buffer.from(done.result.file.data, 'base64').toString('hex'), '000102ff')
})

test('a relative path may not leave the worker workspace, while an absolute path is read', async t => {
  const { hub, workerDir } = await bench(t)
  const outside = join(folder('outside'), 'secret.txt')
  writeFileSync(outside, 'absolute is the user\'s choice\n')
  const escape = hub.dispatch({ node: 'test-node', kind: 'read_file', path: '../secret.txt' })
  assert.equal((await hub.waitForTask(escape.id, { timeoutMs: 5000 })).state, 'rejected')
  const absolute = hub.dispatch({ node: 'test-node', kind: 'read_file', path: outside })
  const done = await hub.waitForTask(absolute.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'done')
  assert.equal(done.result.file.data, 'absolute is the user\'s choice\n')
  assert.equal(resolveNodePath('../x', join(workerDir, 'workspace')).ok, false)
})

test('a write is refused without approval and written with it', async t => {
  const { hub, workerDir } = await bench(t)
  const refused = hub.dispatch({ node: 'test-node', kind: 'write_file', path: 'made.txt', data: 'nope' })
  const rejected = await hub.waitForTask(refused.id, { timeoutMs: 5000 })
  assert.equal(rejected.state, 'rejected')
  assert.match(rejected.result.stderr, /approval/)
  const written = hub.dispatch({ node: 'test-node', kind: 'write_file', path: 'made.txt', data: 'yes', approved: true })
  const done = await hub.waitForTask(written.id, { timeoutMs: 5000 })
  assert.equal(done.state, 'done')
  assert.equal(readFileSync(join(workerDir, 'workspace', 'made.txt'), 'utf8'), 'yes')
  // An approved write may replace an existing file.
  const again = hub.dispatch({ node: 'test-node', kind: 'write_file', path: 'made.txt', data: 'second', approved: true })
  assert.equal((await hub.waitForTask(again.id, { timeoutMs: 5000 })).state, 'done')
  assert.equal(readFileSync(join(workerDir, 'workspace', 'made.txt'), 'utf8'), 'second')
})

test('a file larger than the limit is refused before anything is written', async () => {
  const hub = createHub({ dataDir: folder('hub-too-big'), host: '127.0.0.1', port: 0, log: () => {} })
  await hub.start()
  try {
    await pairDevice(hub, { code: hub.issueCode().code, name: 'far-pc' })
    assert.throws(
      () => hub.dispatch({ node: 'far-pc', kind: 'write_file', path: 'big.txt', data: 'x'.repeat(MAX_FILE_BYTES + 1) }),
      /larger than/,
    )
  } finally {
    await hub.stop()
  }
})

test('device_transfer gets a file out and puts one back', async t => {
  const { hub, workerDir } = await bench(t)
  const workspace = join(workerDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'blob.bin'), Buffer.from([9, 8, 7]))
  const down = hub.dispatch({ node: 'test-node', kind: 'transfer', direction: 'get', path: 'blob.bin' })
  const received = await hub.waitForTask(down.id, { timeoutMs: 5000 })
  assert.equal(received.result.file.encoding, 'base64')
  assert.equal(Buffer.from(received.result.file.data, 'base64').toString('hex'), '090807')
  const up = hub.dispatch({ node: 'test-node', kind: 'transfer', direction: 'put', path: 'copy.bin', data: 'AQID', encoding: 'base64', approved: true })
  const sent = await hub.waitForTask(up.id, { timeoutMs: 5000 })
  assert.equal(sent.state, 'done')
  assert.equal(readFileSync(join(workspace, 'copy.bin')).toString('hex'), '010203')
  // A text file transferred the same way comes back as text, not base64.
  writeFileSync(join(workspace, 'note.txt'), 'plain note\n')
  const textDown = hub.dispatch({ node: 'test-node', kind: 'transfer', direction: 'get', path: 'note.txt' })
  const text = await hub.waitForTask(textDown.id, { timeoutMs: 5000 })
  assert.equal(text.result.file.encoding, 'utf8')
  assert.equal(text.result.file.data, 'plain note\n')
})

test('an unsafe tool command waits for approval, and a refused one is never dispatched', async t => {
  const { hub } = await bench(t)
  const rejected = fakeApproval('rejected')
  const tools = deviceTools({ hub, approval: rejected })
  const exec = { agent: { session: { id: 's1' } }, name: 'run_on_device' }
  const refusal = await tool(tools, 'run_on_device').execute({ node: 'test-node', argv: ['node', '-e', 'process.stdout.write("ran")'] }, exec)
  assert.match(refusal, /did not approve/)
  assert.equal(rejected.requests.length, 1)

  const allowed = fakeApproval('allowed-once')
  const allowedTools = deviceTools({ hub, approval: allowed })
  const ran = await tool(allowedTools, 'run_on_device').execute({ node: 'test-node', argv: ['node', '-e', 'process.stdout.write("ran")'] }, exec)
  assert.match(ran, /ran/)
  assert.equal(allowed.requests.length, 1)

  // A read-only command never asks.
  const quiet = fakeApproval('rejected')
  const quietTools = deviceTools({ hub, approval: quiet })
  const pwd = await tool(quietTools, 'run_on_device').execute({ node: 'test-node', argv: ['pwd'] }, exec)
  assert.match(pwd, /done, exit 0/)
  assert.equal(quiet.requests.length, 0)
})

test('writing and transferring to a machine need approval before dispatch', async t => {
  const { hub } = await bench(t)
  const approvals = fakeApproval('rejected')
  const tools = deviceTools({ hub, approval: approvals })
  const exec = { agent: { session: { id: 's1' } }, name: 'device_write_file' }
  const write = await tool(tools, 'device_write_file').execute({ node: 'test-node', path: 'a.txt', content: 'x' }, exec)
  assert.match(write, /did not approve/)
  const put = await tool(tools, 'device_transfer').execute({ node: 'test-node', direction: 'put', path: 'b.txt', content: 'y' }, exec)
  assert.match(put, /did not approve/)
  assert.equal(approvals.requests.length, 2)

  const allowed = fakeApproval('allowed-once')
  const allowedTools = deviceTools({ hub, approval: allowed })
  const did = await tool(allowedTools, 'device_write_file').execute({ node: 'test-node', path: 'a.txt', content: 'written' }, exec)
  assert.match(did, /Wrote 7 bytes/)
  const read = await tool(allowedTools, 'device_read_file').execute({ node: 'test-node', path: 'a.txt' }, exec)
  assert.match(read, /written/)
  assert.equal(allowed.requests.length, 1)
})

test('without an approval service a write is refused rather than run', async t => {
  const { hub } = await bench(t)
  const tools = deviceTools({ hub })
  const out = await tool(tools, 'device_write_file').execute({ node: 'test-node', path: 'a.txt', content: 'x' }, {})
  assert.match(out, /no approval card here/)
})

test('the selection helper prefers the operating system a path names', () => {
  const nodes = [
    { name: 'mac', online: true, os: 'darwin', hostname: 'Mac-mini' },
    { name: 'win-pc', online: true, os: 'win32', hostname: 'DESKTOP-ABC' },
    { name: 'old-pc', online: false, os: 'win32', hostname: 'DESKTOP-OLD' },
  ]
  assert.equal(hintOs('C:\\Users\\me\\report.docx'), 'win32')
  assert.equal(hintOs('/Users/me/notes.md'), 'darwin')
  assert.equal(bestDevice(nodes, 'open C:\\Users\\me\\report.docx').name, 'win-pc')
  assert.equal(bestDevice(nodes, 'open /Users/me/notes.md').name, 'mac')
  assert.equal(bestDevice(nodes, 'the DESKTOP-ABC machine').name, 'win-pc')
  assert.equal(bestDevice(nodes, 'DESKTOP-OLD'), undefined)
  assert.equal(bestDevice(nodes, 'something else'), undefined)
  assert.equal(bestDevice([{ name: 'only', online: true, os: 'darwin' }], 'anything').name, 'only')
})

// --- The always-on worker (issue #966, part 2) ---

const existsFor = path => existsSync(path)
const cliPath = '/repo/ds-bot/src/host/multi-device/cli.js'
const daemonArgs = { nodePath: '/usr/local/bin/node', cliPath, hubUrl: 'http://192.168.1.5:8787', name: 'windows-pc', dataDir: '/data' }

test('the launchd template starts the worker at login and never carries a pairing code', () => {
  const text = daemonFileContent({ platform: 'darwin', ...daemonArgs })
  assert.match(text, new RegExp(`<string>${LABEL}</string>`))
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(text, /<string>\/usr\/local\/bin\/node<\/string>/)
  assert.match(text, /<string>http:\/\/192\.168\.1\.5:8787<\/string>/)
  assert.match(text, /<string>windows-pc<\/string>/)
  assert.equal(text.includes('--code'), false)
  assert.equal(text.includes('<string>--data</string>'), true)
})

test('the systemd unit and the Windows script restart the worker', () => {
  const unit = daemonFileContent({ platform: 'linux', ...daemonArgs })
  assert.match(unit, /^\[Service\]/m)
  assert.match(unit, /Restart=always/)
  assert.match(unit, /ExecStart=.*--hub.*192\.168\.1\.5:8787/)
  assert.equal(unit.includes('--code'), false)
  const script = daemonFileContent({ platform: 'win32', ...daemonArgs })
  assert.match(script, /@echo off/)
  assert.match(script, /:loop/)
  assert.match(script, /goto loop/)
  assert.match(script, /"--hub" "http:\/\/192\.168\.1\.5:8787"/)
  assert.equal(script.includes('--code'), false)
})

test('installing writes the platform file, status sees it, and uninstalling removes it', () => {
  const home = folder('daemon-home')
  const dataDir = folder('daemon-data')
  const installed = installDaemon({ platform: 'darwin', home, dataDir, hubUrl: 'http://192.168.1.5:8787', name: 'windows-pc', nodePath: '/usr/local/bin/node', cliPath, runCommands: false })
  const file = daemonFile({ platform: 'darwin', home, dataDir })
  assert.equal(installed.file, file)
  assert.match(readFileSync(file, 'utf8'), /192\.168\.1\.5:8787/)
  assert.equal(daemonStatus({ platform: 'darwin', home, dataDir, runCommands: false }).installed, true)
  const removed = uninstallDaemon({ platform: 'darwin', home, dataDir, runCommands: false })
  assert.equal(removed.uninstalled, true)
  assert.equal(existsFor(file), false)
  assert.equal(daemonStatus({ platform: 'darwin', home, dataDir, runCommands: false }).installed, false)
})

test('a Windows install writes its logon script beside the device data', () => {
  const home = folder('daemon-win-home')
  const dataDir = folder('daemon-win-data')
  const installed = installDaemon({ platform: 'win32', home, dataDir, hubUrl: 'http://192.168.1.5:8787', name: 'windows-pc', nodePath: 'C:\\node\\node.exe', cliPath: 'C:\\ds-bot\\cli.js', runCommands: false })
  assert.equal(installed.file, join(dataDir, 'lan-worker.cmd'))
  assert.match(readFileSync(installed.file, 'utf8'), /goto loop/)
  assert.equal(uninstallDaemon({ platform: 'win32', home, dataDir, runCommands: false }).uninstalled, true)
})

test('the Devices status names the install and uninstall commands', () => {
  assert.equal(daemonCommand({ hubUrl: 'http://192.168.1.5:8787' }), 'npm run lan:daemon -- install --hub http://192.168.1.5:8787 --name other-pc')
  assert.equal(WINDOWS_TASK, 'DSBotLanWorker')
})

// --- Approval before dispatch (issue #966, part 4) ---

function countingHub(nodes) {
  const dispatched = []
  return {
    dispatched,
    nodes: () => nodes,
    dispatch: input => {
      dispatched.push(input)
      return { id: 'tk_test', nodeName: 'test-node', ...input, state: 'queued', result: undefined }
    },
    task: () => undefined,
    waitForTask: async () => ({ id: 'tk_test', nodeName: 'test-node', kind: 'shell', argv: ['x'], state: 'done', result: { exitCode: 0, stdout: '' } }),
  }
}

const onlineNode = { id: 'nd_1', name: 'test-node', online: true, os: 'darwin' }

test('an unapproved or refused action never reaches the hub', async () => {
  const hub = countingHub([onlineNode])
  const refused = fakeApproval('rejected')
  const tools = deviceTools({ hub, approval: refused })
  const exec = { agent: { session: { id: 's1' } }, name: 'run_on_device' }
  const out = await tool(tools, 'run_on_device').execute({ node: 'test-node', argv: ['node', '--version'] }, exec)
  assert.match(out, /did not approve/)
  assert.equal(hub.dispatched.length, 0)

  const write = await tool(tools, 'device_write_file').execute({ node: 'test-node', path: 'x.txt', content: 'x' }, exec)
  assert.match(write, /did not approve/)
  assert.equal(hub.dispatched.length, 0)

  // A read that the profile made approval-gated follows the same rule.
  const gated = deviceTools({ hub, approval: fakeApproval('cancelled'), requireApprovalForReads: true })
  const read = await tool(gated, 'device_read_file').execute({ node: 'test-node', path: 'x.txt' }, exec)
  assert.match(read, /cancelled/)
  assert.equal(hub.dispatched.length, 0)
})

test('an approved action is dispatched with the approval mark', async () => {
  const hub = countingHub([onlineNode])
  const tools = deviceTools({ hub, approval: fakeApproval('allowed-once') })
  const exec = { agent: { session: { id: 's1' } }, name: 'device_write_file' }
  await tool(tools, 'device_write_file').execute({ node: 'test-node', path: 'x.txt', content: 'x' }, exec)
  assert.equal(hub.dispatched.length, 1)
  assert.equal(hub.dispatched[0].kind, 'write_file')
  assert.equal(hub.dispatched[0].approved, true)
})

test('the plugin hands the device tools its approval service', async t => {
  const approval = fakeApproval('allowed-once')
  const ctx = fakeContext({ services: { approval } })
  const rt = createRuntime(ctx, {
    home: folder('approval-home'),
    multiDevice: { host: '127.0.0.1', port: 0, dataDir: folder('approval-data'), name: 'approval-mac' },
  })
  t.after(async () => { await rt.multiDeviceHub?.stop(); await ctx.dispose() })
  await rt.multiDeviceReady
  const worker = createWorker({
    hubUrl: rt.multiDeviceHub.url,
    dataDir: folder('approval-worker'),
    name: 'win-pc',
    code: rt.multiDeviceHub.issueCode().code,
    log: () => {},
    reconnectMs: 50,
    maxReconnectMs: 200,
  })
  t.after(() => worker.stop())
  await worker.start()
  await worker.connected({ timeoutMs: 5000 })
  await until(() => rt.multiDeviceHub.isOnline(worker.nodeId), { what: 'the node to come online' })
  const out = await tool(rt.teamTools, 'device_write_file').execute({ node: 'win-pc', path: 'hello.txt', content: 'hi' }, { agent: { session: { id: 'chat' } }, name: 'device_write_file' })
  assert.match(out, /Wrote 2 bytes/)
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /hello\.txt/)
})

// --- Choosing a machine (issue #966, part 5) ---

test('the tool help says how to choose a machine by OS and path', () => {
  const tools = deviceTools({ hub: countingHub([onlineNode]) })
  const list = tool(tools, 'list_devices').description
  assert.match(list, /Windows path/)
  assert.match(list, /Never send a task to an offline machine/)
  assert.match(tool(tools, 'run_on_device').description, /argument list, never a shell line/)
  assert.match(tool(tools, 'device_read_file').description, /path style/)
})

test('an offline machine is refused with the online ones and their OS', async () => {
  const hub = countingHub([
    { id: 'nd_1', name: 'win-pc', online: false, os: 'win32' },
    { id: 'nd_2', name: 'mac-mini', online: true, os: 'darwin' },
  ])
  const tools = deviceTools({ hub })
  const run = await tool(tools, 'run_on_device').execute({ node: 'win-pc', argv: ['ls'] }, {})
  assert.match(run, /win-pc is offline .* Online machines: mac-mini \(darwin\)/)
  const read = await tool(tools, 'device_read_file').execute({ node: 'win-pc', path: '/Users/me/notes.md' }, {})
  assert.match(read, /best online match for this path/)
  assert.equal(hub.dispatched.length, 0)

  const listed = await tool(tools, 'list_devices').execute({ hint: 'C:\\Users\\me\\report.docx' }, {})
  assert.match(listed, /Best match for "C:\\Users\\me\\report\.docx": win-pc \(offline, so it cannot be used now\)/)
})
