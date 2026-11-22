import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { cleanActivityLine, hasInterleavedBlocks, opensReply, stepActivity, stepSegments, thinkingStep, turnReasoning } from '../src/client/turn-reasoning.js'

const step = (n, blocks, status = 'settled') => ({ turn: 1, step: n, status, blocks })
const think = text => ({ kind: 'reasoning', text })
const tool = { kind: 'tool-call', name: 'read' }

test('a long tool Turn shows its reasoning once, on the last step, in order', () => {
  const steps = Array.from({ length: 24 }, (_, i) => step(i + 1, [think(`Reasoning ${i + 1}`), tool]))
  const shown = steps.map(current => turnReasoning(steps, current))
  assert.equal(shown.filter(Boolean).length, 1)
  assert.equal(shown[23], steps.map((_, i) => `Reasoning ${i + 1}`).join('\n\n'))
})

test('the row sits on the last step with reasoning, next to the reply', () => {
  const steps = [step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]
  assert.deepEqual(steps.map(current => turnReasoning(steps, current)), ['', '', 'B\n\nC'])
  // A Turn whose only reasoning step came first keeps the row there.
  const early = [step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]
  assert.deepEqual(early.map(current => turnReasoning(early, current)), ['B', '', ''])
})

test('reasoning still in progress shows while its step thinks', () => {
  const steps = [step(1, [think('A'), tool]), step(2, [think('B')], 'running')]
  assert.equal(turnReasoning(steps, steps[0]), '')
  assert.equal(turnReasoning(steps, steps[1]), 'A\n\nB')
  assert.equal(turnReasoning([step(1, [think('A')], 'running')], step(1, [think('A')], 'running')), 'A')
  steps[1].blocks.push({ kind: 'text', text: 'Reply' })
  assert.equal(turnReasoning(steps, steps[1]), 'A\n\nB')
})

test('the live step is the one still thinking', () => {
  const steps = [step(1, [think('A'), tool]), step(2, [think('B')], 'running')]
  assert.equal(thinkingStep(steps), steps[1])
  // Reasoning that moved on to its reply no longer ticks.
  steps[1].blocks.push({ kind: 'text', text: 'Reply' })
  assert.equal(thinkingStep(steps), undefined)
  // A running step without reasoning yet is not thinking either.
  assert.equal(thinkingStep([step(3, [tool], 'running')]), undefined)
  assert.equal(thinkingStep(steps.slice(0, 1)), undefined)
})

test('a `<signature>` block at the head of reasoning never shows', () => {
  // A signature alone leaves nothing to show, like DSH's hidden reasoning row.
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123</signature>')])), '')
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123</signature>\n\nReal thought')])), 'Real thought')
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123</signature>\r\n\r\nReal thought')])), 'Real thought')
  // A stream that has only reached inside the tag shows nothing yet.
  assert.equal(turnReasoning([], step(1, [think('<sign')])), '')
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123')])), '')
  // Text that only looks like it stays untouched.
  assert.equal(turnReasoning([], step(1, [think('A <signature> mention')])), 'A <signature> mention')
})

test('a step outside the loaded Turn list shows only its own reasoning', () => {
  const current = step(1, [think(' A ')])
  assert.equal(turnReasoning([], current), 'A')
})

test('a reply opens on its first text or on its reasoning row, whichever comes first', () => {
  const opener = steps => steps.findIndex(current => opensReply(steps, current))
  // A word before the tools opens the reply, ahead of the reasoning on the last step.
  assert.equal(opener([step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]), 0)
  // Reasoning that shows before any text opens it.
  assert.equal(opener([step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 0)
  // Tools alone open nothing; the step that answers does.
  assert.equal(opener([step(1, [tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 2)
  assert.equal(opener([step(1, [tool])]), -1)
})

test("with the reasoning hidden, only a step's own text opens the reply", () => {
  const opener = steps => steps.findIndex(current => opensReply(steps, current, false))
  // A reasoning-only first step no longer opens it: the step that answers does.
  assert.equal(opener([step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 2)
  assert.equal(opener([step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]), 0)
  assert.equal(opener([step(1, [think('B'), tool])]), -1)
})

test('local agent CLI activity strips shell wrappers, drops non-activity tags, and renders chronologically in ActivityFold', async () => {
  assert.equal(cleanActivityLine('userMessage'), '')
  assert.equal(cleanActivityLine('/bin/zsh -lc pwd'), 'pwd')
  assert.equal(cleanActivityLine('/bin/zsh -lc "python3 -c \\"print(1)\\""'), 'python3 -c "print(1)"')

  const interleavedStep = step(0, [
    think('▸ userMessage\n'),
    { kind: 'text', text: 'I will inspect the files first.' },
    think('▸ /bin/zsh -lc pwd\n▸ /bin/zsh -lc "python3 -c \'print(1)\'"\n'),
    { kind: 'text', text: 'Here is the final report.' },
  ])
  assert.equal(hasInterleavedBlocks(interleavedStep), true)
  assert.deepEqual(stepActivity(interleavedStep), ['pwd', "python3 -c 'print(1)'"])
  assert.deepEqual(stepSegments(interleavedStep), [
    { kind: 'text', texts: ['I will inspect the files first.'] },
    { kind: 'process', activity: ['pwd', "python3 -c 'print(1)'"], thought: '' },
    { kind: 'text', texts: ['Here is the final report.'] },
  ])

  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const seenMentions = []
  const mod = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module: mod, exports: mod.exports, Intl, Date, TextEncoder, queueMicrotask,
    require: (name) => {
      const platform = {
        react: {
          Fragment: 'fragment',
          createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
          useContext: ctx => ctx.value,
          useCallback: fn => fn,
          useId: () => 'dv-id',
          useSyncExternalStore: (_, getSnapshot) => getSnapshot(),
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
          useRef: current => ({ current }),
          useLayoutEffect() {},
          useEffect() {},
          useMemo: make => make(),
        },
        'react-dom': {},
        '@deepseek-ai/dsh-client-ui-primitives': {
          CellEmpty: () => null,
          MarkdownText: ({ text, fileMentions }) => { seenMentions.push({ text, fileMentions }); return text },
        },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  const { AssistantCell } = mod.exports
  const render = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(render)
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
    return { ...node, children: (node.children ?? []).map(render) }
  }
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return (node.children ?? []).map(textOf).join('')
  }
  const walk = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const child of node) walk(child, pred, out); return out }
    if (pred(node)) out.push(node)
    for (const child of node.children ?? []) walk(child, pred, out)
    return out
  }
  const roster = { bots: [{ id: 'b1', name: 'Codex', color: 'blue' }], byId: { b1: { id: 'b1', name: 'Codex', color: 'blue' } }, roomsById: {}, exchangeTurns: {}, prefs: {} }
  const hook = val => sel => (typeof sel === 'function' ? sel(val) : val)

  const reasoningTree = render(AssistantCell({
    node: { key: 'i1', data: interleavedStep },
    groupPart: 'reasoning',
    sessionId: 'b1',
    useRoster: hook(roster),
    useUi: hook({}),
    useTurnSteps: () => [interleavedStep],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  }))
  assert.equal(textOf(reasoningTree), '')

  const resolver = { resolve: () => '/tmp/report.md' }
  const toggled = []
  const closedStep = { ...interleavedStep, finalNode: { seq: 12 } }
  const responseTree = render(AssistantCell({
    node: { key: 'i1', data: closedStep, location: { kind: 'step', turn: { status: 'closed' } } },
    groupPart: 'response',
    sessionId: 'b1',
    fileMentions: () => resolver,
    useTurnData: () => ({ closing: { finalNode: { seq: 12 } } }),
    useRoster: hook(roster),
    useUi: hook({ reactions: { 'b1:1:i1': { 0: ['👍'], 1: ['❤️'] } } }),
    useTurnSteps: () => [closedStep],
    useTurnContext: () => [],
    actions: { noteLive() {}, toggleReaction: (...args) => toggled.push(args) },
  }))
  const fullText = textOf(responseTree)
  assert.equal(fullText.includes('userMessage'), false)
  assert.equal(fullText.includes('/bin/zsh -lc'), false)
  const idxIntro = fullText.indexOf('I will inspect the files first.')
  const idxCmd = fullText.indexOf('Ran 2 steps')
  const idxOutro = fullText.indexOf('Here is the final report.')
  assert.ok(idxIntro >= 0 && idxCmd > idxIntro && idxOutro > idxCmd, `expected chronological order, got: ${fullText}`)
  const folds = walk(responseTree, n => n.type === 'details' && String(n.props?.className ?? '').includes('bt-act-fold'))
  assert.equal(folds.length, 1)
  assert.equal(folds[0].props.open, false)

  // Saved reactions keep the original step msgKey and sequential bubble indexes across segments.
  const reactButtons = walk(responseTree, n => n.type === 'button' && n.props?.className === 'bt-react')
  assert.deepEqual(reactButtons.map(b => textOf(b)), ['👍', '❤️'])
  reactButtons[0].props.onClick()
  reactButtons[1].props.onClick()
  assert.deepEqual(toggled, [['b1:1:i1', 0, '👍'], ['b1:1:i1', 1, '❤️']])

  // File mention resolver reaches earlier text segments too, not only the final segment.
  assert.equal(seenMentions.length, 2)
  assert.equal(seenMentions[0].fileMentions, resolver)
  assert.equal(seenMentions[1].fileMentions, resolver)
})

test('turnReasoning keeps earlier non-interleaved thoughts and avoids duplicating interleaved thoughts', () => {
  const s1 = step(1, [think('Before interleaved'), tool])
  const s2 = step(2, [{ kind: 'text', text: 'Checking' }, think('Inline thought'), { kind: 'text', text: 'Mid' }])
  const s3 = step(3, [think('After interleaved'), { kind: 'text', text: 'Done' }])

  // Interleaved step at the end must not swallow earlier non-interleaved thoughts.
  assert.deepEqual([s1, s2].map(cur => turnReasoning([s1, s2], cur)), ['Before interleaved', ''])
  assert.equal(opensReply([s1, s2], s1, true), true)

  // Non-interleaved step after an interleaved step must not repeat the inline thought.
  assert.deepEqual([s2, s3].map(cur => turnReasoning([s2, s3], cur)), ['', 'After interleaved'])

  // Contiguous non-interleaved runs on both sides of an interleaved step stay separated in order.
  assert.deepEqual([s1, s2, s3].map(cur => turnReasoning([s1, s2, s3], cur)), ['Before interleaved', '', 'After interleaved'])
})
