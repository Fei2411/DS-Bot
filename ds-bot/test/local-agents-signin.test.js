import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ENGINES } from '../src/host/local-agents/engines.js'
import { probeSignIn, refreshSearchDirs } from '../src/host/local-agents/discover.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import { fakeContext } from './fake-ctx.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The sign-in row of the Local agents page, bundled once and rendered with a minimal
// React stand-in whose useState survives re-renders (#1083).
const { outputFiles } = await build({
  stdin: {
    contents: "export { AgentSignInRow, LocalAgentsPage } from './src/client/local-agents-page.js'\nexport { shortVersion, useLocalAgents } from './src/client/agent-cards.js'\nexport { AgentBadge } from './src/client/agent-badge.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let idx = 0
let concrete = null
let props = {}
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
}
let active = () => expand(AgentSignInRow(props))
const rerender = () => { idx = 0; concrete = active() }
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, p, ...children) => ({ type, props: { ...(p ?? {}), children } }),
  Fragment: 'fragment',
  useEffect() {}, useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
  },
  useMemo: make => make(),
  useRef: (current) => {
    const i = idx++
    if (!(i in slots)) slots[i] = { current }
    return slots[i]
  },
  useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
// The clipboard is swapped per test: the row reads it when the button is clicked.
const nav = { clipboard: { writeText: async () => {} } }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  btoa,
  document: dom.window.document,
  navigator: nav,
  window: { matchMedia: () => ({ matches: false }), dshDesktop: {}, open: () => null },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { AgentSignInRow, shortVersion, AgentBadge } = module.exports

// The settings Row the page passes in: label and hint on the left, controls on the right.
const Row = ({ label, hint, children }) => ({
  type: 'div',
  props: {
    className: 'bt-set-row',
    children: [
      { type: 'span', props: { className: 'bt-set-copy', children: [{ type: 'span', props: { children: label } }, hint ? { type: 'span', props: { className: 'bt-set-hint', children: hint } } : null] } },
      children,
    ],
  },
})
const agent = { route: 'local:cursor', name: 'Cursor', path: '/bench/bin/cursor-agent', version: '1.0.0', signIn: 'cursor-agent login', signedIn: false }

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (match, out = []) => {
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(concrete)
  return out
}
const click = (text) => {
  const button = collect(n => n.type === 'button' && flatten(n).join('') === text)[0]
  assert.ok(button, `button "${text}"`)
  button.props.onClick?.()
}
const note = role => collect(n => n.props?.role === role)[0]
const text = node => flatten(node).join('')
const render = () => { slots.length = 0; active = () => expand(AgentSignInRow(props)); rerender() }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('conflicted custom agents stay manageable but are absent from CLI choices', () => {
  const custom = [
    { id: 'taken', route: 'local-acp-taken', name: 'Taken', command: 'taken', available: false },
    { id: 'ready', route: 'local-acp-ready', name: 'Ready', command: 'ready', available: true },
    { id: 'legacy', route: 'local-acp-legacy', name: 'Legacy', command: 'legacy' },
  ]
  const view = { available: true, detected: [], custom }
  slots.length = 0
  slots.push(view, false)
  idx = 0
  const result = module.exports.useLocalAgents(false)
  assert.deepEqual(Array.from(result.agents, entry => entry.route), ['local-acp-ready', 'local-acp-legacy'])
  slots.length = 0
  slots.push(view, null)
  active = () => expand(module.exports.LocalAgentsPage({ run: () => {}, Row }))
  rerender()
  assert.match(text(concrete), /Taken/)
  assert.equal(collect(n => n.type === 'button' && text(n) === 'Edit').length, 3)
  assert.equal(collect(n => n.type === 'button' && n.props['aria-label'] === 'Remove').length, 3)
  slots.length = 0
  slots.push({ detected: [], custom: [] }, false)
  idx = 0
  assert.equal(module.exports.useLocalAgents(false).agents.length, 0)
})

test('clicking Sign in says the command was copied and where to run it', async () => {
  const written = []
  nav.clipboard = { writeText: async value => { written.push(value) } }
  props = { agent, Row }
  render()
  assert.equal(note('status'), undefined, 'no feedback before the click')
  click('Sign in')
  await flush()
  assert.deepEqual(written, ['cursor-agent login'])
  const line = note('status')
  assert.ok(line, 'a visible confirmation after the click')
  assert.match(text(line), /Sign-in command copied/)
  assert.match(text(line), /cursor-agent login/)
  assert.match(String(line.props.className), /bt-note/)
})

test('a refused clipboard write shows a visible error with the command', async () => {
  nav.clipboard = { writeText: async () => { throw new Error('Write permission denied') } }
  props = { agent, Row }
  render()
  click('Sign in')
  await flush()
  const line = note('alert')
  assert.ok(line, 'the failed copy is reported, not swallowed')
  assert.match(text(line), /Could not copy the sign-in command/)
  assert.match(text(line), /cursor-agent login/, 'the command is still shown so it can be typed')
  assert.match(String(line.props.className), /bt-danger/, 'the error reads as an error')
  assert.equal(note('status'), undefined, 'a failed copy does not claim success')
})

test('a browser without a clipboard shows the error instead of doing nothing', async () => {
  nav.clipboard = undefined
  props = { agent, Row }
  render()
  click('Sign in')
  await flush()
  const line = note('alert')
  assert.ok(line, 'no clipboard is reported')
  assert.match(text(line), /cursor-agent login/)
})

test('an agent that is already signed in shows Signed in without a Sign in button', () => {
  props = {
    agent: { route: 'local-devin-cli', name: 'Devin CLI', path: '/bench/bin/devin', version: 'devin 3000.12.28 (91c3aec41579)', signIn: 'devin auth login', signedIn: true },
    Row,
  }
  render()
  assert.equal(collect(n => n.type === 'button' && flatten(n).join('') === 'Sign in').length, 0, 'no Sign in button when already signed in')
  const state = collect(n => String(n.props?.className ?? '').includes('bt-la-state'))[0]
  assert.ok(state, 'shows sign-in state')
  assert.equal(text(state), 'Signed in')
  const logo = collect(n => n.type === 'img' && String(n.props?.className ?? '').includes('bt-cli-logo'))[0]
  assert.ok(logo, 'renders the agent logo')
  const ver = collect(n => String(n.props?.className ?? '').includes('bt-la-ver'))[0]
  const path = collect(n => String(n.props?.className ?? '').includes('bt-la-path'))[0]
  assert.equal(text(ver), '3000.12.28')
  assert.equal(text(path), '/bench/bin/devin')
})

test('OpenCode has no sign-in check or Sign in button', () => {
  assert.equal(ENGINES['local-opencode'].signedIn, undefined)
  props = {
    agent: { route: 'local-opencode', name: 'OpenCode', path: '/opt/homebrew/bin/opencode', version: 'opencode v2.2.5', signIn: undefined, signedIn: null },
    Row,
  }
  render()
  assert.equal(collect(n => n.type === 'button' && flatten(n).join('') === 'Sign in').length, 0, 'no Sign in button for OpenCode')
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-la-state')).length, 0, 'no Found tag or sign-in state for OpenCode')
  assert.equal(shortVersion('opencode v2.2.5'), 'v2.2.5')
  assert.equal(shortVersion('codex-cli 0.166.0'), '0.166.0')
  assert.equal(shortVersion('1.5.9'), '1.5.9')
})

test('Antigravity with unknown sign-in renders its logo, Sign in button, no state label, and copies agy acp --login', async () => {
  assert.equal(ENGINES['local-antigravity'].signIn, 'agy acp --login')
  const written = []
  nav.clipboard = { writeText: async (value) => { written.push(value) } }
  props = {
    agent: { route: 'local-antigravity', name: 'Antigravity', path: '/usr/local/bin/agy', version: '1.5.9', signIn: 'agy acp --login', signedIn: null },
    Row,
  }
  render()
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-la-state')).length, 0, 'no status label when signedIn is unknown (null)')
  assert.equal(collect(n => n.type === 'button' && flatten(n).join('') === 'Sign in').length, 1, 'shows Sign in button')
  const logo = collect(n => n.type === 'img' && String(n.props?.className ?? '').includes('bt-cli-logo'))[0]
  assert.ok(logo?.props?.src?.startsWith('data:image/png;base64,'), 'renders the Antigravity PNG logo')
  const ver = collect(n => String(n.props?.className ?? '').includes('bt-la-ver'))[0]
  assert.equal(text(ver), '1.5.9')
  click('Sign in')
  await flush()
  assert.deepEqual(written, ['agy acp --login'])
})

test('Antigravity uses only a positive macOS Keychain lookup as sign-in evidence', async (t) => {
  const { signedIn } = ENGINES['local-antigravity']
  const agy = '/bench/bin/agy'
  const fromExit = code => t.mock.fn((_file, _args, options) => spawn(process.execPath, ['-e', `process.exit(${code})`], options))
  const hit = fromExit(0)
  const miss = fromExit(44) // security returns 44 for an item not found.
  assert.equal(await probeSignIn(agy, signedIn, { platform: 'darwin', spawnKeychain: hit }), true)
  const [file, args, options] = hit.mock.calls[0].arguments
  assert.equal(file, '/usr/bin/security')
  assert.deepEqual(args, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'])
  assert.equal(options.stdio, 'ignore')
  assert.equal(await probeSignIn(agy, signedIn, { platform: 'darwin', spawnKeychain: miss }), null)

  const unavailable = t.mock.fn((_file, _args, options) => spawn(join(process.execPath, 'missing'), [], options))
  assert.equal(await probeSignIn(agy, signedIn, { platform: 'darwin', spawnKeychain: unavailable }), null)

  for (const platform of ['linux', 'win32']) {
    assert.equal(await probeSignIn(agy, signedIn, { platform, spawnKeychain: hit }), null)
  }
  assert.equal(hit.mock.callCount(), 1)
})

test('CodeBuddy Code is signed in while its session file holds a login and it has not logged out (#1835)', async (t) => {
  const { signedIn, signIn } = ENGINES['local-codebuddy']
  assert.equal(signIn, 'codebuddy', 'codebuddy has no login subcommand; it signs in on first start')
  const root = mkdtempSync(join(tmpdir(), 'dsb-codebuddy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cli = '/bench/bin/codebuddy'
  const dataDirs = { darwin: ['Library', 'Application Support'], win32: ['AppData', 'Local'], linux: ['.local', 'share'] }
  for (const [platform, dataDir] of Object.entries(dataDirs)) {
    const home = join(root, platform)
    const auth = join(home, ...dataDir, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    const session = join(auth, 'Tencent-Cloud.coding-copilot.info')
    assert.equal(await probeSignIn(cli, signedIn, { home, platform }), null, `${platform}: no session file says nothing`)
    mkdirSync(auth, { recursive: true })
    for (const unreadable of ['', 'not json', '{}', '{"auth":{},"account":{}}', '{"auth":{"accessToken":"enc:token"}}']) {
      writeFileSync(session, unreadable)
      assert.equal(await probeSignIn(cli, signedIn, { home, platform }), null, `${platform}: CodeBuddy rejects ${JSON.stringify(unreadable)}`)
    }
    writeFileSync(session, JSON.stringify({ auth: { accessToken: 'enc:token', domain: 'example.test' }, account: { uid: 'u1' } }))
    assert.equal(await probeSignIn(cli, signedIn, { home, platform }), true, `${platform}: a session with a token and an account is signed in`)
    writeFileSync(`${session}.logged-out`, '')
    assert.equal(await probeSignIn(cli, signedIn, { home, platform }), null, `${platform}: a logout marker wins over the file`)
  }
})

test('AgentBadge adapts dark monochrome SVG logos to theme ink and preserves brand colors', () => {
  const copilot = AgentBadge({ engine: 'local-copilot-cli' })
  const kimi = AgentBadge({ engine: 'local-kimi-cli' })
  const minimax = AgentBadge({ engine: 'local-minimax-code' })
  const mistral = AgentBadge({ engine: 'local-mistral-vibe' })
  assert.equal(copilot.props.style.color, 'var(--bt-ink, currentColor)')
  assert.equal(kimi.props.style.color, 'var(--bt-ink, currentColor)')
  assert.equal(minimax.props.style.color, '#E73562')
  assert.equal(mistral.props.style.color, '#FA520F')
})

test('probeSignIn parses JSON status, auth error phrases, and credential file fallback (#1439)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-signin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const makeScript = (name, body) => {
    const file = join(root, name)
    writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
    chmodSync(file, 0o755)
    if (process.platform === 'win32') {
      const cmd = `${file}.cmd`
      writeFileSync(cmd, `@ECHO off\r\n"${process.execPath}" "${file}" %*\r\n`)
      return cmd
    }
    return file
  }
  const okJson = makeScript('ok.mjs', 'console.log(JSON.stringify({ loggedIn: true }))')
  const noJson = makeScript('no.mjs', 'console.log(JSON.stringify({ loggedIn: false }))')
  const silent = makeScript('silent.mjs', 'console.log("ok")')
  const unauth = makeScript('unauth.mjs', 'console.error("Not authenticated")')

  assert.equal(await probeSignIn(okJson, { args: [] }), true)
  assert.equal(await probeSignIn(noJson, { args: [] }), false)
  assert.equal(await probeSignIn(unauth, { args: [] }), false)
  assert.equal(await probeSignIn(silent, { args: [], nonEmpty: true }), true)

  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}')
  const check = { args: [], fallback: { file: ['.claude', '.credentials.json'] } }
  assert.equal(await probeSignIn(silent, check, { home }), true)
  assert.equal(await probeSignIn(silent, check, { home: join(root, 'empty-home') }), null)
})

test('Devin CLI falls back to credentials.toml on status timeout, while explicit logout still wins', async (t) => {
  const { signedIn } = ENGINES['local-devin-cli']
  const root = mkdtempSync(join(tmpdir(), 'dsb-devin-signin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const makeScript = (name, body) => {
    const file = join(root, name)
    writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
    chmodSync(file, 0o755)
    if (process.platform === 'win32') {
      const cmd = `${file}.cmd`
      writeFileSync(cmd, `@ECHO off\r\n"${process.execPath}" "${file}" %*\r\n`)
      return cmd
    }
    return file
  }
  const slow = makeScript('devin-slow.mjs', 'setTimeout(() => {}, 10_000)')
  const offline = makeScript('devin-offline.mjs', 'console.error("Timed out verifying account status.")')
  const loggedOut = makeScript('devin-out.mjs', 'console.log("Not logged in.\\nRun `devin auth login` to authenticate.")')
  const loggedIn = makeScript('devin-in.mjs', 'console.log("Logged in (via Devin).")')

  const home = join(root, 'home')
  const devinDir = join(home, '.local', 'share', 'devin')
  const creds = join(devinDir, 'credentials.toml')

  assert.equal(await probeSignIn(loggedIn, signedIn, { home, platform: 'linux', env: {} }), true)
  assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'linux', env: {} }), null, 'no credentials file stays unknown')

  mkdirSync(devinDir, { recursive: true })
  for (const invalid of [
    '',
    '# windsurf_api_key = "k"\n',
    'windsurf_api_key = ""\n',
    'windsurf_api_key = "   "\n',
    'windsurf_api_key = \'  \'\n',
    'windsurf_api_key = 123\n',
    'windsurf_api_key = "tok" trailing\n',
    '[backup]\nwindsurf_api_key = "tok-nested"\n',
    'api_server_url = "https://example.test"\n',
  ]) {
    writeFileSync(creds, invalid)
    assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'linux', env: {} }), null, `rejects ${JSON.stringify(invalid)}`)
  }

  for (const valid of [
    'windsurf_api_key = "tok-1"\n',
    'windsurf_api_key = \'tok-2\'\r\n',
    '  windsurf_api_key = "tok-3" # inline\n',
    'windsurf_api_key = "tok-\\"escaped\\""\n[other]\nkey = "v"\n',
  ]) {
    writeFileSync(creds, valid)
    assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'linux', env: {} }), true, `accepts ${JSON.stringify(valid)}`)
  }

  // Real subprocess timeout falls back to credentials.toml.
  assert.equal(await probeSignIn(slow, signedIn, { home, platform: 'linux', env: {}, timeoutMs: 150 }), true)
  assert.equal(await probeSignIn(loggedOut, signedIn, { home, platform: 'linux', env: {} }), false, 'explicit Not logged in beats credentials.toml')

  const xdg = join(root, 'xdg-data')
  mkdirSync(join(xdg, 'devin'), { recursive: true })
  writeFileSync(join(xdg, 'devin', 'credentials.toml'), 'windsurf_api_key = "tok-xdg"\n')
  const emptyHome = join(root, 'empty-home')
  assert.equal(await probeSignIn(offline, signedIn, { home: emptyHome, platform: 'linux', env: { XDG_DATA_HOME: xdg } }), true)
  assert.equal(await probeSignIn(offline, signedIn, { home: emptyHome, platform: 'linux', env: { XDG_DATA_HOME: 'relative/path' } }), null)

  // Windows (%APPDATA% case-insensitively, or ~/AppData/Roaming)
  const winHome = join(root, 'win')
  const winCreds = join(winHome, 'AppData', 'Roaming', 'devin', 'credentials.toml')
  mkdirSync(dirname(winCreds), { recursive: true })
  writeFileSync(winCreds, 'windsurf_api_key = "tok-win"\r\n')
  assert.equal(await probeSignIn(offline, signedIn, { home: winHome, platform: 'win32', env: {} }), true)

  const appData = join(root, 'appdata')
  mkdirSync(join(appData, 'devin'), { recursive: true })
  writeFileSync(join(appData, 'devin', 'credentials.toml'), 'windsurf_api_key = "tok-appdata"\r\n')
  assert.equal(await probeSignIn(offline, signedIn, { home: emptyHome, platform: 'win32', env: { AppData: appData } }), true)
})

test('Cursor CLI falls back to macOS Keychain then auth.json on timeout, while explicit logout wins', async (t) => {
  const { signedIn } = ENGINES['local-cursor-cli']
  const root = mkdtempSync(join(tmpdir(), 'dsb-cursor-signin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const makeScript = (name, body) => {
    const file = join(root, name)
    writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
    chmodSync(file, 0o755)
    if (process.platform === 'win32') {
      const cmd = `${file}.cmd`
      writeFileSync(cmd, `@ECHO off\r\n"${process.execPath}" "${file}" %*\r\n`)
      return cmd
    }
    return file
  }
  const slow = makeScript('cursor-slow.mjs', 'setTimeout(() => {}, 10_000)')
  const offline = makeScript('cursor-offline.mjs', 'console.error("Status check error: network unavailable")')
  const loggedOut = makeScript('cursor-out.mjs', 'console.log("Not logged in")')
  const partial = makeScript('cursor-partial.mjs', 'console.log("Partially authenticated (missing refresh token)")')
  const loggedIn = makeScript('cursor-in.mjs', 'console.log("✓ Logged in as user@example.test")')
  const keychainWith = services => t.mock.fn((_file, args) => {
    const child = new EventEmitter()
    const svc = args[args.indexOf('-s') + 1]
    queueMicrotask(() => child.emit('close', services.has(svc) ? 0 : 44))
    return child
  })
  const oauthHit = keychainWith(new Set(['cursor-access-token', 'cursor-refresh-token']))
  const partialKeychain = keychainWith(new Set(['cursor-access-token']))
  const apiKeyHit = keychainWith(new Set(['cursor-api-key']))
  const miss = keychainWith(new Set())

  const home = join(root, 'home')
  assert.equal(await probeSignIn(loggedIn, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: miss }), true)
  assert.equal(await probeSignIn(loggedOut, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: oauthHit }), false, 'explicit Not logged in beats Keychain')
  assert.equal(await probeSignIn(partial, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: oauthHit }), false, 'Partially authenticated is signed out and beats Keychain')
  assert.equal(oauthHit.mock.callCount(), 0)

  // Real subprocess timeout falls back to macOS Keychain metadata lookup requiring access + refresh tokens.
  assert.equal(await probeSignIn(slow, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: oauthHit, timeoutMs: 150 }), true)
  assert.equal(oauthHit.mock.callCount(), 2)
  for (const call of oauthHit.mock.calls) {
    const [file, args, options] = call.arguments
    assert.equal(file, '/usr/bin/security')
    assert.equal(args[0], 'find-generic-password')
    assert.equal(args[3], '-a')
    assert.equal(args[4], 'cursor-user')
    assert.equal(options.stdio, 'ignore')
    assert.ok(options.signal instanceof AbortSignal)
  }
  assert.deepEqual(oauthHit.mock.calls.map(c => c.arguments[1][2]).sort(), ['cursor-access-token', 'cursor-refresh-token'])

  // Partial Keychain (access token without refresh token) stays unknown, while cursor-api-key succeeds.
  assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: partialKeychain }), null)
  assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: apiKeyHit }), true)

  // macOS with Keychain miss chains to ~/.cursor/auth.json requiring (accessToken && refreshToken) or apiKey strings.
  const macAuth = join(home, '.cursor', 'auth.json')
  mkdirSync(dirname(macAuth), { recursive: true })
  for (const invalid of [
    '',
    'not json',
    '{}',
    '{"accessToken":""}',
    '{"accessToken":"tok-only"}',
    '{"refreshToken":"rt-only"}',
    '{"accessToken":{},"refreshToken":"rt"}',
    '{"accessToken":"tok","refreshToken":[]}',
    '{"apiKey":true}',
    '{"apiKey":123}',
    '{"accessToken":"   ","apiKey":null}',
  ]) {
    writeFileSync(macAuth, invalid)
    assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: miss }), null, `rejects ${invalid}`)
  }
  writeFileSync(macAuth, JSON.stringify({ accessToken: 'tok-mac', refreshToken: 'rt-mac' }))
  assert.equal(await probeSignIn(offline, signedIn, { home, platform: 'darwin', env: {}, spawnKeychain: miss }), true)

  // Linux ($XDG_CONFIG_HOME or ~/.config) and Windows (%APPDATA% or ~/AppData/Roaming)
  const linuxHome = join(root, 'linux')
  const linuxAuth = join(linuxHome, '.config', 'cursor', 'auth.json')
  mkdirSync(dirname(linuxAuth), { recursive: true })
  writeFileSync(linuxAuth, JSON.stringify({ apiKey: 'key-linux' }))
  assert.equal(await probeSignIn(offline, signedIn, { home: linuxHome, platform: 'linux', env: {}, spawnKeychain: oauthHit }), true)

  const xdgCfg = join(root, 'xdg-cfg')
  mkdirSync(join(xdgCfg, 'cursor'), { recursive: true })
  writeFileSync(join(xdgCfg, 'cursor', 'auth.json'), JSON.stringify({ accessToken: 'tok-xdg', refreshToken: 'rt-xdg' }))
  assert.equal(await probeSignIn(offline, signedIn, { home: join(root, 'empty'), platform: 'linux', env: { XDG_CONFIG_HOME: xdgCfg } }), true)

  const winHome = join(root, 'win')
  const winAuth = join(winHome, 'AppData', 'Roaming', 'Cursor', 'auth.json')
  mkdirSync(dirname(winAuth), { recursive: true })
  writeFileSync(winAuth, JSON.stringify({ accessToken: 'tok-win', refreshToken: 'rt-win' }))
  assert.equal(await probeSignIn(offline, signedIn, { home: winHome, platform: 'win32', env: {} }), true)

  const appData = join(root, 'appdata')
  mkdirSync(join(appData, 'Cursor'), { recursive: true })
  writeFileSync(join(appData, 'Cursor', 'auth.json'), JSON.stringify({ apiKey: 'key-appdata' }))
  assert.equal(await probeSignIn(offline, signedIn, { home: join(root, 'empty'), platform: 'win32', env: { AppData: appData } }), true)
})

test('probeSignIns retries inconclusive null after 20s, skips probe-less CLIs, deduplicates, and preserves refresh state', async (t) => {
  await refreshSearchDirs()
  const saved = { ...ENGINES }
  for (const route of Object.keys(ENGINES)) delete ENGINES[route]
  ENGINES['local-devin-cli'] = { ...saved['local-devin-cli'], command: process.execPath, commands: [process.execPath], version: ['-v'] }
  ENGINES['local-opencode'] = { ...saved['local-opencode'], command: process.execPath, commands: [process.execPath], version: ['-v'] }
  t.after(() => {
    for (const route of Object.keys(ENGINES)) delete ENGINES[route]
    Object.assign(ENGINES, saved)
  })

  let clock = 100_000
  let calls = 0
  let nextResult = null
  const gates = []
  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const ctx = fakeContext({ services: { llm } })
  const rt = { ctx, state: { bots: {}, localAgents: { custom: [], sessions: {} } }, save: async () => {} }
  t.after(async () => { await ctx.dispose(); await owner.fiber.dispose() })

  installLocalAgents(rt, {
    now: () => clock,
    probeSignIn: async () => {
      calls++
      if (gates.length > 0) return gates.shift()
      return nextResult
    },
  })

  const devinOf = res => res.detected.find(entry => entry.route === 'local-devin-cli').signedIn
  const opencodeOf = res => res.detected.find(entry => entry.route === 'local-opencode').signedIn

  // Initial inconclusive null is cached for 20s (not 60s), and probe-less CLIs (OpenCode) never invoke probeSignIn.
  let list = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(devinOf(list), null)
  assert.equal(opencodeOf(list), null)
  assert.equal(calls, 1)

  clock += 19_000
  nextResult = true
  list = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(devinOf(list), null)
  assert.equal(calls, 1)

  clock += 2_000
  list = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(devinOf(list), true)
  assert.equal(calls, 2)

  // Definitive true stays cached for 60s.
  clock += 30_000
  nextResult = false
  list = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(devinOf(list), true)
  assert.equal(calls, 2)

  // Concurrent local-agents calls share one in-flight probe; refresh superseding it never causes earlier callers to return null.
  clock += 35_000
  let releaseFirst
  let releaseRefresh
  gates.push(new Promise((resolve) => { releaseFirst = resolve }))
  gates.push(new Promise((resolve) => { releaseRefresh = resolve }))
  const p1 = rt.localAgentsEndpoint('local-agents', {})
  const p2 = rt.localAgentsEndpoint('local-agents', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls, 3, 'concurrent callers reuse the single in-flight probe')

  const refreshPromise = rt.localAgentsEndpoint('local-agent-refresh', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls, 4, 'refresh starts a superseding probe')

  // First probe settles BEFORE refresh completes: p1/p2 must wait for the superseding refresh rather than returning null.
  releaseFirst(false)
  await new Promise(resolve => setTimeout(resolve, 20))
  releaseRefresh(true)
  const [r1, r2, refreshed] = await Promise.all([p1, p2, refreshPromise])
  assert.equal(devinOf(refreshed), true)
  assert.equal(devinOf(r1), true, 'superseded caller waits for refresh result instead of returning null')
  assert.equal(devinOf(r2), true)

  // Stale pre-refresh probe resolving AFTER refresh still cannot clobber refreshed state.
  let releaseSlow
  gates.push(new Promise((resolve) => { releaseSlow = resolve }))
  clock += 65_000
  const staleCall = rt.localAgentsEndpoint('local-agents', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  nextResult = true
  const fastRefresh = await rt.localAgentsEndpoint('local-agent-refresh', {})
  assert.equal(devinOf(fastRefresh), true)
  releaseSlow(false)
  await staleCall
  const after = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(devinOf(after), true, 'late pre-refresh probe cannot overwrite refreshed state')

  // A probe rejection degrades that entry to null instead of failing the endpoint.
  gates.push(Promise.reject(new Error('probe crashed')))
  const degraded = await rt.localAgentsEndpoint('local-agent-refresh', {})
  assert.equal(devinOf(degraded), null)
})
