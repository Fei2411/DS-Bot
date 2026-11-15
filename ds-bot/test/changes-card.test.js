import { changesPatch } from '../src/shared/changes-patch.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { stackReplies } from '../src/shared/group-replies.js'

const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
  useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment',
}
const require = (name) => {
  const platform = { react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null } }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const bundled = async (entry) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, URL, URLSearchParams, document: { hidden: false } })
  return module.exports
}
const card = await bundled('changes-card.js')
const cells = await bundled('cells.js')
const { ChangesCard } = card
const { GroupMessage } = cells

const all = (node, cls, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), cls, out)
  if ((node.props?.className ?? '').split(' ').includes(cls)) out.push(node)
  for (const child of node.children ?? []) all(child, cls, out)
  return out
}
const text = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return text(node.type(node.props))
  return (node.children ?? []).map(text).join('')
}

const row = {
  sessionId: 's1', seq: 7, turn: 3, total: 2, added: 13, deleted: 4,
  files: [{ path: 'src/a.js', added: 12, deleted: 4 }, { path: 'src/b.js', added: 1, deleted: 0 }],
}

test('the row names the files and counts, and opens the review with the same coordinates', () => {
  const opened = []
  const node = ChangesCard({ changes: row, actions: { openChanges: changes => opened.push(changes) } })
  const button = all(node, 'bt-changes')[0]
  assert.ok(button, 'the change line is a button')
  const shown = text(node)
  assert.match(shown, /2 files changed/)
  assert.match(shown, /\+13/)
  assert.match(shown, /−4/)
  assert.match(shown, /src\/a\.js/)
  assert.match(shown, /src\/b\.js/)
  button.props.onClick()
  assert.deepEqual(opened, [row])
})

test('the fourth name on is counted, not listed', () => {
  const many = { ...row, total: 6, files: Array.from({ length: 6 }, (_, index) => ({ path: `src/f${index}.js`, added: 1, deleted: 0 })) }
  const shown = text(ChangesCard({ changes: many, actions: { openChanges: () => {} } }))
  assert.match(shown, /src\/f0\.js/)
  assert.match(shown, /src\/f2\.js/)
  assert.doesNotMatch(shown, /src\/f3\.js/)
  assert.match(shown, /and 3 more/)
})

test('a row with nothing to show draws nothing at all', () => {
  assert.equal(ChangesCard({ changes: { files: [], total: 0 }, actions: { openChanges: () => {} } }), null)
  assert.equal(ChangesCard({ changes: null, actions: { openChanges: () => {} } }), null)
})

test('a group message draws the change line under its bubbles, and none without changes', () => {
  const roster = { prefs: {}, byId: { b1: { id: 'b1', name: 'Flint' } }, roomsById: {} }
  const actions = { openChanges: () => {}, openSession: () => {} }
  const withChanges = GroupMessage({ bot: { id: 'b1', name: 'Flint' }, texts: ['done'], room: undefined, sessionId: 'r1', roster, actions, time: 1, changes: row })
  assert.equal(all(withChanges, 'bt-changes').length, 1)
  // The card button is the row handed to the action, so a second Bot's row never opens the first's review.
  const plain = GroupMessage({ bot: { id: 'b1', name: 'Flint' }, texts: ['done'], room: undefined, sessionId: 'r1', roster, actions, time: 1 })
  assert.equal(all(plain, 'bt-changes').length, 0)
})

test('a stacked block keeps the last change line of the turn it shows', () => {
  const items = stackReplies([
    { botId: 'b1', text: 'working', time: 1 },
    { botId: 'b1', text: 'done', time: 2, changes: row },
  ])
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].changes, row)
  // A later turn's line replaces the earlier one rather than stacking two.
  const second = stackReplies([
    { botId: 'b1', text: 'a', time: 1, changes: row },
    { botId: 'b1', text: 'b', time: 2, changes: { ...row, seq: 9, turn: 4 } },
  ])
  assert.equal(second[0].changes.seq, 9)
})


test('recorded hunks preserve additions, deletions, paths and embedded fences', () => {
  const patch = changesPatch({ kind: 'text', display: 'a.md', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+```'] }] })
  assert.equal(patch, ['````diff', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,2 @@', '-old', '+new', '+```', '````'].join('\n'))
})
