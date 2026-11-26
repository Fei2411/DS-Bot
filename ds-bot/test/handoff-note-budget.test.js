import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format } from 'node:util'
import { install as partsInstall } from '../src/host/parts.js'
import { install as chatInstall } from '../src/host/chat-index.js'
import { fakeContext } from './fake-ctx.js'

// #1105: a handoff note written by a reasoning model on a long context keeps getting
// cut off at the output limit. The note now asks for the least reasoning, gives a
// cut-off retry more output room, and may fall back to one other served route.

const MESSAGES = [
  { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Finish the migration' }], source: { kind: 'user' } },
  { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'The schema is done; the data copy is next.' }] },
]

const NOTE_SECTIONS = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
const note = marker => NOTE_SECTIONS.map(name => `## ${name}\n- ${marker}`).join('\n\n')

// The chunks a real adapter sends for one reply.
function* chunksOf(reply) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  if (reply.text !== '') yield { type: 'text-delta', index: 0, text: reply.text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
  if (reply.usage !== undefined) yield { type: 'usage', usage: reply.usage }
  yield { type: 'finish', reason: { kind: reply.kind ?? 'stop', ...(reply.failure === undefined ? {} : { failure: reply.failure }) } }
}

// A Bot's own chat part with the note writer around it. `replies` are answered in
// order by the model stream; `info` holds resolveModelInfo per route.
async function switchPart({ replies, info = {}, fallback, route = {}, oldNote, retryPolicy, history, folder = false }) {
  const requests = []
  const warnings = []
  const infos = []
  const say = (template, ...args) => format(template, ...args)
  const followed = []
  const selected = []
  let defaultCalls = 0
  const queue = [...replies]
  const abort = new AbortController()
  // Past its hard line a part moves on at the end of its turn, with a note if one
  // can be written.
  const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_000_000 }) } } })
  ctx.logger = {
    warn: (template, ...args) => warnings.push(say(template, ...args)),
    info: (template, ...args) => infos.push(say(template, ...args)),
  }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm = {
    ...(retryPolicy === undefined ? {} : { providerRetryPolicy: () => retryPolicy }),
    resolveModelInfo: async (provider, model) => info[`${provider}/${model}`] ?? {},
    stream: (options) => {
      const prompt = options.messages.at(-1).content.map(block => block.text).join('')
      requests.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens, temperature: options.temperature, stop: options.stop, prompt })
      const reply = queue.shift()
      if (reply === undefined) throw new Error('no reply left for the note')
      if (reply instanceof Error) throw reply
      if (reply.abort === true) abort.abort(new Error('aborted by the test'))
      return chunksOf(reply)
    },
  }
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: `${route.provider ?? 'deepseek'}/${route.model ?? 'v4'}`, segments: oldNote === undefined ? [] : [{ sessionId: 's0', note: oldNote, number: 1 }] }
  const session = {
    id: 's1',
    header: { cwd: '/tmp/team' },
    requestHeader: () => ({ config: { provider: route.provider ?? 'deepseek', model: route.model ?? 'v4', ...route }, tools: [{ name: 'message_bot' }] }),
    deriveMessages: () => MESSAGES,
    toolHistory: () => [],
  }
  const agent = {
    id: 's1', session, status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(abort.signal),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push(message),
    send: async () => {},
  }
  const fresh = {
    id: 's2',
    session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
    status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(abort.signal),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push(message),
    send: async () => {},
  }
  const rt = {
    ctx,
    home: '/unused',
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: (template, ...args) => warnings.push(say(template, ...args)),
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    isMain: () => false,
    chatOf: () => 's1',
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: () => false,
    isLocalAgentRoute: () => false,
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    live: new Map(),
    groupSessionsOf: () => [],
    unreadOf: () => [],
    clock: () => 'now',
    partsOf: () => (bot.segments ?? []).map(segment => segment.sessionId),
    partLines: async function* () {
      for (const message of MESSAGES) yield { who: message.role === 'user' ? 'user' : 'you', text: message.content[0].text, seq: message.id === 'm1' ? 1 : 2, time: 1 }
    },
    eventsBackwards: async function* () {
      for (const message of [...MESSAGES].reverse()) {
        yield message.role === 'user'
          ? { type: 'user/message', time: 1, seq: 1, data: { content: message.content, source: { kind: 'user' } } }
          : { type: 'assistant/message', time: 1, seq: 2, data: { message: { content: message.content } } }
      }
    },
    historyEntry: () => undefined,
    displayItems: async () => [],
    earlierPage: async () => ({}),
    chatPage: async () => ({}),
    followFolder: async () => {},
    heldBack: () => [],
    resolveAgent: async id => (id === 's2' ? fresh : agent),
    createSession: async () => 's2',
    desiredModel: async subject => subject.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async (id, picked) => { selected.push([id, picked]) },
    applyModel: async () => {},
    applyPermission: async () => {},
    ensureCapabilities: async () => {},
    renewMemory: () => {},
    moveSchedules: async () => {},
    sessionTitle: { rename: async () => {} },
    deliver: async () => {},
    teamFolder: () => '/tmp/team',
    workDirOf: () => folder ? '/tmp/new-team' : '/tmp/team',
    isFolder: async () => true,
    uiLanguage: () => 'en',
    roomProgress: new Map(),
    defaultModel: async () => { defaultCalls += 1; return fallback },
  }
  if (history !== undefined) {
    session.seq = history.length
    ctx.sessionController = {
      page: async ({ beforeSeq, maxMessages }) => {
        const end = beforeSeq ?? history.length
        const start = Math.max(0, end - maxMessages)
        return { records: history.slice(start, end).map(event => ({ event })), hasMore: start > 0 }
      },
    }
    chatInstall(rt)
  }
  partsInstall(rt)
  if (folder) await rt.followFolder({ botId: 'b1' })
  else ctx.emit('agent/status', { agent, status: 'idle' })
  for (let at = 0; at < 100 && bot.sessionId !== 's2' && !warnings.some(line => /did not move on/.test(line)); at += 1) {
    await new Promise(done => setTimeout(done, 10))
  }
  const packageText = followed.map(message => message?.content?.map?.(block => block.text).join('') ?? '').join('\n')
  return { bot, requests, warnings, infos, packageText, selected, defaultCalls: () => defaultCalls }
}

test('a folder handoff capped before the Session start writes a note instead of claiming whole history', async () => {
  const history = Array.from({ length: 2001 }, (_, seq) => ({
    seq, time: 1, type: 'user/message',
    data: { content: [{ type: 'text', text: seq === 2000 ? 'Latest request' : 'setup' }], source: { kind: seq === 2000 ? 'user' : 'plugin' } },
  }))
  const run = await switchPart({ history, folder: true, replies: [{ text: note('bounded handoff') }] })
  assert.equal(run.bot.sessionId, 's2')
  assert.equal(run.requests.length, 1)
  assert.match(run.packageText, /Older messages were not carried/)
  assert.doesNotMatch(run.packageText, /every message of the part was carried/)
})

test('attempt 1 preserves the session route config for prefix cache and steps down reasoning on max-tokens retry', async () => {
  const preserved = await switchPart({
    replies: [{ text: note('cached-run') }],
    route: { reasoningEffort: 'high', maxTokens: 32_000, temperature: 0.2, stop: ['END'] },
    info: { 'deepseek/v4': { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } },
  })
  assert.equal(preserved.bot.sessionId, 's2')
  assert.equal(preserved.requests[0].reasoningEffort, 'high')
  assert.equal(preserved.requests[0].maxTokens, 32_000)
  assert.equal(preserved.requests[0].temperature, 0.2)
  assert.deepEqual(preserved.requests[0].stop, ['END'])
  assert.match(preserved.packageText, /cached-run/)

  const steppedOff = await switchPart({
    replies: [{ text: '## Goals\n- cut off', kind: 'max-tokens' }, { text: note('off-retry') }],
    route: { reasoningEffort: 'high', maxTokens: 32_000 },
    info: { 'deepseek/v4': { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } },
  })
  assert.equal(steppedOff.bot.sessionId, 's2')
  assert.deepEqual(steppedOff.requests.map(request => request.reasoningEffort), ['high', 'off'])
  assert.deepEqual(steppedOff.requests.map(request => request.maxTokens), [32_000, 16_384])
  assert.match(steppedOff.packageText, /off-retry/)

  const steppedLowest = await switchPart({
    replies: [{ text: '## Goals\n- cut off', kind: 'max-tokens' }, { text: note('lowest-retry') }],
    route: { reasoningEffort: 'high' },
    info: { 'deepseek/v4': { reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } } },
  })
  assert.deepEqual(steppedLowest.requests.map(request => request.reasoningEffort), ['high', 'minimal'])

  const none = await switchPart({ replies: [{ text: note('no-reasoning') }] })
  assert.equal(none.requests[0].reasoningEffort, undefined)
  assert.match(none.packageText, /no-reasoning/)
})

test('a cut-off note is asked again with a shorter prompt and lowered effort, and the new note is what the fresh part gets', async () => {
  const run = await switchPart({
    replies: [
      { text: '## Goals\n- cut off here', kind: 'max-tokens', usage: { outputTokens: 16_384 } },
      { text: note('second-attempt'), usage: { outputTokens: 900 } },
    ],
    oldNote: 'OLD NOTE FROM PART 1',
  })
  assert.equal(run.bot.sessionId, 's2', run.warnings.join(' | '))
  assert.deepEqual(run.requests.map(request => request.maxTokens), [16_384, 16_384])
  assert.match(run.requests[1].prompt, /shorter/)
  assert.match(run.packageText, /second-attempt/)
  assert.doesNotMatch(run.packageText, /OLD NOTE FROM PART 1/)
  assert.ok(run.warnings.some(line => /cut off at the output limit \(finish max-tokens, output 16384 tokens\)/.test(line)), run.warnings.join(' | '))
})

test('the note uses the full output budget the route allows from attempt 1', async () => {
  const run = await switchPart({
    replies: [
      { text: '## Goals\n- cut off', kind: 'max-tokens' },
      { text: note('capped') },
    ],
    route: { maxTokens: 10_000 },
  })
  assert.deepEqual(run.requests.map(request => request.maxTokens), [10_000, 10_000])
  assert.match(run.packageText, /capped/)
})

test('a note with missing sections or an empty reply still retries with the route budget intact', async () => {
  const missing = await switchPart({
    replies: [
      { text: NOTE_SECTIONS.slice(0, 3).map(name => `## ${name}\n- x`).join('\n\n') },
      { text: note('filled-in') },
    ],
  })
  assert.deepEqual(missing.requests.map(request => request.maxTokens), [16_384, 16_384])
  assert.match(missing.requests[1].prompt, /lacked these headings/)
  assert.match(missing.packageText, /filled-in/)

  const empty = await switchPart({ replies: [{ text: '', kind: 'stop' }, { text: note('after-empty') }] })
  assert.equal(empty.requests.length, 2)
  assert.match(empty.packageText, /after-empty/)
})

test('another route from defaultModel is never called, even when it is different and available', async () => {
  // The conversation must not leave the provider the user chose: a note failing on its
  // own route never sends the same messages to another provider.
  const run = await switchPart({
    replies: [
      { text: '## Goals\n- cut off', kind: 'max-tokens' },
      { text: '## Goals\n- cut off again', kind: 'max-tokens' },
    ],
    fallback: 'ollama/kimi',
    oldNote: 'OLD NOTE FROM PART 1',
  })
  assert.equal(run.bot.sessionId, 's2', run.warnings.join(' | '))
  assert.equal(run.requests.length, 2)
  assert.deepEqual(run.requests.map(request => `${request.provider}/${request.model}`), ['deepseek/v4', 'deepseek/v4'])
  assert.equal(run.defaultCalls(), 0)
  assert.match(run.packageText, /put this note together without the model/)
  assert.doesNotMatch(run.packageText, /cut off/)
  // Past the hard line the existing honest fallback still carries the earlier note.
  assert.match(run.packageText, /carried over unchanged/)
  assert.ok(run.warnings.some(line => /no usable note in 2 attempts on deepseek\/v4/.test(line)), run.warnings.join(' | '))
})

test('an aborted request is not retried and does not fall back', async () => {
  const run = await switchPart({
    replies: [{ text: '', kind: 'aborted', abort: true }],
    fallback: 'ollama/kimi',
  })
  assert.equal(run.bot.sessionId, 's1')
  assert.equal(run.requests.length, 1)
  assert.equal(run.defaultCalls(), 0)
  assert.ok(run.warnings.some(line => /did not move on/.test(line)), run.warnings.join(' | '))
})

test('handoff note retries transient TRANSPORT failures within the provider retry policy', async () => {
  const ok = await switchPart({
    replies: [
      { text: '', kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } },
      { text: note('after-transport') },
    ],
    retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT', 'TIMEOUT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
  })
  assert.equal(ok.bot.sessionId, 's2')
  assert.equal(ok.requests.length, 2)
  assert.deepEqual(ok.requests.map(request => request.maxTokens), [16_384, 16_384])
  assert.match(ok.packageText, /after-transport/)

  const capped = await switchPart({
    replies: [
      { text: '', kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } },
      { text: '', kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } },
    ],
    retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
  })
  assert.equal(capped.requests.length, 2)
})
