import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format } from 'node:util'
import { install as partsInstall } from '../src/host/parts.js'
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
async function switchPart({ replies, info = {}, fallback, route = {}, oldNote, retryPolicy }) {
  const requests = []
  const warnings = []
  const infos = []
  const say = (template, ...args) => format(template, ...args)
  const followed = []
  const selected = []
  let defaultCalls = 0
  const queue = [...replies]
  const abort = new AbortController()
  const ctx = fakeContext()
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
      requests.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens, prompt })
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
    requestHeader: () => ({ config: { provider: route.provider ?? 'deepseek', model: route.model ?? 'v4', ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }) }, tools: [{ name: 'message_bot' }] }),
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
    workDirOf: () => '/tmp/team',
    isFolder: async () => true,
    uiLanguage: () => 'en',
    roomProgress: new Map(),
    defaultModel: async () => { defaultCalls += 1; return fallback },
  }
  partsInstall(rt)
  await rt.newPart('s1')
  for (let at = 0; at < 100 && bot.sessionId !== 's2' && !warnings.some(line => /did not move on/.test(line)); at += 1) {
    await new Promise(done => setTimeout(done, 10))
  }
  const packageText = followed.map(message => message?.content?.map?.(block => block.text).join('') ?? '').join('\n')
  return { bot, requests, warnings, infos, packageText, selected, defaultCalls: () => defaultCalls }
}

test('the note asks for the lowest reasoning the model offers', async () => {
  const off = await switchPart({ replies: [{ text: note('off-run') }], info: { 'deepseek/v4': { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } } })
  assert.equal(off.bot.sessionId, 's2')
  assert.equal(off.requests[0].reasoningEffort, 'off')
  assert.match(off.packageText, /off-run/)

  const lowest = await switchPart({ replies: [{ text: note('lowest-run') }], info: { 'deepseek/v4': { reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } } } })
  assert.equal(lowest.requests[0].reasoningEffort, 'minimal')

  const none = await switchPart({ replies: [{ text: note('no-reasoning') }] })
  assert.equal(none.requests[0].reasoningEffort, undefined)
  assert.match(none.packageText, /no-reasoning/)
})

test('a cut-off note is asked again with a larger output budget, and the new note is what the fresh part gets', async () => {
  const run = await switchPart({
    replies: [
      { text: '## Goals\n- cut off here', kind: 'max-tokens', usage: { outputTokens: 8_192 } },
      { text: note('second-attempt'), usage: { outputTokens: 900 } },
    ],
    oldNote: 'OLD NOTE FROM PART 1',
  })
  assert.equal(run.bot.sessionId, 's2', run.warnings.join(' | '))
  assert.deepEqual(run.requests.map(request => request.maxTokens), [8_192, 16_384])
  assert.match(run.requests[1].prompt, /shorter/)
  assert.match(run.packageText, /second-attempt/)
  assert.doesNotMatch(run.packageText, /OLD NOTE FROM PART 1/)
  assert.ok(run.warnings.some(line => /cut off at the output limit \(finish max-tokens, output 8192 tokens\)/.test(line)), run.warnings.join(' | '))
})

test('the larger retry budget stays inside what the route allows', async () => {
  const run = await switchPart({
    replies: [
      { text: '## Goals\n- cut off', kind: 'max-tokens' },
      { text: note('capped') },
    ],
    route: { maxTokens: 10_000 },
  })
  assert.deepEqual(run.requests.map(request => request.maxTokens), [8_192, 10_000])
  assert.match(run.packageText, /capped/)
})

test('a note with missing sections or an empty reply still retries, and the retry gets the larger budget', async () => {
  const missing = await switchPart({
    replies: [
      { text: NOTE_SECTIONS.slice(0, 3).map(name => `## ${name}\n- x`).join('\n\n') },
      { text: note('filled-in') },
    ],
  })
  assert.deepEqual(missing.requests.map(request => request.maxTokens), [8_192, 16_384])
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
  assert.deepEqual(ok.requests.map(request => request.maxTokens), [8_192, 8_192])
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

