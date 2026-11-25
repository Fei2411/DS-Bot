import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))

const { outputFiles } = await build({
  stdin: {
    contents: `
      export * from './app/ui/src/builtin-tool-views.js'
      export { ToolCallCard } from './app/ui/src/tool-card.js'
      export { createSlotRegistry, TOOL_VIEW_SLOT } from './app/ui/src/slots.js'
      export { PartialArguments } from '@deepseek-ai/dsh-util-values'
    `,
    resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'builtin-tool-views-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /(dsh-primitives|primitives)\.js$/ }, () => ({ path: 'primitives.js', namespace: 'btv-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'btv-stub' }, () => ({
        contents: `
          export const writeClipboard = async (text) => { globalThis.__copied.push(text); return true }
          export const fileExtension = name => /\\.([^./\\\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
          export const fileSizeText = bytes => (Number.isFinite(bytes) ? bytes + ' B' : '')
        `,
        loader: 'js',
      }))
    },
  }],
})

// Stateful mini-React harness (supports hooks + class ErrorBoundary).
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
class MiniComponent {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state, this.props) : next) } }
}
const react = {
  Component: MiniComponent,
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: make => make(),
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  __copied: [],
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`unexpected require ${name}`)
  },
  URL,
  console: { ...console, error() {} },
  setTimeout: () => 0,
  clearTimeout() {},
}
runInNewContext(outputFiles[0].text, sandbox)

const {
  BUILTIN_TOOL_PRIORITY,
  registerBuiltinToolViews,
  parseExitStatus,
  shortPath,
  readMetaFromMeta,
  diffMetaFromMeta,
  computeLineDiff,
  searchMetaFromMeta,
  webSearchMetaFromMeta,
  webFetchMetaFromMeta,
  safeWebHref,
  ToolCallCard,
  createSlotRegistry,
  TOOL_VIEW_SLOT,
  PartialArguments,
} = mod.exports

function renderTree(Component, props) {
  const states = new Map()
  const render = (nextProps = props) => {
    const expand = (node, path) => {
      if (node === null || node === undefined || typeof node === 'boolean') return null
      if (Array.isArray(node)) return node.map((item, index) => expand(item, `${path}.${index}`))
      if (typeof node !== 'object') return node
      if (typeof node.type === 'function') {
        const key = `${path}:${node.type.name || 'fn'}`
        if (node.type.prototype && typeof node.type.prototype.render === 'function') {
          let inst = states.get(key)
          if (!inst) {
            inst = new node.type(node.props)
            states.set(key, inst)
          } else {
            const derived = node.type.getDerivedStateFromProps?.(node.props, inst.state)
            if (derived) inst.state = { ...inst.state, ...derived }
            inst.props = node.props
          }
          try {
            return expand(inst.render(), `${key}:cls`)
          } catch (error) {
            if (typeof node.type.getDerivedStateFromError === 'function') {
              inst.state = { ...inst.state, ...node.type.getDerivedStateFromError(error) }
              inst.componentDidCatch?.(error)
              return expand(inst.render(), `${key}:cls-err`)
            }
            throw error
          }
        }
        const st = states.get(key) ?? { slots: [] }
        states.set(key, st)
        const prev = current
        current = { slots: st.slots, index: 0 }
        try {
          return expand(node.type(node.props), `${key}:fn`)
        } finally {
          current = prev
        }
      }
      return { ...node, props: { ...node.props, children: expand(node.props?.children, `${path}:c`) } }
    }
    return expand(react.createElement(Component, nextProps), 'root')
  }
  return { render }
}

function all(node, match, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) all(child, match, out); return out }
  if (match(node)) out.push(node)
  all(node.props?.children, match, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}

function makeBlock(name, argsObj, extra = {}) {
  const argsRaw = JSON.stringify(argsObj ?? {})
  return {
    kind: extra.phase === 'result' ? 'tool-result' : 'tool-call',
    phase: extra.phase ?? 'result',
    callId: extra.callId ?? `call-${name}`,
    name,
    argsRaw,
    args: PartialArguments.fromText(argsRaw),
    isError: extra.isError ?? false,
    content: extra.content ?? [],
    meta: extra.meta,
    error: extra.error,
    callTime: extra.callTime ?? 1000,
    time: extra.time ?? 2500,
    subCalls: extra.subCalls ?? [],
  }
}

const plain = value => JSON.parse(JSON.stringify(value))

test('pure DSH meta parsers and diff/exit/URL helpers obey exact DSH 0.2.2-rc.1 contracts', () => {
  assert.deepEqual(plain(parseExitStatus('hello\n')), { body: 'hello\n', exitCode: 0 })
  assert.deepEqual(plain(parseExitStatus('oops\n[exit code: 2]')), { body: 'oops', exitCode: 2 })
  assert.deepEqual(plain(parseExitStatus('killed\n[killed by signal: SIGTERM]')), { body: 'killed', signal: 'SIGTERM' })

  assert.equal(shortPath('/repo/src/app.js', '/repo'), 'src/app.js')
  assert.equal(shortPath('/other/file.js', '/repo'), '/other/file.js')

  // FsReadMeta semantic range checks reject out-of-order / past-EOF lines.
  assert.ok(readMetaFromMeta({ path: '/repo/a.js', offset: 1, totalLines: 2, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }], lang: 'js' }))
  assert.equal(readMetaFromMeta({ path: '/repo/a.js', offset: 2, totalLines: 2, lines: [{ number: 1, text: 'a' }] }), undefined)
  assert.equal(readMetaFromMeta({ path: '/repo/a.js', offset: 1, totalLines: 1, lines: [{ number: 2, text: 'b' }] }), undefined)

  // FsDiffMeta + bounded LCS line diff.
  assert.ok(diffMetaFromMeta({ diffs: [{ path: 'a.js', oldText: 'a\nb\n', newText: 'a\nc\nd\n' }], operation: 'update' }))
  assert.equal(diffMetaFromMeta({ diffs: [] }), undefined)
  const diff = computeLineDiff('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\ndelta\n')
  assert.equal(diff.added, 2)
  assert.equal(diff.removed, 1)
  // Huge diff falls back cleanly without blowing up memory/time.
  const bigA = Array.from({ length: 300 }, (_, i) => `old-${i}`).join('\n')
  const bigB = Array.from({ length: 300 }, (_, i) => `new-${i}`).join('\n')
  const bigDiff = computeLineDiff(bigA, bigB)
  assert.equal(bigDiff.added, 300)
  assert.equal(bigDiff.removed, 300)

  // SearchMeta & WebMeta narrowing.
  assert.ok(searchMetaFromMeta({ shape: 'matches', files: [{ path: 'a.js', matches: [{ lineNumber: 3, line: 'foo' }] }], truncated: false, total: 1 }))
  assert.ok(searchMetaFromMeta({ shape: 'paths', paths: [], truncated: false, total: 0 }))
  assert.equal(searchMetaFromMeta({ shape: 'unknown', truncated: false, total: 0 }), undefined)
  assert.ok(webSearchMetaFromMeta({ sources: [{ url: 'https://example.com', title: 'Ex' }], truncated: false }))
  assert.ok(webFetchMetaFromMeta({ url: 'https://example.com/docs', statusCode: 200, truncated: false }))

  // Safe URL check blocks javascript: / data: / file:.
  assert.equal(safeWebHref('javascript:alert(1)'), null)
  assert.equal(safeWebHref('file:///etc/passwd'), null)
  assert.equal(safeWebHref('https://www.example.com/a/b')?.host, 'example.com')
  assert.equal(safeWebHref('https://www.example.com/')?.display, 'example.com')
})

test('built-in views render Shell, Read, Diff, Search, Web, Todo, Present, and RunCode with real DSH metadata', () => {
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    // 1. bash with non-zero exit strips marker from output and shows exit pill.
    const bashView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('bash', { command: 'npm test', description: 'Run tests' }, {
        content: [{ type: 'text', text: 'FAIL test.js\n[exit code: 2]' }],
      }),
    })
    let tree = bashView.render()
    assert.match(textOf(tree), /Command/)
    assert.match(textOf(tree), /Run tests/)
    assert.match(textOf(tree), /exit 2/)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    tree = bashView.render()
    assert.match(textOf(tree), /FAIL test\.js/)
    assert.equal(textOf(tree).includes('[exit code: 2]'), false, 'exit marker must not duplicate in body')

    // 2. read with FsReadMeta renders relative path, line range pill, and numbered code lines.
    const readView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('read', { file_path: '/repo/src/index.js' }, {
        meta: { path: '/repo/src/index.js', offset: 10, totalLines: 100, lang: 'js', lines: [{ number: 10, text: 'const x = 1' }, { number: 11, text: 'export default x' }] },
      }),
    })
    tree = readView.render()
    assert.match(textOf(tree), /src\/index\.js/)
    assert.match(textOf(tree), /Lines 10–11 of 100/)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    tree = readView.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-code-row').length, 2)

    // 3. edit with FsDiffMeta renders +N -M counts and diff rows.
    const editView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('edit', { file_path: '/repo/src/a.js', old_string: 'old', new_string: 'new1\nnew2' }, {
        meta: { operation: 'update', diffs: [{ path: '/repo/src/a.js', oldText: 'keep\nold\n', newText: 'keep\nnew1\nnew2\n' }] },
      }),
    })
    tree = editView.render()
    assert.match(textOf(tree), /\+2/)
    assert.match(textOf(tree), /-1/)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    tree = editView.render()
    assert.equal(all(tree, n => n.props?.className === 'dsb-diff-row' && n.props['data-kind'] === 'add').length, 2)
    assert.equal(all(tree, n => n.props?.className === 'dsb-diff-row' && n.props['data-kind'] === 'del').length, 1)

    // 4. grep & glob with SearchMeta.
    const grepView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('grep', { pattern: 'ToolCell', path: '/repo/src' }, {
        meta: { shape: 'matches', total: 5, truncated: true, files: [{ path: '/repo/src/app.js', matches: [{ lineNumber: 42, line: 'return h(ToolCell)' }] }] },
      }),
    })
    tree = grepView.render()
    assert.match(textOf(tree), /5 matches/)
    assert.match(textOf(tree), /Truncated/)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    assert.match(textOf(grepView.render()), /src\/app\.js:42/)

    // 5. web_search blocks javascript: hrefs while linking safe https URLs.
    const webView = renderTree(ToolCallCard, {
      registry,
      block: makeBlock('web_search', { queries: ['deepseek'] }, {
        meta: {
          truncated: false,
          answer: 'DeepSeek builds open models.',
          sources: [
            { url: 'https://deepseek.com/docs', title: 'Docs', snippet: 'Official docs' },
            { url: 'javascript:alert(1)', title: 'Evil' },
          ],
        },
      }),
    })
    all(webView.render(), n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    tree = webView.render()
    const links = all(tree, n => n.type === 'a')
    assert.equal(links.length, 1, 'javascript: source must NOT render as clickable <a>')
    assert.equal(links[0].props.href, 'https://deepseek.com/docs')
    assert.match(textOf(tree), /DeepSeek builds open models/)

    // 6. todo_write defaults expanded with progress pill.
    const todoView = renderTree(ToolCallCard, {
      registry,
      block: makeBlock('todo_write', {
        todos: [
          { content: 'Design schema', status: 'completed' },
          { content: 'Wire views', status: 'in_progress' },
          { content: 'Run bench', status: 'pending' },
        ],
      }),
    })
    tree = todoView.render()
    assert.match(textOf(tree), /1 \/ 3/)
    assert.equal(all(tree, n => n.type === 'li' && n.props?.className === 'dsb-todo-item').length, 3)

    // 7. present defaults expanded with delivered files.
    const presentView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('present', { files: [{ path: '/repo/out/report.pdf', description: 'Final report' }] }),
    })
    tree = presentView.render()
    assert.match(textOf(tree), /report\.pdf/)
    assert.match(textOf(tree), /Final report/)
  } finally {
    dispose()
  }
})

test('plugin tool.call.toolview registration at default priority 0 overrides built-in priority 100 and isolates crashes', () => {
  const registry = createSlotRegistry()
  const disposeBuiltins = registerBuiltinToolViews(registry)
  try {
    const block = makeBlock('bash', { command: 'echo hi' }, { content: [{ type: 'text', text: 'hi' }] })
    assert.match(textOf(renderTree(ToolCallCard, { registry, block }).render()), /Command/)

    // Plugin at default priority (0 < BUILTIN_TOOL_PRIORITY 100) wins cleanly.
    assert.ok(BUILTIN_TOOL_PRIORITY > 0)
    const disposePlugin = registry.register({ name: TOOL_VIEW_SLOT, key: 'bash' }, ({ block: b }) => (
      react.createElement('div', { className: 'custom-bash' }, `CUSTOM:${b.args.text('command')}`)
    ))
    assert.match(textOf(renderTree(ToolCallCard, { registry, block }).render()), /CUSTOM:echo hi/)
    disposePlugin()

    // Disposing plugin restores built-in view.
    assert.match(textOf(renderTree(ToolCallCard, { registry, block }).render()), /Command/)

    // A crashing plugin override is caught by SlotErrorBoundary with Retry.
    const disposeBad = registry.register({ name: TOOL_VIEW_SLOT, key: 'bash' }, () => { throw new Error('plugin boom') })
    const crashed = renderTree(ToolCallCard, { registry, block }).render()
    assert.equal(all(crashed, n => n.props?.className === 'dsb-slot-error').length, 1)
    assert.match(textOf(crashed), /Retry/)
    disposeBad()
  } finally {
    disposeBuiltins()
  }
})

test('Round 2 DSH contract edge cases: create empty diffs, failed edit error + preview, trailing newline, apply_patch input, working_directory cd, empty read, streaming todo/present, run_code description', () => {
  const registry = createSlotRegistry()
  const dispose = registerBuiltinToolViews(registry)
  try {
    // 1. DSH write on file create emits `{ operation: 'create', path, diffs: [] }`.
    assert.ok(diffMetaFromMeta({ operation: 'create', path: '/repo/new.js', diffs: [] }))
    const writeCreate = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('write', { file_path: '/repo/new.js', content: 'export const x = 1\n' }, {
        meta: { operation: 'create', path: '/repo/new.js', diffs: [] },
      }),
    })
    let tree = writeCreate.render()
    assert.match(textOf(tree), /Created/)
    assert.match(textOf(tree), /\+1/)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    assert.match(textOf(writeCreate.render()), /export const x = 1/)

    // 2. Failed edit MUST show BOTH error result text AND attempted preview diff.
    const failedEdit = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('edit', { file_path: '/repo/a.js', old_string: 'missing', new_string: 'replacement' }, {
        isError: true,
        content: [{ type: 'text', text: 'old_string not found in file' }],
      }),
    })
    all(failedEdit.render(), n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    tree = failedEdit.render()
    assert.match(textOf(tree), /old_string not found in file/)
    assert.equal(all(tree, n => n.props?.className === 'dsb-diff-row' && n.props['data-kind'] === 'del').length, 1)

    // 3. Trailing-newline-only edit produces +1 -1 and renders `\ No newline at end of file` in view & copy.
    const nlDiff = computeLineDiff('hello', 'hello\n')
    assert.equal(nlDiff.added, 1)
    assert.equal(nlDiff.removed, 1)
    assert.equal(nlDiff.rows.some(r => r.noNewline === true), true)
    const nlView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('edit', { file_path: '/repo/nl.txt' }, {
        meta: { operation: 'update', stopped: true, diffs: [{ path: '/repo/nl.txt', oldText: 'hello', newText: 'hello\n' }] },
      }),
    })
    tree = nlView.render()
    assert.match(textOf(tree), /Stopped/)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    tree = nlView.render()
    assert.match(textOf(tree), /\\ No newline at end of file/)
    sandbox.__copied.length = 0
    all(tree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dsb-tool-copy'))[0].props.onClick()
    assert.match(sandbox.__copied[0] ?? '', /\\ No newline at end of file/)

    // 4. apply_patch reads DSH `input` argument.
    const patchView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('apply_patch', { input: '*** Begin Patch\n*** Update File: a.js\n-old\n+new\n*** End Patch' }),
    })
    all(patchView.render(), n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    assert.match(textOf(patchView.render()), /\*\*\* Update File: a\.js/)

    // 5. working_directory reads DSH `cd` argument.
    const wdView = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('working_directory', { cd: '/repo/packages/core' }),
    })
    assert.match(textOf(wdView.render()), /packages\/core/)

    // 6. read on empty file (`lines: []`) omits misleading `L1–1` pill and falls back to result text.
    const emptyRead = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('read', { file_path: '/repo/empty.txt' }, {
        meta: { path: '/repo/empty.txt', offset: 1, totalLines: 0, lines: [] },
        content: [{ type: 'text', text: '(empty file)' }],
      }),
    })
    tree = emptyRead.render()
    assert.equal(textOf(tree).includes('L1–1'), false)
    all(tree, n => n.type === 'button' && n.props?.className === 'dsb-tool-head')[0].props.onClick()
    assert.match(textOf(emptyRead.render()), /\(empty file\)/)

    // 7. todo_write & present mounted while `preparing` (empty) auto-open once populated.
    const liveTodo = renderTree(ToolCallCard, {
      registry,
      block: makeBlock('todo_write', {}, { phase: 'preparing' }),
    })
    liveTodo.render()
    tree = liveTodo.render({
      registry,
      block: makeBlock('todo_write', { todos: [{ content: 'Ship it', status: 'in_progress' }] }, { phase: 'result' }),
    })
    assert.match(textOf(tree), /Ship it/)

    const livePresent = renderTree(ToolCallCard, {
      registry,
      cwd: '/repo',
      block: makeBlock('present', {}, { phase: 'preparing' }),
    })
    livePresent.render()
    tree = livePresent.render({
      registry,
      cwd: '/repo',
      block: makeBlock('present', { files: [{ path: '/repo/out.csv' }] }, { phase: 'result' }),
    })
    assert.match(textOf(tree), /out\.csv/)

    // 8. run_code prefers `description` arg over first line of code.
    const ptcView = renderTree(ToolCallCard, {
      registry,
      block: makeBlock('run_code', { description: 'Summarize metrics', code: 'const x = 1\nreturn x' }),
    })
    assert.match(textOf(ptcView.render()), /Summarize metrics/)
  } finally {
    dispose()
  }
})
