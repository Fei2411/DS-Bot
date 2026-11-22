import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/chatgpt-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'],
})
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'object' && node !== null ? textOf(node.props?.children) : node == null ? '' : String(node)
const buttons = node => Array.isArray(node) ? node.flatMap(buttons) : node && typeof node === 'object' ? [...(node.type === 'button' ? [node] : []), ...buttons(node.props?.children)] : []

function bench(overrides = {}) {
  const cells = [], effects = [], timers = new Map()
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = initial
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    useEffect(effect) { const index = cursor++; if (!(index in cells)) { cells[index] = true; effects.push(effect()) } },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: () => react,
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
  })
  const calls = []
  const actions = {
    chatgpt: async () => ({ state: 'signed-out' }),
    chatgptSignIn: async () => ({ state: 'connected' }),
    chatgptSignOut: async () => ({ state: 'signed-out', remoteRevocationConfirmed: false }),
    chatgptCancel: async () => ({ state: 'signed-out' }),
    chatgptModels: async () => [],
    providers: async () => { calls.push('providers'); return { providers: [] } },
    refreshModels: () => calls.push('models'),
    ...overrides,
  }
  const render = () => {
    cursor = 0
    const node = module.exports.ChatGPTSettings({ actions, apply: promise => promise, provider: { models: [] } })
    return module.exports.ChatGPTControls(node.props)
  }
  return {
    render, calls, timers,
    controls: props => module.exports.ChatGPTControls(props),
    cleanup: () => effects.forEach(cleanup => cleanup?.()),
    click: label => buttons(render()).find(node => textOf(node) === label)?.props.onClick(),
  }
}

test('all ChatGPT states show the appropriate account controls without credentials', () => {
  const b = bench()
  const cases = [
    ['unsupported', ['Sign in with ChatGPT']],
    ['signed-out', ['Sign in with ChatGPT']],
    ['signing-in', ['Cancel']],
    ['connected', ['Refresh models', 'Sign out']],
    ['plan-usage-off', ['Enable plan usage', 'Sign out']],
    ['needs-sign-in', ['Sign in with ChatGPT', 'Sign out']],
    ['temporarily-unavailable', ['Retry', 'Sign out']],
  ]
  for (const [state, labels] of cases) {
    const tree = b.controls({ status: { state, account: { name: 'Demo', email: 'demo@example.test' }, planUsage: false } })
    assert.deepEqual(buttons(tree).map(textOf), labels)
    assert.match(textOf(tree), /demo@example.test/)
    assert.doesNotMatch(textOf(tree), /API key|token|relay/i)
    if (state === 'unsupported') assert.equal(buttons(tree)[0].props.disabled, true)
  }
})

test('consent requests plan usage and Cancel stays available during browser sign-in', () => {
  const b = bench()
  const sent = []
  const tree = b.controls({ status: { state: 'plan-usage-off' }, operate: (...args) => sent.push(args) })
  buttons(tree)[0].props.onClick()
  assert.equal(sent[0][0], 'sign-in')
  assert.equal(sent[0][1].consent, true)
  const signing = b.controls({ status: { state: 'signing-in' }, pending: 'sign-in' })
  assert.equal(buttons(signing)[0].props.disabled, false)
})

test('a temporary connection failure retries the request, not just the cached status', () => {
  const b = bench()
  const sent = []
  const withTokens = b.controls({ status: { state: 'temporarily-unavailable', planUsage: true }, operate: kind => sent.push(kind) })
  buttons(withTokens)[0].props.onClick()
  const withoutTokens = b.controls({ status: { state: 'temporarily-unavailable' }, operate: kind => sent.push(kind) })
  buttons(withoutTokens)[0].props.onClick()
  assert.deepEqual(sent, ['models', 'sign-in'])
})

test('a failed sign-in re-reads authoritative status and keeps the retained account', async () => {
  let reads = 0
  const b = bench({
    chatgpt: async () => ({ state: ++reads === 1 ? 'signed-out' : 'needs-sign-in', account: { email: 'retained@example.test' } }),
    chatgptSignIn: async () => { throw new Error('Please retry sign-in') },
  })
  b.render()
  await settle()
  await b.click('Sign in with ChatGPT')
  assert.equal(reads, 2)
  assert.match(textOf(b.render()), /retained@example.test/)
  assert.match(textOf(b.render()), /Please retry sign-in/)
  assert.deepEqual(b.calls, ['providers', 'models'])
  b.cleanup()
})

test('cancel supersedes a pending sign-in and duplicate starts are blocked', async () => {
  const signing = deferred()
  let starts = 0
  const b = bench({ chatgptSignIn: () => { starts++; return signing.promise } })
  b.render()
  await settle()
  const start = b.click('Sign in with ChatGPT')
  const pending = b.render()
  assert.deepEqual(buttons(pending).map(textOf), ['Cancel'])
  await b.click('Cancel')
  assert.match(textOf(b.render()), /Sign in to use your ChatGPT plan/)
  signing.resolve({ state: 'connected' })
  await start
  assert.equal(starts, 1)
  assert.match(textOf(b.render()), /Sign in to use your ChatGPT plan/)
  b.cleanup()
})

test('polling ignores an old status response after sign-out and stops on unmount', async () => {
  const old = deferred()
  let reads = 0
  const b = bench({ chatgpt: () => ++reads === 2 ? old.promise : Promise.resolve({ state: reads === 1 ? 'connected' : 'signed-out' }) })
  b.render()
  await settle()
  const poll = [...b.timers.values()][0]
  b.timers.clear()
  const waiting = poll()
  await b.click('Sign out')
  assert.match(textOf(b.render()), /remote revocation was not confirmed/)
  old.resolve({ state: 'connected' })
  await waiting
  assert.deepEqual(buttons(b.render()).map(textOf), ['Sign in with ChatGPT'])
  b.cleanup()
  assert.equal(b.timers.size, 0)
})

test('model refresh has a real empty state and reloads provider and model catalogs', async () => {
  const b = bench({ chatgpt: async () => ({ state: 'connected', planUsage: true }) })
  b.render()
  await settle()
  await b.click('Refresh models')
  assert.match(textOf(b.render()), /No models are available for this ChatGPT account/)
  assert.equal(textOf(b.render()).match(/No models are available for this ChatGPT account/g)?.length, 1)
  assert.match(textOf(b.render()), /Plan usage enabled/)
  assert.deepEqual(b.calls, ['providers', 'models'])
  b.cleanup()
})

test('sign-out keeps existing model names, and an empty account invents no model', () => {
  const b = bench()
  const tree = b.controls({ status: { state: 'signed-out' }, models: [{ id: 'existing', name: 'Existing model' }] })
  assert.match(textOf(tree), /Existing model/)
  const empty = b.controls({ status: { state: 'connected' } })
  assert.match(textOf(empty), /No models are available/)
  assert.doesNotMatch(textOf(empty), /gpt-/)
})

test('a pending status request cannot restart polling after unmount', async () => {
  const reading = deferred()
  const b = bench({ chatgpt: () => reading.promise })
  b.render()
  b.cleanup()
  reading.resolve({ state: 'connected' })
  await settle()
  assert.equal(b.timers.size, 0)
})
