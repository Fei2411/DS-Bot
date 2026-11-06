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

// The mailbox catalog row, bundled once and rendered with a minimal React stand-in whose
// useState survives re-renders: hooks are numbered by expansion order, which is
// stable because the tree expands the same way every pass.
const { outputFiles } = await build({
  stdin: {
    contents: "export { MailCatalogRow, MailToolCell } from './src/client/connectors.js'",
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
let active = () => expand(MailCatalogRow(props))
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
const opened = []
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }), dshDesktop: {}, open: (url) => { opened.push(url); return null } },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { MailCatalogRow, MailToolCell } = module.exports
const render = () => { active = () => expand(MailCatalogRow(props)); rerender() }
const renderCell = (cellProps) => { slots.length = 0; active = () => expand(MailToolCell(cellProps)); rerender() }

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
const addressAt = domain => ['me', domain].join('@')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('the mail form shows the QQ guide with its links and closes after a good add', async () => {
  const adds = []
  const actions = {
    mailAccountAdd: (body) => { adds.push(body); return Promise.resolve({ accounts: [] }) },
    mailAccountRemove: () => Promise.resolve(true),
  }
  props = { mail: { accounts: [] }, actions }
  slots.length = 0
  render()
  click('Connect')
  click('QQ')
  const guide = collect(n => n.props?.className === 'bt-mail-guide')[0]
  assert.ok(guide, 'guide list')
  assert.equal(collect(n => n.type === 'li').length, 3)
  const links = collect(n => n.type === 'button' && n.props?.className === 'bt-connector-link')
  assert.equal(links.length, 2)
  opened.length = 0
  links.forEach(link => link.props.onClick())
  assert.equal(opened[0], 'https://mail.qq.com')
  assert.match(opened[1], /help\.mail\.qq\.com/)
  fill('Email address', addressAt('qq.com'))
  fill('Authorization code', 'CODE')
  click('Add')
  await flush()
  assert.equal(adds.length, 1)
  assert.equal(adds[0].provider, 'qq')
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-mail-form')).length, 0, 'form closed after a resolved add')
})

test('a busy mail add blocks a second click and a good add clears the fields', async () => {
  const adds = []
  let release = null
  const actions = {
    mailAccountAdd: (body) => { adds.push(body); return new Promise(resolve => { release = resolve }) },
    mailAccountRemove: () => Promise.resolve(true),
  }
  props = { mail: { accounts: [] }, actions }
  slots.length = 0
  render()
  click('Connect')
  fill('Email address', addressAt('qq.com'))
  fill('Authorization code', 'CODE')
  click('Add')
  await flush()
  assert.equal(adds.length, 1)
  const adding = collect(n => n.type === 'button' && flatten(n).join('') === 'Verifying…')[0]
  assert.ok(adding, 'busy button reads Verifying…')
  assert.equal(adding.props.disabled, true)
  adding.props.onClick?.()
  await flush()
  assert.equal(adds.length, 1, 'a second click while busy adds nothing')
  const address = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Email address')[0]
  assert.equal(address.props.disabled, true, 'the fields are disabled while busy')
  release({ accounts: [] })
  await flush()
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-mail-form')).length, 0, 'form closed after a resolved add')
  // The closed form unmounted; the stand-in keeps hook slots by index, so start them over.
  slots.length = 0
  render()
  click('Connect')
  assert.equal(collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Email address')[0].props.value, '', 'address cleared')
  assert.equal(collect(n => n.type === 'input' && String(n.props?.className ?? '') === 'bt-secret-input')[0].props.value, '', 'code cleared')
  const qq = collect(n => n.type === 'button' && flatten(n).join('') === 'QQ')[0]
  assert.equal(qq.props['aria-pressed'], true, 'provider back to the default')
  click('Other')
  assert.equal(collect(n => n.type === 'input' && n.props?.['aria-label'] === 'IMAP host')[0].props.value, '', 'IMAP host cleared')
  assert.equal(collect(n => n.type === 'input' && n.props?.['aria-label'] === 'SMTP host')[0].props.value, '', 'SMTP host cleared')
})

test('the mail send card is an editable show_view form card with the approval rule menu', async () => {
  const bot = { id: 'b1', name: 'Chief' }
  const sender = addressAt('qq.com')
  const body = 'Hi **all**\n<!-- hidden --> [link](https://x.test)\n\nBye'
  const roster = {
    byId: { s1: bot },
    connectors: { mail: { accounts: [{ id: sender, address: sender }] } },
    mailRequests: {
      b1: [{ id: 'r1', callId: 'c1', sessionId: 's1', status: 'pending', account: sender, to: 'team@corp.dev', subject: 'Weekly_1', body, attachmentDetails: [{ name: 'report.pdf', size: 2048 }] }],
    },
  }
  const answers = []
  const ruleSets = []
  let opened = false
  renderCell({
    sessionId: 's1', callId: 'c1', roster,
    actions: {
      mailSendAnswer: (...args) => { answers.push(args); return Promise.resolve() },
      mailRuleSet: (payload) => { ruleSets.push(payload); return Promise.resolve() },
      openConnectors: () => { opened = true },
    },
  })
  const card = collect(n => String(n.props?.className ?? '').split(' ').includes('dv-view'))[0]
  assert.ok(card, 'view card root')
  assert.ok(card.props.className.split(' ').includes('dv-q'), 'framed like the show_view answer cards')
  assert.equal( flatten(collect(n => n.props?.className === 'dv-view-title')[0]).join(''), 'Mail')
  assert.ok(collect(n => n.props?.className === 'dv-view-icon')[0], 'mail icon in header')
  // Prefilled fields: subject, readOnly from, editable to, editable cc, multiline body.
  const subjectInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Subject')[0]
  const fromInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'From')[0]
  const toInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'To')[0]
  const ccInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Cc')[0]
  const bodyArea = collect(n => n.type === 'textarea' && n.props?.['aria-label'] === 'Write a message…')[0]
  assert.equal(subjectInput.props.value, 'Weekly_1')
  assert.equal(fromInput.props.value, sender)
  assert.equal(fromInput.props.readOnly, true)
  assert.equal(toInput.props.value, 'team@corp.dev')
  assert.equal(ccInput.props.value, '')
  assert.equal(bodyArea.props.value, body, 'body stays literal in textarea')
  const texts = collect(n => typeof n.props?.text === 'string' && n.props?.variant === 'compact').map(n => n.props.text)
  assert.ok(texts.some(text => text.includes('report\\.pdf \\(2 KB\\)')), 'attachments')
  // Approval menu defaults to Needs approval.
  const ruleBtn = collect(n => n.type === 'button' && n.props?.className === 'bt-mail-rule-btn')[0]
  assert.equal(flatten(ruleBtn).join(''), 'Needs approval')
  ruleBtn.props.onClick()
  click('Allow recipient')
  await flush()
  assert.equal(ruleSets.length, 1)
  assert.equal(ruleSets[0].mode, 'allow-recipient')
  assert.equal(flatten(collect(n => n.type === 'button' && n.props?.className === 'bt-mail-rule-btn')[0]).join(''), 'Allow recipient')
  // Manage rules opens Connectors settings.
  collect(n => n.type === 'button' && n.props?.className === 'bt-mail-rule-btn')[0].props.onClick()
  click('Manage rules')
  assert.equal(opened, true)
  // Edit recipient and body in the card, then press Send.
  toInput.props.onChange({ target: { value: 'edited@corp.dev' } })
  collect(n => n.type === 'textarea' && n.props?.['aria-label'] === 'Write a message…')[0].props.onChange({ target: { value: 'Edited body' } })
  const send = collect(n => n.type === 'button' && n.props?.className === 'dv-q-submit')[0]
  assert.equal(flatten(send).join(''), 'Send')
  assert.equal(flatten(collect(n => n.type === 'button' && n.props?.className === 'dv-q-btn')[0]).join(''), 'Discard')
  const formNode = collect(n => n.type === 'form' && n.props?.className === 'dv-widget-form')[0]
  formNode.props.onSubmit({ preventDefault() {} })
  await flush()
  assert.equal(answers.length, 1)
  assert.equal(answers[0][0], 'r1')
  assert.equal(answers[0][1], 'send')
  assert.equal(answers[0][2].rule, 'allow-recipient')
  assert.equal(answers[0][2].fields.to, 'edited@corp.dev')
  assert.equal(answers[0][2].fields.body, 'Edited body')
})

test('a failed mail add shows the host message inside the form', async () => {
  const actions = {
    mailAccountAdd: () => Promise.reject(new Error('The password was refused. Use the mailbox app password or authorization code, not the account password.')),
    mailAccountRemove: () => Promise.resolve(true),
  }
  props = { mail: { accounts: [] }, actions }
  slots.length = 0
  render()
  click('Connect')
  fill('Email address', addressAt('qq.com'))
  fill('Authorization code', 'WRONG')
  click('Add')
  await flush()
  const alert = collect(n => n.props?.role === 'alert')[0]
  assert.ok(alert, 'inline error')
  assert.match(flatten(alert).join(''), /password was refused/)
  assert.ok(String(collect(n => String(n.props?.className ?? '').includes('bt-mail-form'))[0]?.props?.className ?? '').includes('bt-mail-form'), 'form stays open')
})
