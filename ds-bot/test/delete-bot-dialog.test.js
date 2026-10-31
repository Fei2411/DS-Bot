import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/delete-bot.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react', 'react-dom'],
})
let states = []; let cursor = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: () => [states[cursor++], () => {}], useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {}, console })
const { DeleteBotDialog } = module.exports
function walk(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...(node.props?.children ?? []).flatMap(child => walk(child))]
}
const text = node => typeof node === 'string' ? node : (node?.props?.children ?? []).map(text).join(' ')
const view = { bot: { name: 'Writer', workDir: '/work' }, targets: [], groups: [], files: [], tasks: [] }
function render({ preview = view, done = null, busy = false, policy = 'delete', target = '' } = {}) {
  states = [preview, policy, target, [], busy, '', done]; cursor = 0
  return walk(DeleteBotDialog({ id: 'writer', actions: {}, leaving: false }))
}

test('deletion has separate header, scrollable content and footer without setting-card dividers', () => {
  const nodes = render()
  const dialog = nodes.find(node => node.props?.role === 'dialog')
  assert.equal(dialog.props.className, 'bt-delete-dialog')
  assert.deepEqual(Array.from(dialog.props.children, child => child.type), ['header', 'div', 'footer'])
  assert.match(text(dialog), /No files eligible for automatic cleanup/)
  assert.ok(nodes.some(node => node.type === 'button' && text(node) === 'Cancel'))
})

test('deletion with no selected files never claims that files were recycled', () => {
  const nodes = render({ done: { progress: { tasks: {}, files: {} } } })
  const all = text(nodes[0])
  assert.match(all, /Writer was deleted/)
  assert.match(all, /No files were removed/)
  assert.doesNotMatch(all, /moved to recovery storage|Selected files were moved/)
  assert.equal(nodes.filter(node => node.type === 'button').length, 1)
})

test('a restored file still counts as moved to recovery storage', () => {
  const nodes = render({ done: { progress: {
    tasks: {}, files: { report: { status: 'restored', original: '/work/report.txt' } },
  } } })
  const all = text(nodes[0])
  assert.match(all, /1 files moved to recovery storage/)
  assert.doesNotMatch(all, /No files were removed/)
  assert.doesNotMatch(all, /Restore file/)
})

test('the result distinguishes deleted and transferred tasks and allows file restoration', () => {
  const nodes = render({ done: { progress: {
    tasks: { one: { status: 'done' }, two: { status: 'done', to: 'reader' } },
    files: { report: { status: 'recycled', original: '/work/report.txt' } },
  } } })
  const all = text(nodes[0])
  assert.match(all, /1 tasks deleted/); assert.match(all, /1 tasks transferred/)
  assert.match(all, /1 files moved to recovery storage/)
  assert.ok(nodes.some(node => node.type === 'button' && text(node) === 'Restore file'))
})

test('scheduling history is collapsed and explains that saved records do not keep running', () => {
  const nodes = render({ done: { progress: { files: {}, tasks: { one: {
    status: 'done', original: { title: 'Check inbox', prompt: 'Read new mail' },
    records: [{ scheduledAt: '2026-10-30T06:35:42.088Z', messageId: 'receipt' }],
  } } } } })
  const history = nodes.find(node => node.props?.className === 'bt-delete-history')
  assert.equal(history.type, 'details'); assert.equal(history.props.open, undefined)
  assert.match(text(history), /not tasks that are still running/)
  assert.doesNotMatch(text(history), /2026-10-30T06:35:42/)
})

test('transfer lists each active task with the next run from the task record', () => {
  const nodes = render({
    policy: 'transfer', target: 'reader',
    preview: { ...view, targets: [{ id: 'reader', name: 'Reader' }], tasks: [
      { id: 'one', title: 'Check inbox', status: 'active', kind: 'every', everySeconds: 3600, scheduledAt: '2026-10-31T11:17:16.589Z' },
      { id: 'two', title: 'Old check', status: 'finished', scheduledAt: '2026-10-01T09:00:00.000Z' },
    ] },
  })
  const all = text(nodes[0])
  assert.match(all, /Next run/)
  assert.doesNotMatch(all, /2026-10-31T11:17:16/)
  assert.equal(nodes.filter(node => node.type === 'time').length, 1)
})
