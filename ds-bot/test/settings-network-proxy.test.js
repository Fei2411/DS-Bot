import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { toTraditional } from '../src/client/locales/zh-tw.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function loadBundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: join(repoRoot, 'ds-bot') },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

function makeStatefulReact() {
  const states = new Map()
  const effects = new Map()
  const prevDeps = new Map()
  const cleanups = new Map()
  let activePath = ''
  let hookIdx = 0
  const nextSlot = () => `${activePath}#${hookIdx++}`
  const depsChanged = (a, b) => {
    if (!a || !b || a.length !== b.length) return true
    return a.some((v, i) => !Object.is(v, b[i]))
  }
  const React = {
    Fragment: Symbol('Fragment'),
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch) }
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    useState(init) {
      const key = nextSlot()
      if (!states.has(key)) states.set(key, typeof init === 'function' ? init() : init)
      return [states.get(key), (next) => { states.set(key, typeof next === 'function' ? next(states.get(key)) : next) }]
    },
    useRef(init) {
      const key = nextSlot()
      if (!states.has(key)) states.set(key, { current: init })
      return states.get(key)
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useId() { return 'bt-id' },
    createContext(v) { return { Provider: ({ children }) => children, _v: v } },
    useContext(c) { return c?._v },
    useEffect(fn, deps) { effects.set(nextSlot(), { fn, deps }) },
    useLayoutEffect(fn, deps) { effects.set(nextSlot(), { fn, deps }) },
  }
  const expand = (node, path = 'root') => {
    if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${idx}]`))
    if (!node || typeof node !== 'object') return node
    if (node.type === React.Fragment) return expand(node.children, `${path}.F`)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Fn'
      const compPath = `${path}/${name}:${node.props?.key ?? ''}`
      if (node.type.prototype && typeof node.type.prototype.render === 'function') {
        const inst = new node.type({ ...node.props, children: node.children })
        return expand(inst.render(), compPath)
      }
      const prevPath = activePath
      const prevIdx = hookIdx
      activePath = compPath
      hookIdx = 0
      try {
        return expand(node.type({ ...node.props, children: node.children }), compPath)
      } finally {
        activePath = prevPath
        hookIdx = prevIdx
      }
    }
    return { ...node, children: expand(node.children ?? [], `${path}/${String(node.type)}`) }
  }
  const flushEffects = () => {
    for (const [key, { fn, deps }] of effects) {
      if (depsChanged(prevDeps.get(key), deps)) {
        cleanups.get(key)?.()
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.set(key, cleanup)
        prevDeps.set(key, deps)
      }
    }
    effects.clear()
  }
  return {
    React,
    render(el) { const tree = expand(el); flushEffects(); return tree },
    unmount() { for (const fn of cleanups.values()) fn(); cleanups.clear() },
  }
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const baseRoster = {
  bots: [{ id: 'bot-1', name: 'Chief', role: '', model: 'openai/gpt-5' }],
  byId: { 'bot-1': { id: 'bot-1', name: 'Chief', role: '', model: 'openai/gpt-5' } },
  mainBotIds: ['bot-1'],
  models: [{ ref: 'openai/gpt-5', name: 'GPT-5', provider: 'openai' }],
  defaultModel: 'openai/gpt-5',
  prefs: {},
}

test('GeneralPage hides Network proxy section outside desktop app and supports System / Custom / No proxy in desktop app', async () => {
  const code = await loadBundle(`
    export { SettingsDialog } from './src/client/settings.js'
    export { searchHits } from './src/client/settings-palette.js'
  `)
  const prevApp = globalThis.dsBotApp
  const prevWindow = globalThis.window
  const prevDoc = globalThis.document
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
  globalThis.document = { body: { dataset: {} }, documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} }

  try {
    // 0. Traditional Chinese converts 绕 -> 繞 cleanly.
    assert.equal(toTraditional('绕过列表'), '繞過列表')

    // 1. Outside desktop app (no dsBotApp.proxy): Network section AND search palette entry are hidden.
    delete globalThis.dsBotApp
    const harness0 = makeStatefulReact()
    const mod0 = { exports: {} }
    new Function('module', 'exports', 'require', code)(mod0, mod0.exports, () => harness0.React)
    assert.equal(mod0.exports.searchHits('proxy', { roster: baseRoster }).some(hit => hit.id === 'network'), false)

    const hNoApp = makeStatefulReact()
    const modNoApp = { exports: {} }
    new Function('module', 'exports', 'require', code)(modNoApp, modNoApp.exports, () => hNoApp.React)
    const actions = {
      openSettings: () => {},
      closeSettings: () => {},
      folders: () => Promise.resolve({ team: '/work', data: '/data' }),
      setPrefs: () => Promise.resolve(),
    }
    const treeNoApp = hNoApp.render(hNoApp.React.createElement(modNoApp.exports.SettingsDialog, {
      page: 'general', id: null, roster: baseRoster, actions, dsh: null, useUpdate: sel => sel({}),
    }))
    assert.equal(findAll(treeNoApp, n => n.props?.className?.includes('bt-set-network')).length, 0)
    hNoApp.unmount()

    // 2. Inside desktop app (dsBotApp.proxy): search palette finds Proxy, loads saved state, switches modes, rolls back on error, validates and saves custom proxy.
    let stored = { mode: 'system', url: '', bypass: '' }
    let failNext = false
    const calls = []
    globalThis.dsBotApp = {
      dataLocation: () => Promise.resolve({ path: '/data', fixed: false }),
      proxy: {
        get: () => Promise.resolve({ ...stored }),
        set: (next) => {
          calls.push(next)
          if (failNext) { failNext = false; return Promise.reject(new Error('disk full')) }
          if (next.mode === 'custom' && !next.url.includes(':')) return Promise.reject(new Error('Invalid proxy address'))
          stored = { mode: next.mode, url: next.url.includes('://') ? next.url : (next.url ? `http://${next.url}` : ''), bypass: next.bypass }
          return Promise.resolve({ ...stored })
        },
      },
    }
    assert.ok(mod0.exports.searchHits('proxy', { roster: baseRoster }).some(hit => hit.id === 'network' && hit.page === 'general'))
    assert.ok(mod0.exports.searchHits('代理', { roster: baseRoster }).some(hit => hit.id === 'network' && hit.page === 'general'))

    const hApp = makeStatefulReact()
    const modApp = { exports: {} }
    new Function('module', 'exports', 'require', code)(modApp, modApp.exports, () => hApp.React)
    const draw = () => hApp.render(hApp.React.createElement(modApp.exports.SettingsDialog, {
      page: 'general', id: null, roster: baseRoster, actions, dsh: null, useUpdate: sel => sel({}),
    }))
    draw()
    await new Promise(r => setTimeout(r, 0))
    let tree = draw()
    assert.equal(findAll(tree, n => n.props?.className?.includes('bt-set-network')).length, 1)

    // Failed non-custom switch rolls back mode to 'system' so user can retry immediately.
    failNext = true
    findAll(tree, n => n.type === 'button' && textOf(n) === 'No proxy')[0].props.onClick()
    await new Promise(r => setTimeout(r, 0))
    tree = draw()
    assert.equal(findAll(tree, n => n.type === 'button' && textOf(n) === 'System')[0].props['aria-pressed'], true)
    assert.equal(findAll(tree, n => n.props?.role === 'alert').length, 1)

    // Switch to No proxy -> saves immediately.
    const noProxyBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'No proxy')[0]
    assert.ok(noProxyBtn)
    noProxyBtn.props.onClick()
    await new Promise(r => setTimeout(r, 0))
    tree = draw()
    assert.equal(stored.mode, 'direct')

    // Switch to Custom with empty URL -> reveals form without saving yet.
    const customBtn = findAll(tree, n => n.type === 'button' && textOf(n) === 'Custom')[0]
    customBtn.props.onClick()
    tree = draw()
    assert.equal(calls.length, 2)
    const urlInput = findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Proxy address')[0]
    const bypassInput = findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Bypass')[0]
    assert.ok(urlInput && bypassInput)

    // Submitting invalid URL shows alert error.
    urlInput.props.onChange({ target: { value: 'bad-url' } })
    tree = draw()
    findAll(tree, n => n.type === 'form' && n.props?.className === 'bt-set-proxy-form')[0].props.onSubmit({ preventDefault() {} })
    await new Promise(r => setTimeout(r, 0))
    tree = draw()
    assert.ok(findAll(tree, n => n.props?.role === 'alert' && textOf(n).includes('Invalid proxy address')).length === 1)

    // Submitting valid URL + bypass saves cleanly and clears alert.
    findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Proxy address')[0].props.onChange({ target: { value: '127.0.0.1:7890' } })
    findAll(tree, n => n.type === 'input' && n.props?.['aria-label'] === 'Bypass')[0].props.onChange({ target: { value: '.local' } })
    tree = draw()
    findAll(tree, n => n.type === 'form' && n.props?.className === 'bt-set-proxy-form')[0].props.onSubmit({ preventDefault() {} })
    await new Promise(r => setTimeout(r, 0))
    tree = draw()
    assert.deepEqual(stored, { mode: 'custom', url: 'http://127.0.0.1:7890', bypass: '.local' })
    assert.equal(findAll(tree, n => n.props?.role === 'alert').length, 0)
    hApp.unmount()
  } finally {
    if (prevApp === undefined) delete globalThis.dsBotApp
    else globalThis.dsBotApp = prevApp
    globalThis.window = prevWindow
    globalThis.document = prevDoc
  }
})
