import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
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
  releasesUpTo,
  selectReleaseNotes,
} from '../src/shared/release-notes.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const pluginDir = fileURLToPath(new URL('..', import.meta.url))

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

test('parseChangelog skips [Unreleased], strips download blocks, tables, Markdown, and PR/issue citations', () => {
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
    '- Plain improvement (#1234)',
  ].join('\n')

  const parsed = parseChangelog(md)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].version, '0.3.11')
  assert.equal(parsed[0].date, '2026-11-28')
  assert.deepEqual(parsed[0].notes.en.items, [
    'Release notes: Show concise highlights with auto popup.',
    'Plain improvement',
  ])
  assert.equal(cleanChangelogLine('**Bold** `code` (#42, reverts #41)'), 'Bold code')

  const merged = buildReleaseNotesData({
    sourceEntries: [{ version: '0.3.10', date: '2026-11-22', notes: { en: ['Hand-written'] } }],
    changelogText: md,
  })
  assert.deepEqual(merged.map(e => e.version), ['0.3.11', '0.3.10'])
})

test('SemVer comparison, pending version selection, and locale fallbacks', () => {
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
  // Multi-version upgrade merges lastSeenVersion < v <= current newest first.
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.10', lastSeenVersion: '0.3.8', releases: sample }), ['0.3.10', '0.3.9'])
  // Same version / build metadata only / downgrade stay silent.
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.10+meta', lastSeenVersion: '0.3.10', releases: sample }), [])
  assert.deepEqual(pendingReleaseVersions({ current: '0.3.8', lastSeenVersion: '0.3.10', releases: sample }), [])
  // History helper filters releases above current.
  assert.deepEqual(releasesUpTo('0.3.9', sample).map(e => e.version), ['0.3.9', '0.3.8'])

  // Locale fallback: zh-TW -> zh -> en; unknown -> en.
  assert.equal(selectReleaseNotes(sample[0], 'zh-TW').locale, 'zh')
  assert.equal(selectReleaseNotes(sample[2], 'zh-TW').locale, 'en')
  assert.equal(selectReleaseNotes(sample[0], 'ja').locale, 'en')
  assert.equal(selectReleaseNotes(sample[0], 'zh-CN').locale, 'zh')
  assert.ok(RELEASE_NOTES.some(entry => entry.version === '0.3.10'))
})

// ---------------------------------------------------------------------------
// 2. Host persistence, fresh-install silence, upgrade claim concurrency & read-only

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

test('host: multi-version upgrade merges intermediate releases; downgrade stays silent and preserves lastSeenVersion', async (t) => {
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
  // DS_BOT_APP_VERSION takes precedence over package fallback.
  assert.deepEqual(res.value.releaseNotes, { current: '0.3.10', lastSeenVersion: '0.3.8', pending: ['0.3.10', '0.3.9'] })
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

test('host: save failure rolls back lastSeenVersion so retry can claim; read-only host rejects claim', async (t) => {
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

  // Retry succeeds once disk recovers.
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
// 3. Shared dialog, About button, Escape priority, focus restore, overlay order

async function loadClientModule(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

test('AboutPage renders in-app Release notes button even without notesUrl', async () => {
  const code = await loadClientModule('../src/client/about.js')
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
  runInNewContext(code, { module: mod, exports: mod.exports, URL, setTimeout, clearTimeout, require: name => (name === 'react' ? react : {}) })
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

test('ReleaseNotesDialog supports focus restore, Escape priority, optional intro/outro, and manual history toggle', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { ReleaseNotesDialog } from './src/client/release-notes-dialog.js'
        export { useEscape } from './src/client/overlay-hooks.js'
      `,
      resolveDir: pluginDir,
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })

  const listeners = new Map()
  const focusCalls = []
  const prevButton = { isConnected: true, focus: () => focusCalls.push('prev') }
  const win = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  }
  const doc = { activeElement: prevButton }
  const cleanups = []
  let showEarlier = false
  let stateSetter = null
  const react = {
    createContext: initial => ({ value: initial, Provider: ({ children }) => children }),
    useContext: ctx => ctx.value,
    useMemo: make => make(),
    useCallback: fn => fn,
    useId: () => 'rn-title',
    useState: () => {
      const val = showEarlier
      stateSetter = (next) => { showEarlier = typeof next === 'function' ? next(showEarlier) : next }
      return [val, stateSetter]
    },
    useEffect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    useRef: (initial) => ({ current: initial }),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  }

  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    window: win,
    document: doc,
    URL,
    require: name => (name === 'react' ? react : {}),
  })

  const { ReleaseNotesDialog, useEscape } = mod.exports
  const closed = []
  // Register a lower-priority Escape layer (like Settings dialog at priority 0).
  useEscape(() => closed.push('settings'), true, { priority: 0 })

  const sampleReleases = [
    { version: '0.3.10', date: '2026-11-22', notes: { en: { intro: 'Short intro.', items: ['Highlight A'], outro: 'Thanks!' } } },
    { version: '0.3.9', date: '2026-11-21', notes: { en: { items: ['Earlier B'] } } },
  ]
  const tree = ReleaseNotesDialog({
    mode: 'manual',
    current: '0.3.10',
    releases: sampleReleases,
    onClose: () => closed.push('release-notes'),
  })

  const find = (node, pred) => {
    if (Array.isArray(node)) return node.flatMap(n => find(n, pred))
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (typeof node !== 'object') return pred(node) ? [node] : []
    if (typeof node.type === 'function') return find(node.type({ ...node.props, children: node.children }), pred)
    return [...(pred(node) ? [node] : []), ...find(node.children, pred)]
  }
  const [dialog] = find(tree, n => n.props?.role === 'dialog')
  assert.equal(dialog.props['aria-modal'], true)

  // Verify intro, items, outro, and history toggle rendered.
  const allText = find(tree, n => typeof n === 'string').join(' ')
  assert.match(allText, /Short intro\./)
  assert.match(allText, /Highlight A/)
  assert.match(allText, /Thanks!/)
  assert.doesNotMatch(allText, /Earlier B/)

  // Escape closes only ReleaseNotesDialog, not the underlying Settings layer.
  for (const fn of Array.from(listeners.get('keydown') ?? [])) {
    fn({ key: 'Escape', defaultPrevented: false, isComposing: false })
  }
  assert.deepEqual(closed, ['release-notes'])

  // Toggle earlier versions and re-render.
  const [toggleBtn] = find(tree, n => n.props?.className === 'bt-rn-history-toggle')
  assert.ok(toggleBtn)
  toggleBtn.props.onClick()
  cleanups.length = 0
  const expanded = ReleaseNotesDialog({
    mode: 'manual',
    current: '0.3.10',
    releases: sampleReleases,
    onClose: () => {},
  })
  const expandedText = find(expanded, n => typeof n === 'string').join(' ')
  assert.match(expandedText, /Earlier B/)

  // Cleanup restores previous focus.
  for (const fn of cleanups) fn()
  assert.deepEqual(focusCalls, ['prev'])
})

test('Overlays prioritizes release notes before TelemetryNotice and survives post-claim roster pull', async () => {
  const overlaysSource = readFileSync(new URL('../src/client/overlays.js', import.meta.url), 'utf8')
  assert.match(overlaysSource, /!releaseNotesOpen[\s\S]*!activeReleaseNotes[\s\S]*!releaseNotesPendingHere/)
  assert.match(overlaysSource, /claimReleaseNotes/)
  assert.match(overlaysSource, /name:\s*'release-notes'/)
  assert.match(overlaysSource, /mountedRef\.current/)
})
