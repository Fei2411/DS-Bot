import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The user's own bubble on both sides of DSH 0.2.1-alpha.3: before it, the primitives
// projected user text (`projectUserText`); since, the host draws user contents by the
// `conversation.chat.user.content` factory it hands every slot (#1616).
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: { contents: "export * from './src/client/user-message.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// Hooks keep their state between renders, so a click and the render after it can be followed.
let hooks = []
let at = 0
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    const index = at++
    if (!(index in hooks)) hooks[index] = initial
    return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
  },
  useMemo: make => make(), useCallback: fn => fn, useEffect: () => {}, useLayoutEffect: () => {},
  useRef: current => ({ current }), useId: () => 'um-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
}
const load = (primitives) => {
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => {
      const platform = { react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': primitives }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}
// The DSH the tests pin (0.2.2-rc.1) and every release since 0.2.1-alpha.3: no projection.
const current = load({ MarkdownText: () => null, UserTextRun: ({ text }) => text })
// A release before 0.2.1-alpha.3, which projected user text itself.
const older = load({ MarkdownText: () => null, projectUserText: text => [`projected:${text}`] })

const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
// Renders the named components of an element tree, leaving the rest as elements.
const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: node.children.map(child => expand(child, names)) }
}
const words = node => (Array.isArray(node) ? node.map(words).join('')
  : node === null || typeof node !== 'object' ? String(node ?? '') : node.children.map(words).join(''))
const lines = count => Array.from({ length: count }, (_, index) => `第 ${index + 1} 行`).join('\n')

const roster = { bots: [], byId: { b: { id: 'b', name: 'Writer' } }, roomsById: { room: { members: ['b'] } } }
// What the host hands a chat node: its own render seats beside the node.
const hostProps = (content, { sessionId = 'room', data = {} } = {}) => {
  const drawn = []
  return {
    drawn,
    props: {
      node: { kind: 'user', data: { content, time: 1_700_000_000_000, ...data } },
      sessionId,
      useRoster: select => select(roster),
      actions: {},
      loadImage: () => 'image-url',
      renderFactorySlot: (name, input) => { drawn.push({ name, input }); return { type: `factory:${name}`, props: input, children: [] } },
    },
  }
}
const render = (exports, props) => { at = 0; return expand(exports.UserMessageCell(props), ['UserText', 'ProjectedContent', 'HostContent']) }
const fresh = () => { hooks = [] }

test('the bubble mounts on a DSH with the old text projection or with a user-text registry', () => {
  assert.equal(current.canDrawUserMessages(true), true)
  assert.equal(older.canDrawUserMessages(false), true)
  // Neither: DSH keeps its own bubble.
  assert.equal(current.canDrawUserMessages(false), false)
})

test('on a current DSH a long message folds, and the host draws only the part shown', async () => {
  fresh()
  const text = lines(60)
  const { props, drawn } = hostProps([{ type: 'text', text }])
  const folded = render(current, props)
  const [content] = drawn.filter(item => item.name === 'conversation.chat.user.content')
  assert.ok(content, 'the host content factory draws the text')
  assert.equal(content.input.content.text, lines(10))
  assert.equal(content.input.interactive, true)
  assert.equal(find(folded, node => node.props?.['data-folded'] === true).length, 1)
  const [show] = find(folded, node => node.type === 'button' && node.props.className === 'bt-more')
  assert.match(words(show), /Show all/)
  await show.props.onClick()
  drawn.length = 0
  render(current, props)
  assert.equal(drawn.find(item => item.name === 'conversation.chat.user.content').input.content.text, text)
})

test('a short message is drawn whole with no fold control', () => {
  fresh()
  const { props, drawn } = hostProps([{ type: 'text', text: '你好' }])
  const tree = render(current, props)
  assert.equal(drawn[0].input.content.text, '你好')
  assert.equal(find(tree, node => node.props?.className === 'bt-more').length, 0)
})

test('attachments, references and skills go to the host as it draws them itself', () => {
  fresh()
  const image = { attachmentId: 'i1', name: 'chart.png' }
  const file = { attachmentId: 'f1', name: 'notes.pdf', bytes: 10 }
  const extra = { type: 'tool-result', id: 'x' }
  const { props, drawn } = hostProps([
    { type: 'text', text: '看 @Docs' }, { type: 'image', attachment: image }, { type: 'file', attachment: file }, extra,
  ], { data: { referenceLabels: ['Docs'], skillNames: ['pdf'] } })
  const tree = render(current, props)
  const { input } = drawn.find(item => item.name === 'conversation.chat.user.content')
  // The reference line is DS Bot's, under the host's stack, so a fold's fade lands on the text.
  assert.deepEqual(JSON.parse(JSON.stringify(input.content)), {
    text: '看 @Docs',
    attachments: [{ type: 'image', image: { attachment: image } }, { type: 'file', file }],
    extraBlocks: [extra],
  })
  assert.deepEqual(JSON.parse(JSON.stringify(input.facts)), { sessionLabels: ['Docs'], skillNames: ['pdf'] })
  assert.equal(input.loadImage, props.loadImage)
  assert.equal(input.interactive, true)
  assert.match(words(find(tree, node => node.props?.className === 'bt-urefs')[0]), /Docs/)
})

test('text blocks join as the host joins them, and no facts are made up', () => {
  fresh()
  const { props, drawn } = hostProps([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  render(current, props)
  const { input } = drawn[0]
  assert.equal(input.content.text, 'ab')
  assert.deepEqual(JSON.parse(JSON.stringify(input.facts)), {})
})

test('the shell keeps the time, the copy of the whole text and the steering mark', () => {
  fresh()
  const text = lines(60)
  const { props } = hostProps([{ type: 'text', text }])
  const tree = render(current, { ...props, node: { ...props.node, kind: 'steering' } })
  assert.equal(find(tree, node => node.props?.className === 'bt-utime').length, 1)
  assert.equal(find(tree, node => node.props?.['data-steering'] === true).length, 1)
  const [copy] = find(tree, node => node.type?.name === 'CopyButton')
  assert.equal(copy.props.text, text)
})

test('on a current DSH the host bubble is the one text source, so a quote is not doubled', () => {
  fresh()
  const { props } = hostProps([{ type: 'text', text: lines(60) }])
  const tree = render(current, props)
  assert.equal(find(tree, node => node.props?.['data-text-interaction-source'] !== undefined).length, 0)
})

test('an older DSH still draws the text through its projection, folded', () => {
  fresh()
  const { props, drawn } = hostProps([{ type: 'text', text: lines(60) }])
  const tree = render(older, props)
  assert.equal(drawn.length, 0)
  assert.match(words(tree), /projected:第 1 行/)
  assert.doesNotMatch(words(tree), /第 11 行/)
  assert.equal(find(tree, node => node.props?.['data-folded'] === true).length, 1)
})
