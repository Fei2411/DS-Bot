import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { install } from '../src/host/dsh-update.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// The dsh-update module alone: a stub loader says the running DSH version, a
// stub plugin manager says how the bot was installed, and fetch is scripted.
function start({ current = '0.1.0', source, answers = {}, app = false, spawn, config = {}, profileDir }) {
  const fetched = []
  const spawns = []
  const warnings = []
  globalThis.fetch = async (url) => {
    fetched.push(url)
    const answer = answers[url]
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (answer instanceof Error) throw answer
    return { ok: true, status: 200, json: async () => answer }
  }
  const loader = current === null ? undefined : {
    import: async name => (name === '@deepseek-ai/dsh-app-boot' ? { getDshRuntimeVersion: () => current } : {}),
    unwrapExports: exports => exports,
  }
  const profileContext = app ? { dir: profileDir, packageManager: { command: 'pnpm' } } : { dir: profileDir }
  const pluginManager = {
    listBundles: async () => (source === undefined ? [] : [{ name: PKG.name, source }]),
    registries: async () => ({ registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://registry.npmjs.org/' }),
  }
  const rt = {
    ctx: { get: name => ({ loader, pluginManager, profileContext })[name], effect() {} },
    config,
    warn: (...args) => warnings.push(args),
    dshSpawn: spawn ?? ((command, argv) => { spawns.push([command, argv]); return fakeChild(0) }),
  }
  install(rt)
  return { rt, fetched, spawns, warnings }
}

function fakeChild(code) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => child.emit('close', code))
  return child
}

const registryLatest = dsBot => ({ [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: PKG.version, dsBot } })
const githubLatest = (tag, manifest) => ({
  'https://api.github.com/repos/Fei2411/DS-Bot/releases/latest': { tag_name: tag },
  [`https://raw.githubusercontent.com/Fei2411/DS-Bot/${tag}/ds-bot/package.json`]: manifest,
})

test('the newest released bot declares the verified DSH, offered to an older npm install', async () => {
  const { rt, spawns } = start({ source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: '9.9.9' }) })
  const view = await rt.dshUpdateCheck()
  assert.equal(view.current, '0.1.0')
  assert.equal(view.verified, '9.9.9')
  assert.equal(view.kind, 'npm')
  assert.equal(view.available, true)
  assert.equal(rt.dshUpdateStart().phase, 'installing')
  await flush()
  assert.deepEqual(spawns.map(([, argv]) => argv), [['install', '-g', '@deepseek-ai/dsh@9.9.9']])
  assert.equal((await rt.dshUpdateCheck()).phase, 'installed')
  assert.equal((await rt.dshUpdateCheck()).installed, '9.9.9')
})

test('a verified version older than the running one is still offered, for a broken release', async () => {
  const { rt } = start({ current: '9.9.9', source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: '0.2.1-alpha.1' }) })
  const view = await rt.dshUpdateCheck()
  assert.equal(view.verified, '0.2.1-alpha.1')
  assert.equal(view.available, true)
})

test('without any verified version nothing is offered', async () => {
  const { rt } = start({ source: `${PKG.name}@^${PKG.version}` })
  const view = await rt.dshUpdateCheck()
  assert.equal(view.verified, null)
  assert.equal(view.available, false)
})

test('the running version matching the verified one offers nothing', async () => {
  const { rt } = start({ source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: '0.1.0' }) })
  assert.equal((await rt.dshUpdateCheck()).available, false)
  assert.throws(() => rt.dshUpdateStart(), /No DSH update/)
})

test('a minBot newer than the running bot gates the DSH update until the bot goes first', async () => {
  const { rt } = start({ source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: '9.9.9', minBot: '9.9.9' }) })
  const view = await rt.dshUpdateCheck()
  assert.equal(view.available, false)
  assert.equal(view.blockedBy, '9.9.9')
  assert.throws(() => rt.dshUpdateStart(), /No DSH update/)
})

test('a git or local install asks the public repo\'s latest release for its declaration', async () => {
  for (const source of ['github:Fei2411/DS-Bot#v0.1.0&path:/ds-bot', 'link:/work/ds-bot', undefined]) {
    const { rt, fetched } = start({ source, answers: githubLatest('v9.0.0', { dsBot: { verifiedDsh: '8.8.8' } }) })
    const view = await rt.dshUpdateCheck()
    assert.equal(view.verified, '8.8.8')
    assert.deepEqual(fetched, [
      'https://api.github.com/repos/Fei2411/DS-Bot/releases/latest',
      'https://raw.githubusercontent.com/Fei2411/DS-Bot/v9.0.0/ds-bot/package.json',
    ])
  }
})

test('a bundled package manager means the app owns the runtime: report only, never install', async () => {
  const { rt } = start({ app: true, source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: '9.9.9' }) })
  const view = await rt.dshUpdateCheck()
  assert.equal(view.kind, 'app')
  assert.equal(view.available, true)
  assert.throws(() => rt.dshUpdateStart(), /updates with its app/)
})

test('the desktop app pins its DSH: it reports the running version, asks no network and offers nothing', async (t) => {
  process.env.DS_BOT_APP = '1'
  t.after(() => { delete process.env.DS_BOT_APP })
  const { rt, fetched } = start({ app: true, source: `${PKG.name}@^${PKG.version}`, answers: registryLatest({ verifiedDsh: '9.9.9' }) })
  const view = await rt.dshUpdateCheck({ fresh: true })
  assert.equal(view.current, '0.1.0')
  assert.equal(view.kind, 'app')
  assert.equal(view.verified, null)
  assert.equal(view.available, false)
  assert.deepEqual(fetched, [])
})

test('without a running version there is nothing to compare against', async () => {
  const { rt } = start({ current: null, source: `${PKG.name}@^${PKG.version}` })
  const view = await rt.dshUpdateCheck()
  assert.equal(view.current, null)
  assert.equal(view.available, false)
})

test('a failed npm install reports why and can be tried again', async () => {
  let attempt = 0
  const { rt } = start({
    source: `${PKG.name}@^${PKG.version}`,
    answers: registryLatest({ verifiedDsh: '9.9.9' }),
    spawn: () => { attempt += 1; return fakeChild(attempt === 1 ? 1 : 0) },
  })
  await rt.dshUpdateCheck()
  rt.dshUpdateStart()
  await flush()
  const failed = await rt.dshUpdateCheck()
  assert.equal(failed.phase, 'failed')
  assert.match(failed.error, /npm exited 1/)
  assert.equal(failed.available, true)
  rt.dshUpdateStart()
  await flush()
  assert.equal((await rt.dshUpdateCheck()).phase, 'installed')
})
