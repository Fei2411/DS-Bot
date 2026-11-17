import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The delivered-file card of a group reply and an earlier chat row (#975, #1443), bundled
// once and rendered with a minimal React, like the other client cells.
const { outputFiles } = await build({
  stdin: {
    contents: "export { FileCards, FILE_CARD_CSS } from './src/client/file-card.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createElement: h, Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
  useEffect: effect => { effects.push(effect) },
  useLayoutEffect: effect => { effects.push(effect) },
  useMemo: make => make(), useRef: current => ({ current }),
}
const requests = []
const urls = []
const downloads = []
// The two chunks of one presented file, as file-download serves them.
const chunks = [
  { bytes: Buffer.from('hello ').toString('base64'), name: 'notes.md', mime: 'text/markdown', nextOffset: 6, done: false, version: 'v1' },
  { bytes: Buffer.from('world').toString('base64'), name: 'notes.md', mime: 'text/markdown', nextOffset: 11, done: true, version: 'v1' },
]
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, Blob, TextEncoder,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  URL: { createObjectURL: blob => { urls.push(blob); return `blob:${urls.length}` }, revokeObjectURL: () => {} },
  document: {
    createElement: () => {
      const link = { href: '', download: '', click: () => downloads.push({ href: link.href, download: link.download, blob: urls.at(-1) }), remove: () => {} }
      return link
    },
    body: { append: () => {} },
  },
  setTimeout: () => 0,
  fetch: async (route, init) => {
    requests.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true, value: chunks[requests.length - 1] }) }
  },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return {}
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        FileTypeIcon: ({ path, className }) => h('span', { className, path }),
        fileExtension: name => name.split('.').pop(),
        fileSizeText: bytes => `${bytes} B`,
      }
    }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { FileCards } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
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
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const byClass = (node, name) => findAll(node, entry => entry.props?.className === name)

test('a delivered file shows its name, type, size and a save', () => {
  effects = []
  const cards = expand(h(FileCards, {
    files: [
      { sessionId: 's1', seq: 4, index: 0, name: 'notes.md', bytes: 11 },
      // A row read back from history has no size of its own; its type still shows.
      { sessionId: 's1', seq: 7, index: 0, name: 'build.log' },
    ],
  }))
  assert.deepEqual(byClass(cards, 'bt-dfile-name').map(text), ['notes.md', 'build.log'])
  assert.deepEqual(byClass(cards, 'bt-dfile-meta').map(text), ['MD · 11 B', 'LOG'])
  assert.equal(byClass(cards, 'bt-dfile-icon').length, 2)
  const saves = findAll(cards, entry => entry.type === 'button' && entry.props?.className === 'bt-soft bt-soft-sm')
  assert.deepEqual(saves.map(text), ['Save', 'Save'])
})

test('save reads the file by its ref over file-download and downloads the bytes', async () => {
  effects = []
  requests.length = 0
  urls.length = 0
  downloads.length = 0
  const cards = expand(h(FileCards, { files: [{ sessionId: 's1', seq: 4, index: 0, name: 'notes.md', bytes: 11 }] }))
  const [save] = findAll(cards, entry => entry.type === 'button' && entry.props?.className === 'bt-soft bt-soft-sm')
  save.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(requests, [
    { endpoint: 'file-download', payload: { sessionId: 's1', seq: 4, index: 0, offset: 0 } },
    { endpoint: 'file-download', payload: { sessionId: 's1', seq: 4, index: 0, offset: 6, version: 'v1' } },
  ])
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].download, 'notes.md')
  assert.equal(downloads[0].href, 'blob:1')
  assert.equal(await downloads[0].blob.text(), 'hello world')
  assert.equal(downloads[0].blob.type, 'text/markdown')
})
