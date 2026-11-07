// Acceptance path for #966 "the same conversation on two screens". One dsh Web host runs
// on the center machine (this Mac), two independent browser logins read and write the same
// Bot Session through /api/bot, and the plugin's LAN hub serves the device path.
//
//   npm run harness                                      # once, if dev/harness has no dsh
//   node dev/lan-sync-accept.mjs prove                   # fresh team, both directions, stop
//   KEEP=1 node dev/lan-sync-accept.mjs prove            # leave the host up for Windows
//   node dev/lan-sync-accept.mjs pair                    # code + worker command for Windows
//   node dev/lan-sync-accept.mjs devices                 # list -> pick -> hostname (Windows)
//   node dev/lan-sync-accept.mjs status | stop
//
// The proof writes JSON evidence (no token, no cookie value) to /tmp by default, or to
// --out. It never prints the launch token; the tokenized URL goes to <home>/login-url.txt
// with mode 0600, because a second machine needs that URL to open the same session.
//
// This is one dsh host and several clients, not two DSH instances syncing: a Session has a
// single owner and the team store a single writer (docs/plans/966-lan-multi-device.md).
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { networkInterfaces, hostname as localHostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const HARNESS = join(PLUGIN, 'dev', 'harness')
const DSH_BIN = join(HARNESS, 'node_modules', '.bin', 'dsh')
const HOME = process.env.DSBOT_LAN_SYNC_HOME ?? join(tmpdir(), 'dsbot-966-sync-home')
const PROFILE = join(HOME, 'profiles', 'web')
const DATA = join(HOME, 'multi-device')
const PIDS = join(HOME, 'pids.json')
const WORKER_HUB_NAME = 'dsbot-966-center'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function usage(code = 2) {
  console.error(`usage: node dev/lan-sync-accept.mjs <prove|start|prove-sync|pair|devices|status|stop> [options]

  prove        start a fresh team, prove both directions, run the device path, stop
  start        start the mock and one dsh Web host on the LAN address, leave them up
  prove-sync   the two-client proof against the running host
  pair         print a pairing code and the Windows worker command
  devices      list -> auto-pick -> hostname against the running host
  status       processes, origin, paired nodes
  stop         stop the worker, dsh and the mock

Options:
  --out <file>       evidence path (prove: /tmp/dsbot-966-sync-accept-report.json,
                     devices: /tmp/dsbot-966-sync-devices.json)
  --ip <address>     bind address (default: en0/en1, else the first non-loopback IPv4)
  --web-port <n>     Web port (default 0: the OS picks one)
  --hub-port <n>     hub port (default: a free port)
  --fresh            wipe the home, including the installed profile, before starting
  --no-worker        do not start the local stand-in worker during prove

Environment: KEEP=1 leaves the processes up after prove; DSBOT_LAN_SYNC_HOME moves the
home; EXPECT_HOSTNAME asserts the hostname result (default DESKTOP-BNUICR3 for devices).`)
  process.exit(code)
}

function parse(argv) {
  const options = {}
  const action = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : 'prove'
  for (let index = argv[0] === action ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fresh' || arg === '--no-worker') options[arg.slice(2)] = true
    else if (arg === '--help' || arg === '-h') usage(0)
    else if (arg.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) usage()
      options[arg.slice(2)] = value
      index += 1
    } else usage()
  }
  return { action, options }
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}

// The launch URL carries a process credential; it must never reach a log line or the report.
export function redact(text) {
  return String(text).replace(/token=[^\s&"']+/g, 'token=<redacted>')
}

function tail(path, lines = 20) {
  try {
    return redact(readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n'))
  } catch {
    return ''
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

// A concrete local address is what dsh accepts: it rejects wildcard binds.
function detectLanIp() {
  for (const name of ['en0', 'en1']) {
    try {
      const value = execFileSync('ipconfig', ['getifaddr', name], { encoding: 'utf8' }).trim()
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value
    } catch {
      // Not macOS, or that interface is down.
    }
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  throw new Error('no LAN IPv4 address found; pass --ip')
}

function alive(pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pids() {
  try {
    return readJson(PIDS)
  } catch {
    return {}
  }
}

function savedLaunch() {
  try {
    return readJson(join(HOME, 'launch.json'))
  } catch {
    return undefined
  }
}

function saveLaunch(info) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'launch.json'), `${JSON.stringify(info, null, 2)}\n`)
}

function savePids(value) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(PIDS, `${JSON.stringify(value, null, 2)}\n`)
}

function launch(name, command, args, { cwd, env, log }) {
  const fd = openSync(log, 'a')
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  child.unref()
  const all = { ...pids(), [name]: child.pid }
  savePids(all)
  return child.pid
}

async function stopOne(name) {
  const all = pids()
  const pid = all[name]
  if (pid === undefined) return
  if (alive(pid)) {
    try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
    for (let i = 0; i < 50 && alive(pid); i += 1) await sleep(200)
    if (alive(pid)) {
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
  }
  delete all[name]
  savePids(all)
}

async function stopAll() {
  for (const name of ['worker', 'web', 'mock']) await stopOne(name)
}

function ensureHarness() {
  if (existsSync(DSH_BIN)) return
  console.log('installing the DSH packages for the tests (npm run harness)…')
  execFileSync('npm', ['run', 'harness'], { cwd: PLUGIN, stdio: 'inherit' })
  if (!existsSync(DSH_BIN)) throw new Error(`no dsh at ${DSH_BIN} after npm run harness`)
}

function profileText() {
  return `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'ds-bot': `link:${PLUGIN}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }, null, 2)}\n`
}

// Same profile as dev/bench.sh: the web bundle plus this checkout's ds-bot, so /api/bot
// exists. Without ds-bot the page loads but the team has nowhere to send or read messages.
function ensureProfile() {
  const file = join(PROFILE, 'package.json')
  const wanted = profileText()
  let current = ''
  try { current = readFileSync(file, 'utf8') } catch {}
  const linked = existsSync(join(PROFILE, 'node_modules', 'ds-bot', 'index.js'))
  if (current === wanted && linked) return
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(file, wanted)
  writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  try {
    execFileSync('pnpm', ['install'], { cwd: PROFILE, env: { ...process.env, DSH_HOME: HOME }, stdio: 'pipe' })
  } catch (error) {
    throw new Error(`pnpm install failed in ${PROFILE}: ${redact(error.stderr?.toString() ?? error.message)}`)
  }
}

function writeOverlay(hubPort) {
  writeFileSync(join(HOME, 'lan-sync.patch.yml'), [
    '- id: bot',
    '  config:',
    '    multiDevice:',
    '      host: 0.0.0.0',
    `      port: ${hubPort}`,
    `      dataDir: ${DATA}`,
    `      name: ${WORKER_HUB_NAME}`,
    '',
  ].join('\n'))
}

function prepareHome({ fresh }) {
  if (fresh) rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  // A new team and new Sessions each run; the installed profile stays.
  rmSync(join(HOME, 'bot'), { recursive: true, force: true })
  rmSync(join(HOME, 'sessions'), { recursive: true, force: true })
  rmSync(DATA, { recursive: true, force: true })
  rmSync(join(HOME, 'worker'), { recursive: true, force: true })
  for (const file of ['web.log', 'mock.out', 'mock.jsonl', 'worker.log', 'pids.json', 'login-url.txt', 'launch.json']) {
    rmSync(join(HOME, file), { force: true })
  }
}

function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await sleep(100)
  }
  return false
}

async function startMock() {
  const running = pids().mock
  if (alive(running)) return running
  const port = await freePort()
  rmSync(join(HOME, 'mock.out'), { force: true })
  const pid = launch('mock', process.execPath, ['dev/mock-llm.mjs'], {
    cwd: PLUGIN,
    env: { MOCK_PORT: String(port), MOCK_DELAY_MS: '150', MOCK_LOG: join(HOME, 'mock.jsonl') },
    log: join(HOME, 'mock.out'),
  })
  if (!await waitForPort(port, 20_000)) {
    throw new Error(`the mock model did not start: ${tail(join(HOME, 'mock.out'))}`)
  }
  return pid
}

function mockPort() {
  const match = /mock on http:\/\/127\.0\.0\.1:(\d+)/.exec(tail(join(HOME, 'mock.out'), 20))
  if (!match) throw new Error('the mock model is not running')
  return Number(match[1])
}

function loginUrl() {
  let log = ''
  try { log = readFileSync(join(HOME, 'web.log'), 'utf8') } catch { return undefined }
  return /(http:\/\/[^\s/]+\/\?token=[^\s]+)/.exec(log)?.[1]
}

function webOrigin(url) {
  return new URL(url).origin
}

async function startWeb({ ip, webPort, hubPort }) {
  const running = pids().web
  if (alive(running) && loginUrl() !== undefined) return running
  ensureHarness()
  ensureProfile()
  writeOverlay(hubPort)
  const log = join(HOME, 'web.log')
  rmSync(log, { force: true })
  const pid = launch('web', DSH_BIN, [
    '--profile', 'web',
    '--patch', join(HOME, 'lan-sync.patch.yml'),
    '--host', ip,
    '--port', String(webPort),
    '--no-open',
  ], {
    cwd: HARNESS,
    env: {
      DSH_HOME: HOME,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort()}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
    },
    log,
  })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const url = loginUrl()
    if (url !== undefined) {
      writeFileSync(join(HOME, 'login-url.txt'), `${url}\n`, { mode: 0o600 })
      chmodSync(join(HOME, 'login-url.txt'), 0o600)
      return pid
    }
    if (!alive(pid)) throw new Error(`dsh web exited: ${tail(log)}`)
    await sleep(300)
  }
  throw new Error(`dsh web did not print a login URL: ${tail(log)}`)
}

async function hubRequest(url, path, { method = 'GET', body } = {}) {
  const token = readFileSync(join(DATA, 'admin.token'), 'utf8').trim()
  const init = { method, headers: { 'x-admin-token': token } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${url}${path}`, init)
  const parsed = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path}: ${parsed.error ?? `HTTP ${response.status}`}`)
  return parsed
}

function hubUrl(ip, hubPort) {
  return `http://${ip}:${hubPort}`
}

async function waitForHub(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      return await hubRequest(url, '/admin/nodes')
    } catch (error) {
      last = error
    }
    await sleep(300)
  }
  throw new Error(`the plugin's LAN hub is not answering at ${url}: ${last?.message ?? 'timeout'}`)
}

// A second browser: its own login exchange and its own cookie jar, not a copy of the first.
async function login(url, label) {
  const response = await fetch(url, { redirect: 'manual', headers: { 'user-agent': `dsbot-966-sync-${label}` } })
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
  if (cookies.length === 0) throw new Error(`the login URL returned no cookie (${response.status})`)
  const cookie = cookies.join('; ')
  return { cookie, status: response.status }
}

function client(origin, cookie) {
  return async (endpoint, payload = {}) => {
    const response = await fetch(`${origin}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint, payload }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`)
    if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
    return result.value
  }
}

// The Bot's own chat at its current part; user lines are the proof that both clients see
// the same Session, because each client reads with its own cookie.
async function userLines(api, botId) {
  const page = await api('chat', { botId })
  return { sessionId: page?.sessionId, lines: (page?.items ?? []).filter(item => item.kind === 'user').map(item => item.text) }
}

async function waitForText(api, botId, text, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const page = await userLines(api, botId)
      if (page.lines.includes(text)) return page
      last = page
    } catch (error) {
      last = error.message
    }
    await sleep(400)
  }
  throw new Error(`the other client never showed "${text}" (last read: ${JSON.stringify(last)?.slice(0, 300)})`)
}

async function settle(api, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    const state = await api('state')
    if (Object.keys(state.activity ?? {}).length > 0) quietSince = Date.now()
    else if (Date.now() - quietSince > 1500) return
    await sleep(400)
  }
}

// The rule the Bot is told to use: never an offline node, prefer the Windows machine,
// otherwise the one whose hostname looks like a Windows desktop, otherwise the first.
export function pickDevice(nodes = []) {
  const online = nodes.filter(node => node.online)
  return online.find(node => node.os === 'win32')
    ?? online.find(node => /^DESKTOP-/i.test(node.hostname ?? ''))
    ?? online[0]
}

async function runHostname(url, node) {
  const started = await hubRequest(url, '/admin/tasks', { method: 'POST', body: { node: node.id ?? node.name, argv: ['hostname'], timeoutMs: 30_000 } })
  const id = started.task.id
  const deadline = Date.now() + 40_000
  let task = started.task
  while (!['done', 'failed', 'rejected', 'timeout', 'cancelled'].includes(task.state) && Date.now() < deadline) {
    await sleep(250)
    task = (await hubRequest(url, `/admin/tasks/${id}`)).task
  }
  return task
}

async function deviceProof({ ip, hubPort, strict }) {
  const url = hubUrl(ip, hubPort)
  const { nodes } = await waitForHub(url)
  const picked = pickDevice(nodes)
  if (picked === undefined) throw new Error('no paired machine is online; run `pair` and start the worker on the other machine')
  const expected = process.env.EXPECT_HOSTNAME
    ?? (strict ? 'DESKTOP-BNUICR3' : picked.hostname)
  const task = await runHostname(url, picked)
  const stdout = String(task.result?.stdout ?? '').trim()
  const ok = task.state === 'done' && task.result?.exitCode === 0 && stdout.toLowerCase() === String(expected).toLowerCase()
  return {
    hubUrl: url,
    nodes: nodes.map(node => ({ name: node.name, id: node.id, online: node.online, os: node.os, arch: node.arch, hostname: node.hostname, lastSeen: node.lastSeen })),
    picked: { name: picked.name, id: picked.id, hostname: picked.hostname, os: picked.os },
    rule: 'online only; prefer win32, then a DESKTOP-* hostname, then the first online node',
    expectedHostname: expected,
    task: { id: task.id, state: task.state, exitCode: task.result?.exitCode, stdout, stderr: String(task.result?.stderr ?? ''), durationMs: task.result?.durationMs },
    ok,
    windowsHostname: stdout.toLowerCase() === 'desktop-bnuicr3',
  }
}

function startStandInWorker(code, ip, hubPort) {
  return launch('worker', process.execPath, [
    'src/host/multi-device/cli.js', 'worker',
    '--hub', hubUrl(ip, hubPort),
    '--code', code,
    '--name', 'windows-pc',
    '--data', join(HOME, 'worker'),
  ], {
    cwd: PLUGIN,
    log: join(HOME, 'worker.log'),
  })
}

// The model the mock serves. The catalog also lists this machine's local-agent routes
// (gemini-cli and friends); one of those would leave the turn waiting for a login that
// never comes, and the queued second message would never be written.
export function mockModel(models = []) {
  return models.find(entry => (entry.ref ?? '').startsWith('deepseek-official/'))
    ?? models.find(entry => /deepseek/i.test(entry.ref ?? ''))
}

async function syncProof({ url }) {
  const origin = webOrigin(url)
  const a = await login(url, 'client-a')
  const b = await login(url, 'client-b')
  const apiA = client(origin, a.cookie)
  const apiB = client(origin, b.cookie)

  const page = await fetch(origin, { headers: { cookie: a.cookie } })
  if (!page.ok) throw new Error(`the Web page did not load (${page.status})`)

  const before = await apiA('state')
  const bot = before.bots.find(entry => entry.name === 'Chief') ?? before.bots[0]
  if (bot === undefined) throw new Error('the team has no Bot to talk to')
  const model = mockModel(before.models)
  if (model === undefined) throw new Error('the model catalog has no DeepSeek route for the mock')
  if (bot.waiting || bot.model !== model.ref) await apiA('update-bot', { id: bot.id, model: model.ref })
  await settle(apiA).catch(() => {})

  const stamp = new Date().toISOString()
  const textA = `LAN sync A→B ${stamp} ${Math.random().toString(16).slice(2, 8)}`
  await apiA('send', { sessionId: bot.id, text: textA })
  const seenByB = await waitForText(apiB, bot.id, textA)
  const bSawAt = new Date().toISOString()

  const textB = `LAN sync B→A ${new Date().toISOString()} ${Math.random().toString(16).slice(2, 8)}`
  await apiB('send', { sessionId: bot.id, text: textB })
  const seenByA = await waitForText(apiA, bot.id, textB)
  const aSawAt = new Date().toISOString()

  const stateA = await apiA('state')
  const stateB = await apiB('state')
  const sessionA = stateA.bots.find(entry => entry.id === bot.id)?.sessionId
  const sessionB = stateB.bots.find(entry => entry.id === bot.id)?.sessionId

  return {
    bot: { id: bot.id, name: bot.name, model: model.ref },
    sessionId: seenByB.sessionId,
    sameSessionFromBothClients: sessionA === sessionB && sessionA === seenByB.sessionId && sessionA === seenByA.sessionId,
    aToB: {
      text: textA,
      sentAt: stamp,
      bSawAt,
      bChatSessionId: seenByB.sessionId,
      bExcerpt: seenByB.lines.slice(-3),
    },
    bToA: {
      text: textB,
      readBackAt: aSawAt,
      aChatSessionId: seenByA.sessionId,
      aExcerpt: seenByA.lines.slice(-3),
    },
    clients: {
      a: { cookieSha256: sha(a.cookie).slice(0, 16), loginStatus: a.status },
      b: { cookieSha256: sha(b.cookie).slice(0, 16), loginStatus: b.status },
    },
  }
}

async function pairCode(ip, hubPort) {
  return hubRequest(hubUrl(ip, hubPort), '/admin/pair-code', { method: 'POST', body: {} })
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  return ok
}

async function context(options) {
  const saved = savedLaunch()
  const ip = options.ip ?? saved?.ip ?? detectLanIp()
  const webPort = options['web-port'] === undefined ? saved?.webPort ?? 0 : Number(options['web-port'])
  const hubPort = options['hub-port'] === undefined ? saved?.hubPort ?? await freePort() : Number(options['hub-port'])
  return { ip, webPort, hubPort, out: options.out }
}

async function commandStart(options) {
  const { ip, webPort, hubPort } = await context(options)
  if (alive(pids().web)) {
    await commandStatus(options)
    return
  }
  prepareHome({ fresh: options.fresh === true })
  saveLaunch({ ip, webPort, hubPort, startedAt: new Date().toISOString() })
  const mock = await startMock()
  await startWeb({ ip, webPort, hubPort })
  const url = loginUrl()
  await waitForHub(hubUrl(ip, hubPort))
  console.log(`mock:     pid ${mock}`)
  console.log(`dsh web:  pid ${pids().web}`)
  console.log(`origin:   ${webOrigin(url)}  (login URL: ${join(HOME, 'login-url.txt')}, mode 0600)`)
  console.log(`hub:      ${hubUrl(ip, hubPort)}  data: ${DATA}`)
  console.log('open the login URL from the other machine to see the same Session; it is the credential.')
}

async function commandProveSync(options) {
  const { ip, hubPort } = await context(options)
  const url = loginUrl()
  if (url === undefined || !alive(pids().web)) throw new Error('the host is not running; run `start` first')
  await waitForHub(hubUrl(ip, hubPort))
  const out = options.out ?? '/tmp/dsbot-966-sync-session.json'
  const sync = await syncProof({ url })
  writeFileSync(out, `${JSON.stringify(sync, null, 2)}\n`)
  check('two clients read the same Session id', sync.sameSessionFromBothClients, sync.sessionId)
  check('the second client reads the first client\'s message', sync.aToB.bExcerpt.includes(sync.aToB.text), sync.aToB.text)
  check('the first client reads the second client\'s message', sync.bToA.aExcerpt.includes(sync.bToA.text), sync.bToA.text)
  console.log(`evidence: ${out}`)
  return sync
}

async function commandProve(options) {
  const { ip, webPort } = await context(options)
  // A proof run takes a fresh hub port: a kept host from an earlier run may still hold
  // the saved one.
  const hubPort = options['hub-port'] === undefined ? await freePort() : Number(options['hub-port'])
  const out = options.out ?? '/tmp/dsbot-966-sync-accept-report.json'
  const startedAt = new Date().toISOString()
  await stopAll()
  prepareHome({ fresh: options.fresh === true || process.env.FRESH === '1' })
  saveLaunch({ ip, webPort, hubPort, startedAt })
  await startMock()
  await startWeb({ ip, webPort, hubPort })
  const url = loginUrl()
  const origin = webOrigin(url)
  const hub = hubUrl(ip, hubPort)

  console.log(`home:   ${HOME}`)
  console.log(`origin: ${origin}`)
  console.log(`hub:    ${hub}`)

  let windowsRemaining
  let devices
  let workerPid
  try {
    await waitForHub(hub)
    check('one dsh host serves /api/bot on the LAN address', true, origin)

    const sync = await syncProof({ url })
    check('two independent logins reach the same Bot Session', sync.sameSessionFromBothClients, sync.sessionId)
    check('client B reads client A\'s message', sync.aToB.bExcerpt.includes(sync.aToB.text), sync.aToB.text)
    check('client A reads client B\'s message', sync.bToA.aExcerpt.includes(sync.bToA.text), sync.bToA.text)

    const { nodes } = await waitForHub(hub)
    check('the plugin\'s LAN hub started inside dsh', Array.isArray(nodes), hub)

    if (options['no-worker'] !== true) {
      const issued = await pairCode(ip, hubPort)
      workerPid = startStandInWorker(issued.code, ip, hubPort)
      let online = false
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && !online) {
        const listed = await hubRequest(hub, '/admin/nodes')
        online = listed.nodes.some(node => node.online)
        if (!online) await sleep(300)
      }
      check('a worker pairs and comes online through the plugin hub', online, 'local stand-in named windows-pc')
    }

    devices = await deviceProof({ ip, hubPort, strict: false })
    check('list -> auto-pick -> hostname runs through the hub', devices.ok, `${devices.picked.name}: ${devices.task.stdout || devices.task.state}`)
    if (!devices.windowsHostname) {
      windowsRemaining = `the stand-in worker runs on this Mac (${localHostname()}), so hostname is not DESKTOP-BNUICR3. Attach the Windows worker, then run: node dev/lan-sync-accept.mjs devices`
    }

    const report = {
      generatedAt: new Date().toISOString(),
      startedAt,
      origin,
      loginUrlFile: join(HOME, 'login-url.txt'),
      home: HOME,
      hubUrl: hub,
      profile: { path: PROFILE, plugin: PLUGIN, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'], multiDevice: { host: '0.0.0.0', port: hubPort, dataDir: DATA } },
      sync,
      devices: { ...devices, simulated: !devices.windowsHostname },
      checks,
      windowsRemaining: windowsRemaining ?? null,
      ok: checks.every(entry => entry.ok),
    }
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`evidence: ${out}`)
    return report.ok
  } finally {
    if (process.env.KEEP === '1') {
      console.log(`kept running (KEEP=1): origin ${origin}, hub ${hub}, worker pid ${workerPid ?? 'none'}`)
      console.log(`login URL: ${join(HOME, 'login-url.txt')} (0600)`)
    } else {
      await stopAll()
      rmSync(join(HOME, 'login-url.txt'), { force: true })
    }
  }
}

async function commandPair(options) {
  const { ip, hubPort } = await context(options)
  if (!alive(pids().web)) throw new Error('the host is not running; run `start` first')
  await waitForHub(hubUrl(ip, hubPort))
  const issued = await pairCode(ip, hubPort)
  console.log(`Pairing code: ${issued.code}   (one machine, one use, valid until ${issued.expiresAt})`)
  console.log('On the Windows machine, in ds-bot/, run:')
  console.log(`  npm run lan:worker -- --hub ${hubUrl(ip, hubPort)} --code ${issued.code} --name windows-pc`)
  console.log('The code is for that machine only: do not paste it into a file, a log or an issue.')
}

async function commandDevices(options) {
  const { ip, hubPort } = await context(options)
  const out = options.out ?? '/tmp/dsbot-966-sync-devices.json'
  if (!alive(pids().web)) throw new Error('the host is not running; run `start` (or KEEP=1 prove) first')
  const url = hubUrl(ip, hubPort)
  const { nodes } = await waitForHub(url)
  for (const node of nodes) {
    console.log(`${node.online ? 'online ' : 'offline'} ${node.name} ${node.os ?? ''} ${node.hostname ?? ''}`)
  }
  const windows = nodes.find(node => node.online && (node.os === 'win32' || /^DESKTOP-/i.test(node.hostname ?? '')))
  if (windows === undefined) {
    throw new Error('no Windows machine is online: run `pair` and start `npm run lan:worker` on the Windows machine first')
  }
  const devices = await deviceProof({ ip, hubPort, strict: true })
  check('a Windows machine is online', true, `${windows.name} (${windows.hostname ?? windows.os})`)
  check('auto-pick chose the Windows machine', devices.picked.id === windows.id, devices.picked.hostname ?? devices.picked.name)
  check(`hostname returns ${devices.expectedHostname}`, devices.ok, devices.task.stdout || devices.task.state)
  const report = { generatedAt: new Date().toISOString(), hubUrl: url, ...devices, checks }
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`evidence: ${out}`)
  process.exitCode = checks.every(entry => entry.ok) ? 0 : 1
}

async function commandStatus(options) {
  const { ip, hubPort } = await context(options)
  const all = pids()
  console.log(`home: ${HOME}`)
  for (const name of ['mock', 'web', 'worker']) {
    console.log(`${name}: ${alive(all[name]) ? `running (pid ${all[name]})` : 'stopped'}`)
  }
  if (alive(all.web)) {
    const url = loginUrl()
    if (url !== undefined) console.log(`origin: ${webOrigin(url)}  login URL: ${join(HOME, 'login-url.txt')} (0600)`)
    try {
      const { nodes } = await waitForHub(hubUrl(ip, hubPort), 5_000)
      for (const node of nodes) console.log(`node: ${node.online ? 'online ' : 'offline'} ${node.name} ${node.os ?? ''} ${node.hostname ?? ''}`)
    } catch (error) {
      console.log(`hub: ${error.message}`)
    }
  }
}

async function commandStop(options) {
  await stopAll()
  // The process token died with the host; keep no stale copy of it on disk.
  rmSync(join(HOME, 'login-url.txt'), { force: true })
  await commandStatus(options)
}

export async function main(argv = process.argv.slice(2)) {
  const { action, options } = parse(argv)
  if (action === 'start') return commandStart(options)
  if (action === 'prove') {
    const ok = await commandProve(options)
    process.exitCode = ok ? 0 : 1
    return
  }
  if (action === 'prove-sync') {
    await commandProveSync(options)
    process.exitCode = checks.every(entry => entry.ok) ? 0 : 1
    return
  }
  if (action === 'pair') return commandPair(options)
  if (action === 'devices') return commandDevices(options)
  if (action === 'status') return commandStatus(options)
  if (action === 'stop') return commandStop(options)
  usage()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(redact(error.message))
    process.exitCode = 1
  })
}
