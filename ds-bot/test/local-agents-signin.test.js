import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { ENGINES } from '../src/host/local-agents/engines.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The sign-in row of the Local agents page, bundled once and rendered with a minimal
// React stand-in whose useState survives re-renders (#1083).
const { outputFiles } = await build({
  stdin: {
    contents: "export { AgentSignInRow } from './src/client/local-agents-page.js'\nexport { shortVersion } from './src/client/agent-cards.js'",
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
const { AgentSignInRow, shortVersion } = module.exports

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
})
