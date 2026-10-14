import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/member-status.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, Fragment: 'fragment' },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { busyMembers, summaryText, MemberDock } = module.exports
// Values from the bundle's realm compare by content only.
const plain = value => JSON.parse(JSON.stringify(value))
// The dock's capsule in an element tree.
const capsuleOf = (node) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props.className === 'bt-mw-pill') return node
  for (const child of node.children) {
    const found = capsuleOf(child)
    if (found) return found
  }
  return null
}

test('the members line names who waits for an approval first, then who is at work', () => {
  const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill', e: 'King', f: 'Comet' }
  const roster = { byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])) }
  const room = { members: ['e', 'd', 'a', 'b', 'c', 'f'] }
  const work = {
    bots: { d: { since: 1, tool: 'edit' }, a: { since: 1, tool: 'pwsh' }, f: { since: 1 } },
    approvals: [{ botId: 'a' }, { botId: 'b' }, { botId: 'c' }],
  }
  const busy = busyMembers(room, work, roster)
  assert.deepEqual(plain(busy.map(entry => [entry.bot.name, entry.state])), [['Anvil', 'ask'], ['Flint', 'ask'], ['Prism', 'ask'], ['Quill', 'work'], ['Comet', 'work']])
  assert.deepEqual(plain(summaryText(busy)), { waiting: 'Anvil, Flint and 1 more are waiting for your approval', doing: 'Quill · Writing changes… +1' })
  assert.deepEqual(plain(summaryText(busy.slice(1, 3))), { waiting: 'Flint and Prism are waiting for your approval', doing: '' })
  assert.deepEqual(plain(summaryText(busy.slice(4))), { waiting: '', doing: 'Comet · Thinking about it…' })
  assert.equal(busyMembers(room, { bots: {}, approvals: [] }, roster).length, 0)
})

const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill' }
const team = {
  byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])),
  roomsById: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c', 'd'] }, r2: { id: 'r2', name: 'Docs', members: ['a', 'b'] } },
}
// The capsule's label and what a click on it asks for.
const dock = (sessionId, work) => {
  const calls = []
  const actions = { showDetails: id => calls.push(['details', id]), openSession: id => calls.push(['session', id]) }
  const capsule = capsuleOf(MemberDock({ sessionId, useRoster: pick => pick(team), useWork: pick => pick(work), actions }))
  if (!capsule) return null
  capsule.props.onClick()
  return { label: capsule.props['aria-label'], calls }
}

test('one capsule names who waits and who works, without the round\'s speaker, and opens the details', () => {
  const work = {
    // Anvil runs in its own chat too; its work here wins.
    bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2', tool: 'edit' } },
    rooms: { r1: [{ botId: 'a', since: 1, tool: 'write' }, { botId: 'd', since: 1, speaking: true }], r2: [{ botId: 'b', since: 1, tool: 'edit' }] },
    approvals: [{ botId: 'c', roomId: 'r1' }],
  }
  assert.deepEqual(plain(dock('r1', work)), { label: 'Prism is waiting for your approval · Anvil · Writing changes… +1', calls: [['details', 'r1']] })
  assert.equal(dock('r1', { bots: {}, rooms: { r1: [{ botId: 'd', since: 1, speaking: true }] }, approvals: [] }), null)
})

test('a Bot\'s own chat shows the groups it is at work in, unless its own chat runs', () => {
  const away = { bots: { a: { since: 1, roomId: 'r1', tool: 'pwsh' } }, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }], r2: [{ botId: 'a', since: 1 }] }, approvals: [] }
  assert.deepEqual(plain(dock('a', away)), { label: 'in Ops · Running shell commands… +1', calls: [['session', 'r1']] })
  assert.equal(dock('a', { ...away, bots: { a: { since: 1 } } }), null)
  assert.equal(dock('b', away), null)
})
