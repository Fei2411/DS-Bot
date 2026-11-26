// Real-runtime contract tests for memory recall quality, prompt budgeting,
// bounded panel/tidy prompts, O(1) tidy undo, non-starving tidy scheduling,
// and reverse-chunked journal history reads.
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { MEMORY_LIMITS, wordsOf } from '../src/host/memory-entries.js'
import { PENDING_FILE, record as pendingRecord } from '../src/host/memory-pending.js'
import { pickRecalled, rankEntries } from '../src/host/memory-search.js'
import { estimateTokens } from '../src/host/text.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coder', model: 'deepseek/v4', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 1,
      log: [{ who: 'User', text: 'Keep launch updates brief', seq: 1 }],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember this' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved.' }] } } } },
]

function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-opt-')), replies = [], config = {}, modelInfo = () => ({}) } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }, { id: 'small' }, { id: 'large' }, { id: 'unknown' }],
      resolveModelInfo: async (provider, model) => modelInfo(provider, model),
      async* stream(request) {
        requests.push(request)
        const next = typeof replies === 'function' ? await replies(request) : await replies.shift()
        if (next instanceof Error) throw next
        const out = typeof next === 'object' && next !== null ? next : { text: next ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 12 } } }),
      selectModel: async () => {},
      page: async () => ({ records: ownChat, hasMore: false }),
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, memoryReview: false, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const section = sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId } })
  const read = (...path) => readFileSync(join(home, 'memory', ...path), 'utf8')
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, rt, call, tool, section, read, requests, warnings, stop }
}

const textOf = message => (message?.content ?? []).map(block => block.text).join('')
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function runPreStep(ctx, sessionId, messages, history = []) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => history } }
  return step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages }))
}

async function recallOf(ctx, sessionId, text, { source = { kind: 'user' }, history = [] } = {}) {
  const messages = text === '' ? [] : [{ role: 'user', source, content: [{ type: 'text', text }] }]
  const decision = await runPreStep(ctx, sessionId, messages, history)
  return decision.messages.find(item => item.source?.kind === 'ds-bot-memory-recall')
}

async function summarized(call, botId = 'b2') {
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await call('memory-view', { botId })).value.summarizing === false) return
    await settle()
  }
  throw new Error('memory summary did not finish')
}

// ---------------------------------------------------------------------------
// P0-1: O(1) tidy undo, stale batch pruning, bounded tidy input, topic caps,
// expired-entry daily due(), and non-starving round-robin scheduler.

test('P0-1: tidy uses O(1) retired offset/hash undo on >600 KB retired.jsonl, prunes old batch files, and recovers idempotently', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-opt-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(join(dir, 'tidy'), { recursive: true })
  const facts = Array.from({ length: 12 }, (_, at) => `- Fact number ${at + 1} [id: a${String(at).padStart(3, '0')}; added: 2026-10-01]`)
  const originalMain = `# Memory\n\n${facts.join('\n')}\n\n## Index\n`
  writeFileSync(join(dir, 'MEMORY.md'), originalMain)
  // Pre-existing >600 KB retired.jsonl would previously blow past pending.json's 1 MB cap
  // because retired.jsonl was copied raw + double-escaped inside tidy/<batch>.json.
  const largeRetired = `${Array.from({ length: 1_500 }, (_, i) => JSON.stringify({ batch: `old-${i}`, time: '2026-09-01T00:00:00.000Z', file: 'MEMORY.md', line: `- Retired historical entry ${i} ${'x'.repeat(350)}`, why: 'ended' })).join('\n')}\n`
  assert.ok(Buffer.byteLength(largeRetired, 'utf8') > 600_000)
  writeFileSync(join(dir, 'retired.jsonl'), largeRetired)
  // Stale undo batch files left from earlier tidies.
  writeFileSync(join(dir, 'tidy', 'stale-1.json'), '{"batch":"stale-1"}')
  writeFileSync(join(dir, 'tidy', 'stale-2.json'), '{"batch":"stale-2"}')

  const replies = [JSON.stringify({ changes: [{ op: 'retire', entry: 1, why: 'no longer needed' }, { op: 'retire', entry: 2, why: 'done' }] })]
  const { call, rt, read, stop } = start({ home, replies })
  t.after(() => stop())
  await call('state', {})
  await rt.tidyMemoryNow('bot:b2')

  const tidyFiles = readdirSync(join(dir, 'tidy'))
  assert.equal(tidyFiles.length, 1, 'superseded tidy batch files must be pruned')
  const savedBatch = JSON.parse(read('bots', 'b2', 'tidy', tidyFiles[0]))
  assert.equal(savedBatch.retiredBefore, undefined, 'must not duplicate retired.jsonl inside batch file')
  assert.equal(savedBatch.retiredOffset, Buffer.byteLength(largeRetired, 'utf8'))
  assert.equal(savedBatch.retiredLines, 2)
  assert.equal(typeof savedBatch.retiredHash, 'string')
  assert.ok(savedBatch.retiredHash.length === 64)
  assert.ok(statSync(join(dir, 'retired.jsonl')).size > savedBatch.retiredOffset)

  // Undo restores MEMORY.md verbatim, truncates retired.jsonl back to exact offset,
  // and deletes the undone batch file.
  const view = (await call('memory-view', { botId: 'b2' })).value
  const undone = await call('memory-tidy-undo', { botId: 'b2', scope: 'own', batch: view.tidy.batch })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(read('bots', 'b2', 'MEMORY.md'), originalMain)
  assert.equal(read('bots', 'b2', 'retired.jsonl'), largeRetired)
  assert.equal(readdirSync(join(dir, 'tidy')).length, 0)

  // Crash-recovery idempotency of append step: simulate partial write past offset before restart.
  const delta = `${JSON.stringify({ batch: 'rec', why: 'ended', line: '- Partial test' })}\n`
  const offset = Buffer.byteLength(largeRetired, 'utf8')
  writeFileSync(join(dir, 'retired.jsonl'), `${largeRetired}${delta.slice(0, 12)}`)
  writeFileSync(join(home, 'memory', PENDING_FILE), JSON.stringify(pendingRecord({
    id: 'recover-append-1',
    time: '2026-11-23T00:00:00.000Z',
    op: 'tidy',
    scope: 'bot:b2',
    steps: [{ action: 'append', path: 'bots/b2/retired.jsonl', text: delta, offset }],
    row: { op: 'tidy', scope: 'bot:b2', actor: 'b2', actorName: 'Writer', auto: true },
  })))
  await call('memory-view', { botId: 'b2' })
  assert.equal(existsSync(join(home, 'memory', PENDING_FILE)), false)
  assert.equal(read('bots', 'b2', 'retired.jsonl'), `${largeRetired}${delta}`)

  // Backward compatibility: legacy tidy batch files containing `retiredBefore` still undo cleanly.
  const legacyBatch = 'legacy-batch-1'
  const legacyRetired = `${JSON.stringify({ batch: 'older', why: 'ended', line: '- Older retired line' })}\n`
  const mutatedMain = '# Memory\n\n- Mutated after legacy tidy [id: f999]\n\n## Index\n'
  writeFileSync(join(dir, 'retired.jsonl'), `${legacyRetired}${delta}`)
  writeFileSync(join(dir, 'MEMORY.md'), mutatedMain)
  writeFileSync(join(dir, 'tidied.json'), JSON.stringify({ batch: legacyBatch, time: '2026-11-23T00:01:00.000Z', day: '2026-11-23' }))
  writeFileSync(join(dir, 'tidy', `${legacyBatch}.json`), JSON.stringify({
    batch: legacyBatch,
    scope: 'bot:b2',
    files: [{ file: 'MEMORY.md', before: originalMain, after: mutatedMain }],
    retiredBefore: legacyRetired,
  }))
  const legacyUndone = await call('memory-tidy-undo', { botId: 'b2', scope: 'own', batch: legacyBatch })
  assert.equal(legacyUndone.ok, true, JSON.stringify(legacyUndone))
  assert.equal(read('bots', 'b2', 'MEMORY.md'), originalMain)
  assert.equal(read('bots', 'b2', 'retired.jsonl'), legacyRetired)

  // Crash-recovery fail-closed: append step must refuse when file shrank below offset.
  writeFileSync(join(dir, 'retired.jsonl'), 'tiny\n')
  writeFileSync(join(home, 'memory', PENDING_FILE), JSON.stringify(pendingRecord({
    id: 'recover-append-short',
    time: '2026-11-23T00:02:00.000Z',
    op: 'tidy',
    scope: 'bot:b2',
    steps: [{ action: 'append', path: 'bots/b2/retired.jsonl', text: delta, offset: 500 }],
    row: { op: 'tidy', scope: 'bot:b2', actor: 'b2', actorName: 'Writer', auto: true },
  })))
  const shortFailed = await call('memory-view', { botId: 'b2' })
  assert.equal(shortFailed.ok, false)
  assert.match(shortFailed.error.message, /Cannot append to bots\/b2\/retired\.jsonl at offset 500/)
  assert.equal(read('bots', 'b2', 'retired.jsonl'), 'tiny\n')
})

test('P0-1: tidy bounds LLM prompt size on large multi-topic memories and enforces 16 KB / 40 topic caps on move', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-opt-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  const mainLines = Array.from({ length: 10 }, (_, i) => `- Core item ${i + 1} [id: b${String(i).padStart(3, '0')}; added: 2026-10-01]`)
  writeFileSync(join(dir, 'MEMORY.md'), `# Memory\n\n${mainLines.join('\n')}\n- Always pinned rule [id: f001; added: 2026-01-01; pinned: user]\n\n## Index\n- [[tea]]\n`)
  // Full 16 KB topic `tea.md` + 38 other topics (total 39 topics, leaving room for 1 split `tea-2`, then hitting 40-topic cap).
  const fullTea = `# tea\n\n${Array.from({ length: 56 }, (_, i) => `- Tea detail ${i} ${'z'.repeat(280)} [id: t${String(i).padStart(3, '0')}]`).join('\n')}\n`
  writeFileSync(join(dir, 'tea.md'), fullTea)
  for (let i = 1; i <= MEMORY_LIMITS.topics - 2; i += 1) {
    writeFileSync(join(dir, `extra-${i}.md`), `# extra-${i}\n\n- Extra note ${i} ${'k'.repeat(240)} [id: e${String(i).padStart(3, '0')}]\n- Extra note ${i}b ${'k'.repeat(240)} [id: d${String(i).padStart(3, '0')}]\n`)
  }
  const replies = [JSON.stringify({ changes: [
    { op: 'move', entry: 1, topic: 'tea' },
    { op: 'move', entry: 2, topic: 'brand-new-over-cap' },
  ] })]
  const { call, rt, read, requests, stop } = start({
    home,
    replies,
    modelInfo: () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4_000 }),
  })
  t.after(() => stop())
  await call('state', {})
  await rt.tidyMemoryNow('bot:b2')

  assert.equal(requests.length, 1)
  const prompt = requests[0].messages[0].content[0].text
  // Input must stay bounded rather than dumping all ~40 KB of topic files.
  assert.ok(prompt.length < 22_000, `expected bounded tidy prompt, got ${prompt.length} chars`)
  assert.match(prompt, /other entries are not included in this pass/)
  assert.match(prompt, /Pinned entries \(read-only context/)
  assert.match(prompt, /Always pinned rule/)
  // First move spills full `tea.md` into `tea-2.md` (topic #40).
  assert.match(read('bots', 'b2', 'tea-2.md'), /Core item 1/)
  // Second move would create topic #41 and must be skipped, keeping Core item 2 in MEMORY.md.
  assert.equal(existsSync(join(dir, 'brand-new-over-cap.md')), false)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Core item 2/)
})

test('P0-1: failing scope backs off without starving other scopes, and expired entries trigger daily tidy without new writes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-opt-'))
  const dirM1 = join(home, 'memory', 'bots', 'm1')
  const dirB2 = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dirM1, { recursive: true })
  mkdirSync(dirB2, { recursive: true })
  writeFileSync(join(dirM1, 'MEMORY.md'), `# Memory\n\n${Array.from({ length: 10 }, (_, i) => `- Chief fact ${i} [id: c${String(i).padStart(3, '0')}]`).join('\n')}\n\n## Index\n`)
  writeFileSync(join(dirB2, 'MEMORY.md'), '# Memory\n\n- Active fact [id: b001]\n- Expired temp note [id: b002; until: 2020-01-01]\n\n## Index\n')
  // Mark b2 tidied yesterday with NO journal changes since, while m1 has a recent change.
  writeFileSync(join(dirB2, 'tidied.json'), JSON.stringify({ time: '2026-10-01T00:00:00.000Z', day: '2026-10-01', merged: 0, moved: 0, retired: 0 }))
  writeFileSync(join(home, 'memory', 'journal.jsonl'), `${JSON.stringify({ id: 'j-m1', time: '2026-11-22T00:00:00.000Z', op: 'add', scope: 'bot:m1', file: 'MEMORY.md', after: '- Chief fact 0' })}\n`)

  let m1Calls = 0
  let b2Calls = 0
  const { call, rt, read, stop } = start({
    home,
    config: { memoryTidyBackoffMs: 60_000 },
    replies: (req) => {
      if (req.system.includes('Chief')) {
        m1Calls += 1
        return new Error('model route unavailable')
      }
      b2Calls += 1
      return JSON.stringify({ changes: [] })
    },
  })
  t.after(() => stop())
  await call('state', {})
  // Tick 1 tries m1 (fails -> enters backoff).
  await rt.tidyMemoryTick()
  assert.equal(m1Calls, 1)
  // Tick 2 skips backed-off m1, advances round-robin to b2, and retires expired entry with 0 LLM calls.
  await rt.tidyMemoryTick()
  assert.equal(m1Calls, 1, 'failed scope must stay backed off instead of retrying immediately')
  assert.equal(b2Calls, 0, 'expired-only tidy should retire dead entries without spending an LLM call')
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /Expired temp note/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Active fact/)
  assert.match(read('bots', 'b2', 'retired.jsonl'), /Expired temp note/)
})

// ---------------------------------------------------------------------------
// P0-2: Tokenizer, length-invariant auto-recall, group prompt extraction,
// non-conversational bot trigger skip, and MEMORY.md truncation black hole.

test('P0-2: wordsOf preserves 2-char tech terms, CJK compounds, Unicode scripts, and stems while filtering glue', () => {
  const tech = wordsOf('Use Go and TS for CI/CD, UI, PR reviews, DB on M4, plus A股 and café')
  for (const expected of ['go', 'ts', 'ci', 'cd', 'ui', 'pr', 'db', 'm4', 'a股', 'café', 'review']) {
    assert.ok(tech.has(expected), `expected "${expected}" in ${JSON.stringify([...tech])}`)
  }
  for (const glue of ['and', 'for', 'on', 'the', 'with']) assert.equal(tech.has(glue), false)
  assert.ok(wordsOf('direct morning flights').has('flight'))
  assert.ok(wordsOf('deploying services').has('deploy'))
  assert.ok(wordsOf('テスト環境').has('テス'))
  assert.ok(wordsOf('배포 설정').has('배포'))
})

test('P0-2: autoRecall surfaces realistic detailed Chinese/English/2-char-tech entries without false positives', async (t) => {
  const { ctx, tool, section, stop } = start()
  t.after(() => stop())
  await tool('bot_remember', { text: '生产环境部署必须先跑完单元和冒烟测试，再通过 GitHub Release 自动发布，禁止手动 npm publish', topic: 'deploy' }, 'b2')
  await tool('bot_remember', { text: 'The user prefers direct morning flights on ANA or JAL when traveling to Tokyo and always books aisle seats near the front', topic: 'travel' }, 'b2')
  await tool('bot_remember', { text: 'Backend microservices are written in Go and run automated CI tests on every PR before merge', topic: 'backend' }, 'b2')
  for (let i = 0; i < 15; i += 1) {
    await tool('bot_remember', { text: `用户的新项目文档第${i + 1}条：please check the new project checklist note ${i}`, topic: `misc-${i}` }, 'b2')
  }
  section('b2')

  const zhHit = await recallOf(ctx, 'b2', '帮我发个版本部署到生产环境')
  assert.match(textOf(zhHit), /生产环境部署必须先跑完单元和冒烟测试/)

  const enHit = await recallOf(ctx, 'b2', 'Book me a flight to Tokyo next week')
  assert.match(textOf(enHit), /direct morning flights on ANA or JAL/)

  const shortTechHit = await recallOf(ctx, 'b2', 'Go CI rules')
  assert.match(textOf(shortTechHit), /written in Go and run automated CI tests/)

  // Unrelated and short generic queries must stay quiet (no low-IDF false positives).
  assert.equal(await recallOf(ctx, 'b2', '今天天气怎么样要不要带伞'), undefined)
  assert.equal(await recallOf(ctx, 'b2', 'please check the weather in Paris tomorrow'), undefined)
  assert.equal(await recallOf(ctx, 'b2', '检查一下项目'), undefined)
  assert.equal(await recallOf(ctx, 'b2', '用户的项目'), undefined)
  assert.equal(await recallOf(ctx, 'b2', 'help me check the new thing'), undefined)

  // Tiny 1-doc corpus still recalls matching detailed entries cleanly.
  const singleRanked = rankEntries([{ text: 'Backend microservices are written in Go and run automated CI tests on every PR before merge', file: { topic: 'backend' } }], 'Go CI rules')
  assert.equal(pickRecalled(singleRanked, 5, 'Go CI rules').length, 1)

  // pickRecalled remains backwards-compatible with 2-arg calls.
  const ranked = rankEntries([{ text: 'Short release checklist', file: { topic: 'release' } }], 'release checklist')
  assert.equal(pickRecalled(ranked, 5).length, 1)
})

test('P0-2: group autoRecall parses "This round so far" past long notice headers, skips handoff/kickoff, and handles head+tail long DMs', async (t) => {
  const { ctx, tool, section, stop } = start()
  t.after(() => stop())
  await tool('bot_remember', { text: '生产环境部署必须先跑完单元和冒烟测试再通过 Release 发布', topic: 'deploy' }, 'g3')
  await tool('bot_remember', { text: 'Backend microservices are written in Go and run automated CI tests on every PR before merge', topic: 'backend' }, 'g3')
  await tool('bot_remember', { text: 'Alpha beta gamma protocol notice keyword decoy entry', topic: 'decoy' }, 'g3')
  await tool('bot_remember', { text: 'Message discussion prefix tool step reply result promise silent entry', topic: 'boilerplate-decoy' }, 'g3')
  section('b3')

  const realRoomReply = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, call your first tool in the same step as your opening note — if you stop without a tool call, your turn ends and no work runs. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
  const longNotice = `Group notice (shared instructions for every member):\n${'Alpha beta gamma protocol guidelines. '.repeat(70)}`
  assert.ok(longNotice.length > 2_400)
  const groupPrompt = [
    'Members: the user, Writer and you (admin).',
    longNotice,
    'Earlier in the group, before this round (context only):\nUser: Just checking in.',
    'This round so far, starting with the new message (oldest first):\nUser: 帮我部署生产环境发版',
    'Conversations the user referenced in this round:\n\nAlpha beta gamma protocol notes.',
    realRoomReply,
  ].join('\n\n')
  const groupHit = await recallOf(ctx, 'g3', groupPrompt, { source: { kind: 'bot', form: 'relay', role: 'room' } })
  assert.match(textOf(groupHit), /生产环境部署必须先跑完单元和冒烟测试/)
  assert.doesNotMatch(textOf(groupHit), /decoy entry|boilerplate-decoy|Message discussion prefix/)

  // Solo/short group turn followed directly by real ROOM_REPLY must strip boilerplate so "Go CI rules" recalls cleanly.
  const soloGroupPrompt = [
    'Members: the user, Writer and you (admin).',
    'This round so far, starting with the new message (oldest first):\nUser: Go CI rules',
    realRoomReply,
  ].join('\n\n')
  const soloHit = await recallOf(ctx, 'g3', soloGroupPrompt, { source: { kind: 'bot', form: 'relay', role: 'room' } })
  assert.match(textOf(soloHit), /written in Go and run automated CI tests/)
  assert.doesNotMatch(textOf(soloHit), /Message discussion prefix/)

  // Empty-round wake ("Nothing new in this round since your last message.") must not fall back to notice/ROOM_REPLY.
  const emptyRoundPrompt = [
    'Members: the user, Writer and you (admin).',
    longNotice,
    'Nothing new in this round since your last message.',
    realRoomReply,
  ].join('\n\n')
  assert.equal(await recallOf(ctx, 'g3', emptyRoundPrompt, { source: { kind: 'bot', form: 'relay', role: 'room' } }), undefined)

  // Non-conversational bot messages (handoff / kickoff / task-handoff) and handoff REPLY_KIND payloads must not trigger recall.
  assert.equal(await recallOf(ctx, 'b3', '生产环境部署必须先跑完单元和冒烟测试', { source: { kind: 'bot', handoff: true } }), undefined)
  assert.equal(await recallOf(ctx, 'b3', '生产环境部署必须先跑完单元和冒烟测试', { source: { kind: 'bot', role: 'kickoff' } }), undefined)
  assert.equal(await recallOf(ctx, 'b3', '生产环境部署必须先跑完单元和冒烟测试', { source: { kind: 'bot', role: 'task-handoff' } }), undefined)
  assert.equal(await recallOf(ctx, 'b3', JSON.stringify({ kind: 'answer_to_pending_handoff', question: 'Go CI rules', answer: '生产环境部署' }), { source: { kind: 'user-question-reply' } }), undefined)

  // Long DM whose actual question sits at the tail (>2000 chars in) still recalls via head+tail query.
  await tool('bot_remember', { text: 'Database migrations always run inside an explicit transaction with rollback check', topic: 'db' }, 'b2')
  section('b2')
  const longDm = `${'Background log filler line.\n'.repeat(100)}\nQuestion: how should database migrations rollback check run?`
  assert.ok(longDm.length > 2_500)
  const tailHit = await recallOf(ctx, 'b2', longDm)
  assert.match(textOf(tailHit), /Database migrations always run/)
})

test('P0-2: autoRecall surfaces MEMORY.md entries omitted by the 2% prompt cap without duplicating shown entries', async (t) => {
  const { ctx, tool, stop } = start({
    modelInfo: () => ({ context: { contextWindow: 5_000 } }),
  })
  t.after(() => stop())
  // Older entry that will be pushed out by newer entries under the 100-token (2% of 5,000) budget.
  await tool('bot_remember', { text: 'Tokyo ANA aisle seat preference for direct morning flights near the front of the cabin' }, 'b2')
  for (let i = 0; i < 12; i += 1) {
    await tool('bot_remember', { text: `Newer resident memory entry number ${i} occupying budget slots` }, 'b2')
  }
  // Prime noteWindow + part-opening resident memory snapshot.
  const firstStep = await runPreStep(ctx, 'b2', [])
  const ownSnap = firstStep.messages.find(item => item.source?.kind === 'ds-bot-own-memory')
  const prompt = textOf(ownSnap)
  assert.match(prompt, /more entries are saved here; bot_recall finds them/)
  assert.doesNotMatch(prompt, /Tokyo ANA aisle seat/)

  // Omitted MEMORY.md entry is surfaced automatically on a relevant turn.
  const hit = await recallOf(ctx, 'b2', 'Book Tokyo ANA aisle seat', { history: [ownSnap] })
  assert.match(textOf(hit), /\(yours · MEMORY\.md\) Tokyo ANA aisle seat preference/)
  // An entry already shown in the part-opening snapshot must NOT be duplicated into auto-recall.
  const shownMatch = /Newer resident memory entry number (\d+)/.exec(prompt)
  assert.ok(shownMatch)
  const dup = await recallOf(ctx, 'b2', `Newer resident memory entry number ${shownMatch[1]} occupying budget slots`, { history: [ownSnap] })
  assert.doesNotMatch(textOf(dup), new RegExp(`entry number ${shownMatch[1]}`))
})

// ---------------------------------------------------------------------------
// P1-1: Reserved topic-index budget + unified noteWindow usable floor,
// local-agent window support, and model-switch cache invalidation.

test('P1-1: full Chinese MEMORY.md reserves topic-index budget and reports omitted topics instead of dropping them silently', async (t) => {
  const { ctx, tool, stop } = start({
    modelInfo: () => ({ context: { contextWindow: 128_000 }, defaultMaxTokens: 8_000 }),
  })
  t.after(() => stop())
  // ~3,500 Chinese chars in MEMORY.md exceeds 2% of 120k (2,400 tokens).
  for (let i = 0; i < 25; i += 1) {
    await tool('bot_remember', { text: `这是第${i + 1}条非常详细的中文长期记忆内容用于验证提示词窗口预算裁剪逻辑${'详'.repeat(110)}` }, 'b2')
  }
  for (let i = 0; i < 6; i += 1) {
    await tool('bot_remember', { text: `Topic fact ${i}`, topic: `topic-${i}` }, 'b2')
  }
  const bigStep = await runPreStep(ctx, 'b2', [])
  const own = textOf(bigStep.messages.find(item => item.source?.kind === 'ds-bot-own-memory')).split('## Your memory (MEMORY.md)\n')[1].split('\n\n## Team memory')[0]
  assert.match(own, /more entries are saved here; bot_recall finds them/)
  assert.match(own, /Topic \[\[topic-0\]\]/, 'topic links must remain visible even when MEMORY.md fills the 2% budget')
  assert.ok(estimateTokens(own) <= 2_400, `own section tokens ${estimateTokens(own)} exceeded budget 2400`)

  // With tiny budget (100 tokens), FULL MEMORY.md + 25 topics still surfaces topics & explicit omitted-topics count!
  const small = start({ modelInfo: () => ({ context: { contextWindow: 5_000 } }) })
  t.after(() => small.stop())
  for (let i = 0; i < 15; i += 1) await small.tool('bot_remember', { text: `Resident entry ${i} occupying tight prompt budget` }, 'b2')
  for (let i = 0; i < 25; i += 1) await small.tool('bot_remember', { text: `Ref ${i}`, topic: `ref-${i}` }, 'b2')
  const smallStep = await runPreStep(small.ctx, 'b2', [])
  const ownSmall = textOf(smallStep.messages.find(item => item.source?.kind === 'ds-bot-own-memory')).split('## Your memory (MEMORY.md)\n')[1].split('\n\n## Team memory')[0]
  assert.match(ownSmall, /more entries are saved here; bot_recall finds them/)
  assert.match(ownSmall, /Topic \[\[ref-0\]\]/)
  assert.match(ownSmall, /more topics? (?:is|are) saved here; call bot_recall with no arguments to list them/)
  assert.ok(estimateTokens(ownSmall) <= 100, `small section tokens ${estimateTokens(ownSmall)} exceeded budget 100`)
})

test('P1-1: noteWindow applies steward usable floor, reads localAgentContext only for local routes, clears stale caps, and caches negative lookups', async (t) => {
  const models = {
    'deepseek/v4': { context: { contextWindow: 32_768 }, defaultMaxTokens: 32_768 },
    'deepseek/small': { context: { contextWindow: 5_000 }, defaultMaxTokens: 0 },
    'deepseek/large': { context: { contextWindow: 200_000 }, defaultMaxTokens: 8_000 },
    'deepseek/unknown': {},
  }
  const lookups = []
  const { ctx, rt, tool, stop } = start({
    modelInfo: (provider, model) => {
      lookups.push(`${provider}/${model}`)
      return models[`${provider}/${model}`] ?? {}
    },
  })
  t.after(() => stop())
  const snapOf = async () => textOf((await runPreStep(ctx, 'b2', [])).messages.find(item => item.source?.kind === 'ds-bot-own-memory'))
  await tool('bot_remember', { text: 'Critical preference that must remain visible' }, 'b2')
  // defaultMaxTokens === contextWindow must clamp usable to contextWindow / 2 (16,384 -> 327 tokens), never 0!
  assert.match(await snapOf(), /Critical preference that must remain visible/)

  // Switching model immediately refreshes noteWindow (not cached for 10 min under old bot.id).
  for (let i = 0; i < 12; i += 1) await tool('bot_remember', { text: `Extra resident item ${i} with descriptive words` }, 'b2')
  rt.botOf('b2').model = 'deepseek/small'
  rt.renewMemory('b2')
  assert.match(await snapOf(), /more entries are saved here/, 'switching to small model must enforce 100-token cap immediately')

  // Switching to a model with unknown contextWindow must CLEAR the stale small-model cap AND cache the negative lookup.
  rt.botOf('b2').model = 'deepseek/unknown'
  rt.renewMemory('b2')
  assert.doesNotMatch(await snapOf(), /more entries are saved here/, 'unknown-window model must not inherit stale cap')
  const unknownLookupsAfterFirst = lookups.filter(ref => ref === 'deepseek/unknown').length
  await runPreStep(ctx, 'b2', [])
  assert.equal(lookups.filter(ref => ref === 'deepseek/unknown').length, unknownLookupsAfterFirst, 'negative modelInfo lookup must be throttled')

  rt.botOf('b2').model = 'deepseek/large'
  rt.renewMemory('b2')
  assert.doesNotMatch(await snapOf(), /more entries are saved here/, 'switching to large model must lift cap immediately')

  // A stale localAgentContext record must NOT override a served API model!
  rt.localAgentContext = sessionId => (sessionId === 'b2' ? { size: 5_000 } : undefined)
  rt.isLocalAgentRoute = provider => provider === 'local-cli'
  rt.renewMemory('b2')
  assert.doesNotMatch(await snapOf(), /more entries are saved here/, 'served API model must ignore stale localAgentContext')

  // When routed to a local-agent provider, localAgentContext size governs the 2% prompt cap.
  const prevDesired = rt.desiredModel
  rt.desiredModel = async bot => (bot.id === 'b2' ? 'local-cli/default' : prevDesired(bot))
  rt.renewMemory('b2')
  assert.match(await snapOf(), /more entries are saved here/, 'localAgentContext size must govern 2% prompt cap for local-agent routes')
})

// ---------------------------------------------------------------------------
// P1-2: bot_recall multi-scope topic disambiguation, full-corpus BM25 CJK
// ranking, and expired entry demotion/marking.

test('P1-2: bot_recall disambiguates same-named topics across scopes, ranks rare CJK terms via full-corpus BM25, and marks expired entries', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  await tool('bot_remember', { text: 'Personal earlier fact', topic: 'earlier', scope: 'own' }, 'b3')
  await tool('bot_remember', { text: 'Group earlier fact', topic: 'earlier' }, 'g3')
  // Inside group chat with no scope, prefers group's [[earlier]] and notes own's [[earlier]].
  const inGroup = await tool('bot_recall', { topic: 'earlier' }, 'g3')
  assert.match(inGroup, /Topic \[\[earlier\]\] in the group memory[\s\S]*Group earlier fact/)
  assert.match(inGroup, /Also found topic \[\[earlier\]\] in your memory \(scope "own"\)/)
  // Explicit scope still returns own's [[earlier]] cleanly.
  const ownExplicit = await tool('bot_recall', { topic: 'earlier', scope: 'own' }, 'g3')
  assert.match(ownExplicit, /Personal earlier fact/)
  assert.doesNotMatch(ownExplicit, /Also found topic/)
  // Invalid topic names (e.g. "MEMORY.md" or path chars) must NOT match MEMORY.md as `Topic [[undefined]]`.
  const reservedTopic = await tool('bot_recall', { topic: 'MEMORY.md' }, 'g3')
  assert.match(reservedTopic, /^No topic \[\[MEMORY\.md\]\] there\./)
  assert.doesNotMatch(reservedTopic, /\[\[undefined\]\]/)
  const invalidTopic = await tool('bot_recall', { topic: 'bad/topic' }, 'g3')
  assert.match(invalidTopic, /^No topic \[\[bad\/topic\]\] there\./)

  // Full-corpus BM25: rare domain keyword outranks 20 entries sharing filler Chinese bigrams.
  for (let i = 0; i < 20; i += 1) {
    await tool('bot_remember', { text: `用户喜欢的日常办公习惯第${i + 1}条：保持桌面整洁` }, 'b2')
  }
  await tool('bot_remember', { text: '用户喜欢的 Redis 集群超时配置为 30 秒' }, 'b2')
  const cjkRanked = await tool('bot_recall', { query: '用户喜欢的redis超时配置' }, 'b2')
  const firstHitLine = cjkRanked.split('\n')[1]
  assert.match(firstHitLine, /Redis 集群超时配置为 30 秒/)

  // Active entries rank above expired ones, and expired entries carry `[expired]`.
  await tool('bot_remember', { text: 'Deploy window was Tuesday', until: '2020-01-01' }, 'b2')
  await tool('bot_remember', { text: 'Deploy window is Thursday afternoon' }, 'b2')
  const deployHits = await tool('bot_recall', { query: 'deploy window' }, 'b2')
  const lines = deployHits.split('\n').slice(1)
  assert.match(lines[0], /Deploy window is Thursday afternoon/)
  assert.doesNotMatch(lines[0], /\[expired\]/)
  assert.match(lines[1], /Deploy window was Tuesday.*\[expired\]/)
})

// ---------------------------------------------------------------------------
// P1-3: Bounded startSummary & memoryAsk + reverse-chunked readTail & memoryHistory.

test('P1-3: startSummary excludes expired entries and bounds prompt; memoryAsk bounds prompt while prioritizing matching topic entries', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-opt-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n- Active resident fact [id: a001]\n- Expired summary decoy [id: a002; until: 2020-01-01]\n\n## Index\n')
  for (let i = 0; i < 12; i += 1) {
    const entries = Array.from({ length: 20 }, (_, j) => `- Topic ${i} archival record ${j} ${'m'.repeat(160)} [id: ${i.toString(16)}${j.toString(16).padStart(3, '0')}; added: 2026-09-01]`)
    writeFileSync(join(dir, `archive-${i}.md`), `# archive-${i}\n\n${entries.join('\n')}\n`)
  }
  writeFileSync(join(dir, 'travel.md'), '# travel\n\n- Kyoto ryokan booking confirmed for November [id: b999; added: 2026-01-01]\n')

  const replies = (request) => {
    const text = request.messages[0].content[0].text
    if (requests.length === 1) return '## Overview\nBounded summary generated.\n'
    const match = /\[(\d+)\][^\n]*Kyoto ryokan booking confirmed/.exec(text)
    assert.ok(match, 'matching Kyoto entry must be numbered in bounded ask prompt')
    return JSON.stringify({
      reply: 'Updated the Kyoto booking.',
      changes: [{ op: 'edit', entry: Number(match[1]), text: 'Kyoto ryokan booking moved to December' }],
    })
  }
  const { call, read, requests, stop } = start({
    home,
    replies,
    modelInfo: () => ({ context: { contextWindow: 40_000 }, defaultMaxTokens: 4_000 }),
  })
  t.after(() => stop())

  // 1. Bounded startSummary excluding expired entry.
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call, 'b2')
  assert.equal(requests.length, 1)
  const sumPrompt = requests[0].messages[0].content[0].text
  assert.ok(sumPrompt.length < 15_000, `summary prompt should stay bounded, got ${sumPrompt.length}`)
  assert.match(sumPrompt, /Active resident fact/)
  assert.doesNotMatch(sumPrompt, /Expired summary decoy/)
  assert.match(sumPrompt, /older topic entries omitted/)

  // 2. Bounded memoryAsk prioritizing the topic entry relevant to the user's question.
  const asked = await call('memory-ask', { botId: 'b2', text: 'Update my Kyoto ryokan booking to December' })
  assert.equal(asked.ok, true, JSON.stringify(asked))
  assert.equal(requests.length, 2)
  const askPrompt = requests[1].messages[0].content[0].text
  assert.ok(askPrompt.length < 15_000, `ask prompt should stay bounded, got ${askPrompt.length}`)
  assert.match(askPrompt, /Kyoto ryokan booking confirmed/)
  assert.match(askPrompt, /older topic entries are not shown/)
  assert.match(read('bots', 'b2', 'travel.md'), /Kyoto ryokan booking moved to December/)
})

test('P1-3: memoryHistory and readTail read multi-chunk UTF-8 journal backwards without full-file readFileSync', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-opt-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  const journalPath = join(home, 'memory', 'journal.jsonl')
  const baseMs = Date.parse('2026-10-01T00:00:00.000Z')
  const rows = Array.from({ length: 700 }, (_, i) => ({
    id: `row-${i}`,
    time: new Date(baseMs + i * 1_000).toISOString(),
    op: 'add',
    scope: 'bot:b2',
    file: 'MEMORY.md',
    actor: 'b2',
    actorName: 'Writer',
    after: `- 多字节中文测试条目编号${i} ${'汉'.repeat(110)} [id: ${(i & 0xffff).toString(16).padStart(4, '0')}]`,
  }))
  // Add a restore row at the very end undoing row-640 (which sits on page 2!).
  rows.push({
    id: 'row-restore-640',
    time: new Date(baseMs + 701 * 1_000).toISOString(),
    op: 'remove',
    scope: 'bot:b2',
    file: 'MEMORY.md',
    actor: 'user',
    actorName: 'user',
    restored: 'row-640',
    before: rows[640].after,
  })
  const content = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
  assert.ok(Buffer.byteLength(content, 'utf8') > 250_000, 'journal should span multiple 64 KB chunks')
  writeFileSync(journalPath, content)

  const { ctx, call, stop } = start({ home })
  t.after(() => stop())

  const fullReads = []
  const realReadFileSync = fs.readFileSync
  fs.readFileSync = (path, ...rest) => {
    if (String(path) === journalPath) fullReads.push(String(path))
    return realReadFileSync(path, ...rest)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fs.readFileSync = realReadFileSync
    syncBuiltinESMExports()
  })

  // Page 1 & Page 2 via chunked reverse reads — zero full-file readFileSync calls.
  const page1 = await call('memory-history', { botId: 'b2' })
  assert.equal(page1.ok, true, JSON.stringify(page1))
  assert.equal(page1.value.rows.length, 50)
  assert.equal(page1.value.rows[0].id, 'row-restore-640')
  assert.equal(page1.value.rows[1].id, 'row-699')
  assert.match(page1.value.rows[1].text, /^多字节中文测试条目编号699 汉+$/)
  assert.notEqual(page1.value.more, null)

  const page2 = await call('memory-history', { botId: 'b2', before: page1.value.more })
  assert.equal(page2.ok, true, JSON.stringify(page2))
  assert.equal(page2.value.rows.length, 50)
  const undone640 = page2.value.rows.find(row => row.id === 'row-640')
  assert.ok(undone640, 'row-640 should be on page 2')
  assert.equal(undone640.restored, true, 'restore marker from page 1 must mark row-640 undone on page 2')

  // Trigger readTail via memoryUpdate pre-step — also must NOT call full-file readFileSync.
  await runPreStep(ctx, 'b2', [])
  assert.deepEqual(fullReads, [], 'neither memoryHistory nor readTail should call readFileSync on journal.jsonl')
})
