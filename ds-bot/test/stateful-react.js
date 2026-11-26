// Test helpers for client components: bundle a module the way the plugin is built, and a
// small stateful React that keeps hook slots per component instance.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export async function loadClientBundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: join(repoRoot, 'ds-bot') },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    plugins: [{
      name: 'harness-packages',
      setup(bundler) {
        bundler.onResolve({ filter: /^@deepseek-ai\/(dsh-llm\/assistant-stream|dsh-util-values)$/ }, (args) => {
          try { return { path: fileURLToPath(import.meta.resolve(args.path)) } } catch { return { path: args.path, external: true } }
        })
      },
    }],
  })
  return outputFiles[0].text
}

// Stateful React harness that tracks per-instance hook slots, effect deps/cleanups,
// and child-before-parent effect commit order (matching React's commit phase).
export function makeStatefulReact() {
  let active = null
  const instances = new Map()
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const slot = (init) => {
    const i = active.idx++
    if (!(i in active.hooks)) active.hooks[i] = init()
    return active.hooks[i]
  }
  const scheduleEffect = (fn, deps) => {
    const cell = slot(() => ({ deps: undefined, cleanup: undefined }))
    if (deps === undefined || !sameDeps(cell.deps, deps)) {
      active.pending.push(() => {
        if (typeof cell.cleanup === 'function') cell.cleanup()
        cell.deps = deps
        cell.cleanup = fn()
      })
    }
  }
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  }
  const React = {
    Component,
    Fragment: Symbol('Fragment'),
    memo: fn => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true) }
    },
    useState(init) {
      const cell = slot(() => ({ value: typeof init === 'function' ? init() : init }))
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    useRef(init) { return slot(() => ({ current: init })) },
    useMemo(fn, deps) {
      const cell = slot(() => ({ deps: undefined, value: undefined, ready: false }))
      if (!cell.ready || deps === undefined || !sameDeps(cell.deps, deps)) {
        cell.deps = deps
        cell.value = fn()
        cell.ready = true
      }
      return cell.value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useId() { return 'bt-test-id' },
    useSyncExternalStore(_sub, getSnapshot) { return getSnapshot() },
    createContext(v) { return { Provider: ({ children }) => children, _v: v } },
    useContext(c) { return c?._v },
    useEffect: scheduleEffect,
    useLayoutEffect: scheduleEffect,
  }
  const resolveType = type => (type && typeof type === 'object' && type.$$typeof === Symbol.for('react.memo') ? type.type : type)
  function renderNode(node, path, seen, effects) {
    if (Array.isArray(node)) return node.map((child, i) => renderNode(child, `${path}[${i}]`, seen, effects))
    if (!node || typeof node !== 'object') return node
    const fn = resolveType(node.type)
    if (typeof fn === 'function') {
      const key = `${path}:${fn.name || 'fn'}:${node.props?.key ?? ''}`
      seen.add(key)
      let inst = instances.get(key)
      if (!inst) { inst = { hooks: [], idx: 0, pending: [] }; instances.set(key, inst) }
      let out
      if (fn.prototype && typeof fn.prototype.render === 'function') {
        const clsProps = { ...node.props, children: node.children }
        if (!inst.cls) inst.cls = new fn(clsProps)
        inst.cls.props = clsProps
        out = inst.cls.render()
      } else {
        const prev = active
        active = inst
        inst.idx = 0
        inst.pending = []
        try {
          out = fn({ ...node.props, children: node.children })
        } finally {
          active = prev
        }
      }
      // Children commit effects BEFORE their parent, matching React.
      const expanded = renderNode(out, key, seen, effects)
      effects.push(...inst.pending)
      inst.pending = []
      return expanded
    }
    return {
      ...node,
      children: (node.children ?? []).map((child, i) => renderNode(child, `${path}/${i}`, seen, effects)),
    }
  }
  function render(element, attachRefs) {
    const seen = new Set()
    const effects = []
    const tree = renderNode(element, 'root', seen, effects)
    for (const [key, inst] of [...instances.entries()]) {
      if (!seen.has(key)) {
        for (const hook of inst.hooks) {
          if (hook && typeof hook.cleanup === 'function') hook.cleanup()
        }
        instances.delete(key)
      }
    }
    if (attachRefs) attachRefs(tree)
    for (const run of effects) run()
    return tree
  }
  function unmount() {
    for (const inst of instances.values()) {
      for (const hook of inst.hooks) {
        if (hook && typeof hook.cleanup === 'function') hook.cleanup()
      }
    }
    instances.clear()
  }
  return { React, render, unmount }
}
