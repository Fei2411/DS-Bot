// Live language switch over the memoized transcript rows, tested end to end with the
// real React 19 reconciler (mini-dom). It proves the two halves of the memo contract:
//
//  1. While a reply streams in chunks, the committed rows never render again — counting
//     every memoized component's invocation through a React shim.
//  2. When the interface language changes underneath the same log, those rows do render
//     again, in the new language: the copy buttons, the compaction bar, the bot event
//     line, the failure banner and the code block labels all switch. This is the review
//     finding P1-1 (rows froze in the old language because `t()` is read at render time
//     and memo props never changed); the language now travels as a prop.
//
// The transcript tree is bundled with esbuild so app and ds-bot modules share one React,
// with `react` aliased to a counting shim and `ui/src/api.js` stubbed (the bundle never
// opens a socket). The locale service the rows read is created and driven from here.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installMiniDom } from './mini-dom.mjs'
import { createLocale } from '../ui/src/locale.js'

installMiniDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The bundle must resolve the app's own react at runtime (one copy for the host's locale
// module, the renderer, and every component), so it builds in a scratch dir inside
// app/test whose node_modules lookup walks up to the app install.
const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-locale-'))
const reactCountPath = join(dir, 'react-count.mjs')
writeFileSync(reactCountPath, `
export * from 'react'
export { act } from 'react'
import { memo as reactMemo } from 'react'
export const renderCounts = new Map()
export function resetRenderCounts() { renderCounts.clear() }
// The bundle renames component bindings (UserRow may arrive as UserRow2), so the row
// key is what a test matches on; the component name only disambiguates.
export function memo(type, compare) {
  const name = typeof type === 'function' ? (type.displayName ?? type.name ?? 'anon') : 'anon'
  const counted = (props) => {
    const rowKey = props?.row?.key ?? ''
    renderCounts.set(name + '::' + rowKey, (renderCounts.get(name + '::' + rowKey) ?? 0) + 1)
    return type(props)
  }
  counted.displayName = name
  return reactMemo(counted, compare)
}
`)
const apiStubPath = join(dir, 'api-stub.mjs')
writeFileSync(apiStubPath, `
export const openSessionFollow = () => () => {}
export const patchApp = () => {}
export const apiGet = async () => { throw new Error('stub') }
`)

const appDir = fileURLToPath(new URL('..', import.meta.url))
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
writeFileSync(join(dir, 'entry.js'), `
export { createElement, Fragment } from 'react'
export { createRoot } from 'react-dom/client'
export { act } from 'react'
export { renderCounts, resetRenderCounts } from ${JSON.stringify(reactCountPath)}
export { applyFrame, emptyLog } from ${JSON.stringify(join(rootDir, 'ds-bot/src/client/session-log.js'))}
export { SessionTranscript } from ${JSON.stringify(join(appDir, 'ui/src/session-chat.js'))}
export { installLocale } from ${JSON.stringify(join(rootDir, 'ds-bot/src/client/i18n.js'))}
export { setAppLocaleService } from ${JSON.stringify(join(appDir, 'ui/src/locale.js'))}
`)

// Mirrors vite.config.js: the ds-bot client modules take their interface primitives from
// the app's own primitives module, so the bundle renders exactly what the desktop window
// renders. `react` is aliased to the counting shim, `ui/src/api.js` is stubbed out.
const primitivesPath = join(appDir, 'ui/src/primitives.js')
const reactAliasPlugin = {
  name: 'test-hooks',
  setup(buildCtx) {
    buildCtx.onResolve({ filter: /^react$/ }, (args) => {
      if (args.importer === reactCountPath || args.importer === '') return { path: 'react', external: true }
      return { path: reactCountPath }
    })
    buildCtx.onResolve({ filter: /ui[\\/]src[\\/]api\.js$/ }, () => ({ path: apiStubPath }))
    buildCtx.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({ path: primitivesPath }))
  },
}

const { outputFiles } = await build({
  entryPoints: [join(dir, 'entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [reactAliasPlugin],
  logLevel: 'silent',
  // The entry lives in a temp dir, so React and the @deepseek-ai peers resolve through
  // the app's own install — matching the standalone `Desktop app profile` CI job.
  nodePaths: [join(appDir, 'node_modules')],
})
const bundlePath = join(dir, 'bundle.mjs')
writeFileSync(bundlePath, outputFiles[0].text)
const { createElement: h, createRoot, act, renderCounts, resetRenderCounts, applyFrame, emptyLog, SessionTranscript, installLocale, setAppLocaleService } = await import(pathToFileURL(bundlePath).href)

// One locale service, shared with the bundle: `installLocale` binds the bundle's `t()`
// and registers every dictionary into it; `setAppLocaleService` is what the rows'
// `useUiLanguage` subscribes to.
const locale = createLocale('en-US')
installLocale(locale)
setAppLocaleService(locale)

const sessionId = 'session-main'
const roster = {
  byId: { [sessionId]: { id: sessionId, name: 'Test Bot', color: 'blue', model: 'deepseek-official/deepseek-chat' } },
  bots: [],
  roomsById: {},
  prefs: {},
  models: [],
}

// A short scripted log: a user message, an assistant reply that carries a fenced code
// block, a compaction checkpoint with its summary, a bot event line, and a failed turn —
// one of each memoized row that holds translated copy. Then a live reply streams in turn 3.
const T0 = 1700000000000
const ev = (seq, time, type, data) => ({ type: 'event', event: { seq, time, type, data } })
const events = [
  ev(1, T0, 'turn/start', { turn: 1 }),
  ev(2, T0 + 1, 'user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'write a hello world script' }] }),
  ev(3, T0 + 2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Here is the script:\n\n```js\nconsole.log("hi")\n```\n' }] } }),
  ev(4, T0 + 3, 'compaction/summary', { compactionId: 'c1', summary: 'Earlier small talk.', shadowedItemCount: 6, shadowedTokenCount: 120 }),
  { type: 'event', event: { seq: 5, time: T0 + 4, type: 'user/message', surfaceOp: 'replace', data: { source: { kind: 'compact-checkpoint', compactionId: 'c1', itemCount: 6 }, content: [{ type: 'text', text: 'checkpoint' }] } } },
  ev(6, T0 + 5, 'turn/end', { turn: 1 }),
  ev(7, T0 + 6, 'user/message', { source: { kind: 'bot', role: 'update' }, content: [] }),
  ev(8, T0 + 7, 'turn/start', { turn: 2 }),
  ev(9, T0 + 8, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'INTERNAL', message: 'the model exploded' } } }),
]
const streamStart = (turn) => ({ type: 'assistant-stream', frame: { type: 'start', attemptId: `${sessionId}:${turn}`, revision: 1, turn, step: 1, startedAfterSeq: 9 } })
const streamChunk = (turn, revision, index, text, blockIndex = 0) => ({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: `${sessionId}:${turn}`, revision, index, time: T0 + 100 + index, chunk: { type: 'text-delta', index: blockIndex, text } } })
const blockStart = (turn, revision, index, blockIndex = 0) => ({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: `${sessionId}:${turn}`, revision, index, time: T0 + 100 + index, chunk: { type: 'block-start', index: blockIndex, blockType: 'text' } } })

function baseLog() {
  let log = emptyLog()
  for (const frame of [
    { type: 'snapshot', header: { id: sessionId, cwd: '/tmp/bench' }, cursor: 9, hasMore: false, records: events.map(event => ({ type: 'event', event: event.event })), assistantStream: { revision: 0 } },
    streamStart(3),
    blockStart(3, 2, 0),
  ]) {
    const next = applyFrame(log, frame)
    if (next.reopen) throw new Error(`unexpected reopen on ${frame.type}`)
    log = next.log
  }
  return log
}

// Stable props, as the real window passes them: the memo contract is about references
// that do not move while a reply streams, and a fresh object per render would defeat it
// for a reason the implementation is not meant to survive.
const actions = {}
const bot = roster.byId[sessionId]

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return {
    container,
    render(log) {
      act(() => root.render(h(SessionTranscript, {
        log, sessionId, roster, actions, classic: false,
        bot,
      })))
    },
    text: () => container.textContent,
    unmount() { act(() => root.unmount()); container.remove() },
  }
}

const countOf = (rowKey) => {
  let total = 0
  for (const [key, n] of renderCounts) if (key.endsWith('::' + rowKey)) total += n
  return total
}
const keysFor = (rowKey) => [...renderCounts.keys()].filter(key => key.endsWith('::' + rowKey))

test('stream chunks re-render only the live row; committed memoized rows render zero extra times', () => {
  resetRenderCounts()
  const view = mount()
  let log = baseLog()
  view.render(log)
  // The tree rendered: one of each memoized row.
  assert.ok(countOf('user:2') >= 1, 'user row mounted')
  assert.ok(countOf('assistant:3') >= 1, 'committed assistant row mounted')
  assert.ok(countOf('compaction:5') >= 1, 'compaction row mounted')
  assert.ok(countOf('ev:7') >= 1, 'bot event row mounted')
  assert.ok(countOf('turn-error:9') >= 1, 'failure row mounted')

  const before = new Map(renderCounts)
  // Five stream chunks land, one render each — exactly what a live reply does.
  const chunks = ['Hello', ', this', ' is the', ' reply streaming', ' in chunks.']
  let revision = 3
  chunks.forEach((text, i) => {
    log = applyFrame(log, streamChunk(3, revision, i + 1, text)).log
    revision += 1
    view.render(log)
  })
  assert.match(view.text(), /reply streaming/, 'the live text reached the DOM')

  const liveRowKey = `writing:${sessionId}:3`
  for (const [key, n] of renderCounts) {
    const initial = before.get(key) ?? 0
    if (key.endsWith('::' + liveRowKey)) {
      assert.ok(n > initial, `live row ${key} re-rendered with the chunks`)
    } else if (key.endsWith('::')) {
      // Inner components (a Bubbles inside an AssistantRow) carry no row key, so their
      // count mixes the live row's correct re-renders with the committed rows'; the
      // row-level keys above are the contract, and the rows memoize them by construction.
      continue
    } else {
      assert.equal(n, initial, `memoized row ${key} never re-rendered while chunks streamed`)
    }
  }
  assert.ok(keysFor(liveRowKey).length > 0, 'a live writing row exists')
  view.unmount()
})

test('a language switch re-renders the memoized rows in the new language, mid-stream or not', () => {
  resetRenderCounts()
  const view = mount()
  const log = baseLog()
  view.render(log)

  // English copy before the switch: user copy button, compaction bar, bot event line,
  // failure banner, and the code block's own Copy label inside the committed reply.
  assert.match(view.container.innerHTML, /aria-label="Copy"/, 'copy buttons read Copy in English')
  assert.equal(view.container.querySelector('.md-copy')?.textContent, 'Copy', 'the code block label reads Copy in English')
  assert.match(view.text(), /compacted/, 'compaction bar in English')
  assert.match(view.text(), /Profile updated/, 'bot event line in English')
  assert.match(view.text(), /script/, 'assistant text rendered')

  // Flip the language. The service notifies; every memoized row re-renders because the
  // language travels as a prop, even though log, rows, roster and actions are untouched.
  const before = new Map(renderCounts)
  act(() => { void locale.setLocale('zh') })

  assert.match(view.container.innerHTML, /aria-label="复制"/, 'copy buttons read 复制 after the switch')
  assert.equal(view.container.querySelector('.md-copy')?.textContent, '复制', 'the code block label inside the memoized committed row is in Chinese')
  assert.doesNotMatch(view.container.innerHTML, /aria-label="Copy"/, 'no English Copy label survives anywhere')
  assert.match(view.text(), /压缩|条消息|上下文/, 'compaction bar is in Chinese')
  assert.doesNotMatch(view.text(), /Profile updated/, 'the English bot event line is gone')
  assert.match(view.text(), /资料|更新/, 'bot event line is in Chinese')
  assert.match(view.text(), /script/, 'the untranslated reply text itself is untouched')

  for (const rowKey of ['user:2', 'assistant:3', 'compaction:5', 'ev:7', 'turn-error:9']) {
    assert.ok((countOf(rowKey) ?? 0) > ([...before.entries()].filter(([key]) => key.endsWith('::' + rowKey)).reduce((sum, [, n]) => sum + n, 0) ?? 0), `${rowKey} re-rendered on the language switch`)
  }

  // And back: the memo re-renders again, in English.
  act(() => { void locale.setLocale('en') })
  assert.match(view.container.innerHTML, /aria-label="Copy"/, 'copy buttons are English again')
  assert.equal(view.container.querySelector('.md-copy')?.textContent, 'Copy', 'the code block label is English again')
  assert.match(view.text(), /Profile updated/, 'bot event line is English again')
  view.unmount()
})

test('a language switch during streaming re-renders history once and streaming keeps the memo afterwards', () => {
  resetRenderCounts()
  const view = mount()
  let log = baseLog()
  view.render(log)

  // Two chunks stream.
  let revision = 3
  for (const [i, text] of ['Part one', ' of the reply'].entries()) {
    log = applyFrame(log, streamChunk(3, revision, i + 1, text)).log
    revision += 1
    view.render(log)
  }
  const settledCounts = new Map(renderCounts)

  // Language switches mid-stream: history re-renders exactly this once.
  act(() => { void locale.setLocale('zh') })
  for (const rowKey of ['user:2', 'assistant:3', 'compaction:5', 'ev:7']) {
    const earlier = [...settledCounts.entries()].filter(([key]) => key.endsWith('::' + rowKey)).reduce((sum, [, n]) => sum + n, 0)
    assert.ok(countOf(rowKey) > earlier, `${rowKey} re-rendered for the switch`)
  }
  const afterSwitch = new Map(renderCounts)

  // Streaming continues in the new language: history is memoized again, only the live row moves.
  const liveRowKey = `writing:${sessionId}:3`
  for (const [i, text] of [' more', ' text here'].entries()) {
    log = applyFrame(log, streamChunk(3, revision, i + 3, text)).log
    revision += 1
    view.render(log)
  }
  for (const [key, n] of renderCounts) {
    if (key.endsWith('::' + liveRowKey) || key.endsWith('::')) continue
    assert.equal(n, afterSwitch.get(key) ?? 0, `${key} stays memoized while streaming in the new language`)
  }
  assert.match(view.text(), /text here/, 'the tail of the reply arrived')
  view.unmount()
})


test('a live expanded focused tool card keeps its DOM node and disclosure when its row commits', () => {
  resetRenderCounts()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ev = (seq, time, type, data) => ({ type: 'event', event: { seq, time, type, data } })
  let log = applyFrame(emptyLog(), {
    type: 'snapshot',
    header: { id: sessionId, cwd: '/tmp/bench' },
    cursor: 2,
    hasMore: false,
    records: [
      ev(1, T0, 'turn/start', { turn: 1 }),
      ev(2, T0 + 1, 'user/message', { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'run ls' }] }),
    ],
    assistantStream: { revision: 0 },
  }).log
  const stream = (frame) => {
    log = applyFrame(log, { type: 'assistant-stream', frame }).log
    if (frame.type === 'chunk' && frame.chunk?.type === 'finish') return
  }
  stream({ type: 'start', attemptId: 'tool-live', revision: 1, turn: 1, step: 1, startedAfterSeq: 2 })
  stream({ type: 'chunk', attemptId: 'tool-live', revision: 2, index: 0, time: T0 + 10, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } })
  stream({ type: 'chunk', attemptId: 'tool-live', revision: 3, index: 1, time: T0 + 11, chunk: { type: 'tool-call-delta', index: 0, id: 'call-live', name: 'bash', argumentsDelta: '{"command":"ls -la"' } })
  const render = () => act(() => root.render(h(SessionTranscript, {
    log, sessionId, roster, actions, classic: false, bot,
  })))
  render()
  const head = container.querySelector('.dsb-tool-head')
  assert.ok(head, 'live preparing tool card rendered')
  act(() => { head.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })) })
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'tool card expanded before commit')
  head.focus()
  assert.equal(document.activeElement, head)

  log = applyFrame(log, ev(3, T0 + 20, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'tool-call', id: 'call-live', name: 'bash', arguments: '{"command":"ls -la"}' }] },
  })).log
  render()
  const afterHead = container.querySelector('.dsb-tool-head')
  assert.equal(afterHead, head, 'the same DOM node survives the live-to-committed move')
  assert.equal(container.contains(head), true)
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'disclosure state survives the commit')
  assert.equal(document.activeElement, head, 'focus survives the commit')
  act(() => root.unmount())
  container.remove()
})

test('a stream chunk never rewrites the turn clock: the noting effect skips when events are unchanged', () => {
  const notes = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const actions = { noteTurnTime: (...args) => notes.push(args) }
  let log = baseLog()
  const render = (next) => act(() => root.render(h(SessionTranscript, {
    log: next, sessionId, roster, actions, classic: false, bot,
  })))
  render(log)
  const initial = notes.length
  assert.ok(initial > 0, 'the first render notes the turn times')
  log = applyFrame(log, streamChunk(3, 3, 1, 'streaming text')).log
  render(log)
  assert.equal(notes.length, initial, 'a stream chunk does not re-note a single turn time')
  log = applyFrame(log, streamChunk(3, 4, 2, ' and more')).log
  render(log)
  assert.equal(notes.length, initial, 'nor does the next chunk')

  // Switching sessionId or actions.noteTurnTime with the same events array reference MUST re-note.
  const otherNotes = []
  act(() => root.render(h(SessionTranscript, {
    log, sessionId: 'session-2', roster, actions: { noteTurnTime: (...args) => otherNotes.push(args) }, classic: false, bot,
  })))
  assert.ok(otherNotes.length > 0, 'switching sessionId/actions re-notes turn times even when events array ref matches')
  assert.ok(otherNotes.every(([sid]) => sid === 'session-2'))
  act(() => root.unmount())
  container.remove()
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})
