import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import React, { act, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom'
import {
  buildReleaseNotesData,
  cleanChangelogLine,
  parseChangelog,
  validateReleaseNotes,
} from '../scripts/build-release-notes.mjs'
import {
  cleanSemver,
  compareSemver,
  pendingReleaseVersions,
  RELEASE_NOTES,
  selectReleaseNotes,
} from '../src/shared/release-notes.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const pluginDir = fileURLToPath(new URL('..', import.meta.url))
const req = createRequire(import.meta.url)
const harnessReq = createRequire(join(process.env.DSH_HARNESS ?? join(pluginDir, 'dev', 'harness'), 'package.json'))
const { JSDOM } = harnessReq('jsdom')

// ---------------------------------------------------------------------------
// 1. Data validation, CHANGELOG fallback parsing, and SemVer selection

test('validateReleaseNotes accepts string[] and { intro, items, outro } and rejects invalid entries', () => {
  const valid = validateReleaseNotes([
    {
      version: 'v0.3.10',
      date: '2026-11-22',
      notes: {
        zh: { intro: '你好。', items: ['一条亮点'], outro: '感谢支持。' },
        en: ['One concise highlight'],
      },
    },
  ])
  assert.equal(valid[0].version, '0.3.10')
  assert.deepEqual(valid[0].notes.zh, { intro: '你好。', items: ['一条亮点'], outro: '感谢支持。' })
  assert.deepEqual(valid[0].notes.en, { items: ['One concise highlight'] })

  assert.throws(() => validateReleaseNotes([]), /non-empty/)
  assert.throws(() => validateReleaseNotes([
    { version: '0.3.10', date: '2026-11-22', notes: { en: ['a'] } },
    { version: '0.3.10', date: '2026-11-23', notes: { en: ['b'] } },
  ]), /duplicated/)
  assert.throws(() => validateReleaseNotes([
    { version: 'not-semver', date: '2026-11-22', notes: { en: ['a'] } },
  ]), /semver/)
  assert.throws(() => validateReleaseNotes([
    { version: '0.3.10', date: '2026/11/22', notes: { en: ['a'] } },
  ]), /YYYY-MM-DD/)
  assert.throws(() => validateReleaseNotes([
    { version: '0.3.10', date: '2026-11-22', notes: { en: [] } },
  ]), /non-empty/)
})

test('parseChangelog skips [Unreleased], strips download blocks/HTML/PR citations, and preserves angle-bracket tokens inside backticks', () => {
  const md = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '- Should never appear (#999)',
    '',
    '## [0.3.11] - 2026-11-28',
    '<!-- downloads -->',
    '## Download / 下载',
    '| System | File |',
    '| --- | --- |',
    '| macOS | DS-Bot.zip |',
    '<!-- /downloads -->',
    '',
    '### Added',
    '- **Release notes**: Show concise [highlights](https://example.com) with `auto` popup. (by @alice; [#2341](https://github.com/Fei-Craft/DS-Bot/issues/2341), [#2350](https://github.com/Fei-Craft/DS-Bot/pull/2350))',
    '- Strip `</DSML ...>` leakage without eating code span and drop <b>HTML</b> tags (#1234)',
  ].join('\n')

  const parsed = parseChangelog(md)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].version, '0.3.11')
  assert.equal(parsed[0].date, '2026-11-28')
  assert.deepEqual(parsed[0].notes.en.items, [
    'Release notes: Show concise highlights with auto popup.',
    'Strip </DSML ...> leakage without eating code span and drop HTML tags',
  ])
  assert.equal(cleanChangelogLine('**Bold** `code` (#42, reverts #41)'), 'Bold code')
  assert.equal(cleanChangelogLine('Fix `</DSML …>` leak and <br> break (#88)'), 'Fix </DSML …> leak and break')

  const merged = buildReleaseNotesData({
    sourceEntries: [{ version: '0.3.10', date: '2026-11-22', notes: { en: ['Hand-written'] } }],
    changelogText: md,
  })
  assert.deepEqual(merged.map(e => e.version), ['0.3.11', '0.3.10'])
})

test('SemVer comparison, current-only pending version selection, and locale fallbacks', () => {
  assert.equal(cleanSemver('v0.3.10+build.42'), '0.3.10')
  assert.equal(compareSemver('0.3.10+a', '0.3.10+b'), 0)
  assert.equal(compareSemver('0.3.10', '0.3.10-rc.1'), 1)
  assert.equal(compareSemver('0.3.10', '0.3.9'), 1)
  assert.equal(compareSemver('0.3.8', '0.3.10'), -1)

  const sample = [
    { version: '0.3.10', date: '2026-11-22', notes: { zh: { items: ['十'] }, en: { items: ['ten'] } } },
    { version: '0.3.9', date: '2026-11-21', notes: { zh: { items: ['九'] }, en: { items: ['nine'] } } },
    { version: '0.3.8', date: '2026-11-16', notes: { en: { items: ['eight'] } } },
  ]
  // Legacy upgrade without lastSeenVersion shows only current release.
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.10', lastSeenVersion: null, releases: sample }), ['0.3.10'])
  // Multi-version upgrade also returns ONLY current release (never piles older versions).
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.10', lastSeenVersion: '0.3.8', releases: sample }), ['0.3.10'])
  // Current version with no entry stays empty.
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.11', lastSeenVersion: '0.3.8', releases: sample }), [])
  // Same version / build metadata only / downgrade stay silent.
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.10+meta', lastSeenVersion: '0.3.10', releases: sample }), [])
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.8', lastSeenVersion: '0.3.10', releases: sample }), [])

  // Locale fallback: zh-TW -> zh -> en; unknown -> en.
  assert.equal(selectReleaseNotes(sample[0], 'zh-TW').locale, 'zh')
  assert.equal(selectReleaseNotes(sample[2], 'zh-TW').locale, 'en')
  assert.equal(selectReleaseNotes(sample[0], 'ja').locale, 'en')
  assert.equal(selectReleaseNotes(sample[0], 'zh-CN').locale, 'zh')
  assert.ok(RELEASE_NOTES.some(entry => entry.version === '0.3.10'))
})

// ---------------------------------------------------------------------------
// 2. Host persistence, fresh-install silence, upgrade claim concurrency & ELOCKLOST

function startHost({ home, appVersion = '0.3.10' }) {
  let nextSession = 1
  const sessions = new Map()
  const sessionController = {
    create: async () => {
      const id = `sess-${nextSession++}`
      const session = { id, status: 'idle', title: '' }
      sessions.set(id, { id, session })
      return { sessionId: id }
    },
    resolveAgent: async id => ({ agent: { session: sessions.get(id)?.session ?? { id }, setModel: async () => {} } }),
    page: async () => ({ records: [], hasMore: false }),
  }
  const workspaces = new Map()
  const workspaceRegistry = {
    get: id => workspaces.get(id),
    resolveByPath: async path => [...workspaces.values()].find(w => w.path === path),
    create: async (path, name) => {
      const ws = { id: 'ws-1', path, name }
      workspaces.set(ws.id, ws)
      return ws
    },
    list: async () => [...workspaces.values()],
  }
  const sessionTitle = { rename: async (session, title) => { if (session) session.title = title } }
  const sessionStore = { get: id => sessions.get(id)?.session, list: () => [...sessions.values()].map(x => x.session) }
  const ctx = fakeContext({ services: { sessionController, workspaceRegistry, sessionTitle, sessions: sessionStore } })
  ctx.sessionController = sessionController
  ctx.workspaceRegistry = workspaceRegistry
  ctx.sessionTitle = sessionTitle
  ctx.sessions = sessionStore
  const rt = createRuntime(ctx, { home, workspace: join(home, 'workspace'), appVersion, github: false, diagnosticsFile: false })
  return { ctx, rt }
}

test('host: fresh install records lastSeenVersion silently without pending release notes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-rn-fresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prevEnv = process.env.DS_BOT_APP_VERSION
  delete process.env.DS_BOT_APP_VERSION
  t.after(() => { if (prevEnv === undefined) delete process.env.DS_BOT_APP_VERSION; else process.env.DS_BOT_APP_VERSION = prevEnv })

  const { ctx, rt } = startHost({ home: dir, appVersion: '0.3.10' })
  t.after(() => ctx.dispose())
  const res = await rt.channelCall('state', {})
  assert.equal(res.ok, true)
  assert.deepEqual(res.value.releaseNotes, { current: '0.3.10', lastSeenVersion: '0.3.10', pending: [] })
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.lastSeenVersion, '0.3.10')
})

test('host: legacy team without lastSeenVersion shows only current release and claims once across concurrent calls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-rn-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['bot-1'],
    bots: { 'bot-1': { id: 'bot-1', name: 'Chief', role: '', instructions: '', capabilities: [], packs: [] } },
    rooms: {},
    agents: {},
    sections: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    prefs: {},
    revision: 3,
  }))

  const { ctx, rt } = startHost({ home: dir, appVersion: '0.3.10' })
  t.after(() => ctx.dispose())
  const stateRes = await rt.channelCall('state', {})
  assert.equal(stateRes.ok, true)
  assert.deepEqual(stateRes.value.releaseNotes, { current: '0.3.10', lastSeenVersion: null, pending: ['0.3.10'] })

  // Remote/relay state must omit releaseNotes and reject release-notes-claim.
  const remoteState = await rt.channelCall('state', {}, undefined, true)
  assert.equal(remoteState.ok, true)
  assert.equal('releaseNotes' in remoteState.value, false)
  const remoteClaim = await rt.channelCall('release-notes-claim', { version: '0.3.10' }, undefined, true)
  assert.equal(remoteClaim.ok, false)

  // Concurrent local claims serialize so only one window wins.
  const [first, second] = await Promise.all([
    rt.channelCall('release-notes-claim', { version: '0.3.10' }),
    rt.channelCall('release-notes-claim', { version: '0.3.10' }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual([first.value.claimed, second.value.claimed].sort(), [false, true])

  const afterState = await rt.channelCall('state', {})
  assert.deepEqual(afterState.value.releaseNotes, { current: '0.3.10', lastSeenVersion: '0.3.10', pending: [] })
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.lastSeenVersion, '0.3.10')
})

test('host: multi-version upgrade reports only current release; downgrade stays silent and preserves lastSeenVersion', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-rn-multi-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    lastSeenVersion: '0.3.8',
    mainBotIds: ['bot-1'],
    bots: { 'bot-1': { id: 'bot-1', name: 'Chief', role: '', instructions: '', capabilities: [], packs: [] } },
    rooms: {},
    agents: {},
    sections: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    prefs: {},
    revision: 2,
  }))

  const prevEnv = process.env.DS_BOT_APP_VERSION
  process.env.DS_BOT_APP_VERSION = '0.3.10'
  t.after(() => { if (prevEnv === undefined) delete process.env.DS_BOT_APP_VERSION; else process.env.DS_BOT_APP_VERSION = prevEnv })

  const { ctx, rt } = startHost({ home: dir, appVersion: '0.3.9' })
  const res = await rt.channelCall('state', {})
  assert.equal(res.ok, true)
  // DS_BOT_APP_VERSION takes precedence over package fallback, and pending holds only current.
  assert.deepEqual(res.value.releaseNotes, { current: '0.3.10', lastSeenVersion: '0.3.8', pending: ['0.3.10'] })
  // Version mismatch is rejected.
  const wrong = await rt.channelCall('release-notes-claim', { version: '0.3.9' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.code, 'bot/invalid')
  await ctx.dispose()

  // Downgrade check: lastSeenVersion 0.3.10 under current 0.3.9 stays silent and never rolls back.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    lastSeenVersion: '0.3.10',
    mainBotIds: ['bot-1'],
    bots: { 'bot-1': { id: 'bot-1', name: 'Chief', role: '', instructions: '', capabilities: [], packs: [] } },
    rooms: {},
    agents: {},
    sections: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    prefs: {},
    revision: 4,
  }))
  process.env.DS_BOT_APP_VERSION = '0.3.9'
  const down = startHost({ home: dir, appVersion: '0.3.9' })
  t.after(() => down.ctx.dispose())
  const downRes = await down.rt.channelCall('state', {})
  assert.deepEqual(downRes.value.releaseNotes, { current: '0.3.9', lastSeenVersion: '0.3.10', pending: [] })
  const downClaim = await down.rt.channelCall('release-notes-claim', { version: '0.3.9' })
  assert.equal(downClaim.ok, true)
  assert.equal(downClaim.value.claimed, false)
  assert.equal(down.rt.state.lastSeenVersion, '0.3.10')
})

test('host: save failure rolls back lastSeenVersion, ELOCKLOST preserves disk value, read-only rejects claim', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-rn-fail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    lastSeenVersion: '0.3.9',
    mainBotIds: ['bot-1'],
    bots: { 'bot-1': { id: 'bot-1', name: 'Chief', role: '', instructions: '', capabilities: [], packs: [] } },
    rooms: {},
    agents: {},
    sections: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    prefs: {},
    revision: 1,
  }))

  const { ctx, rt } = startHost({ home: dir, appVersion: '0.3.10' })
  t.after(() => ctx.dispose())
  await rt.load()

  const realSave = rt.save
  rt.save = async () => { throw new Error('disk full') }
  const failed = await rt.channelCall('release-notes-claim', { version: '0.3.10' })
  assert.equal(failed.ok, false)
  assert.equal(rt.state.lastSeenVersion, '0.3.9')
  assert.deepEqual(rt.releaseNotesView().pending, ['0.3.10'])

  // ELOCKLOST: another process took the lock and save() adopted its newer state from disk.
  // claimReleaseNotes must NOT roll state.lastSeenVersion back over the adopted value.
  rt.save = async () => {
    rt.state.lastSeenVersion = '0.3.10'
    throw Object.assign(new Error('lock lost'), { code: 'ELOCKLOST' })
  }
  const lockLost = await rt.channelCall('release-notes-claim', { version: '0.3.10' })
  assert.equal(lockLost.ok, false)
  assert.equal(rt.state.lastSeenVersion, '0.3.10')

  // Reset to 0.3.9 on disk and verify retry succeeds once save works.
  rt.state.lastSeenVersion = '0.3.9'
  rt.save = realSave
  const retried = await rt.channelCall('release-notes-claim', { version: '0.3.10' })
  assert.equal(retried.ok, true)
  assert.equal(retried.value.claimed, true)
  assert.equal(rt.state.lastSeenVersion, '0.3.10')

  // A host against a home locked by another live process is read-only and blocked from claiming.
  const roDir = mkdtempSync(join(tmpdir(), 'dsb-rn-ro-'))
  t.after(() => rmSync(roDir, { recursive: true, force: true }))
  writeFileSync(join(roDir, 'state.json'), JSON.stringify({
    version: 1,
    lastSeenVersion: '0.3.9',
    mainBotIds: ['bot-1'],
    bots: { 'bot-1': { id: 'bot-1', name: 'Chief', role: '', instructions: '', capabilities: [], packs: [] } },
    rooms: {},
    agents: {},
    sections: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    prefs: {},
    revision: 1,
  }))
  writeFileSync(join(roDir, 'state.lock'), JSON.stringify({
    pid: process.ppid,
    host: hostname(),
    token: 'other-live-host',
    since: Date.now(),
  }))
  const ro = startHost({ home: roDir, appVersion: '0.3.10' })
  t.after(() => ro.ctx.dispose())
  const roClaim = await ro.rt.channelCall('release-notes-claim', { version: '0.3.10' })
  assert.equal(roClaim.ok, false)
  assert.equal(roClaim.error.code, 'bot/read-only')
})

// ---------------------------------------------------------------------------
// 3. Real React + JSDOM tests: AboutPage, ReleaseNotesDialog, Overlays, SettingsShell

const primitivesStub = new Proxy({}, {
  get: (_, key) => {
    if (key === 'Tooltip') return ({ children }) => children ?? null
    if (key === 'ConnectionIndicator' || key === 'Modal' || key === 'Button') return () => null
    return () => null
  },
})

async function buildBundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: pluginDir },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

function loadWithRealReact(code) {
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDOM
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    return req(id)
  })
  return mod.exports
}

function withDom(run) {
  return async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
    const prev = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver,
      ResizeObserver: globalThis.ResizeObserver,
      KeyboardEvent: globalThis.KeyboardEvent,
      Event: globalThis.Event,
      localStorage: globalThis.localStorage,
      getComputedStyle: globalThis.getComputedStyle,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
      dsBotApp: globalThis.dsBotApp,
    }

    dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => false })
    globalThis.window = dom.window
    globalThis.document = dom.window.document
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    })
    globalThis.HTMLElement = dom.window.HTMLElement
    globalThis.Element = dom.window.Element
    globalThis.Node = dom.window.Node
    globalThis.MutationObserver = dom.window.MutationObserver
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    globalThis.KeyboardEvent = dom.window.KeyboardEvent
    globalThis.Event = dom.window.Event
    globalThis.localStorage = dom.window.localStorage
    globalThis.getComputedStyle = dom.window.getComputedStyle
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0)
    globalThis.cancelAnimationFrame = id => clearTimeout(id)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    delete globalThis.dsBotApp

    const { createRoot } = await import('react-dom/client')
    const container = dom.window.document.getElementById('root')
    const root = createRoot(container)
    try {
      await run({ dom, root, container })
    } finally {
      await act(async () => { root.unmount() })
      dom.window.close()
      globalThis.window = prev.window
      globalThis.document = prev.document
      if (prev.navigator) Object.defineProperty(globalThis, 'navigator', prev.navigator)
      globalThis.HTMLElement = prev.HTMLElement
      globalThis.Element = prev.Element
      globalThis.Node = prev.Node
      globalThis.MutationObserver = prev.MutationObserver
      globalThis.ResizeObserver = prev.ResizeObserver
      globalThis.KeyboardEvent = prev.KeyboardEvent
      globalThis.Event = prev.Event
      globalThis.localStorage = prev.localStorage
      globalThis.getComputedStyle = prev.getComputedStyle
      globalThis.requestAnimationFrame = prev.requestAnimationFrame
      globalThis.cancelAnimationFrame = prev.cancelAnimationFrame
      globalThis.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT
      if (prev.dsBotApp === undefined) delete globalThis.dsBotApp
      else globalThis.dsBotApp = prev.dsBotApp
    }
  }
}

function makeStore(initial) {
  let snap = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snap,
    set: (next) => {
      snap = typeof next === 'function' ? next(snap) : next
      for (const listener of [...listeners]) listener()
    },
    use: (selector = v => v) => useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      () => selector(snap),
    ),
  }
}

let uiBundlePromise = null
const getUiBundleCode = () => (uiBundlePromise ??= buildBundle(`
  export { AboutPage } from './src/client/about.js'
  export { ReleaseNotesDialog } from './src/client/release-notes-dialog.js'
  export { Overlays } from './src/client/overlays.js'
  export { SettingsShell } from './src/client/settings-shell.js'
  export { useEscape } from './src/client/overlay-hooks.js'
`))

test('AboutPage renders in-app Release notes button even without notesUrl', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/about.js', import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const react = {
    createContext: initial => ({ value: initial, Provider: ({ children }) => children }),
    useContext: ctx => ctx.value,
    useMemo: make => make(),
    useCallback: fn => fn,
    useId: () => 'id',
    useSyncExternalStore: (_, get) => get(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useRef: current => ({ current }),
    useLayoutEffect: () => {},
  }
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports, URL, setTimeout, clearTimeout, require: name => (name === 'react' ? react : {}) })
  const opened = []
  const tree = mod.exports.AboutPage({
    useUpdate: s => s({ current: '0.3.10' }),
    actions: { repoStars: async () => null, openSettings() {}, openReleaseNotes: opts => opened.push(opts) },
    run: p => p,
    Section: 'section',
    Row: 'row',
  })
  const find = (node, pred) => {
    if (Array.isArray(node)) return node.flatMap(n => find(n, pred))
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (typeof node !== 'object') return pred(node) ? [node] : []
    if (typeof node.type === 'function') return find(node.type({ ...node.props, children: node.children }), pred)
    return [...(pred(node) ? [node] : []), ...find(node.children, pred)]
  }
  const [rnRow] = find(tree, n => n.type === 'row' && n.props?.label === 'Release notes')
  assert.ok(rnRow, 'Release notes row is always present offline')
  const [btn] = find(rnRow.children, n => n.type === 'button')
  assert.ok(btn)
  btn.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ current: '0.3.10', notesUrl: null }])
})

test('ReleaseNotesDialog shows only current version (never older ones), renders empty state on missing version, and respects Escape priority & focus restore', withDom(async ({ dom, root }) => {
  const { ReleaseNotesDialog, useEscape } = loadWithRealReact(await getUiBundleCode())
  const sampleReleases = [
    { version: '0.3.10', date: '2026-11-22', notes: { en: { intro: 'Short intro.', items: ['Highlight A'], outro: 'Thanks!' } } },
    { version: '0.3.9', date: '2026-11-21', notes: { en: { items: ['Earlier B'] } } },
  ]

  const prevBtn = dom.window.document.createElement('button')
  dom.window.document.body.append(prevBtn)
  prevBtn.focus()

  const closed = []
  function Harness({ open, current }) {
    useEscape(() => closed.push('settings'), true, { priority: 0 })
    return open
      ? React.createElement(ReleaseNotesDialog, {
          current,
          releases: sampleReleases,
          onClose: () => closed.push('release-notes'),
        })
      : null
  }

  // Case 1: exact current version shows ONLY 0.3.10 (no older version, no Earlier versions toggle).
  await act(async () => {
    root.render(React.createElement(Harness, { open: true, current: '0.3.10' }))
  })
  const dialog = dom.window.document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.match(dialog.textContent, /What's new in v0\.3\.10/)
  assert.match(dialog.textContent, /Short intro\./)
  assert.match(dialog.textContent, /Highlight A/)
  assert.match(dialog.textContent, /Thanks!/)
  assert.doesNotMatch(dialog.textContent, /Earlier B|Earlier versions|Hide earlier/)
  assert.ok(dialog.querySelector('a.bt-rn-link'))

  // Escape closes only ReleaseNotesDialog, not underlying Settings layer.
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.deepEqual(closed, ['release-notes'])

  // Case 2: current version has no entry -> shows empty state and never substitutes older 0.3.10.
  await act(async () => {
    root.render(React.createElement(Harness, { open: true, current: '0.3.11' }))
  })
  const missingDialog = dom.window.document.querySelector('[role="dialog"]')
  assert.match(missingDialog.textContent, /What's new in v0\.3\.11/)
  assert.match(missingDialog.textContent, /No release notes for this version yet\./)
  assert.doesNotMatch(missingDialog.textContent, /Highlight A|Earlier B|2026-11-22/)
  assert.ok(missingDialog.querySelector('a.bt-rn-link'))

  // Closing restores focus to previous button.
  await act(async () => {
    root.render(React.createElement(Harness, { open: false, current: '0.3.10' }))
  })
  assert.equal(dom.window.document.activeElement, prevBtn)
}))

test('Overlays converges render count when ReleaseNotesDialog opens (no useLinger infinite re-render loop)', withDom(async ({ dom, root }) => {
  const { Overlays } = loadWithRealReact(await getUiBundleCode())
  const rosterStore = makeStore({
    ready: true,
    readOnly: false,
    telemetryPrompt: false,
    releaseNotes: { current: '0.3.10', lastSeenVersion: '0.3.10', pending: [] },
    bots: [],
    rooms: [],
    byId: {},
    roomsById: {},
    prefs: {},
  })
  const uiStore = makeStore({ releaseNotes: null, settings: null, memory: null, menu: null })
  const emptyStore = makeStore({})
  const sessionsStore = makeStore({ byId: {} })
  const statusStore = makeStore(new Map())
  const updateStore = makeStore({ notesUrl: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v0.3.10' })
  const shellHeldStore = makeStore(false)

  let renders = 0
  function TrackedOverlays(props) {
    renders += 1
    return React.createElement(Overlays, props)
  }

  const actions = {
    closeReleaseNotes: () => uiStore.set(s => ({ ...s, releaseNotes: null })),
    claimReleaseNotes: async () => ({ claimed: false }),
  }
  const props = {
    useRoster: rosterStore.use,
    useUi: uiStore.use,
    useSessions: sessionsStore.use,
    useSessionStatus: statusStore.use,
    useActivity: emptyStore.use,
    useWork: emptyStore.use,
    useComputer: emptyStore.use,
    useRegistry: emptyStore.use,
    useBrowserPages: emptyStore.use,
    useBrowserTabs: emptyStore.use,
    useBrowserHolds: emptyStore.use,
    useBotCompletions: emptyStore.use,
    useUpdate: updateStore.use,
    useSettingsShellHeld: shellHeldStore.use,
    actions,
  }

  await act(async () => { root.render(React.createElement(TrackedOverlays, props)) })
  const beforeOpen = renders

  await act(async () => {
    uiStore.set(s => ({ ...s, releaseNotes: { mode: 'manual', current: '0.3.10', notesUrl: null } }))
  })
  await new Promise(resolve => setTimeout(resolve, 40))

  const afterOpen = renders
  assert.ok(dom.window.document.querySelector('.bt-rn-dialog'), 'ReleaseNotesDialog is mounted')
  assert.ok(afterOpen - beforeOpen <= 4, `Expected converged render count (<= 4), got ${afterOpen - beforeOpen}`)

  // Wait another tick to prove renders have completely stopped.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, afterOpen, 'No further renders occur while ReleaseNotesDialog stays open')
}))

test('Overlays triggers auto release notes when shellHeld is true (DSH plugin), suppresses under ui.settings, and never deadlocks TelemetryNotice', withDom(async ({ dom, root }) => {
  const { Overlays } = loadWithRealReact(await getUiBundleCode())

  const makeProps = ({ claimResult, uiSettings = null, includeClaimAction = true }) => {
    const claimCalls = []
    const rosterStore = makeStore({
      ready: true,
      readOnly: false,
      telemetryPrompt: true,
      releaseNotes: { current: '0.3.10', lastSeenVersion: '0.3.9', pending: ['0.3.10'] },
      bots: [],
      rooms: [],
      byId: {},
      roomsById: {},
      prefs: {},
    })
    const uiStore = makeStore({ releaseNotes: null, settings: uiSettings, memory: null, menu: null })
    const emptyStore = makeStore({})
    const sessionsStore = makeStore({ byId: {} })
    const statusStore = makeStore(new Map())
    const updateStore = makeStore({})
    // DSH plugin side always mounts SettingsShell, so shellHeld is true even when Settings is closed.
    const shellHeldStore = makeStore(true)
    const actions = {
      closeReleaseNotes: () => uiStore.set(s => ({ ...s, releaseNotes: null })),
      setPrefs: async () => {},
      ...(includeClaimAction ? {
        claimReleaseNotes: async (ver) => {
          claimCalls.push(ver)
          return claimResult
        },
      } : {}),
    }
    return {
      claimCalls,
      uiStore,
      rosterStore,
      props: {
        useRoster: rosterStore.use,
        useUi: uiStore.use,
        useSessions: sessionsStore.use,
        useSessionStatus: statusStore.use,
        useActivity: emptyStore.use,
        useWork: emptyStore.use,
        useComputer: emptyStore.use,
        useRegistry: emptyStore.use,
        useBrowserPages: emptyStore.use,
        useBrowserTabs: emptyStore.use,
        useBrowserHolds: emptyStore.use,
        useBotCompletions: emptyStore.use,
        useUpdate: updateStore.use,
        useSettingsShellHeld: shellHeldStore.use,
        actions,
      },
    }
  }

  // Subcase A: shellHeld === true, ui.settings === null, claim wins -> shows ReleaseNotesDialog first,
  // then TelemetryNotice appears after closing ReleaseNotesDialog.
  const caseA = makeProps({ claimResult: { claimed: true, version: '0.3.10' } })
  await act(async () => { root.render(React.createElement(Overlays, caseA.props)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.deepEqual(caseA.claimCalls, ['0.3.10'])
  assert.ok(dom.window.document.querySelector('.bt-rn-dialog'), 'Auto release notes opens even when shellHeld === true')
  assert.equal(dom.window.document.querySelector('.bt-priv-dialog'), null, 'TelemetryNotice waits while release notes is open')

  const okBtn = dom.window.document.querySelector('.bt-rn-ok')
  await act(async () => { okBtn.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(dom.window.document.querySelector('.bt-rn-dialog'), null)
  assert.ok(dom.window.document.querySelector('.bt-priv-dialog'), 'TelemetryNotice opens after release notes closes')

  // Subcase B: claim loses ({ claimed: false }) -> does NOT deadlock TelemetryNotice.
  await act(async () => { root.render(null) })
  const caseB = makeProps({ claimResult: { claimed: false, version: '0.3.10' } })
  await act(async () => { root.render(React.createElement(Overlays, caseB.props)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.deepEqual(caseB.claimCalls, ['0.3.10'])
  assert.equal(dom.window.document.querySelector('.bt-rn-dialog'), null)
  assert.ok(dom.window.document.querySelector('.bt-priv-dialog'), 'TelemetryNotice is unlocked when claim returns claimed: false')

  // Subcase C: ui.settings is open while shellHeld === true -> suppresses both auto release notes and TelemetryNotice.
  await act(async () => { root.render(null) })
  const caseC = makeProps({ claimResult: { claimed: true, version: '0.3.10' }, uiSettings: { page: 'about', id: null } })
  await act(async () => { root.render(React.createElement(Overlays, caseC.props)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.deepEqual(caseC.claimCalls, [], 'Auto release notes is suppressed while ui.settings is open')
  assert.equal(dom.window.document.querySelector('.bt-rn-dialog'), null)
  assert.equal(dom.window.document.querySelector('.bt-priv-dialog'), null)

  // Subcase D: claimReleaseNotes missing -> releaseNotesPendingHere stays false so TelemetryNotice is not deadlocked.
  await act(async () => { root.render(null) })
  const caseD = makeProps({ claimResult: { claimed: false }, includeClaimAction: false })
  await act(async () => { root.render(React.createElement(Overlays, caseD.props)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(dom.window.document.querySelector('.bt-priv-dialog'), 'TelemetryNotice is not blocked when claimReleaseNotes is absent')

  // Subcase E: an active foreign modal defers auto release notes until the modal closes, then resumes automatically.
  await act(async () => { root.render(null) })
  const foreignModal = dom.window.document.createElement('div')
  foreignModal.setAttribute('role', 'alertdialog')
  foreignModal.setAttribute('aria-modal', 'true')
  dom.window.document.body.appendChild(foreignModal)
  const caseE = makeProps({ claimResult: { claimed: true, version: '0.3.10' } })
  await act(async () => { root.render(React.createElement(Overlays, caseE.props)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) })
  assert.deepEqual(caseE.claimCalls, [], 'Auto release notes waits while a foreign modal is open')
  assert.equal(dom.window.document.querySelector('.bt-rn-dialog'), null)

  await act(async () => { foreignModal.remove() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.deepEqual(caseE.claimCalls, ['0.3.10'], 'Auto release notes claims automatically once the foreign modal closes')
  assert.ok(dom.window.document.querySelector('.bt-rn-dialog'), 'ReleaseNotesDialog opens after the foreign modal leaves')
}))

test('SettingsShell renders manual ReleaseNotesDialog in Classic Agent mode (without Overlays), holds styles, and isolates Escape', withDom(async ({ dom, root }) => {
  const { SettingsShell } = loadWithRealReact(await getUiBundleCode())
  const uiStore = makeStore({ settings: { page: 'about', id: null }, releaseNotes: null })
  const rosterStore = makeStore({
    ready: true,
    bots: [],
    rooms: [],
    models: [],
    byId: {},
    roomsById: {},
    prefs: {},
    releaseNotes: { current: '0.3.10', lastSeenVersion: '0.3.10', pending: [] },
  })
  const updateStore = makeStore({ current: '0.3.10', notesUrl: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v0.3.10' })
  const emptyList = makeStore([])
  const sessionsStore = makeStore({ phase: 'ready', byId: {} })
  const undefStore = makeStore(undefined)
  const connStore = makeStore('connected')
  const deskUpdateStore = makeStore({})

  let lookHeld = 0
  let lookReleases = 0
  const events = []
  const actions = {
    openSettings: () => {},
    closeSettings: () => { events.push('closeSettings'); uiStore.set(s => ({ ...s, settings: null })) },
    openReleaseNotes: opts => uiStore.set(s => ({ ...s, releaseNotes: { mode: 'manual', ...opts } })),
    closeReleaseNotes: () => { events.push('closeReleaseNotes'); uiStore.set(s => ({ ...s, releaseNotes: null })) },
    holdSettingsLook: () => { lookHeld += 1; return () => { lookReleases += 1 } },
    repoStars: async () => null,
    diagnostics: async () => ({}),
    surfaceMode: () => 'agent',
  }

  const props = {
    wide: true,
    renderSlot: () => null,
    actions,
    useUi: uiStore.use,
    useRoster: rosterStore.use,
    useUpdate: updateStore.use,
    useSessions: sessionsStore.use,
    useSections: emptyList.use,
    useGeneralItems: emptyList.use,
    useOnboardingSteps: emptyList.use,
    useOnboardingRequest: undefStore.use,
    useConnectionState: connStore.use,
    useDesktopUpdate: deskUpdateStore.use,
    useSettingsShortcut: undefStore.use,
    reconnect: () => {},
    openDesktopUpdate: () => {},
    openOnboarding: () => {},
    finishOnboarding: () => {},
    holdSeat: () => () => {},
  }

  // Mount SettingsShell alone (Overlays is unmounted in Classic Agent mode).
  await act(async () => { root.render(React.createElement(SettingsShell, props)) })
  assert.equal(lookHeld, 1)
  assert.equal(lookReleases, 0)

  // Open ReleaseNotesDialog from About page while Settings is open.
  await act(async () => {
    actions.openReleaseNotes({ current: '0.3.10', notesUrl: null })
  })
  const rnDialog = dom.window.document.querySelector('.bt-rn-dialog')
  assert.ok(rnDialog, 'SettingsShell renders ReleaseNotesDialog even when Overlays is not mounted')
  assert.match(rnDialog.textContent, /What's new in v0\.3\.10/)

  // Tab and Shift+Tab stay trapped inside ReleaseNotesDialog instead of reaching covered Settings controls.
  const rnClose = rnDialog.querySelector('.bt-rn-close')
  const rnOk = rnDialog.querySelector('.bt-rn-ok')
  assert.equal(dom.window.document.activeElement, rnDialog)
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(dom.window.document.activeElement, rnOk, 'Shift+Tab from dialog wraps to last focusable control inside dialog')
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  })
  assert.equal(dom.window.document.activeElement, rnClose, 'Tab from last control wraps to first focusable control inside dialog')

  // Pressing Escape closes only ReleaseNotesDialog, leaving Settings open.
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.deepEqual(events, ['closeReleaseNotes'])

  // Even if Settings closes while ReleaseNotesDialog stays open, holdSettingsLook stays active until ReleaseNotesDialog closes.
  await act(async () => {
    uiStore.set({ settings: null, releaseNotes: { mode: 'manual', current: '0.3.10', notesUrl: null } })
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(lookReleases, 0, 'holdSettingsLook remains held while ReleaseNotesDialog is open')
  assert.ok(dom.window.document.querySelector('.bt-rn-dialog'))

  await act(async () => {
    uiStore.set({ settings: null, releaseNotes: null })
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(lookReleases, 1, 'holdSettingsLook releases once both Settings and ReleaseNotesDialog close')
}))
