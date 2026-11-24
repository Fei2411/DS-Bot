import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
let bundlePromise
const getBundle = () => (bundlePromise ??= build({
  stdin: {
    contents: "export { MaskedInput, SecretCard, SecretsPage } from './src/client/secret-card.js'",
    resolveDir: PLUGIN,
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
}).then(({ outputFiles }) => outputFiles[0].text))

function loadSecretCard({ cssSupports = true } = {}) {
  return getBundle().then((code) => {
    const slots = []
    let index = 0
    const react = {
      Fragment: 'fragment',
      createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
      useContext: ctx => ctx.value,
      useMemo: make => make(),
      useCallback: fn => fn,
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true) } }),
      useState: (initial) => {
        const i = index++
        if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
        return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
      },
      useRef: (initial) => {
        const i = index++
        if (!(i in slots)) slots[i] = { current: initial }
        return slots[i]
      },
      useId: () => 'secret-id',
      useEffect() {},
      useLayoutEffect() {},
      useSyncExternalStore: (_sub, snap) => snap(),
    }
    const mod = { exports: {} }
    runInNewContext(code, {
      module: mod,
      exports: mod.exports,
      CSS: { supports: () => cssSupports },
      require: name => (name === 'react' ? react : {}),
    })
    const expand = (node) => {
      if (node === null || node === undefined || node === false || node === true) return node
      if (Array.isArray(node)) return node.map(expand)
      if (typeof node !== 'object') return node
      if (typeof node.type === 'function') return expand(node.type(node.props))
      return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
    }
    const render = (Component, props) => {
      index = 0
      return expand(react.createElement(Component, props))
    }
    const findAll = (node, pred, out = []) => {
      if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
      if (!node || typeof node !== 'object') return out
      if (pred(node)) out.push(node)
      for (const child of node.props?.children ?? []) findAll(child, pred, out)
      return out
    }
    return { ...mod.exports, react, render, findAll }
  })
}

const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))

const keyEvent = (extra = {}) => {
  let prevented = false
  return {
    event: { key: 'Enter', metaKey: false, ctrlKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() { prevented = true }, ...extra },
    get prevented() { return prevented },
  }
}

test('MaskedInput defaults to single-line input and supports multiline textarea with Cmd/Ctrl+Enter submit', async () => {
  const { MaskedInput, render } = await loadSecretCard({ cssSupports: true })

  let singleSubmitted = 0
  const single = render(MaskedInput, { value: 'tok-1234', onChange() {}, onEnter: () => { singleSubmitted += 1 }, label: 'API key' })
  assert.equal(single.type, 'input')
  assert.equal(single.props.className, 'bt-secret-input')
  assert.equal(single.props['data-masked'], '')
  const singleEnter = keyEvent()
  single.props.onKeyDown(singleEnter.event)
  assert.equal(singleEnter.prevented, true)
  assert.equal(singleSubmitted, 1)

  let multiSubmitted = 0
  const multi = render(MaskedInput, { value: 'line1\nline2', onChange() {}, onEnter: () => { multiSubmitted += 1 }, label: 'Value', multiline: true })
  assert.equal(multi.type, 'textarea')
  assert.equal(multi.props.rows, 1)
  assert.equal(multi.props.className, 'bt-secret-input bt-secret-input-multi')
  assert.equal(multi.props['data-masked'], '')

  // Plain Enter inserts a newline instead of submitting.
  const plainEnter = keyEvent()
  multi.props.onKeyDown(plainEnter.event)
  assert.equal(plainEnter.prevented, false)
  assert.equal(multiSubmitted, 0)

  // Cmd+Enter and Ctrl+Enter submit.
  const metaEnter = keyEvent({ metaKey: true })
  multi.props.onKeyDown(metaEnter.event)
  assert.equal(metaEnter.prevented, true)
  assert.equal(multiSubmitted, 1)

  const ctrlEnter = keyEvent({ ctrlKey: true })
  multi.props.onKeyDown(ctrlEnter.event)
  assert.equal(ctrlEnter.prevented, true)
  assert.equal(multiSubmitted, 2)

  // IME composition never submits.
  const composing = keyEvent({ ctrlKey: true, nativeEvent: { isComposing: true } })
  multi.props.onKeyDown(composing.event)
  assert.equal(composing.prevented, false)
  assert.equal(multiSubmitted, 2)
})

test('MaskedInput falls back to blur masking on multiline when -webkit-text-security is unsupported', async () => {
  const { MaskedInput, render } = await loadSecretCard({ cssSupports: false })

  const single = render(MaskedInput, { value: 'tok', onChange() {}, label: 'API key' })
  assert.equal(single.type, 'input')
  assert.equal(single.props.type, 'password')
  assert.equal(single.props['data-masked'], undefined)

  const multi = render(MaskedInput, { value: 'a\nb', onChange() {}, label: 'Value', multiline: true })
  assert.equal(multi.type, 'textarea')
  assert.equal(multi.props['data-masked'], 'blur')
})

test('SecretsPage uses multiline textarea for AddSecret and ValueEditor while keeping passphrase single-line', async () => {
  const { SecretsPage, react, render, findAll } = await loadSecretCard({ cssSupports: true })
  const saved = []
  const actions = {
    secretSet: payload => { saved.push(payload); return Promise.resolve(true) },
    secretUpdate: () => Promise.resolve(true),
    secretDelete: () => Promise.resolve(true),
    secretEncrypt: () => Promise.resolve(true),
  }
  const roster = {
    bots: [{ id: 'b1', name: 'Chief' }],
    byId: { b1: { id: 'b1', name: 'Chief' } },
    secrets: [{ name: 'SSH_KEY', purpose: 'deploy', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 }],
    secretStore: { mode: 'plaintext', locked: false },
  }
  const Section = ({ title, action, children }) => react.createElement('section', { className: 'bt-set-section' }, title, action, children)
  const props = { roster, actions, run: p => Promise.resolve(p), Section }

  // Open Add a key form, expand existing secret row, and open encryption form.
  let tree = render(SecretsPage, props)
  const addButton = findAll(tree, n => n.type === 'button' && (n.props.children ?? []).includes('Add a key'))[0]
  const summaryButton = findAll(tree, n => n.type === 'button' && String(n.props.className ?? '').includes('bt-secret-summary'))[0]
  const encryptButton = findAll(tree, n => n.type === 'button' && (n.props.children ?? []).includes('Encrypt keys at rest'))[0]
  addButton.props.onClick()
  summaryButton.props.onClick()
  encryptButton.props.onClick()

  tree = render(SecretsPage, props)
  const textareas = findAll(tree, n => n.type === 'textarea')
  const passwordInputs = findAll(tree, n => n.type === 'input' && String(n.props.className ?? '').includes('bt-secret-input'))
  assert.equal(textareas.length, 2, 'both ValueEditor and AddSecret render multiline textareas')
  assert.equal(passwordInputs.length, 2, 'encryption passphrase fields stay single-line inputs')

  // Save a multiline value via AddSecret.
  const multiValue = 'line-one\n  line-two\nline-three'
  const nameInput = findAll(tree, n => n.type === 'input' && n.props['aria-label'] === 'Key name')[0]
  const addTextarea = textareas.find(n => n.props['aria-label'] === 'Value')
  nameInput.props.onChange({ target: { value: 'my_cert' } })
  addTextarea.props.onChange({ target: { value: multiValue } })
  tree = render(SecretsPage, props)
  const saveKeyBtn = findAll(tree, n => n.type === 'button' && (n.props.children ?? []).includes('Save key'))[0]
  assert.equal(saveKeyBtn.props.disabled, false)
  saveKeyBtn.props.onClick()
  assert.deepEqual(plain(saved[0]), { name: 'MY_CERT', purpose: '', value: multiValue, scope: 'all' })

  // Replace an existing secret with a multiline value via ValueEditor.
  const replaceTextarea = findAll(tree, n => n.type === 'textarea' && n.props['aria-label'] === 'New value of SSH_KEY')[0]
  replaceTextarea.props.onChange({ target: { value: 'new-line-1\nnew-line-2' } })
  tree = render(SecretsPage, props)
  const replaceBtn = findAll(tree, n => n.type === 'button' && (n.props.children ?? []).includes('Replace'))[0]
  assert.equal(replaceBtn.props.disabled, false)
  replaceBtn.props.onClick()
  assert.deepEqual(plain(saved[1]), { name: 'SSH_KEY', value: 'new-line-1\nnew-line-2' })
})

test('SecretCard renders a multiline textarea and submits full multiline text intact', async () => {
  const { SecretCard, render, findAll } = await loadSecretCard({ cssSupports: true })
  const saved = []
  const actions = {
    holdCard: () => () => {},
    secretSet: payload => { saved.push(payload); return Promise.resolve(true) },
    secretCancel: () => Promise.resolve(true),
    secretAllow: () => Promise.resolve(true),
  }
  const props = {
    sessionId: 'b1',
    bot: { id: 'b1', name: 'Chief' },
    request: { id: 'req-1', kind: 'fill', name: 'DEPLOY_KEY', purpose: 'SSH' },
    roster: { secrets: [] },
    actions,
  }
  let tree = render(SecretCard, props)
  const textarea = findAll(tree, n => n.type === 'textarea')[0]
  assert.ok(textarea, 'SecretCard renders a multiline textarea')
  const multiValue = 'first-line\nsecond-line\nthird-line'
  textarea.props.onChange({ target: { value: multiValue } })
  tree = render(SecretCard, props)
  const saveBtn = findAll(tree, n => n.type === 'button' && n.props.className === 'bt-q-submit')[0]
  assert.equal(saveBtn.props.disabled, false)
  saveBtn.props.onClick()
  await tick()
  assert.deepEqual(plain(saved), [{ requestId: 'req-1', value: multiValue, scope: 'all' }])
})
