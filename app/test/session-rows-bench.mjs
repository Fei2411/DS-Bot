// Reproducible micro-benchmark for `buildSessionRows` while a reply streams in.
//
// A committed history (300 events by default; HISTORY_EVENTS=2000 for the long-session check) (user/assistant exchanges with tool calls) plus one
// active attempt streaming 200 chunks. Every chunk applies one frame and rebuilds the
// rows, the same way `SessionTranscript` does per render; only the time inside
// `buildSessionRows` is measured.
//
// Run from the repo root or the worktree: node app/test/session-rows-bench.mjs
// Prints JSON: total ms, per-call mean/median/p95, and output row counts as a sanity check.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))
const stubs = {
  'primitives.js': `
    export const MarkdownText = () => null
    export const writeClipboard = async () => true
    export const fileExtension = () => ''
    export const fileSizeText = () => ''
  `,
}

// Bundle the real client projection code (session-log.js, session-transcript.js and their
// imports), stubbing only the interface primitives the window substitutes at build time.
const entryCode = `
  export { applyFrame, emptyLog } from '../ds-bot/src/client/session-log.js'
  export { buildSessionRowParts } from './ui/src/session-transcript.js'
`
const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'bench-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-llm\/assistant-stream$/ }, () => ({ path: assistantStream }))
      bundler.onResolve({ filter: /^@deepseek-ai\/dsh-util-values$/ }, () => ({ path: utilValues }))
      bundler.onResolve({ filter: /^\.\/dsh-primitives\.js$|ds-bot\/src\/client\/dsh-primitives\.js$/ }, args => (args.path.includes('dsh-primitives') ? { path: 'primitives.js', namespace: 'bench-stub' } : null))
      bundler.onLoad({ filter: /.*/, namespace: 'bench-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

const module = { exports: {} }
const sandbox = {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        Fragment: 'fragment',
        memo: fn => fn,
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useRef: initial => ({ current: initial }),
        useEffect: () => {}, useLayoutEffect: () => {},
        useMemo: make => make(),
        useCallback: fn => fn,
      }
    }
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`no platform module ${name}`)
  },
}
runInNewContext(outputFiles[0].text, sandbox)
const { applyFrame, emptyLog, buildSessionRowParts } = module.exports

// --- fixture: a realistic 300-event history -----------------------------------------
const paragraph = (seed) => [
  `Reply ${seed}: the first paragraph explains the approach in some detail,`,
  'with a couple of sentences so the length resembles a real answer.',
  '',
  '- first point of the list',
  '- second point, somewhat longer than the first one was',
  '- third point',
  '',
  '```js',
  `const value${seed} = compute(${seed})`,
  'console.log(value' + seed + ')',
  '```',
  '',
  'A closing paragraph with `inline code` and **bold** text.',
].join('\n')

function historyEvents(count) {
  const events = []
  let seq = 0
  let turn = 0
  while (events.length < count) {
    turn += 1
    const base = 1_700_000_000_000 + seq * 1000
    events.push({ seq: seq++, time: base, type: 'turn/start', data: { turn } })
    events.push({ seq: seq++, time: base + 1, type: 'user/message', data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text: `Question number ${turn}: please explain.` }] } })
    events.push({ seq: seq++, time: base + 2, type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: paragraph(turn) }] } } })
    if (turn % 3 === 0 && events.length < count - 2) {
      events.push({ seq: seq++, time: base + 3, type: 'tool/call', data: { turn, step: 1, callId: `c-${turn}`, name: 'bash', arguments: '{"command":"ls"}' } })
      events.push({ seq: seq++, time: base + 4, type: 'tool/result', data: { turn, step: 1, message: { toolCallId: `c-${turn}`, content: [{ type: 'text', text: 'a.txt\nb.txt' }], isError: false } } })
    }
    events.push({ seq: seq++, time: base + 5, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events.slice(0, count)
}

// --- fixture: 200 streamed chunks of one long markdown reply -------------------------
const streamedText = (() => {
  const parts = []
  for (let section = 0; section < 8; section += 1) {
    parts.push(`Section ${section} begins with an introductory sentence that keeps going.\n\n`)
    parts.push('```ts\n' + `export const section${section} = ${section}\n` + '```\n\n')
    parts.push(`- bullet ${section}-a\n- bullet ${section}-b\n\n`)
  }
  return parts.join('')
})()
const chunkCount = 200
const chunkSize = Math.ceil(streamedText.length / chunkCount)
const chunks = []
for (let index = 0; index < chunkCount; index += 1) {
  chunks.push(streamedText.slice(index * chunkSize, (index + 1) * chunkSize))
}

// --- drive the log -------------------------------------------------------------------
const benchEvents = historyEvents(Number(process.env.HISTORY_EVENTS ?? 300))
function buildLog(events = benchEvents) {
  const snapshot = {
    type: 'snapshot',
    header: { id: 'bench-bot', cwd: '/repo' },
    cursor: events.at(-1).seq,
    hasMore: false,
    records: events.map(event => ({ type: 'event', event })),
  }
  let log = applyFrame(emptyLog(), snapshot).log
  const start = { type: 'assistant-stream', frame: { type: 'start', attemptId: 'bench-1', revision: 1, turn: 99, step: 1, startedAfterSeq: events.at(-1).seq } }
  log = applyFrame(log, start).log
  return log
}

function frames() {
  // DSH compact stream frames: each chunk carries block-start once, then text-deltas.
  const out = []
  let revision = 1
  let index = 0
  revision += 1
  out.push({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'bench-1', revision, index: index++, time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
  for (const text of chunks) {
    revision += 1
    out.push({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'bench-1', revision, index: index++, time: revision, chunk: { type: 'text-delta', index: 0, text } } })
  }
  return out
}

function measure() {
  const frameList = frames()
  const timings = []
  let rowsOut = 0
  const roster = { exchangeTurns: {}, closedCards: {} }
  // Warmup pass so one-time module costs stay out of the numbers.
  let warm = buildLog()
  for (const frame of frameList) {
    warm = applyFrame(warm, frame).log
    buildSessionRowParts(warm, { roster, sessionId: 'bench-bot' })
  }
  for (let round = 0; round < 3; round += 1) {
    let log = buildLog()
    const roundTimings = []
    for (const frame of frameList) {
      log = applyFrame(log, frame).log
      const t0 = performance.now()
      const rows = buildSessionRowParts(log, { roster, sessionId: 'bench-bot' }).committed
      roundTimings.push(performance.now() - t0)
      rowsOut = rows.length
    }
    timings.push(roundTimings)
  }
  // Best-of-rounds per chunk position, then aggregate.
  const perCall = frameList.map((_, i) => Math.min(...timings.map(round => round[i])))
  const total = perCall.reduce((sum, ms) => sum + ms, 0)
  const sorted = [...perCall].sort((a, b) => a - b)
  return {
    calls: perCall.length,
    totalMs: Math.round(total * 100) / 100,
    meanMs: Math.round((total / perCall.length) * 1000) / 1000,
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 1000) / 1000,
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 1000) / 1000,
    maxMs: Math.round(sorted.at(-1) * 1000) / 1000,
    rowsOut,
    textLength: streamedText.length,
  }
}

const result = measure()
assert.equal(result.calls, chunkCount + 1)
assert.ok(result.rowsOut > 0)
console.log(JSON.stringify(result, null, 2))
