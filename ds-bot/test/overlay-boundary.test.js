import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))

async function loadBundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: plugin },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

// Minimal React runtime with class ErrorBoundary lifecycle (getDerivedStateFromProps,
// getDerivedStateFromError, componentDidCatch) so tests exercise real boundary isolation.
function createRuntime() {
  const stateSlots = new Map()
  const refSlots = new Map()
  const instances = new Map()
  let activeKey = null
  let hookIndex = 0

  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch
      if (next !== null && next !== undefined) this.state = { ...this.state, ...next }
    }
  }

  const react = {
    Component,
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) },
    }),
    createContext: value => ({ Provider: 'Provider', value }),
    useContext: context => context.value,
    useEffect() {},
    useLayoutEffect() {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useId: () => 'id',
    useState(initial) {
      const key = `${activeKey}:s:${hookIndex++}`
      if (!stateSlots.has(key)) stateSlots.set(key, typeof initial === 'function' ? initial() : initial)
      return [stateSlots.get(key), (next) => {
        const prev = stateSlots.get(key)
        stateSlots.set(key, typeof next === 'function' ? next(prev) : next)
      }]
    },
    useRef(initial) {
      const key = `${activeKey}:r:${hookIndex++}`
      if (!refSlots.has(key)) refSlots.set(key, { current: initial })
      return refSlots.get(key)
    },
  }

  const renderNode = (node, path = '0', seen = new Set()) => {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return node
    }
    if (Array.isArray(node)) {
      return node.map((child, idx) => renderNode(child, `${path}.${idx}`, seen))
    }
    if (node.type === react.Fragment) {
      return renderNode(node.props?.children, `${path}.f`, seen)
    }
    if (typeof node.type === 'function' && node.type.prototype instanceof Component) {
      const key = `${path}:${node.type.name}:${node.props?.name ?? node.props?.key ?? ''}`
      seen.add(key)
      let inst = instances.get(key)
      if (!inst) {
        inst = new node.type(node.props)
        instances.set(key, inst)
      } else {
        inst.props = node.props
      }
      if (typeof node.type.getDerivedStateFromProps === 'function') {
        const derived = node.type.getDerivedStateFromProps(inst.props, inst.state)
        if (derived !== null && derived !== undefined) inst.state = { ...inst.state, ...derived }
      }
      try {
        return renderNode(inst.render(), `${key}.c`, seen)
      } catch (error) {
        if (typeof node.type.getDerivedStateFromError === 'function') {
          const derived = node.type.getDerivedStateFromError(error)
          if (derived !== null && derived !== undefined) inst.state = { ...inst.state, ...derived }
          inst.componentDidCatch?.(error, { componentStack: `\n    at ${node.type.name}` })
          return renderNode(inst.render(), `${key}.e`, seen)
        }
        throw error
      }
    }
    if (typeof node.type === 'function') {
      const prevKey = activeKey
      const prevIndex = hookIndex
      activeKey = `${path}:${node.type.name}:${node.props?.key ?? ''}`
      hookIndex = 0
      try {
        return renderNode(node.type(node.props ?? {}), `${activeKey}.r`, seen)
      } finally {
        activeKey = prevKey
        hookIndex = prevIndex
      }
    }
    return {
      ...node,
      props: {
        ...node.props,
        children: renderNode(node.props?.children, `${path}.ch`, seen),
      },
    }
  }

  const render = (element) => {
    const seen = new Set()
    const tree = renderNode(element, '0', seen)
    for (const key of [...instances.keys()]) {
      if (!seen.has(key)) instances.delete(key)
    }
    return tree
  }

  return { react, render }
}

const bundleCode = await loadBundle(`
  export { OverlayBoundary } from './src/client/overlay-boundary.js'
  export { Overlays } from './src/client/overlays.js'
  export { SettingsShell } from './src/client/settings-shell.js'
  export { teamActions } from './src/client/team-actions.js'
  export { createSource, EMPTY_ROSTER } from './src/client/sources.js'
  export { clientErrors, clearClientErrors } from './src/client/diagnostics.js'
`)

function loadModule(react, { consoleError = () => {} } = {}) {
  const mod = { exports: {} }
  runInNewContext(bundleCode, {
    module: mod, exports: mod.exports,
    console: { ...console, error: consoleError, warn: () => {} },
    document: { body: {} },
    window: { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout, clearTimeout, Promise,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: (_, key) => key })),
  })
  return mod.exports
}

const collect = (tree, match, out = []) => {
  if (Array.isArray(tree)) { tree.forEach(item => collect(item, match, out)); return out }
  if (!tree || typeof tree !== 'object') return out
  if (match(tree)) out.push(tree)
  collect(tree.props?.children, match, out)
  return out
}

test('OverlayBoundary isolates a crashing NewChat, dismisses it, notifies the user, and recovers when reopened', () => {
  const errors = []
  const { react, render } = createRuntime()
  const { OverlayBoundary, teamActions, createSource, EMPTY_ROSTER, clientErrors, clearClientErrors } = loadModule(react, {
    consoleError: (...args) => errors.push(args),
  })
  clearClientErrors()

  const roster = createSource({ ...EMPTY_ROSTER, ready: true })
  const ui = createSource({
    details: 'bot-chief', view: 'details', newChat: 'new', newChatSection: 'sec-1',
    exchange: ['a', 'b'], menu: null, palette: null, toast: null, paste: {},
  })
  const actions = teamActions({
    call: async () => ({}), after: p => p, partFor: id => id,
    roster, ui, live: createSource({}), cards: createSource({}), heldCards: createSource({}), turnClock: createSource({}),
  })

  let shouldCrash = true
  function FlakyNewChat() {
    if (shouldCrash) throw new Error('Minified React error #310')
    return react.createElement('div', { className: 'bt-newchat-ok' }, 'New chat open')
  }
  function HealthySibling() {
    return react.createElement('div', { className: 'bt-panel-ok' }, 'Panel intact')
  }

  const renderShell = () => {
    const state = ui.getSnapshot()
    return react.createElement(react.Fragment, null,
      react.createElement(OverlayBoundary, { name: 'panel', actions },
        react.createElement(HealthySibling)),
      state.newChat ? react.createElement(OverlayBoundary, {
        name: 'new-chat',
        reset: `${state.newChat}:${state.newChatSection ?? ''}`,
        onDismiss: () => actions.closeNewChat(),
        actions,
      }, react.createElement(FlakyNewChat)) : null)
  }

  // First render: FlakyNewChat throws, OverlayBoundary catches it without crashing the shell.
  const afterCrash = render(renderShell())
  assert.equal(collect(afterCrash, n => n.props?.className === 'bt-panel-ok').length, 1, 'sibling overlay stays mounted')
  assert.equal(collect(afterCrash, n => n.props?.className === 'bt-newchat-ok').length, 0)
  assert.equal(ui.getSnapshot().newChat, null, 'crashed NewChat is dismissed')
  assert.equal(ui.getSnapshot().newChatSection, null, 'newChatSection is cleared with newChat')
  assert.equal(ui.getSnapshot().details, 'bot-chief', 'open details panel is preserved')
  assert.deepEqual(ui.getSnapshot().exchange, ['a', 'b'], 'open exchange dialog is preserved')
  assert.equal(ui.getSnapshot().toast?.text, 'This view closed because of an error.')
  assert.ok(clientErrors().some(entry => entry.text.includes('overlay:new-chat: Minified React error #310')))
  assert.equal(errors.length, 1)

  // Re-render while dismissed unmounts the boundary cleanly.
  render(renderShell())

  // Clicking "+" again opens NewChat with a fresh boundary.
  shouldCrash = false
  actions.openNewChat('new')
  assert.equal(ui.getSnapshot().newChat, 'new')
  const reopened = render(renderShell())
  assert.equal(collect(reopened, n => n.props?.className === 'bt-newchat-ok').length, 1, 'reopening via + works immediately')
})

test('OverlayBoundary stays quiet during linger after a crash and resets only on explicit reopen', () => {
  const { react, render } = createRuntime()
  const { OverlayBoundary, clearClientErrors } = loadModule(react)
  clearClientErrors()

  let throws = true
  let renderCalls = 0
  let dismissed = 0
  let notices = 0
  function CrashingPanel() {
    renderCalls += 1
    if (throws) throw new Error('panel boom')
    return react.createElement('aside', { className: 'bt-panel-ok' })
  }
  const actions = { notice: () => { notices += 1 } }

  // 1. Open and crash.
  render(react.createElement(OverlayBoundary, {
    name: 'panel', active: true, reset: 'bot-1:details', onDismiss: () => { dismissed += 1 }, actions,
  }, react.createElement(CrashingPanel)))
  assert.equal(renderCalls, 1)
  assert.equal(dismissed, 1)
  assert.equal(notices, 1)

  // 2. While lingering (active=false), boundary stays failed and never re-mounts the broken panel.
  render(react.createElement(OverlayBoundary, {
    name: 'panel', active: false, notify: false, reset: 'bot-1:details', onDismiss: () => { dismissed += 1 }, actions,
  }, react.createElement(CrashingPanel)))
  assert.equal(renderCalls, 1, 'does not re-render crashed panel during exit linger')
  assert.equal(dismissed, 1)

  // 3. Explicit reopen before linger finishes (active: false -> true) resets the boundary.
  throws = false
  const reopened = render(react.createElement(OverlayBoundary, {
    name: 'panel', active: true, reset: 'bot-1:details', onDismiss: () => { dismissed += 1 }, actions,
  }, react.createElement(CrashingPanel)))
  assert.equal(renderCalls, 2)
  assert.equal(collect(reopened, n => n.props?.className === 'bt-panel-ok').length, 1)
})

test('OverlayBoundary suppresses toast when notify=false and tolerates a failing onDismiss', () => {
  const { react, render } = createRuntime()
  const { OverlayBoundary, clientErrors, clearClientErrors } = loadModule(react)
  clearClientErrors()

  let notices = 0
  function BadWatcher() {
    throw new Error('watcher boom')
  }
  const renderWatcher = () => react.createElement(OverlayBoundary, {
    name: 'notifications',
    notify: false,
    onDismiss: () => { throw new Error('dismiss failed') },
    actions: { notice: () => { notices += 1 } },
  }, react.createElement(BadWatcher))

  assert.doesNotThrow(() => render(renderWatcher()))
  assert.equal(notices, 0)
  assert.ok(clientErrors().some(entry => entry.text.includes('overlay:notifications: watcher boom')))
  // Re-rendering does not loop when reset/active are unchanged.
  assert.doesNotThrow(() => render(renderWatcher()))
})

test('Overlays wraps every overlay and watcher child in an OverlayBoundary', () => {
  const { react } = createRuntime()
  const { Overlays, OverlayBoundary } = loadModule(react)

  const roster = {
    bots: [], rooms: [], byId: { 'bot-1': { id: 'bot-1', name: 'Chief' } },
    roomsById: { 'room-1': { id: 'room-1', name: 'Team' } },
    exchangeTurns: {}, prefs: {},
  }
  const ui = {
    pendingOpen: { target: 'bot-1', id: 'bot-1', name: 'Chief', slow: false },
    details: 'bot-1', view: 'details', renaming: false, tab: null, side: null, task: null,
    newChat: 'new', newChatSection: null,
    palette: { query: '', token: 1 },
    groupSearch: { roomId: 'room-1', token: 2 },
    exchange: ['bot-1', 'bot-2'],
    voice: 'bot-1',
    menu: { kind: 'bot', id: 'bot-1', x: 10, y: 20 },
    settings: { page: 'general', id: null },
    memory: 'bot-1',
    leftDrawer: false, panelYield: false,
  }
  const tree = Overlays({
    useRoster: select => select(roster),
    useUi: select => select(ui),
    useSessions: select => select({ byId: {} }),
    useSessionStatus: select => select(new Map()),
    useActivity: select => select({}),
    useWork: select => select({ approvals: [], rooms: {}, waiting: {} }),
    useComputer: select => select({ asks: {} }),
    useRegistry: select => select(0),
    useBrowserPages: select => select({}),
    useBrowserTabs: select => select({}),
    useBrowserHolds: select => select({}),
    useUpdate: select => select({}),
    useFrame: select => select({ viewport: 1400, sidebarWidth: 280, collapsedWidth: 0 }),
    useSidebarPref: select => select('open'),
    useSettingsShellHeld: select => select(false),
    actions: {},
  })

  const children = tree.props.children.filter(Boolean)
  assert.equal(children.length, 11, 'all 11 overlay slots are mounted in the test fixture')
  for (const child of children) {
    assert.equal(child.type, OverlayBoundary, `expected OverlayBoundary wrapper, got ${child.type?.name ?? String(child.type)}`)
  }
  const names = children.map(child => child.props.name)
  assert.deepEqual(names, [
    'notifications', 'opening', 'panel', 'new-chat', 'palette',
    'group-search', 'exchange', 'voice', 'menu', 'settings', 'memory',
  ])
})

test('Overlays derives distinct panel reset keys for different background tasks', () => {
  const { react } = createRuntime()
  const { Overlays, OverlayBoundary } = loadModule(react)

  const roster = { bots: [], rooms: [], byId: { 'bot-1': { id: 'bot-1', name: 'Chief' } }, roomsById: {}, exchangeTurns: {}, prefs: {} }
  const renderPanelReset = (task) => {
    const tree = Overlays({
      useRoster: select => select(roster),
      useUi: select => select({ details: 'bot-1', view: 'task', renaming: false, tab: null, side: null, task, leftDrawer: false, panelYield: false }),
      useSessions: select => select({ byId: {} }),
      useSessionStatus: select => select(new Map()),
      useActivity: select => select({}),
      useWork: select => select({ approvals: [], rooms: {}, waiting: {} }),
      useComputer: select => select({ asks: {} }),
      useRegistry: select => select(0),
      useBrowserPages: select => select({}),
      useBrowserTabs: select => select({}),
      useBrowserHolds: select => select({}),
      useUpdate: select => select({}),
      useFrame: select => select({ viewport: 1400, sidebarWidth: 280, collapsedWidth: 0 }),
      useSidebarPref: select => select('open'),
      useSettingsShellHeld: select => select(false),
      actions: {},
    })
    const panel = tree.props.children.filter(Boolean).find(node => node.type === OverlayBoundary && node.props.name === 'panel')
    return panel.props.reset
  }

  const resetA = renderPanelReset({ botId: 'bot-1', taskId: 'task-1' })
  const resetB = renderPanelReset({ botId: 'bot-1', taskId: 'task-2' })
  assert.notEqual(resetA, resetB)
  assert.ok(!resetA.includes('[object Object]'))
  assert.ok(resetA.includes('bot-1:task-1'))
  assert.ok(resetB.includes('bot-1:task-2'))
})

test('SettingsShell wraps its SettingsDialog portal in an OverlayBoundary', () => {
  const { react } = createRuntime()
  const { SettingsShell, OverlayBoundary } = loadModule(react)

  const tree = SettingsShell({
    wide: true,
    renderSlot: () => null,
    actions: { openSettings() {}, closeSettings() {} },
    useUi: select => select({ settings: { page: 'general', id: null } }),
    useRoster: select => select({ bots: [], rooms: [], byId: {}, roomsById: {}, prefs: {} }),
    useUpdate: select => select({}),
    useSessions: select => select({ byId: {} }),
    useSections: select => select([]),
    useGeneralItems: select => select([]),
    useOnboardingSteps: select => select([]),
    useOnboardingRequest: select => select(undefined),
    useConnectionState: select => select({ status: 'connected' }),
    useDesktopUpdate: select => select({ presentation: null }),
    useSettingsShortcut: select => select(null),
    reconnect() {}, openDesktopUpdate() {}, openOnboarding() {}, finishOnboarding() {}, holdSeat: () => () => {},
  })
  const boundaries = collect(tree, node => node.type === OverlayBoundary && node.props?.name === 'settings')
  assert.equal(boundaries.length, 1)
})

test('teamActions.closeNewChat and closeExchange only dismiss their own overlay', () => {
  const { react } = createRuntime()
  const { teamActions, createSource, EMPTY_ROSTER } = loadModule(react)

  const roster = createSource({ ...EMPTY_ROSTER, ready: true })
  const ui = createSource({ details: 'bot-1', view: 'details', newChat: 'new', newChatSection: 'sec-1', exchange: ['a', 'b'] })
  const actions = teamActions({
    call: async () => ({}), after: p => p, partFor: id => id,
    roster, ui, live: createSource({}), cards: createSource({}), heldCards: createSource({}), turnClock: createSource({}),
  })

  actions.closeNewChat()
  assert.equal(ui.getSnapshot().newChat, null)
  assert.equal(ui.getSnapshot().newChatSection, null)
  assert.equal(ui.getSnapshot().details, 'bot-1')
  assert.deepEqual(ui.getSnapshot().exchange, ['a', 'b'])

  actions.closeExchange()
  assert.equal(ui.getSnapshot().exchange, null)
  assert.equal(ui.getSnapshot().details, 'bot-1')
})
