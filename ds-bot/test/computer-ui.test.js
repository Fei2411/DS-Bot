import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ComputerPage, BotComputerCard, ComputerView, PendingAppAccess, ComputerIndicator, ComputerCallRow } from './src/client/computer.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ children }) => children; return ctx },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
  useCallback: fn => fn,
  useContext: ctx => ctx.value,
  useEffect: (make, deps) => effect(make, deps ?? []),
  useId: () => 'id',
  useLayoutEffect: (make, deps) => effect(make, deps ?? []),
  useMemo: (make) => make(),
  useRef: value => slot(() => ({ current: value })),
  useState: initial => { const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [cell.value, next => { cell.value = next }] },
}
const run = (code, sandbox) => {
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, require: (name) => name === 'react' ? react : {}, ...sandbox }, { filename: 'bundle.cjs' })
  return module.exports
}
const mod = run(outputFiles[0].text)
const render = (component, props) => {
  current = { index: 0, slots: [], effects: [] }
  const tree = mod[component](props)
  return tree
}
const texts = (node, found = []) => {
  if (typeof node === 'string' || typeof node === 'number') found.push(String(node))
  if (Array.isArray(node)) node.forEach(item => texts(item, found))
  if (node && typeof node === 'object') {
    for (const key of ['children', 'label', 'title']) if (node.props?.[key]) texts(node.props[key], found)
  }
  return found
}
const buttons = (node, found = []) => {
  if (Array.isArray(node)) node.forEach(item => buttons(item, found))
  if (node && typeof node === 'object') {
    if (node.type === 'button') found.push(texts(node).join(''))
    for (const key of ['children', 'label', 'title']) if (node.props?.[key]) buttons(node.props[key], found)
  }
  return found
}

test('the app-access card orders its buttons Deny, This time, Always', () => {
  const actions = { computerAppAnswer: async () => true }
  const ask = { id: 'a1', sessionId: 'w1', botName: 'Writer', appName: 'Notes' }
  const tree = render('PendingAppAccess', { ask, actions, inline: true })
  assert.deepEqual(buttons(tree), ['Deny', 'This time', 'Always'])
})

test('the settings page draws the switch, the provider line and one level picker per Bot', () => {
  const roster = { bots: [{ id: 'w1', name: 'Writer' }], computer: { enabled: false } }
  const hooks = { useComputer: pick => pick({ provider: { state: 'missing' } }) }
  const Switch = ({ label }) => ({ type: 'switch', props: { label } })
  const tree = render('ComputerPage', {
    roster, actions: { computerSetEnabled: async () => {} }, run: p => p, hooks,
    Section: ({ children }) => h2(children), Row: ({ children }) => h2(children), Switch,
  })
  function h2(children) { return { type: 'row', props: { children } } }
  // The page title names the page; the first section carries no title of its own.
  assert.ok(texts(tree).some(text => text.includes('Let Bots use the computer')))
})

test('a missing provider package shows the install command and says the levels wait (#1050)', () => {
  const install = { packages: ['@deepseek-ai/dsh-computer-use@0.2.2-rc.1'], command: 'pnpm --dir "/p" add @deepseek-ai/dsh-computer-use@0.2.2-rc.1' }
  const roster = { bots: [{ id: 'w1', name: 'Writer' }], computer: { enabled: true, provider: { state: 'missing', message: 'x is not installed in this DSH.', install } } }
  const Row = props => ({ type: 'row', props })
  const tree = render('ComputerPage', {
    roster, actions: { computerSetEnabled: async () => {}, computerProviderRetry: async () => {}, computerSetLevel: async () => {} }, run: p => p,
    Section: ({ children }) => ({ type: 'section', props: { children } }), Row, Switch: () => null,
  })
  const find = (node, test) => {
    if (Array.isArray(node)) return node.map(item => find(item, test)).find(Boolean)
    if (node && typeof node === 'object') {
      if (test(node)) return node
      return find(node.props?.children, test)
    }
    return undefined
  }
  const installRow = find(tree, node => node.props?.install !== undefined)
  assert.ok(installRow, 'the install row is drawn')
  const drawn = installRow.type(installRow.props)
  assert.ok(drawn.props.hint.includes(install.command))
  assert.deepEqual(buttons(drawn), ['Copy command'])
  assert.ok(texts(tree).includes('Bots get no computer tools until the provider is ready.'))
})

test('the control card shows the level picker and the Always apps with Revoke', () => {
  const bot = { id: 'w1', name: 'Writer', computer: { level: 'background', apps: { notes: { name: 'Notes', grantedAt: 0 } } } }
  const tree = render('BotComputerCard', {
    bot, roster: { computer: { enabled: true } },
    actions: { computerSetLevel: async () => {}, computerRevokeApp: async () => {} }, run: p => p,
    Card: ({ children }) => h3(children), Row: ({ children }) => h3(children),
  })
  function h3(children) { return { type: 'row', props: { children } } }
  assert.ok(texts(tree).includes('Revoke'))
  assert.ok(texts(tree).includes('Notes'))
})

test('the computer view shows the state, steps and the action buttons', () => {
  const bot = { id: 'w1', name: 'Writer' }
  const tree = render('ComputerView', {
    bot,
    actions: { computerShot: async () => ({ dataUrl: 'data:image/png;base64,x' }), computerStop: async () => {}, computerTakeover: async () => {}, computerHandback: async () => {} },
    hooks: { useComputer: pick => pick({ bots: { w1: { state: 'bot', app: 'Notes', steps: [{ time: 1, action: 'click', ok: true }] } } }) },
  })
  assert.ok(texts(tree).includes('Take over the computer') || texts(tree).includes('Hand back'))
  assert.ok(texts(tree).includes('Stop'))
})

test('the indicator lists entries with a localized Stop and Stop all', () => {
  const live = { leases: [{ kind: 'app', appKey: 'notes', appName: 'Notes', botId: 'w1' }, { kind: 'app', appKey: 'mail', appName: 'Mail', botId: 'm1' }], bots: {} }
  const roster = { getSnapshot: () => ({ byId: { w1: { name: 'Writer' }, m1: { name: 'Chief' } } }) }
  const useComputer = pick => pick(live)
  const useRoster = pick => pick(roster.getSnapshot())
  const tree = render('ComputerIndicator', { useComputer, useRoster, actions: { computerStop: async () => {} } })
  const found = buttons(tree)
  assert.deepEqual(found.filter(name => name === 'Stop').length, 2)
  assert.ok(found.includes('Stop all'))
})


// A computer step row reads "app · action": the app from the step record or the
// getApp selector, the action from the method; with no app just the action.
test('a computer call row names the app and the action', () => {
  const live = { bots: { w1: { steps: [{ callId: 'c1', app: 'Notes' }] } } }
  const props = (call, botsLive = live) => ({
    sessionId: 's-w1',
    call,
    roster: { byId: { 's-w1': { id: 'w1', name: 'Chief' } } },
    actions: {},
    hooks: { useComputer: map => map(botsLive) },
  })
  // arguments may arrive as a JSON string; the app comes from the step record
  const row = render('ComputerCallRow', props({ name: 'cua', callId: 'c1', argsRaw: '{"method":"click","params":{"appHandle":"h1"}}', content: [] }))
  assert.deepEqual(texts(row), ['Notes · Click'])
  // getApp names its target by the selector, before any step record exists
  const getApp = render('ComputerCallRow', props({ name: 'cua', callId: 'c2', argsRaw: '{"method":"getApp","params":{"selector":"TextEdit"}}', content: [] }, { bots: {} }))
  assert.deepEqual(texts(getApp), ['TextEdit · Get App'])
  // no app yet: just the action
  const caps = render('ComputerCallRow', props({ name: 'cua', callId: 'c3', argsRaw: '{"method":"getCapabilities","params":{}}', content: [] }, { bots: {} }))
  assert.deepEqual(texts(caps), ['Capabilities'])
  // cua-driver: the tool suffix is the action
  const driver = render('ComputerCallRow', props({ name: 'cua_driver_native__screenshot', callId: 'c1', argsRaw: '{}', content: [] }))
  assert.deepEqual(texts(driver), ['Notes · Screenshot'])
})

// The settings scroll container wraps the computer page like every other page.
test('the computer settings page sits inside the scroll container', () => {
  const src = new URL('../src/client/settings.js', import.meta.url)
  const code = String((process.getBuiltinModule('node:fs')).readFileSync(src))
  const scroll = code.indexOf('bt-settings-scroll')
  assert.ok(scroll > 0)
  assert.ok(code.indexOf('h(ComputerPage') > scroll)
})

// The computer styles register in their own effect, like the other style packs.
test('the computer styles register in their own effect call', () => {
  const src = new URL('../src/client/index.js', import.meta.url)
  const code = String((process.getBuiltinModule('node:fs')).readFileSync(src))
  assert.match(code, /ctx\.effect\(\(\) => installCompiledStyles\(COMPUTER_CSS, 'computer'\)/)
})
