import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const MarkdownText = () => null
const bundle = await build({
  stdin: {
    contents: "export { AssistantCell, Bubbles, ChatRows, ThinkingRow, ToolCell } from './src/client/cells.js'\nexport { UserMessageCell } from './src/client/user-message.js'",
    resolveDir: root,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }),
        useMemo: make => make(), useCallback: fn => fn, useId: () => 'quote-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText, projectUserText: text => text },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell, Bubbles, ChatRows, ThinkingRow, ToolCell, UserMessageCell } = module.exports

const renderers = ['Bubbles', 'Bubble', 'ChatRows', 'EarlierUser', 'GroupMessage', 'GroupReplies', 'SpeakerHead', 'ThinkingRow', 'ToolCell']
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (renderers.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}
const findAll = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...findAll(node.children, match)]
}
const withClass = (node, name) => node.props?.className?.split(' ').includes(name)
const sources = node => findAll(node, item => item.props?.['data-text-interaction-source'] !== undefined)

const bot = { id: 'b', name: 'Writer' }
const roster = { bots: [bot], byId: { b: bot }, roomsById: {}, exchangeTurns: {} }
const assistantProps = (data = {}, prefs) => ({
  node: {
    key: 'n10', location: { kind: 'step', turn: { turn: 3, status: 'closed' } },
    data: { turn: 3, step: 1, seq: 10, status: 'settled', finalNode: { seq: 10, messageId: 'm10' }, blocks: [{ kind: 'text', text: 'A finished answer.' }], ...data },
  },
  sessionId: 'b',
  useRoster: select => select({ ...roster, prefs }),
  useUi: () => null,
  useTurnSteps: () => [],
  useTurnContext: () => [],
  actions: { noteLive() {} },
})

test('only a persistent settled Assistant reply exposes its text to the native quote interaction', () => {
  const cases = [
    [{}, ''],
    [{ status: 'running' }, undefined],
    [{ status: 'interrupted' }, undefined],
    [{ finalNode: { seq: 10 } }, undefined],
  ]
  for (const [patch, expected] of cases) {
    const tree = expand(AssistantCell(assistantProps(patch)))
    const bubble = findAll(tree, node => withClass(node, 'bt-bubble'))[0]
    assert.ok(bubble, JSON.stringify(patch))
    assert.equal(bubble.props['data-text-interaction-source'], expected, JSON.stringify(patch))
    assert.equal(sources(tree).length, expected === '' ? 1 : 0)
    assert.equal(findAll(tree, node => node.type === MarkdownText)[0].props['data-text-interaction-source'], undefined)
  }
})

test('settled reasoning joins the interaction only after its live stream ends', () => {
  const props = assistantProps({ blocks: [{ kind: 'reasoning', text: 'Check the evidence.' }] }, { thinking: true })
  const cell = AssistantCell(props)
  const row = findAll(cell, node => node.type === ThinkingRow)[0]
  assert.equal(row.props.textInteractionSource, true)
  const box = findAll(expand(row), node => withClass(node, 'bt-think-text'))[0]
  assert.equal(box.props['data-text-interaction-source'], '')
  const live = findAll(expand(ThinkingRow({ text: 'Still thinking', live: true, textInteractionSource: true })), node => withClass(node, 'bt-think-text'))[0]
  assert.equal(live.props['data-text-interaction-source'], undefined)
})

test('sent and steering user messages each have one text source', () => {
  for (const kind of ['message', 'steering']) {
    const tree = UserMessageCell({
      node: { kind, data: { content: [{ type: 'text', text: 'Please quote this.' }] } },
      sessionId: 'b', useRoster: select => select(roster), actions: {},
    })
    const body = findAll(tree, node => withClass(node, 'bt-ubody'))[0]
    assert.equal(body.props['data-text-interaction-source'], '', kind)
    assert.equal(sources(tree).length, 1, kind)
  }
})

test('earlier user and Bot rows retain independent quote boundaries', () => {
  const tree = expand(ChatRows({
    items: [{ kind: 'user', text: 'Earlier question', time: 1 }, { kind: 'bot', text: 'Earlier answer', time: 2 }],
    sessionId: 'b', roster, actions: {},
  }))
  for (const name of ['bt-ububble', 'bt-bubble']) {
    const body = findAll(tree, node => withClass(node, name))[0]
    assert.equal(body.props['data-text-interaction-source'], '', name)
  }
  assert.equal(sources(tree).length, 2)
})

test('image-only earlier messages do not expose their image-count label as quoted text', () => {
  const imageOnly = expand(ChatRows({
    items: [{ kind: 'user', text: '', images: 1, time: 1 }], sessionId: 'b', roster, actions: {},
  }))
  assert.equal(sources(imageOnly).length, 0)
  const count = findAll(imageOnly, node => withClass(node, 'bt-uimages'))[0]
  assert.equal(count.props['data-text-interaction-exclude'], '')

  const captioned = expand(ChatRows({
    items: [{ kind: 'user', text: 'A caption', images: 2, time: 2 }], sessionId: 'b', roster, actions: {},
  }))
  assert.equal(sources(captioned).length, 1)
  assert.equal(findAll(captioned, node => withClass(node, 'bt-uimages'))[0].props['data-text-interaction-exclude'], '')
})

test('group relay user and Bot messages join the current chat quote interaction', () => {
  const room = { id: 'room', name: 'Ops', members: ['b'], admin: 'b' }
  const groupRoster = { ...roster, rooms: [room], roomsById: { room } }
  const content = JSON.stringify({ replies: [{ kind: 'user', text: 'Group question', time: 1 }, { botId: 'b', text: 'Group answer', time: 2 }] })
  const tree = expand(ToolCell({
    node: {
      key: 'tool', location: { turn: { turn: 1 } },
      data: { root: { kind: 'tool-result', name: 'group_relay', callId: 'call', call: { name: 'group_relay', argsRaw: '{}' }, content: [{ type: 'text', text: content }], subCalls: [] } },
    },
    sessionId: 'room', useRoster: select => select(groupRoster), useUi: select => select({ reactions: {}, visits: {} }), actions: {},
  }))
  for (const name of ['bt-ububble', 'bt-bubble']) {
    const body = findAll(tree, node => withClass(node, name))[0]
    assert.equal(body.props['data-text-interaction-source'], '', name)
  }
  assert.equal(sources(tree).length, 2)
})

test('an earlier user message starting with a folded code block keeps its quote source', () => {
  const text = `\`\`\`js\n${Array.from({ length: 40 }, (_, index) => `const line${index} = ${index}`).join('\n')}\n\`\`\``
  const tree = expand(ChatRows({
    items: [{ kind: 'user', text, time: 1 }], sessionId: 'b', roster, actions: {},
  }))
  const bubble = findAll(tree, node => withClass(node, 'bt-ububble'))[0]
  assert.equal(bubble.props['data-text-interaction-source'], '')
  assert.equal(findAll(bubble, node => withClass(node, 'bt-fold-pre')).length, 1)
  assert.equal(sources(tree).length, 1)
})

test('a folded code preview stays inside its bubble source without marking preview bubbles elsewhere', () => {
  const text = `\`\`\`js\n${Array.from({ length: 40 }, (_, index) => `const line${index} = ${index}`).join('\n')}\n\`\`\``
  const tree = expand(Bubbles({
    texts: [text], roster, selfId: 'b', actions: {}, fold: { chars: 1, lines: Infinity },
    useUi: select => select({ reactions: {} }), textInteractionSource: true,
  }))
  const bubble = findAll(tree, node => withClass(node, 'bt-bubble'))[0]
  assert.equal(bubble.props['data-text-interaction-source'], '')
  assert.equal(findAll(bubble, node => withClass(node, 'bt-fold-pre')).length, 1)
  assert.equal(sources(tree).length, 1)

  const preview = expand(Bubbles({ texts: ['Preview only'], roster, selfId: 'b', actions: {}, useUi: select => select({ reactions: {} }) }))
  assert.equal(sources(preview).length, 0)
})
