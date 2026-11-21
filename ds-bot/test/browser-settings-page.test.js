import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Browser settings page with a small React so its sections and rows render.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/browser-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const cells = []
let hook = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState(initial) {
    const i = hook++
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
    return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }]
  },
  useEffect() {},
  Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
})
const { BrowserPage } = module.exports
const h = react.createElement
const Section = ({ title, action, children }) => h('section', null, h('h3', null, title), action ?? null, ...(children ?? []))
const Row = ({ label, hint, children }) => h('div', null, h('span', null, label), hint ? h('span', null, hint) : null, ...(children ?? []))
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}

test('the Browser page renders hot-swappable backend choices and read-only default copy', () => {
  hook = 0
  cells.length = 0
  const text = textOf(expand(BrowserPage({ roster: { bots: [] }, actions: {}, run: () => {}, Section, Row })))
  assert.match(text, /Browser backend/)
  assert.match(text, /A Bot can read the page you have open/)
  assert.match(text, /cannot click, type, scroll or open pages/)
  assert.match(text, /DS Bot Playwright · ARIA refs/)
  assert.match(text, /DS Bot Playwright · Script/)
  assert.match(text, /DS Bot Playwright · Whole task/)
  assert.match(text, /DSH browser plugins/)
  assert.match(text, /MCP browser servers/)
  assert.match(text, /With an interactive plugin, Bots browse, click and fill in forms/)
  assert.doesNotMatch(text, /freely/)
})

test('the Browser page lists ego lite DSH plugins, MCP servers, native providers, and external permission notice', () => {
  hook = 0
  cells.length = 0
  const roster = {
    bots: [],
    browserBackend: {
      active: 'dsh:dsh-ego-browser',
      status: {
        id: 'dsh:dsh-ego-browser',
        kind: 'dsh-plugin',
        name: 'Ego Browser (ego lite)',
        mode: 'external',
        state: 'ready',
        supportsGrants: false,
        message: null,
        installCommand: null,
      },
      canInstall: true,
      builtins: [
        { id: 'builtin:refs', name: 'DS Bot Playwright · ARIA refs', description: 'Built-in refs' },
      ],
      dshPlugins: [
        {
          id: 'dsh:dsh-ego-browser',
          name: 'Ego Browser (ego lite)',
          description: 'Drive ego lite',
          packageName: 'dsh-ego-browser',
          installed: true,
          version: '0.14.1',
          installCommand: 'dsh plugin add dsh-ego-browser',
        },
        {
          id: 'dsh:@dshworks/dsh-ego-browser',
          name: 'Ego Browser Memory (ego lite)',
          description: 'Site skill memory',
          packageName: '@dshworks/dsh-ego-browser',
          installed: false,
          installCommand: 'dsh plugin add @dshworks/dsh-ego-browser',
        },
      ],
      mcpServers: [
        { id: 'mcp:playwright-mcp', name: 'Playwright MCP', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      ],
      providers: [
        { id: 'provider:custom-cdp', name: 'Custom CDP Driver', description: 'Third-party native provider' },
      ],
    },
  }
  const text = textOf(expand(BrowserPage({
    roster,
    actions: { browserSetBackend: () => {}, browserInstallPlugin: () => {}, browserCustomSave: () => {} },
    run: () => {},
    Section,
    Row,
  })))
  assert.match(text, /Ego Browser \(ego lite\)/)
  assert.match(text, /0\.14\.1/)
  assert.match(text, /Ego Browser Memory \(ego lite\)/)
  assert.match(text, /Playwright MCP/)
  assert.match(text, /Registered providers/)
  assert.match(text, /Custom CDP Driver/)
  assert.match(text, /Add custom browser plugin/)
  assert.match(text, /The active external browser plugin handles its own permissions/)
})

test('the Browser page hides Retry while waiting for a required restart', () => {
  hook = 0
  cells.length = 0
  const roster = {
    bots: [],
    browserBackend: {
      active: 'dsh:dsh-ego-browser',
      status: {
        id: 'dsh:dsh-ego-browser',
        kind: 'dsh-plugin',
        name: 'Ego Browser (ego lite)',
        mode: 'external',
        state: 'restart-needed',
        supportsGrants: false,
        message: 'Restart DS Bot to load its tools.',
        installCommand: null,
      },
      canInstall: true,
      builtins: [],
      dshPlugins: [],
      mcpServers: [],
      providers: [],
    },
  }
  const text = textOf(expand(BrowserPage({
    roster,
    actions: { browserRetry: () => {} },
    run: () => {},
    Section,
    Row,
  })))
  assert.match(text, /Restart required/)
  assert.doesNotMatch(text, /Retry/)
})

