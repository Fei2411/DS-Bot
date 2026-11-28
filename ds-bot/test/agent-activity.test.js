import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The quiet-note mapping and the collapsed actions row of a local-agent turn,
// bundled once and rendered with the minimal React stand-in of tool-cells.test.js.
const { outputFiles } = await build({
  stdin: {
    contents: "export { localActivityNote, workPhrase, AgentActivityRow } from './src/client/cells.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false },
  require: (name) => {
    if (name === 'react') {
      return {
        createElement: h, Fragment: Symbol('Fragment'),
        useContext: ctx => ctx.value,
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useCallback: fn => fn,
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect() {}, useLayoutEffect() {},
        useMemo: make => make(), useRef: current => ({ current }), useId: () => 'aa-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
      }
    }
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { localActivityNote, workPhrase, AgentActivityRow } = module.exports

const findAll = (node, match) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) { entry.forEach(visit); return }
    if (!entry || typeof entry !== 'object') return
    if (match(entry)) found.push(entry)
    visit(entry.props?.children)
  }
  visit(node)
  return found
}
const text = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props?.children) : String(node)
}

// A meta/discovery tool of the CLI itself must never reach the live status with
// its raw name or arguments: it folds into the generic working phrase.
test('meta and discovery tools fold into the quiet working state, never leaking raw names', () => {
  for (const raw of [
    'search_tool(query: dsbot schedule_create)',
    'use_tool(name: dsbot__schedule_create)',
    'mcp__grok__use_tool(name: dsbot__schedule_create)',
    'grok:search_tool(query: dsbot)',
    'grok/use_tool(name: dsbot__schedule_create)',
    'load_tool(name: dsbot__schedule_create)',
    'tool_search schedule',
    'ToolSearch(query: dsbot)',
    'search_tools',
    'list_tools',
    'discover_tools',
    'discover_tool more',
    'Search_Tool(query: x)',
  ]) {
    const note = localActivityNote(raw)
    assert.equal(note.label, null, raw)
    assert.equal(note.state, 'working', raw)
  }
  // The marker of a fresh reasoning line is stripped before the mapping.
  assert.equal(localActivityNote('▸ search_tool(query: x)').label, null)
  assert.equal(localActivityNote('▸ use_tool x').state, 'working')
})

test('real working actions map onto the same phrases as DSH tools', () => {
  const cases = [
    ['shell(ls -la)', 'Running shell commands', 'working'],
    ['pwsh Get-ChildItem', 'Running shell commands', 'working'],
    ['read `src/host/acp.js`', 'Opening a file', 'searching'],
    ['cat README.md', 'Opening a file', 'searching'],
    ['grep pattern src/', 'Looking through files', 'searching'],
    ['list_dir src', 'Looking through files', 'searching'],
    ['edit `a.js`', 'Writing changes', 'working'],
    ['search_replace x y', 'Writing changes', 'working'],
    ['write `b.js`', 'Writing changes', 'working'],
    ['web_search(query: x)', 'Searching online', 'searching'],
    ['fetch https://example.com', 'Reading a page', 'searching'],
  ]
  for (const [raw, label, state] of cases) {
    const note = localActivityNote(raw)
    assert.equal(note.label, label, raw)
    assert.equal(note.state, state, raw)
  }
  // An unknown tool name keeps working without a made-up phrase. (Compared field by
  // field: the note objects live in the bundle's realm, not this test's.)
  const unknown = localActivityNote('frobnicate the flux')
  assert.equal(unknown.label, null)
  assert.equal(unknown.state, 'working')
  // A blank or missing line falls back on the tool the host reports, in its own state.
  const blankRead = localActivityNote('', 'read')
  assert.equal(blankRead.label, null)
  assert.equal(blankRead.state, 'searching')
  const blankCli = localActivityNote('', 'cli')
  assert.equal(blankCli.label, null)
  assert.equal(blankCli.state, 'working')
  assert.equal(localActivityNote(''), null)
  assert.equal(localActivityNote(undefined), null)
})

test('the sidebar work phrase masks a meta-tool note instead of leaking it', () => {
  // The raw downgraded status text must not become the team-facing phrase.
  const hidden = workPhrase({ tool: 'cli', note: 'search_tool(query: schedule)' })
  assert.doesNotMatch(hidden, /search_tool/)
  assert.doesNotMatch(workPhrase({ tool: 'cli', note: 'mcp__grok__use_tool x' }), /use_tool/)
  assert.doesNotMatch(workPhrase({ tool: 'cli', note: 'load_tool x' }), /load_tool/)
  // Masked, the phrase falls back on the tool kind alone.
  assert.equal(typeof hidden, 'string')
  // A real note still carries the work it names.
  assert.match(String(workPhrase({ tool: 'cli', note: 'run tests' })), /run tests/)
  // What the Bot said still leads, masked note or not.
  assert.match(String(workPhrase({ tool: 'cli', said: 'Reviewing the diff', note: 'search_tool(x)' })), /Reviewing the diff/)
})

// The aggregated action lines of a Turn draw as one collapsed disclosure row:
// the count in the summary, the lines hidden inside until it opens.
test('the actions of a turn collapse into one quiet disclosure row', () => {
  const lines = ['read `a.js`', 'edit `b.js`']
  const row = AgentActivityRow({ lines, viewKey: 'test:1' })
  assert.equal(row.type, 'details')
  // Collapsed by default: nothing is remembered as open on a first view.
  assert.equal(row.props.open, false)
  const [summary] = findAll(row, node => node.type === 'summary')
  assert.equal(text(summary), '2 actions')
  const single = AgentActivityRow({ lines: ['read `a.js`'], viewKey: 'test:2' })
  const [oneSummary] = findAll(single, node => node.type === 'summary')
  assert.equal(text(oneSummary), '1 action')
  // The lines ride inside the scroll region, each on its own compact row.
  const items = findAll(row, node => node.props?.className === 'bt-agent-act-text')
  assert.deepEqual(items.map(text), ['read a.js', 'edit b.js'])
  // The raw line survives in the tooltip, and the backticked part renders as code.
  const cells = findAll(row, node => node.props?.className === 'bt-agent-act')
  assert.equal(cells[0].props.title, 'read `a.js`')
  const codes = findAll(row, node => node.type === 'code')
  assert.deepEqual(codes.map(text), ['a.js', 'b.js'])
})
