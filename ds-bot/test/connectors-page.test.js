import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The mail section, bundled once and rendered with a minimal React stand-in whose
// useState survives re-renders: hooks are numbered by expansion order, which is
// stable because the tree expands the same way every pass.
const { outputFiles } = await build({
  stdin: {
    contents: "export { MailSection } from './src/client/connectors.js'",
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
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; render() }]
  },
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { MailSection } = module.exports
const render = () => { idx = 0; concrete = expand(MailSection(props)) }

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
const fill = (label, value) => {
  const input = collect(n => n.type === 'input' && n.props?.['aria-label'] === label)[0]
  assert.ok(input, `input "${label}"`)
  input.props.onChange?.({ target: { value } })
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('the mail form shows the QQ guide with its links and closes after a good add', async () => {
  const adds = []
  const actions = {
    mailAccountAdd: (body) => { adds.push(body); return Promise.resolve({ accounts: [] }) },
    mailAccountRemove: () => Promise.resolve(true),
  }
  const run = (task, onDone) => Promise.resolve(task).then(() => onDone?.(), () => {})
  props = { mail: { accounts: [] }, actions, run }
  render()
  click('Add an account')
  click('QQ')
  const guide = collect(n => n.props?.className === 'bt-mail-guide')[0]
  assert.ok(guide, 'guide list')
  assert.equal(collect(n => n.type === 'li').length, 3)
  const links = collect(n => n.type === 'a' && n.props?.className === 'bt-connector-link')
  assert.equal(links.length, 2)
  assert.equal(links[0].props.href, 'https://mail.qq.com')
  assert.match(links[1].props.href, /help\.mail\.qq\.com/)
  assert.equal(links[0].props.target, '_blank')
  fill('Email address', 'me@qq.com')
  fill('Authorization code', 'CODE')
  click('Add account')
  await flush()
  assert.equal(adds.length, 1)
  assert.equal(adds[0].provider, 'qq')
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-mail-form')).length, 0, 'form closed after a resolved add')
})

test('a failed mail add shows the host message inside the form', async () => {
  const actions = {
    mailAccountAdd: () => Promise.reject(new Error('The password was refused. Use the mailbox app password or authorization code, not the account password.')),
    mailAccountRemove: () => Promise.resolve(true),
  }
  const run = (task, onDone) => Promise.resolve(task).then(() => onDone?.(), () => {})
  props = { mail: { accounts: [] }, actions, run }
  render()
  click('Add an account')
  fill('Email address', 'me@qq.com')
  fill('Authorization code', 'WRONG')
  click('Add account')
  await flush()
  const alert = collect(n => n.props?.role === 'alert')[0]
  assert.ok(alert, 'inline error')
  assert.match(flatten(alert).join(''), /password was refused/)
  assert.ok(String(collect(n => String(n.props?.className ?? '').includes('bt-mail-form'))[0]?.props?.className ?? '').includes('bt-mail-form'), 'form stays open')
})
