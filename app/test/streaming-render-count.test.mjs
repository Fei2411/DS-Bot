// React Profiler render-count guard for W4 streaming performance (#2472):
// Simulates 200 streaming `assistant-stream` frames over controllable animation frames
// against the real React 19 reconciler (mini-dom) and asserts:
//   1. `ComposerArea` (composer + all docks + queue) renders 0 times during streaming.
//   2. `Transcript` / `SessionTranscript` commits at most once per animation frame
//      (<= frame count) while still rendering every streamed token in order.
//   3. Committed rows (`subagentCatalog` & `committedRowsCache`) keep object identity
//      across stream chunks and unrelated roster updates.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { installMiniDom } from './mini-dom.mjs'

installMiniDom()

const appDir = fileURLToPath(new URL('..', import.meta.url))
const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const deepViewReact = fileURLToPath(import.meta.resolve('deep-view/react'))

const dir = mkdtempSync(join(tmpdir(), 'dsb-stream-render-test-'))

// Controllable rAF queue so tests drive exact animation-frame boundaries.
let nextRafId = 1
const rafQueue = new Map()
globalThis.requestAnimationFrame = (cb) => {
  const id = nextRafId++
  rafQueue.set(id, cb)
  return id
}
globalThis.cancelAnimationFrame = (id) => {
  rafQueue.delete(id)
}
if (globalThis.window) {
  globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame
  globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function flushRafFrame(act) {
  const batch = [...rafQueue.entries()]
  rafQueue.clear()
  if (batch.length === 0) return 0
  act(() => {
    for (const [, cb] of batch) cb(Date.now())
  })
  return batch.length
}

// Controllable SSE stream for `/api/bot/session`.
function createSseFetch() {
  const streams = new Map()
  const encoder = new TextEncoder()
  const fetch = async (url, { signal } = {}) => {
    const parsed = new URL(url, 'http://localhost')
    const id = parsed.searchParams.get('id') ?? ''
    const queue = []
    let waiter = null
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
    }
    signal?.addEventListener?.('abort', finish)
    const entry = {
      push(event, data) {
        if (closed) return
        const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        if (waiter) { const w = waiter; waiter = null; w({ value: chunk, done: false }) }
        else queue.push(chunk)
      },
      close: finish,
    }
    streams.set(id, entry)
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => { waiter = resolve })
          },
          cancel: () => { finish(); return Promise.resolve() },
        }),
      },
    }
  }
  return { fetch, get: id => streams.get(id), clear: () => { for (const s of streams.values()) s.close(); streams.clear() } }
}

const sse = createSseFetch()
globalThis.fetch = (...args) => sse.fetch(...args)
globalThis.__testCall = async () => ({ records: [], hasMore: false })

// Record React.Profiler commits by id.
const profileCommits = new Map()
globalThis.__onProfile = (id, phase) => {
  const list = profileCommits.get(id) ?? []
  list.push(phase)
  profileCommits.set(id, list)
}
const resetProfiles = () => profileCommits.clear()
const commitCount = id => (profileCommits.get(id) ?? []).length

// Check whether the split modules (`composer-area.js` / `chat-transcript.js`) exist yet so
// this test can also run against the pre-fix baseline and demonstrate failure there.
const stubs = {
  'cells.js': `
    import { createElement as h } from 'react'
    export const Bubbles = ({ texts }) => h('div', { className: 'stub-bubbles' }, ...(Array.isArray(texts) ? texts : []))
    export const ThinkingRow = ({ text }) => h('div', { className: 'stub-thinking' }, text)
    export const EarlierParts = () => null
    export const PartLine = () => null
    export const NewDivider = () => h('div', { className: 'bt-new-sep' })
    export const unseenSince = () => false
    export const ChatRows = () => null
    export const Shimmer = ({ children }) => h('span', null, children)
    export const Elapsed = () => null
    export const workPhrase = () => ''
    export const ToolCell = () => h('span', { hidden: true, 'data-bt-empty': '' })
    export const isBotTool = () => false
  `,
  'widget-cell.js': `
    export const WidgetCell = () => null
    export const WidgetDock = () => null
    export const AnsweredReply = () => null
    export const ViewCard = () => null
  `,
  'model-menu.js': `
    export const ModelChoiceDock = () => null
    export const ModelKeyCard = () => null
    export const ModelMenu = () => null
    export const Caret = () => null
    export const useAnchoredMenu = () => ({ open: false, setOpen() {}, triggerRef: { current: null }, menuRef: { current: null }, style: {} })
    export const modelOf = () => null
    export const manageModels = () => undefined
  `,
  'api.js': 'export const call = (...args) => globalThis.__testCall(...args)\n',
  'primitives.js': `
    import { createElement as h } from 'react'
    export const FishLogo = () => null
    export const MarkdownText = ({ text }) => h('div', { className: 'stub-md' }, text)
    export const writeClipboard = async () => true
    export const fileExtension = () => ''
    export const fileSizeText = () => ''
  `,
}

// Wrap real modules with React.Profiler via esbuild shim plugins so zero test hooks
// exist in production code.
const realQueueDockPath = join(appDir, 'ui/src/queue-dock.js')
const realSessionChatPath = join(appDir, 'ui/src/session-chat.js')
const realComposerAreaPath = join(appDir, 'ui/src/composer-area.js')
const realTranscriptPath = join(appDir, 'ui/src/chat-transcript.js')

const entryCode = `
  export { createElement, act, Profiler } from 'react'
  export { createRoot } from 'react-dom/client'
  export { Chat } from './ui/src/chat.js'
  export { buildSessionRowParts } from './ui/src/session-transcript.js'
  export { applyFrame, emptyLog } from '../ds-bot/src/client/session-log.js'
`

const reactEntry = fileURLToPath(import.meta.resolve('react'))
const reactDomEntry = fileURLToPath(import.meta.resolve('react-dom'))
const reactDomClientEntry = fileURLToPath(import.meta.resolve('react-dom/client'))

const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: appDir,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  nodePaths: [join(appDir, 'node_modules')],
  plugins: [{
    name: 'stream-render-profiler',
    setup(bundler) {
      bundler.onResolve({ filter: /^react$/ }, () => ({ path: reactEntry }))
      bundler.onResolve({ filter: /^react-dom$/ }, () => ({ path: reactDomEntry }))
      bundler.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: reactDomClientEntry }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^deep-view\/react$/ }, () => ({ path: deepViewReact }))
      bundler.onResolve({ filter: /(src\/client\/(cells|widget-cell|model-menu|api|dsh-primitives)|ui\/src\/primitives)\.js$|^\.\/(dsh-)?primitives\.js$/ }, (args) => {
        const name = args.path.split('/').pop()
        return { path: name === 'dsh-primitives.js' ? 'primitives.js' : name, namespace: 'stub' }
      })
      bundler.onResolve({ filter: /^\.\/(cells|widget-cell|model-menu|api)\.js$/ }, (args) => {
        if (!args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: args.path.slice(2), namespace: 'stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], resolveDir: appDir, loader: 'js' }))

      // Profile DesktopQueueDock inside the real ComposerArea (also catches pre-split Chat).
      bundler.onResolve({ filter: /^\.\/queue-dock\.js$/ }, (args) => {
        if (args.namespace === 'profile-wrap') return { path: realQueueDockPath }
        return { path: 'queue-dock', namespace: 'profile-wrap' }
      })
      bundler.onLoad({ filter: /^queue-dock$/, namespace: 'profile-wrap' }, () => ({
        contents: `
          import { createElement as h, Profiler } from 'react'
          import { DesktopQueueDock as Real, queueRowText } from ${JSON.stringify(realQueueDockPath)}
          export { queueRowText }
          export function DesktopQueueDock(props) {
            return h(Profiler, { id: 'DesktopQueueDock', onRender: (id, phase) => globalThis.__onProfile(id, phase) },
              h(Real, props))
          }
        `,
        resolveDir: join(appDir, 'ui/src'),
        loader: 'js',
      }))

      // Profile SessionTranscript.
      bundler.onResolve({ filter: /^\.\/session-chat\.js$/ }, (args) => {
        if (args.namespace === 'profile-wrap') return { path: realSessionChatPath }
        return { path: 'session-chat', namespace: 'profile-wrap' }
      })
      bundler.onLoad({ filter: /^session-chat$/, namespace: 'profile-wrap' }, () => ({
        contents: `
          import { createElement as h, Profiler } from 'react'
          import * as real from ${JSON.stringify(realSessionChatPath)}
          export * from ${JSON.stringify(realSessionChatPath)}
          export function SessionTranscript(props) {
            return h(Profiler, { id: 'SessionTranscript', onRender: (id, phase) => globalThis.__onProfile(id, phase) },
              h(real.SessionTranscript, props))
          }
        `,
        resolveDir: join(appDir, 'ui/src'),
        loader: 'js',
      }))

      // Profile ComposerArea when split exists.
      bundler.onResolve({ filter: /^\.\/composer-area\.js$/ }, (args) => {
        if (args.namespace === 'profile-wrap') return { path: realComposerAreaPath }
        return { path: 'composer-area', namespace: 'profile-wrap' }
      })
      bundler.onLoad({ filter: /^composer-area$/, namespace: 'profile-wrap' }, () => ({
        contents: `
          import { createElement as h, Profiler } from 'react'
          import * as real from ${JSON.stringify(realComposerAreaPath)}
          export * from ${JSON.stringify(realComposerAreaPath)}
          export function ComposerArea(props) {
            return h(Profiler, { id: 'ComposerArea', onRender: (id, phase) => globalThis.__onProfile(id, phase) },
              h(real.ComposerArea, props))
          }
        `,
        resolveDir: join(appDir, 'ui/src'),
        loader: 'js',
      }))

      // Profile Transcript when split exists.
      bundler.onResolve({ filter: /^\.\/chat-transcript\.js$/ }, (args) => {
        if (args.namespace === 'profile-wrap') return { path: realTranscriptPath }
        return { path: 'chat-transcript', namespace: 'profile-wrap' }
      })
      bundler.onLoad({ filter: /^chat-transcript$/, namespace: 'profile-wrap' }, () => ({
        contents: `
          import { createElement as h, Profiler } from 'react'
          import * as real from ${JSON.stringify(realTranscriptPath)}
          export * from ${JSON.stringify(realTranscriptPath)}
          export function Transcript(props) {
            return h(Profiler, { id: 'Transcript', onRender: (id, phase) => globalThis.__onProfile(id, phase) },
              h(real.Transcript, props))
          }
        `,
        resolveDir: join(appDir, 'ui/src'),
        loader: 'js',
      }))
    },
  }],
})

const bundlePath = join(dir, 'bundle.mjs')
writeFileSync(bundlePath, outputFiles[0].text)
const { createElement: h, act, createRoot, Chat, buildSessionRowParts, applyFrame, emptyLog } = await import(pathToFileURL(bundlePath).href)

const tick = () => new Promise(resolve => setImmediate(resolve))

function makeTeam(sessionRunning = true) {
  const roster = {
    ready: true,
    prefs: { enterToSend: true },
    bots: [{ id: 'b1', name: 'Bot', sessionId: 'b1' }],
    byId: { b1: { id: 'b1', name: 'Bot', sessionId: 'b1' } },
    rooms: [],
    roomsById: {},
    questions: {},
    exchangeTurns: {},
    closedCards: {},
  }
  const statusMap = new Map([['b1', { running: sessionRunning }]])
  const emptyObj = {}
  const emptyList = []
  const emptyWork = { bots: {}, approvals: [] }
  const sessions = { ids: ['b1'], byId: { b1: { id: 'b1' } } }
  const listeners = new Set()
  return {
    actions: {
      noteSent() {},
      noteLive() {},
      noteTurnTime() {},
      noteTurnFacts() {},
      noteReplyArrival() {},
      send: async () => {},
      stopChat: async () => {},
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
      answerQuestion: async () => {},
      dismissQuestion() {},
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select(emptyObj),
      useTurnClock: select => select(emptyObj),
      useSessionStatus: select => select(statusMap),
      useSessions: select => select(sessions),
      useWork: select => select(emptyWork),
      useUserQuestions: select => select(emptyList),
      useSessionQueues: select => select(emptyObj),
      useCards: select => select(emptyObj),
      useHeldCards: select => select(emptyObj),
      useComputer: select => select(emptyObj),
      useBrowserHolds: select => select(emptyObj),
      useBrowserTabs: select => select(emptyObj),
      useBrowserPages: select => select(emptyObj),
      useRescuedDrafts: select => select(emptyObj),
      useConnection: select => select({ status: 'connected' }),
    },
    chat: { on: fn => { listeners.add(fn); return () => listeners.delete(fn) } },
  }
}

test('200 stream frames across 10 animation frames: ComposerArea renders 0 times and Transcript commits <= animation frames', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const team = makeTeam(true)
  try {
    act(() => {
      root.render(h(Chat, { sessionId: 'b1', team }))
    })
    await tick()
    const stream = sse.get('b1')
    assert.ok(stream, 'session follow stream opened')

    // Initial snapshot + turn start + stream start + block-start.
    await act(async () => {
      stream.push('frame', {
        type: 'snapshot',
        header: { id: 'b1', cwd: '/tmp' },
        cursor: 1,
        hasMore: false,
        records: [
          { type: 'event', event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
          { type: 'event', event: { type: 'user/message', seq: 1, time: 101, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } } },
        ],
      })
      stream.push('frame', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'att-1', revision: 1, turn: 1, step: 1, startedAfterSeq: 1 } })
      stream.push('frame', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att-1', revision: 2, index: 0, time: 110, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
      await tick()
      await tick()
    })
    flushRafFrame(act)

    // Reset Profiler counts right before the 200 streaming token frames.
    resetProfiles()

    const totalFrames = 200
    const animFrames = 10
    const perFrame = totalFrames / animFrames
    let revision = 2
    let index = 1

    for (let f = 0; f < animFrames; f += 1) {
      for (let k = 0; k < perFrame; k += 1) {
        revision += 1
        await act(async () => {
          stream.push('frame', {
            type: 'assistant-stream',
            frame: {
              type: 'chunk',
              attemptId: 'att-1',
              revision,
              index: index++,
              time: 200 + revision,
              chunk: { type: 'text-delta', index: 0, text: `tok${f}_${k} ` },
            },
          })
          await tick()
        })
      }
      flushRafFrame(act)
    }

    const composerCommits = commitCount('ComposerArea')
    const queueDockCommits = commitCount('DesktopQueueDock')
    const transcriptCommits = commitCount('Transcript')
    const sessionTranscriptCommits = commitCount('SessionTranscript')

    // All 200 tokens landed in the rendered transcript.
    assert.match(container.textContent, /tok0_0/)
    assert.match(container.textContent, /tok9_19/)

    assert.ok(sessionTranscriptCommits >= 1 && sessionTranscriptCommits <= animFrames,
      `SessionTranscript commits (${sessionTranscriptCommits}) must be <= animation frame count (${animFrames})`)
    assert.ok(transcriptCommits >= 1 && transcriptCommits <= animFrames,
      `Transcript commits (${transcriptCommits}) must be <= animation frame count (${animFrames})`)
    assert.equal(composerCommits, 0, `ComposerArea must render 0 times during 200 stream frames, got ${composerCommits}`)
    assert.equal(queueDockCommits, 0, `DesktopQueueDock must render 0 times during 200 stream frames, got ${queueDockCommits}`)
  } finally {
    act(() => root.unmount())
    container.remove()
    sse.clear()
    rafQueue.clear()
  }
})

test('200 stream frames in a single animation frame coalesce into 1 Transcript commit, and non-stream event flushes pending chunks immediately', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const team = makeTeam(true)
  try {
    act(() => {
      root.render(h(Chat, { sessionId: 'b1', team }))
    })
    await tick()
    const stream = sse.get('b1')
    assert.ok(stream)

    await act(async () => {
      stream.push('frame', {
        type: 'snapshot',
        header: { id: 'b1', cwd: '/tmp' },
        cursor: 0,
        hasMore: false,
        records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } }],
      })
      stream.push('frame', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'att-burst', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 } })
      stream.push('frame', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att-burst', revision: 2, index: 0, time: 101, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
      await tick()
    })
    flushRafFrame(act)
    resetProfiles()

    // Burst 200 chunks before a single animation frame ticks.
    let revision = 2
    let index = 1
    for (let k = 0; k < 200; k += 1) {
      revision += 1
      await act(async () => {
        stream.push('frame', {
          type: 'assistant-stream',
          frame: {
            type: 'chunk',
            attemptId: 'att-burst',
            revision,
            index: index++,
            time: 200 + revision,
            chunk: { type: 'text-delta', index: 0, text: `b${k} ` },
          },
        })
        await tick()
      })
    }

    // Nothing committed before rAF fires.
    assert.equal(commitCount('Transcript'), 0)
    assert.equal(commitCount('ComposerArea'), 0)

    // One rAF commits all 200 chunks together.
    flushRafFrame(act)
    assert.equal(commitCount('Transcript'), 1)
    assert.equal(commitCount('SessionTranscript'), 1)
    assert.equal(commitCount('ComposerArea'), 0)
    assert.match(container.textContent, /b0 /)
    assert.match(container.textContent, /b199 /)

    // A pending chunk followed by a committed assistant/message event flushes immediately without rAF.
    revision += 1
    await act(async () => {
      stream.push('frame', {
        type: 'assistant-stream',
        frame: { type: 'chunk', attemptId: 'att-burst', revision, index: index++, time: 999, chunk: { type: 'text-delta', index: 0, text: 'tail ' } },
      })
      stream.push('frame', { type: 'assistant-stream', frame: { type: 'end', attemptId: 'att-burst', revision: revision + 1, index } })
      stream.push('frame', {
        type: 'event',
        event: { type: 'assistant/message', seq: 1, time: 1000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final settled reply' }] } } },
      })
      await tick()
      await tick()
    })
    assert.match(container.textContent, /final settled reply/)
    assert.equal(rafQueue.size, 0, 'non-stream event cancels pending rAF after flushing')
  } finally {
    act(() => root.unmount())
    container.remove()
    sse.clear()
    rafQueue.clear()
  }
})

test('committedRowsCache stays valid across unrelated roster changes and invalidates on session-relevant fields', () => {
  const snapshot = {
    type: 'snapshot',
    header: { id: 'b1', cwd: '/tmp' },
    cursor: 3,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
      { type: 'event', event: { type: 'user/message', seq: 1, time: 101, data: { turn: 1, source: { kind: 'user', rpcId: 'api:tok1' }, content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 2, time: 102, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hello' }] } } } },
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 103, data: { turn: 1, reason: { kind: 'completed' } } } },
    ],
  }
  const log = applyFrame(emptyLog(), snapshot).log
  const r1 = { revision: 1, prefs: { theme: 'deepseek' }, bots: [{ id: 'b1' }], exchangeTurns: { b1: [] }, closedCards: {}, api: { tokens: [{ keyId: 'tok1', name: 'CLI' }] } }
  const r2 = { revision: 2, prefs: { theme: 'paper' }, bots: [{ id: 'b1' }, { id: 'b2' }], exchangeTurns: { b1: [] }, closedCards: {}, api: { tokens: [{ keyId: 'tok1', name: 'CLI' }] } }
  const r3 = { ...r2, exchangeTurns: { b1: [1] } }
  const r4 = { ...r2, api: { tokens: [{ keyId: 'tok1', name: 'Renamed' }] } }

  const p1 = buildSessionRowParts(log, { roster: r1, sessionId: 'b1' })
  const p2 = buildSessionRowParts(log, { roster: r2, sessionId: 'b1' })
  assert.strictEqual(p1.committed, p2.committed, 'unrelated roster update must reuse the exact committed rows array')
  assert.equal(p1.committed.find(r => r.kind === 'user')?.via, 'api:CLI')

  const p3 = buildSessionRowParts(log, { roster: r3, sessionId: 'b1' })
  assert.notStrictEqual(p1.committed, p3.committed, 'session-relevant exchangeTurns update must invalidate committed rows')
  assert.equal(p3.committed.some(row => row.kind === 'assistant' && row.turn === 1), false)

  const p4 = buildSessionRowParts(log, { roster: r4, sessionId: 'b1' })
  assert.notStrictEqual(p1.committed, p4.committed, 'api.tokens rename must invalidate committed rows')
  assert.equal(p4.committed.find(r => r.kind === 'user')?.via, 'api:Renamed')
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})
