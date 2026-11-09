import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import {
  MEMORY_LIMITS, addLink, cleanEntry, cleanTopic, formatEntry, insertEntry, looksLikeKey,
  looksSecret, matchEntries, parseAsk, parseMemory, parseReview, reviewEntries, removeLink, splitMeta, writtenIn,
} from '../src/host/memory.js'
import { fitWindow, promptEntry } from '../src/host/memory-entries.js'
import { rankEntries } from '../src/host/memory-search.js'
import { estimateTokens } from '../src/host/text.js'
import { latestMemoryChange, summaryBlocks } from '../src/client/text.js'
import { fakeContext } from './fake-ctx.js'

test('entries carry their metadata at the end of the line, as Agent Memory Repo writes it', () => {
  assert.deepEqual(splitMeta('Prefers tea [source: part 2 #14; by: Chief; added: 2026-10-09]'), {
    text: 'Prefers tea', meta: { source: 'part 2 #14', by: 'Chief', added: '2026-10-09' },
  })
  // Brackets that are not metadata stay in the text.
  assert.deepEqual(splitMeta('Uses [[travel]] notes [draft]'), { text: 'Uses [[travel]] notes [draft]', meta: {} })
  assert.equal(formatEntry('Prefers tea', { source: 'part 1 #3', by: '', added: '2026-10-09' }), '- Prefers tea [source: part 1 #3; added: 2026-10-09]')
  assert.equal(formatEntry('x', { source: 'a; b [c]' }), '- x [source: a b c]')
  assert.equal(cleanEntry('  - * Likes  short\nreplies [source: forged] '), 'Likes short replies')
  assert.equal(cleanTopic(' [[Project X.md]] '), 'project-x')
  assert.equal(cleanTopic('旅行'), '旅行')
  for (const bad of ['', '../etc', 'a/b', 'memory', '-x', 'x'.repeat(49)]) assert.equal(cleanTopic(bad), undefined, bad)
})

test('the Index holds topic links; entries above it, and hand-written lines, stay put', () => {
  const text = '# Memory\n\nA note by hand.\n\n- One [added: 2026-10-01]\n\n## Index\n- [[travel]]\n'
  const parsed = parseMemory(text)
  assert.deepEqual(parsed.entries.map(entry => [entry.line, entry.text]), [[4, 'One']])
  assert.deepEqual(parsed.links, ['travel'])
  const added = insertEntry(parsed.lines, '- Two')
  assert.deepEqual(added, ['# Memory', '', 'A note by hand.', '', '- One [added: 2026-10-01]', '- Two', '', '## Index', '- [[travel]]'])
  assert.deepEqual(insertEntry(['# Memory', '', '## Index'], '- First'), ['# Memory', '', '- First', '', '## Index'])
  assert.deepEqual(insertEntry(['# travel'], '- Fly'), ['# travel', '', '- Fly'])
  assert.deepEqual(addLink(added, 'work'), [...added, '- [[work]]'])
  assert.deepEqual(addLink(['# Memory', '', '- One'], 'work'), ['# Memory', '', '- One', '', '## Index', '- [[work]]'])
  assert.deepEqual(removeLink(addLink(added, 'work'), 'travel'), [...added.slice(0, -1), '- [[work]]'])
})

test('a request names one entry by its text, or by a part only it has', () => {
  const entries = parseMemory('- Likes tea\n- Likes green tea\n- Lives in Hangzhou\n').entries
  assert.deepEqual(matchEntries(entries, 'likes tea').map(entry => entry.text), ['Likes tea'])
  assert.deepEqual(matchEntries(entries, 'tea').map(entry => entry.text), ['Likes tea', 'Likes green tea'])
  assert.deepEqual(matchEntries(entries, 'hangzhou').map(entry => entry.text), ['Lives in Hangzhou'])
  assert.deepEqual(matchEntries(entries, '  '), [])
})

test('keys are refused, while paths, names, and links are kept', () => {
  for (const key of ['sk-' + 'abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz12', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f']) assert.equal(looksLikeKey(key), true, key)
  for (const fine of ['The repo is ~/repos/dsbot/ds-bot/src/host', 'Doc: https://docs.example.com/d/aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f/edit', 'Uses deepseek-v4-flash for drafts', '用户喜欢简短的回答']) assert.equal(looksLikeKey(fine), false, fine)
  // Passwords given as such, and ID or card numbers, are secrets too.
  for (const secret of ['测试服务器的 root 密码是 hunter2-prod', 'The root password is hunter2', 'pwd: x', '身份证号 330106199001011234', 'card 6222 0212 3456 7890', 'the password for root is hunter2', 'The user\'s ATM PIN is 1234', 'passcode is 654321', '验证码是 123456', 'the CVV is 123', 'staging password remains hunter2', 'root 的密码还是 hunter2', 'the db password was changed to s3cret', 'card 6222-0212-3456-7890', 'Amex 3714-496353-98431', '身份证 330106-19900101-1234', 'I use hunter2 as my password', 'Use 654321 for the PIN', 'The user uses s3cret as the staging root password', '我的密码用 hunter2', '我用 hunter2 当密码', '用 abc123 作为服务器密码', 'I use correct horse battery staple as my password', 'Use six five four three two one for the PIN', '我用 correct horse battery staple 当密码', 'The user\'s SSN is 123-45-6789', 'passport number is A12345678', '护照号E12345678', 'driver\'s license D1234567']) assert.equal(looksSecret(secret), true, secret)
  for (const fine of ['用户不想把密码存进记忆', 'Trip on 2026-11-15, back 2026-11-17', 'The user keeps passwords in a password manager, which is 1Password', '用户的密码管理器是 1Password', 'The user pins the sidebar', 'Pin the tab, it is handy', 'The user uses 1Password for passwords', 'Uses Bitwarden as the password manager', 'Use the PIN pad on the left', '密码用 1Password 管理', '密码不能告诉用户', '密码用于登录', '用 1Password 作为密码管理器', 'Uses Tab for the password field', 'The user uses Vim for editing and Rust for work', 'The user\'s passport expires 2027-05-01', 'Passport renewed 2026-11-15, flight 2026-11-17', 'ID card photo, call 138 0013 8000', '密码不能明文保存因为不安全', 'Off 2026-11-15 2026-11-17', '电话 138-0013-8000', '手机 138 0013 8000 是工作号', 'Issue https://x.test/a/1234567890123456789']) assert.equal(looksSecret(fine), false, fine)
})

test('the memory review writes entries in the language of the user\'s lines', () => {
  assert.equal(writtenIn(['帮我写个函数。我们项目用 TypeScript，包管理只用 pnpm，别给我 npm 命令。'], 'x'), 'Chinese (简体中文)')
  assert.equal(writtenIn(['Use pnpm, not npm'], 'x'), 'English')
  assert.equal(writtenIn(['Rename it to 订单 service please, the old one is wrong'], 'x'), 'x')
  assert.equal(writtenIn(['👍'], 'x'), 'x')
})

test('the memory panel reads JSON from the model, in a fence or not', () => {
  assert.deepEqual(parseAsk('```json\n{"reply": "Done.", "changes": [{"op": "add", "text": "x"}]}\n```'), { reply: 'Done.', changes: [{ op: 'add', text: 'x' }] })
  assert.deepEqual(parseAsk('I could not do that.'), { reply: 'I could not do that.', changes: [] })
  assert.deepEqual(parseAsk('{"reply": 3}'), { reply: '3', changes: [] })
  // The review takes only a list of changes; prose or a broken object is no answer.
  assert.deepEqual(parseReview('```json\n{"changes": [{"op": "add", "text": "x"}]}\n```'), { changes: [{ op: 'add', text: 'x' }], leftOut: [] })
  assert.deepEqual(parseReview('{"changes": []}'), { changes: [], leftOut: [] })
  for (const bad of ['Nothing to keep.', '{"changes": "none"}', '{"changes": [{"op": "add"']) assert.equal(parseReview(bad), undefined, bad)
  // A malformed change is set aside; the well-formed ones still count.
  for (const bad of ['"remember this"', '{"text": "x"}', '{"op": "add", "text": " "}', '{"op": "edit", "entry": "two", "text": "x"}', '{"op": "remove", "entry": 0}', '{"op": "add", "text": "x", "team": "true"}']) {
    const parsed = parseReview(`{"changes": [${bad}, {"op": "add", "text": "y"}]}`)
    assert.deepEqual(parsed.changes, [{ op: 'add', text: 'y' }], bad)
    assert.deepEqual(parsed.leftOut, [JSON.parse(bad)], bad)
  }
  assert.deepEqual(parseReview('{"changes": [{"op": "remove", "entry": "2"}]}'), { changes: [{ op: 'remove', entry: '2' }], leftOut: [] })
})

test('the panel shows a summary as headings over paragraphs', () => {
  assert.deepEqual(summaryBlocks('## Overview\nYou like **tea**.\nYou live in Hangzhou.\n\n## Team\n- Ship on Friday\n'), [
    { kind: 'h', text: 'Overview' },
    { kind: 'p', text: 'You like tea. You live in Hangzhou.' },
    { kind: 'h', text: 'Team' },
    { kind: 'p', text: 'Ship on Friday' },
  ])
  assert.deepEqual(summaryBlocks(''), [])
})

// ---------------------------------------------------------------------------

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
    b4: { id: 'b4', sessionId: 'b4', name: 'Temp', role: '临时', instructions: '', createdAt: 4 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 3,
      log: [
        { who: 'User', text: 'Keep everything you send me under one page', seq: 1 },
        { who: 'Coder', botId: 'b3', kind: 'lookup', text: 'page', seq: 2 },
        { who: 'Coder', botId: 'b3', text: 'Will do.', seq: 3 },
      ],
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

// The model answers each call with the next of `replies`. `history` holds the events
// of a Session, oldest first; each own chat has one user message, at seq 10, unless
// it says otherwise. `requireSession` turns down a request without a Session, as
// some routes do.
let rt
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-')), replies = [], config = {}, history = {}, reasoning = { efforts: [{ id: 'off' }, { id: 'high' }] }, models = ['v4'], defaultModel, requireSession = false } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const services = defaultModel === undefined ? {} : { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: defaultModel }) } }
  const ctx = fakeContext({ services })
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async () => ({ reasoning }),
      async* stream(request) {
        requests.push(request)
        if (requireSession && request.sessionId === undefined) throw new Error('400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}')
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: { message: out.failure } } : {}) } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId] ?? ownChat).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? ownChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
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
  rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const section = sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId } })
  const read = (...path) => readFileSync(join(home, 'memory', ...path), 'utf8')
  const journal = () => read('journal.jsonl').trim().split('\n').map(line => JSON.parse(line))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, call, tool, section, read, journal, requests, warnings, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// The group memory message the memory's pre-step puts before a Session's step, given
// what its history holds.
const textOf = message => (message?.content ?? []).map(block => block.text).join('')
async function groupMemoryOf(ctx, sessionId, history = []) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /isGroupMemory|memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => history } }
  const decision = await step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages.find(message => message.source?.kind === 'ds-bot-group-memory')
}

// The summary is written to disk after the model answers; a fixed wait is too short on
// a slow disk and leaves the write running into the next step or the cleanup.
async function summarized(call, botId = 'b2') {
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await call('memory-view', { botId })).value.summarizing === false) return
    await settle()
  }
  throw new Error('the memory summary did not finish')
}

async function until(check) {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await settle()
  assert.ok(check(), 'the condition did not hold within 4 s')
}

test('remember saves one entry with its source, and forget removes it, both in the journal', async (t) => {
  const { tool, read, journal, stop } = start()
  t.after(() => stop())
  assert.match(await tool('remember', { text: '- User prefers short replies' }, 'b2'), /^Saved to your memory, in MEMORY\.md \(MEMORY\.md: \d+ of 8000 characters\)\. Your other conversations see it at their next step; recall finds it now\.$/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /^# Memory\n\n- User prefers short replies \[id: [0-9a-f]{4}; source: part 1 #10; added: \d{4}-\d{2}-\d{2}\]\n\n## Index\n$/)
  assert.match(await tool('remember', { text: 'user prefers  SHORT replies' }, 'b2'), /^Already in your memory \(MEMORY\.md\): "User prefers short replies"\. Nothing changed\.$/)

  assert.match(await tool('remember', { text: 'User prefers detailed replies', replace: 'short replies' }, 'b2'), /"User prefers short replies" is now "User prefers detailed replies"/)
  assert.match(await tool('forget', { entry: 'detailed' }, 'b2'), /^Removed from your memory \(MEMORY\.md\): "User prefers detailed replies", all of it, so save again with remember any part that is still true\. The change log keeps a copy\.$/)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 0)
  assert.deepEqual(journal().map(record => [record.op, record.scope, record.file, record.actorName]), [
    ['add', 'bot:b2', 'MEMORY.md', 'Writer'],
    ['replace', 'bot:b2', 'MEMORY.md', 'Writer'],
    ['remove', 'bot:b2', 'MEMORY.md', 'Writer'],
  ])
  const [, replaced, removed] = journal()
  assert.match(replaced.before, /^- User prefers short replies \[/)
  assert.match(replaced.after, /^- User prefers detailed replies \[/)
  assert.match(removed.before, /^- User prefers detailed replies \[/)
  await assert.rejects(tool('forget', { entry: 'nothing like it' }, 'b2'), /No entry in your memory matches "nothing like it"\. recall shows what is saved\.$/)
})

test('topics hold details, linked from MEMORY.md, and go when their last entry does', async (t) => {
  const { tool, read, stop, home } = start()
  t.after(() => stop())
  assert.match(await tool('remember', { text: 'Flies from Hangzhou', topic: 'Travel' }, 'b2'), /in the new topic \[\[travel\]\], linked from MEMORY\.md/)
  assert.match(await tool('remember', { text: 'Prefers window seats', topic: 'travel' }, 'b2'), /in topic \[\[travel\]\] \(travel\.md: \d+ of 16000 characters\)/)
  assert.match(read('bots', 'b2', 'travel.md'), /^# travel\n\n- Flies from Hangzhou \[.*\]\n- Prefers window seats \[.*\]\n$/)
  assert.equal(read('bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n- [[travel]]\n')
  await assert.rejects(tool('remember', { text: 'x', topic: '../up' }, 'b2'), /cannot be a topic name/)

  assert.match(await tool('recall', { topic: 'travel' }, 'b2'), /^Topic \[\[travel\]\] in your memory \(travel\.md: \d+ of 16000 characters\):\n# travel\n\n- Flies from Hangzhou/)
  assert.match(await tool('recall', { query: 'window' }, 'b2'), /^Entries with "window" in your memory and the team memory:\n\[yours · \[\[travel\]\]\] Prefers window seats \[id: [0-9a-f]{4}; source: part 1 #10; added: /)
  assert.match(await tool('recall', {}, 'b2'), /^Your memory: MEMORY\.md has 0 entries \(MEMORY\.md: \d+ of 8000 characters\); topics \[\[travel\]\] \(2\)\.\n\nThe team memory: MEMORY\.md has 0 entries/)

  await tool('forget', { entry: 'Flies' }, 'b2')
  assert.match(await tool('forget', { entry: 'window', topic: 'travel' }, 'b2'), /The topic \[\[travel\]\] was empty, so it is gone too\./)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'travel.md')), false)
  assert.equal(read('bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n')
})

test('a journal line restores its change: remove, replace, and add undone', async (t) => {
  const { tool, call, read, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'User prefers short replies' }, 'b2')
  const added = journal().at(-1)
  assert.equal(added.op, 'add')

  // Undoing a remove puts the line back.
  await tool('forget', { entry: 'short replies' }, 'b2')
  const removed = journal().at(-1)
  assert.equal(removed.op, 'remove')
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 0)
  const restored = await call('memory-restore', { botId: 'b2', id: removed.id })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- User prefers short replies \[/)
  assert.equal(journal().at(-1).op, 'add')
  assert.equal(journal().at(-1).restored, removed.id)

  // A remove already undone is not undone twice: the line is back, so NO_MATCH.
  const twice = await call('memory-restore', { botId: 'b2', id: removed.id })
  assert.equal(twice.ok, false)
  assert.match(twice.error.message, /already restored/)

  // Undoing an add takes the line back out, while it still reads as written.
  const undone = await call('memory-restore', { botId: 'b2', id: added.id })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(journal().at(-1).op, 'remove')
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 0)

  // A replace puts the before-line back.
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  await tool('remember', { text: 'Lives in Shanghai', replace: 'Hangzhou' }, 'b2')
  const replaced = journal().at(-1)
  const back = await call('memory-restore', { botId: 'b2', id: replaced.id })
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.equal(journal().at(-1).op, 'replace')
  assert.equal(journal().at(-1).restored, replaced.id)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Lives in Hangzhou \[/)
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /Shanghai/)
})

test('a restore refuses drift and rows that are not restorable', async (t) => {
  const { tool, call, read, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'User prefers short replies' }, 'b2')
  const added = journal().at(-1)
  // The entry the add wrote was replaced since: undoing it now is a NO_MATCH,
  // not a delete of the newer text.
  await tool('remember', { text: 'User prefers very short replies', replace: 'short replies' }, 'b2')
  const drift = await call('memory-restore', { botId: 'b2', id: added.id })
  assert.equal(drift.ok, false)
  assert.match(drift.error.message, /no longer in|not where the change log left it/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /very short replies/)

  for (const body of [{ botId: 'b2', id: '' }, { botId: 'b2' }]) {
    const bad = await call('memory-restore', body)
    assert.equal(bad.ok, false, JSON.stringify(body))
    assert.match(bad.error.message, /change log id/)
  }
  const missing = await call('memory-restore', { botId: 'b2', id: 'row-that-is-not-there' })
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /not in the change log of this memory/)
})

test('restoring a remove that took a topic with it makes the topic again', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Flies from Hangzhou', topic: 'Travel' }, 'b2')
  await tool('forget', { entry: 'Flies', topic: 'travel' }, 'b2')
  const removed = journal().at(-1)
  assert.equal(removed.removedTopic, true)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'travel.md')), false)

  const restored = await call('memory-restore', { botId: 'b2', id: removed.id })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(read('bots', 'b2', 'travel.md'), /^# travel\n\n- Flies from Hangzhou \[/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- \[\[travel\]\]/)
})

test('a restore does not put back a value that is a saved secret now', async (t) => {
  const { tool, call, read, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'The clubhouse code word is bricksparrow72' }, 'b2')
  await tool('remember', { text: 'Picks bricksparrow72 for the draw' }, 'b2')
  await tool('remember', { text: 'Picks plain tickets for the draw', replace: 'for the draw' }, 'b2')
  await tool('forget', { entry: 'code word' }, 'b2')
  const [replaced, removed] = journal().slice(-2)
  const lines = journal().length
  assert.match(read('bots', 'b2', 'MEMORY.md'), /plain tickets/)

  // The value is a saved secret since the change log kept it: putting the line
  // back would write it in the clear, to the file and to the restore's own row.
  const saved = await call('secret-set', { name: 'CLUB_CODE', value: 'bricksparrow72' })
  assert.equal(saved.ok, true, JSON.stringify(saved))

  const back = await call('memory-restore', { botId: 'b2', id: removed.id })
  assert.equal(back.ok, false)
  assert.match(back.error.message, /cannot be put back/)
  assert.match(back.error.message, /never keeps/)
  assert.doesNotMatch(back.error.message, /bricksparrow72/)
  const backReplace = await call('memory-restore', { botId: 'b2', id: replaced.id })
  assert.equal(backReplace.ok, false)
  assert.match(backReplace.error.message, /cannot be put back/)
  assert.doesNotMatch(backReplace.error.message, /bricksparrow72/)

  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /bricksparrow72/)
  assert.equal(journal().length, lines)
})

test('the row a restore wrote passes the same guards when it is restored', async (t) => {
  const { tool, call, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Wears a green coat' }, 'b2')
  // Undoing the add leaves a remove row of its own.
  const undone = await call('memory-restore', { botId: 'b2', id: journal().at(-1).id })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(journal().at(-1).op, 'remove')
  const line = journal().length
  const rid = journal().at(-1).id

  // The fact is back under another topic: the restore row is not duplicated back.
  await tool('remember', { text: 'wears  a green   coat', topic: 'Style' }, 'b2')
  const again = await call('memory-restore', { botId: 'b2', id: rid })
  assert.equal(again.ok, false)
  assert.match(again.error.message, /already in/)

  // And once the value is a saved secret, the same row cannot put it back either.
  const saved = await call('secret-set', { name: 'COAT_COLOR', value: 'green coat' })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const refused = await call('memory-restore', { botId: 'b2', id: rid })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /cannot be put back/)
  assert.doesNotMatch(refused.error.message, /green coat/)
  assert.equal(journal().length, line + 1)
})

test('a restore does not duplicate a fact remembered again', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Lives in Hangzhou', topic: 'Home' }, 'b2')
  await tool('forget', { entry: 'Hangzhou' }, 'b2')
  const removed = journal().at(-1).id
  // The same fact is back, in MEMORY.md this time and under new metadata.
  await tool('remember', { text: 'lives   in  hangzhou' }, 'b2')
  const restored = await call('memory-restore', { botId: 'b2', id: removed })
  assert.equal(restored.ok, false)
  assert.match(restored.error.message, /already in/)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 1)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'home.md')), false)
})

test('a restore rebuilds a topic even when the memory holds its most topics', async (t) => {
  const { tool, call, read, journal, stop } = start()
  t.after(() => stop())
  for (let i = 1; i <= 40; i += 1) await tool('remember', { text: `detail ${i}`, topic: `topic-${i}` }, 'b2')
  // topic-40 goes when its last entry does; a fresh topic takes the room meanwhile.
  await tool('forget', { entry: 'detail 40', topic: 'topic-40' }, 'b2')
  const removed = journal().at(-1).id
  await tool('remember', { text: 'a fresh fact', topic: 'fresh' }, 'b2')
  const restored = await call('memory-restore', { botId: 'b2', id: removed })
  assert.equal(restored.ok, true)
  assert.match(read('bots', 'b2', 'topic-40.md'), /- detail 40/)
})

test('a restore of a replace does not duplicate a fact remembered again', async (t) => {
  const { tool, call, read, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  await tool('remember', { text: 'Lives in Shanghai', replace: 'Hangzhou' }, 'b2')
  const replaced = journal().at(-1)
  // The old fact is remembered again since, under a topic and new metadata.
  await tool('remember', { text: 'lives  in  hangzhou', topic: 'Home' }, 'b2')
  const restored = await call('memory-restore', { botId: 'b2', id: replaced.id })
  assert.equal(restored.ok, false)
  assert.match(restored.error.message, /already in/)
  // The entry it replaced stays put, and the remembered copy is not doubled.
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Lives in Shanghai \[/)
  assert.equal(parseMemory(read('bots', 'b2', 'home.md')).entries.length, 1)
})

test('a restore of a replace whose after reads like its before is no duplicate', async (t) => {
  const { tool, call, read, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Drinks tea daily' }, 'b2')
  await tool('remember', { text: 'drinks tea daily', replace: 'tea' }, 'b2')
  // The after-line squashes to the before text: the matched entry itself is no
  // duplicate, so the restore still puts the recorded before-line back.
  const restored = await call('memory-restore', { botId: 'b2', id: journal().at(-1).id })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Drinks tea daily \[/)
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /- drinks tea daily/)
})

test('a restore refuses a change-log row whose file is not a flat name', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Team drinks tea', scope: 'team', always: true }, 'm1')
  await tool('remember', { text: 'Likes quiet mornings' }, 'b2')
  const journalPath = join(home, 'memory', 'journal.jsonl')
  // A forged row in the shared log can name any path; it is read, not trusted.
  const forge = (file) => {
    const row = { id: `forged-${file}`, time: new Date().toISOString(), op: 'remove', scope: 'bot:b2', file, actor: 'user', actorName: 'user', removedTopic: true, before: '- forged entry' }
    writeFileSync(journalPath, `${read('journal.jsonl')}${JSON.stringify(row)}\n`)
    return row.id
  }
  for (const file of ['../../team/MEMORY.md', '..\\..\\team\\MEMORY.md', 'topics/deep.md', '..', '.', 'C:\\out\\x.md']) {
    const rid = forge(file)
    const count = journal().length
    const denied = await call('memory-restore', { botId: 'b2', id: rid })
    assert.equal(denied.ok, false, file)
    assert.match(denied.error.message, /not a change that can be restored/, file)
    // The file the row pointed at is untouched, and no restore row was logged.
    assert.match(read('team', 'MEMORY.md'), /- Team drinks tea \[/)
    assert.doesNotMatch(read('team', 'MEMORY.md'), /forged/)
    assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /forged|\.\./)
    assert.equal(journal().length, count)
  }
})

test('a restore finds a change by row id, blank and foreign lines aside', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Fact A' }, 'b2')
  const addedA = journal().at(-1)
  await tool('remember', { text: 'Fact B' }, 'b2')
  await tool('forget', { entry: 'Fact A' }, 'b2')
  const removed = journal().at(-1)
  const journalPath = join(home, 'memory', 'journal.jsonl')

  // Blank and half-written lines sit in the log: the row's own id still finds it.
  writeFileSync(journalPath, `\nnot json\n${read('journal.jsonl')}`)
  const restored = await call('memory-restore', { botId: 'b2', id: removed.id })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Fact A \[/)

  // The add of A goes by its id too: restoring it takes A out again.
  const undone = await call('memory-restore', { botId: 'b2', id: addedA.id })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /Fact A/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Fact B \[/)
})

test('memory-history lists a Bot\'s own and team changes, newest first', async (t) => {
  const { tool, call, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Team drinks tea', scope: 'team', always: true }, 'm1')
  await tool('remember', { text: 'Likes quiet mornings' }, 'b2')
  await tool('remember', { text: 'Another Bot fact' }, 'b4')
  const page = await call('memory-history', { botId: 'b2' })
  assert.equal(page.ok, true, JSON.stringify(page))
  assert.equal(page.value.more, null)
  assert.deepEqual(page.value.rows.map(row => [row.op, row.scope, row.by]), [
    ['add', 'own', 'Writer'],
    ['add', 'team', 'Chief'],
  ])
  assert.match(page.value.rows[0].text, /Likes quiet mornings/)
  assert.equal(page.value.rows.every(row => row.restored === false), true)
  assert.equal(journal().length, 3)
})

test('memory-history reads a private Bot\'s own log beside the shared one', async (t) => {
  const { tool, call, stop, home } = start()
  t.after(() => stop())
  const team = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  team.bots.b2.private = true
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  await tool('remember', { text: 'A private fact' }, 'b2')
  await tool('remember', { text: 'Team drinks tea', scope: 'team', always: true }, 'm1')
  const page = await call('memory-history', { botId: 'b2' })
  assert.equal(page.ok, true, JSON.stringify(page))
  // Own rows come out of the private log, team rows out of the shared one.
  assert.equal(page.value.rows.find(row => row.scope === 'own')?.text.slice(0, 14), 'A private fact')
  assert.equal(page.value.rows.find(row => row.scope === 'team')?.text.slice(0, 14), 'Team drinks te')
  assert.equal(page.value.rows.length, 2)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'journal.jsonl')), true)
})

test('memory-history lists a group\'s changes and marks rows already undone', async (t) => {
  const { tool, call, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Keep replies under one page' }, 'g3')
  await tool('forget', { entry: 'one page' }, 'g3')
  const removed = journal().at(-1)
  const restored = await call('memory-restore', { roomId: 'r1', id: removed.id })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  const page = await call('memory-history', { roomId: 'r1' })
  assert.equal(page.ok, true, JSON.stringify(page))
  assert.deepEqual(page.value.rows.map(row => [row.op, row.scope, row.restored]), [
    ['add', 'group', false],
    ['remove', 'group', true],
    ['add', 'group', false],
  ])
  assert.equal(page.value.rows.at(-1).restored, false)
  // A row that is itself a restore is listed like any other, and can be undone.
  assert.equal(page.value.rows[0].id, journal().at(-1).id)
  const undone = await call('memory-restore', { roomId: 'r1', id: journal().at(-1).id })
  assert.equal(undone.ok, true, JSON.stringify(undone))
})

test('a restore refuses a row outside the owner\'s scopes', async (t) => {
  const { tool, call, journal, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'A Bot fact' }, 'b4')
  const row = journal().at(-1)
  const denied = await call('memory-restore', { botId: 'b2', id: row.id })
  assert.equal(denied.ok, false)
  assert.match(denied.error.message, /not in the change log of this memory/)
})

test('memory-history pages oldest rows behind before', async (t) => {
  const { tool, call, journal, stop, home } = start()
  t.after(() => stop())
  const journalPath = join(home, 'memory', 'journal.jsonl')
  await tool('remember', { text: 'First fact' }, 'b2')
  const base = journal()
  const forged = Array.from({ length: 60 }, (_, i) => ({ id: `old-${i}`, time: new Date(Date.now() - (60 - i) * 1000).toISOString(), op: 'add', scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', after: `- forged ${i}` }))
  writeFileSync(journalPath, `${journal().map(row => JSON.stringify(row)).join('\n')}\n${forged.map(row => JSON.stringify(row)).join('\n')}\n`)
  const first = await call('memory-history', { botId: 'b2' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.rows.length, 50)
  assert.notEqual(first.value.more, null)
  const second = await call('memory-history', { botId: 'b2', before: first.value.more })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.value.rows.length, 11)
  assert.equal(second.value.more, null)
  assert.equal(second.value.rows.at(-1).id, 'old-0')
  assert.equal(first.value.rows[0].id, base[0].id)
})

test('a restore refuses a row whose before is not one entry line', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Real fact' }, 'b2')
  const journalPath = join(home, 'memory', 'journal.jsonl')
  const forge = (row) => {
    writeFileSync(journalPath, `${read('journal.jsonl')}${JSON.stringify(row)}\n`)
    return JSON.parse(read('journal.jsonl').trim().split('\n').at(-1)).id
  }
  // A heading or several lines put back would corrupt the file or hide what
  // follows from recall; a real remove row always held one bullet.
  for (const before of ['## Index', '- one\n- two', 'plain text', '* ', '']) {
    const removeId = forge({ id: `rm-${JSON.stringify(before)}`, time: new Date().toISOString(), op: 'remove', scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', before })
    const denied = await call('memory-restore', { botId: 'b2', id: removeId })
    assert.equal(denied.ok, false, JSON.stringify(before))
    assert.match(denied.error.message, /not a change that can be restored/, JSON.stringify(before))
    const replaceId = forge({ id: `rp-${JSON.stringify(before)}`, time: new Date().toISOString(), op: 'replace', scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', before, after: journal()[0].after })
    const deniedReplace = await call('memory-restore', { botId: 'b2', id: replaceId })
    assert.equal(deniedReplace.ok, false, JSON.stringify(before))
    assert.match(deniedReplace.error.message, /not a change that can be restored/, JSON.stringify(before))
  }
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Real fact \[/)
})

test('a restore follows a hand-named topic file', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  // A file renamed or created by hand still lists as a topic; a replace that
  // finds its entry journals the name as it is, not a cleanTopic form.
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'Travel.md'), '# Travel\n\n- Prefers aisle seats [added: 2026-01-01]\n')
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n- [[Travel]]\n')
  assert.match(await tool('remember', { text: 'Prefers window seats', replace: 'aisle' }, 'b2'), /is now "Prefers window seats"/)
  assert.equal(journal().at(-1).file, 'Travel.md')
  const restored = await call('memory-restore', { botId: 'b2', id: journal().at(-1).id })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(read('bots', 'b2', 'Travel.md'), /- Prefers aisle seats \[added: 2026-01-01\]/)
})

test('a restore checks the whole line for a saved secret, its metadata too', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  const secret = 'harbor dock meeting 9f3k'
  const saved = await call('secret-set', { name: 'DOCK_WORD', value: secret })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const journalPath = join(home, 'memory', 'journal.jsonl')
  // The value sits in the line's metadata, not its text: the text-only check a
  // new entry gets never sees it, but putting the line back would write it.
  const forge = (row) => {
    writeFileSync(journalPath, `${read('journal.jsonl')}${JSON.stringify(row)}\n`)
    return JSON.parse(read('journal.jsonl').trim().split('\n').at(-1)).id
  }
  for (const op of ['remove', 'replace']) {
    const before = `- Prefers window seats [note: ${secret}]`
    const row = { id: `sec-${op}`, time: new Date().toISOString(), op, scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', before }
    if (op === 'replace') row.after = journal()[1].after
    const denied = await call('memory-restore', { botId: 'b2', id: forge(row) })
    assert.equal(denied.ok, false, op)
    assert.match(denied.error.message, /cannot be put back/, op)
    assert.doesNotMatch(denied.error.message, new RegExp(secret))
  }
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /harbor dock meeting|window seats/)
  assert.doesNotMatch(read('journal.jsonl'), /harbor dock meeting 9f3k.*"op":"add"/s)
})

test('a restore refuses a file name with a control character instead of wedging', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  const journalPath = join(home, 'memory', 'journal.jsonl')
  // The name passes a separators-only check, but a write of the file it names
  // fails after the pending record is accepted, so every later memory change
  // stops on it. The row is refused before any of that is reached.
  const row = { id: 'bad-ctl', time: new Date().toISOString(), op: 'remove', scope: 'bot:b2', file: 'bad\0.md', actor: 'user', actorName: 'user', removedTopic: true, before: '- forged entry' }
  writeFileSync(journalPath, `${read('journal.jsonl')}${JSON.stringify(row)}\n`)
  const denied = await call('memory-restore', { botId: 'b2', id: 'bad-ctl' })
  assert.equal(denied.ok, false)
  assert.match(denied.error.message, /not a change that can be restored/)
  assert.equal(existsSync(join(home, 'memory', 'pending.json')), false)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Likes tea \[/)
  assert.equal(journal().length, 2)
  // The memory still works: nothing half-written is waiting to be finished.
  assert.equal((await call('memory-view', { botId: 'b2' })).ok, true)
  assert.match(await tool('remember', { text: 'Also likes coffee' }, 'b2'), /Saved to your memory/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Also likes coffee \[/)
})

test('a restore dedupes a row whose before line is an indented bullet', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Drinks tea daily' }, 'b2')
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  const journalPath = join(home, 'memory', 'journal.jsonl')
  // Rows are written by publish with one bullet, but a hand-edited or foreign
  // row may indent it; the text check and the duplicate check must read it as
  // the same entry either way.
  const forge = (row) => {
    writeFileSync(journalPath, `${read('journal.jsonl')}${JSON.stringify(row)}\n`)
    return JSON.parse(read('journal.jsonl').trim().split('\n').at(-1)).id
  }
  const removeId = forge({ id: 'ind-rm', time: new Date().toISOString(), op: 'remove', scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', before: '  - Drinks tea daily [added: 2026-01-01]' })
  const denied = await call('memory-restore', { botId: 'b2', id: removeId })
  assert.equal(denied.ok, false)
  assert.match(denied.error.message, /already in/)
  const replaceId = forge({ id: 'ind-rp', time: new Date().toISOString(), op: 'replace', scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', before: '  - Drinks tea daily', after: journal()[1].after })
  const deniedReplace = await call('memory-restore', { botId: 'b2', id: replaceId })
  assert.equal(deniedReplace.ok, false)
  assert.match(deniedReplace.error.message, /already in/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Lives in Hangzhou \[/)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 2)
  // An indented before that is no duplicate still restores, and reports the
  // entry's text, not the line's raw shape.
  const clean = forge({ id: 'ind-ok', time: new Date().toISOString(), op: 'remove', scope: 'bot:b2', file: 'MEMORY.md', actor: 'user', actorName: 'user', before: '  - Prefers aisle seats' })
  const restored = await call('memory-restore', { botId: 'b2', id: clean })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(journal().at(-1).after, /Prefers aisle seats/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /^ {2}- Prefers aisle seats$/m)
})

test('a restore puts a removed topic back into its case-folded file, never over it', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  // A topic file made by hand is removed whole with its last entry.
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'Travel.md'), '# Travel\n\n- Prefers aisle seats [added: 2026-01-01]\n')
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n- [[Travel]]\n')
  await tool('forget', { entry: 'aisle seats' }, 'b2')
  const removed = journal().at(-1).id
  const dir = join(home, 'memory', 'bots', 'b2')
  // Remembering under the same words makes travel.md; on a file system that
  // folds case it is the file Travel.md named. A fresh Travel.md written over
  // it would lose the new fact.
  await tool('remember', { text: 'Flies on Fridays', topic: 'Travel' }, 'b2')
  const folded = existsSync(join(dir, 'TRAVEL.MD'))
  const restored = await call('memory-restore', { botId: 'b2', id: removed })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  if (folded) {
    assert.match(read('bots', 'b2', 'travel.md'), /- Flies on Fridays \[/)
    assert.match(read('bots', 'b2', 'travel.md'), /- Prefers aisle seats \[added: 2026-01-01\]/)
    assert.equal(journal().at(-1).file, 'travel.md')
    // Undoing the restore finds the line in the file that holds it.
    const undone = await call('memory-restore', { botId: 'b2', id: journal().at(-1).id })
    assert.equal(undone.ok, true, JSON.stringify(undone))
    assert.doesNotMatch(read('bots', 'b2', 'travel.md'), /Prefers aisle seats/)
  } else {
    // A case-sensitive file system keeps the two files apart: Travel.md is
    // rebuilt next to travel.md.
    assert.match(read('bots', 'b2', 'Travel.md'), /- Prefers aisle seats \[added: 2026-01-01\]/)
    assert.match(read('bots', 'b2', 'travel.md'), /- Flies on Fridays \[/)
  }
})

test('a restore refuses a removed topic whose name is a saved secret now', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Meet at the dock', topic: 'harbor-dock-meeting-9f3k' }, 'b2')
  await tool('forget', { entry: 'dock', topic: 'harbor-dock-meeting-9f3k' }, 'b2')
  const rid = journal().at(-1).id
  const lines = journal().length
  const dir = join(home, 'memory', 'bots', 'b2')
  assert.equal(existsSync(join(dir, 'harbor-dock-meeting-9f3k.md')), false)
  // The name became a saved secret since the row was written: rebuilding the
  // topic would write it into a heading and the Index link, in the clear.
  const saved = await call('secret-set', { name: 'COVE_WORD', value: 'harbor-dock-meeting-9f3k' })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const denied = await call('memory-restore', { botId: 'b2', id: rid })
  assert.equal(denied.ok, false)
  assert.match(denied.error.message, /cannot be put back/)
  assert.doesNotMatch(denied.error.message, /harbor-dock-meeting-9f3k/)
  assert.equal(existsSync(join(dir, 'harbor-dock-meeting-9f3k.md')), false)
  assert.equal(existsSync(join(home, 'memory', 'pending.json')), false)
  assert.equal(journal().length, lines)
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /harbor-dock-meeting-9f3k/)
})

test('a restore rebuilds a removed topic whose file name is near the name limit', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  for (const stem of ['a'.repeat(250), 'a'.repeat(251)]) {
    // The topic's own name is legal; a temporary name made of the whole path
    // beside it would pass the system's per-name limit and the write would fail
    // after the pending record accepted the change, wedging every later one.
    writeFileSync(join(dir, `${stem}.md`), `# ${stem}\n\n- A fact kept for ${stem.length} characters [added: 2026-01-01]\n`)
    writeFileSync(join(dir, 'MEMORY.md'), `# Memory\n\n## Index\n- [[${stem}]]\n`)
    assert.match(await tool('forget', { entry: `${stem.length} characters` }, 'b2'), /was empty/)
    const restored = await call('memory-restore', { botId: 'b2', id: journal().at(-1).id })
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.match(read('bots', 'b2', `${stem}.md`), /- A fact kept for /)
    assert.equal(existsSync(join(home, 'memory', 'pending.json')), false)
    // Nothing half-written: the memory still reads and writes.
    assert.equal((await call('memory-view', { botId: 'b2' })).ok, true)
    assert.match(await tool('remember', { text: 'Still works' }, 'b2'), /Saved to your memory/)
  }
})

test('a restore does not journal a line that is a saved secret now', async (t) => {
  const { tool, call, read, journal, stop, home } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  const addId = journal().at(-1).id
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await tool('remember', { text: 'Likes green tea', replace: 'tea' }, 'b2')
  const replaceId = journal().at(-1).id
  const rows = journal().length
  // Each restore copies the line its row wrote into a row of its own: a value
  // that became a saved secret since must not come back to the change log.
  const kept = await call('secret-set', { name: 'HOME_CITY', value: 'Lives in Hangzhou' })
  assert.equal(kept.ok, true, JSON.stringify(kept))
  const keptTea = await call('secret-set', { name: 'TEA_CHOICE', value: 'Likes green tea' })
  assert.equal(keptTea.ok, true, JSON.stringify(keptTea))

  const undoAdd = await call('memory-restore', { botId: 'b2', id: addId })
  assert.equal(undoAdd.ok, false)
  assert.match(undoAdd.error.message, /cannot be taken out/)
  assert.doesNotMatch(undoAdd.error.message, /Lives in Hangzhou/)
  const undoReplace = await call('memory-restore', { botId: 'b2', id: replaceId })
  assert.equal(undoReplace.ok, false)
  assert.match(undoReplace.error.message, /cannot be taken out/)
  assert.doesNotMatch(undoReplace.error.message, /Likes green tea/)

  assert.equal(journal().length, rows)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Lives in Hangzhou \[/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Likes green tea \[/)
  assert.equal(existsSync(join(home, 'memory', 'pending.json')), false)
})

test('recall finds a continuous Chinese phrase, and keeps space-separated and Latin matching', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: '女友小李的生日是 10 月 22 日' }, 'b2')
  await tool('remember', { text: 'The user likes green tea' }, 'b2')
  // The phrase is not a substring of the entry: its character pairs find it.
  assert.match(await tool('recall', { query: '小李生日' }, 'b2'), /女友小李的生日是 10 月 22 日/)
  // An entry holding the whole phrase still matches every term.
  await tool('remember', { text: '小李生日会定在周六' }, 'b2')
  assert.match(await tool('recall', { query: '小李生日' }, 'b2'), /^Entries with "小李生日" in your memory and the team memory:\n\[yours · MEMORY\.md\] 小李生日会定在周六/)
  // Space-separated terms and Latin words match as they did.
  assert.match(await tool('recall', { query: '小李 生日' }, 'b2'), /女友小李的生日/)
  assert.match(await tool('recall', { query: 'green tea' }, 'b2'), /likes green tea/)
  assert.match(await tool('recall', { query: 'green 生日' }, 'b2'), /No entry has all of "green 生日"/)
})

test('recall caps the user\'s words, not their pairs, and a whole phrase outranks pair matches', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: '周末上海出差安排住外滩的酒店' }, 'b2')
  // The word after the phrase still counts: with 生日 missing, the hotel entry
  // is not a full match, only the closest.
  const trip = await tool('recall', { query: '周末上海出差安排 生日' }, 'b2')
  assert.match(trip, /No entry has all of "周末上海出差安排 生日"/)
  assert.match(trip, /周末上海出差安排住外滩的酒店/)
  // Of many entries that share the pairs and the one that holds the phrase
  // whole, only that one is a full match.
  for (let at = 1; at <= 30; at += 1) await tool('remember', { text: `周末上海出差安全事项第${at}条` }, 'b2')
  await tool('remember', { text: '周末上海出差安排在周五确认' }, 'b2')
  const hits = await tool('recall', { query: '周末上海出差安排' }, 'b2')
  assert.match(hits, /^Entries with "周末上海出差安排"/)
  assert.match(hits, /周末上海出差安排在周五确认/)
  assert.doesNotMatch(hits, /安全事项/)
})

test('a repeated word in a recall query is counted once, so a later word still reaches the cut', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: '周末上海出差安排住外滩的酒店' }, 'b2')
  await tool('remember', { text: '女友小李的生日是 10 月 22 日' }, 'b2')
  // 上海 said six times is one word: 生日 still counts, so the entry that holds
  // only 上海 is the closest, not a full match.
  const hits = await tool('recall', { query: '上海 上海 上海 上海 上海 上海 生日' }, 'b2')
  assert.match(hits, /No entry has all of "上海 上海 上海 上海 上海 上海 生日"/)
  assert.match(hits, /周末上海出差安排住外滩的酒店/)
  assert.match(hits, /女友小李的生日是 10 月 22 日/)
})

test('a mixed word keeps its Latin part in recall', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: '中文资料保存在文档中' }, 'b2')
  await tool('remember', { text: 'AI中文教程在书架上' }, 'b2')
  // "AI中文" is more than 中文: only the entry that holds the phrase is a full match.
  assert.match(await tool('recall', { query: 'AI中文' }, 'b2'), /^Entries with "AI中文" in your memory and the team memory:\n\[yours · MEMORY\.md\] AI中文教程在书架上 \[id: [0-9a-f]{4}; source: /)
})

test('Main Bots and group admins write the team memory; only Main Bots touch another Bot\'s', async (t) => {
  const { tool, read, stop } = start()
  t.after(() => stop())
  await assert.rejects(tool('remember', { text: 'Ship on Friday', scope: 'team', always: true }, 'b2'), /Only Main Bots and group admins write the team memory/)
  // Coder is the admin of Launch, and speaks there from its group Session.
  assert.match(await tool('remember', { text: 'Ship on Friday', scope: 'team', always: true }, 'g3'), /^Saved to the team memory/)
  assert.match(read('team', 'MEMORY.md'), /- Ship on Friday \[id: [0-9a-f]{4}; source: group "Launch" #\d+; by: Coder; added: /)
  assert.match(await tool('remember', { text: 'Writes in Chinese', scope: 'Writer' }, 'm1'), /^Saved to Writer's memory/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Writes in Chinese \[id: [0-9a-f]{4}; source: part 1 #10; by: Chief; added: /)
  await assert.rejects(tool('remember', { text: 'Bossy', scope: 'Chief' }, 'b2'), /Only a Main Bot can change another Bot's memory/)
  assert.doesNotMatch(await tool('recall', { scope: 'Writer' }, 'b3'), /private/)
  assert.match(await tool('recall', { scope: 'Nobody' }, 'b3'), /^No Bot named Nobody/)
  assert.match(await tool('recall', { query: 'friday' }, 'b2'), /\[team · MEMORY\.md\] Ship on Friday/)
  await assert.rejects(tool('forget', { entry: 'Friday', scope: 'team' }, 'b2'), /Only Main Bots and group admins/)
  assert.match(await tool('forget', { entry: 'Friday', scope: 'team' }, 'm1'), /^Removed from the team memory/)
  await assert.rejects(tool('remember', { text: 'x' }, 'stranger'), /Only Bots on the team keep a memory\./)
})

test('keys and long entries are refused with what to do instead, and a full file makes room', async (t) => {
  const { tool, read, stop, home } = start()
  t.after(() => stop())
  await assert.rejects(tool('remember', { text: 'API key sk-' + 'abcdefghijklmnopqrstuvwx' }, 'b2'), /looks like a key.*request_secret/)
  await assert.rejects(tool('remember', { text: 'x'.repeat(MEMORY_LIMITS.entry + 1) }, 'b2'), /at most 300 characters; this one has 301/)
  await assert.rejects(tool('remember', { text: '  ' }, 'b2'), /Write the entry to save\.$/)

  // A MEMORY.md written past its size by hand still takes a shorter replacement.
  const big = Array.from({ length: 40 }, (_, index) => `- Fact ${index} ${'y'.repeat(250)}`)
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), `# Memory\n\n${big.join('\n')}\n`)
  assert.match(await tool('remember', { text: 'Fact 3 is short now', replace: 'Fact 3 y' }, 'b2'), /is now "Fact 3 is short now"/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Fact 3 is short now \[/)
  await assert.rejects(tool('forget', { entry: 'Fact 1' }, 'b2'), /matches \d+ entries in your memory; quote more of the one you mean:\n- Fact 1 y+ \(MEMORY\.md\)\n- Fact 10/)
  // One more, on a MEMORY.md past its size: it is saved, and the oldest move out.
  assert.match(await tool('remember', { text: 'One more' }, 'b2'), /Saved to your memory.*its \d+ oldest entries moved to \[\[earlier\]\], where recall finds them\./)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- One more \[/)
  assert.match(read('bots', 'b2', 'earlier.md'), /- Fact \d+ /)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /\[\[earlier\]\]/)
  assert.match(await tool('recall', { topic: 'earlier' }, 'b2'), /- Fact \d+ /)
})

test('a write that changed nothing fails the call with a code, and a saved one keeps its answer', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  // What a saved write answers is what the model reads, word for word.
  assert.match(await tool('remember', { text: 'Likes tea' }, 'b2'), /^Saved to your memory, in MEMORY\.md \(MEMORY\.md: \d+ of 8000 characters\)\. Your other conversations see it at their next step; recall finds it now\.$/)
  // A refusal is a failure, with the kind of failure in its code.
  await assert.rejects(tool('remember', { text: 'Ship on Friday', scope: 'team', always: true }, 'b2'), (error) => {
    assert.equal(error.code, 'memory/refused')
    assert.match(error.message, /Only Main Bots and group admins write the team memory/)
    return true
  })
  // A write with nothing in it says what is missing.
  await assert.rejects(tool('remember', { text: '  ' }, 'b2'), (error) => {
    assert.equal(error.code, 'memory/empty')
    assert.match(error.message, /Write the entry to save\./)
    return true
  })
  // A failure from the write keeps the kind it came with.
  await assert.rejects(tool('forget', { entry: 'nothing like it' }, 'b2'), (error) => {
    assert.equal(error.code, 'memory/no-match')
    assert.match(error.message, /No entry in your memory matches "nothing like it"/)
    return true
  })
})

test('a Session keeps the memory it began with, across restarts, until its snapshot goes', async (t) => {
  const first = start()
  t.after(() => first.stop())
  await first.tool('remember', { text: 'Likes tea' }, 'b2')
  const opened = first.section('b2')
  assert.match(opened, /^# Your memory\n/)
  assert.match(opened, /## Your memory \(MEMORY\.md\)\n- Likes tea \[[0-9a-f]{4} · \d\d-\d\d\]\n\n## Team memory, shared by every Bot \(team\/MEMORY\.md\)\n\(nothing saved yet\)$/)
  assert.match(opened, /when the whole team should know something, tell a Main Bot with message_bot/)
  assert.match(first.section('m1'), /As a Main Bot you write it with remember scope "team"/)
  assert.match(first.section('g3'), /As a group admin you write it/)
  assert.equal(first.section('nobody'), '')

  await first.tool('remember', { text: 'Lives in Hangzhou', topic: 'home' }, 'b2')
  assert.equal(first.section('b2'), opened)
  // Another dsh run finds the snapshot and keeps the same bytes.
  await first.stop({ keep: true })
  const second = start({ home: first.home })
  await second.tool('recall', {}, 'b2')
  assert.equal(second.section('b2'), opened)
  // Without its snapshot (renewMemory removes it), the Session freezes the memory anew.
  await second.ctx.dispose()
  const renewed = start({ home: first.home })
  t.after(() => renewed.stop())
  rmSync(join(first.home, 'memory', 'snapshots', 'b2.md'))
  await renewed.tool('recall', {}, 'b2')
  assert.match(renewed.section('b2'), /- Likes tea \[.*\]\nTopic \[\[home\]\]\n/)
})

test('a memory file that cannot be read is left alone, and the section says so', async (t) => {
  const { home, tool, section, stop } = start()
  t.after(() => stop())
  // A directory reads as EISDIR on every platform; no chmod games needed.
  mkdirSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), { recursive: true })
  await assert.rejects(tool('remember', { text: 'Likes tea' }, 'b2'), /Memory file .*MEMORY\.md could not be read \(EISDIR\)\. DS Bot leaves it as it is/)
  assert.deepEqual(readdirSync(join(home, 'memory', 'bots', 'b2')), ['MEMORY.md'])
  // The prompt shows the failure instead of looking empty, and nothing is frozen.
  assert.match(section('b2'), /\(this memory could not be read: EISDIR\)/)
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'b2.md')), false)
  rmSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), { recursive: true })
  const after = section('b2')
  assert.doesNotMatch(after, /could not be read/)
  assert.match(after, /\(nothing saved yet\)/)
})

test('a change of role freezes the section again, so its team rule matches the tools', async (t) => {
  const { call, tool, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  const before = section('b2')
  assert.match(before, /tell a Main Bot with message_bot/)
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  assert.equal(section('b2'), before)

  assert.equal((await call('set-main', { id: 'b2', main: true })).ok, true)
  const promoted = section('b2')
  assert.match(promoted, /As a Main Bot you write it with remember scope "team"/)
  assert.doesNotMatch(promoted, /tell a Main Bot with message_bot/)
  // Frozen anew, so entries saved since come along; then it holds still again.
  assert.match(promoted, /- Lives in Hangzhou \[/)
  assert.equal(section('b2'), promoted)

  assert.equal((await call('set-main', { id: 'b2', main: false })).ok, true)
  assert.match(section('b2'), /tell a Main Bot with message_bot/)
  // Coder loses the admin seat of Launch, and with it the team rule in its group Session.
  assert.match(section('g3'), /As a group admin you write it/)
  assert.equal((await call('update-room', { id: 'r1', admin: 'b2' })).ok, true)
  assert.match(section('g3'), /tell a Main Bot with message_bot/)
  assert.match(section('b2'), /As a group admin you write it/)
})

test('deleting a Bot moves its memory to the archive', async (t) => {
  const { tool, call, home, journal, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Temporary fact' }, 'b4')
  section('b4')
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'b4.md')), true)
  assert.equal((await call('delete-bot', { id: 'b4' })).ok, true)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b4')), false)
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'b4.md')), false)
  const [archived] = readdirSync(join(home, 'memory', 'archive'))
  assert.match(archived, /^b4-\d{4}-/)
  assert.match(readFileSync(join(home, 'memory', 'archive', archived, 'MEMORY.md'), 'utf8'), /Temporary fact/)
  assert.deepEqual(journal().at(-1).op, 'archive')
})

test('the memory panel shows every entry and a summary the Bot\'s model writes once per change', async (t) => {
  const replies = ['## Overview\nYou like tea.']
  const { tool, call, requests, stop } = start({ replies })
  t.after(() => stop())
  assert.equal((await call('state', {})).value.memory, true)
  const empty = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([empty.entries, empty.summary, empty.fresh, empty.summarizing], [[], null, true, false])
  assert.deepEqual(empty.limits, { ...MEMORY_LIMITS, own: MEMORY_LIMITS.bot })
  assert.equal(requests.length, 0)

  await tool('remember', { text: 'Likes tea' }, 'b2')
  const asked = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual(asked.entries.map(entry => [entry.scope, entry.topic, entry.text]), [['own', null, 'Likes tea']])
  assert.equal(asked.summarizing, true)
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([done.summary.text, done.fresh, done.summarizing, done.error], ['## Overview\nYou like tea.', true, false, null])
  assert.equal(requests.length, 1)
  assert.deepEqual([requests[0].provider, requests[0].model, requests[0].reasoningEffort], ['deepseek', 'v4', 'off'])
  assert.match(requests[0].messages[0].content[0].text, /## Writer's memory\n- Likes tea\n\n## Team memory\n\(nothing\)/)

  // A new entry leaves the old summary up, marked stale, until the next one is in.
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  replies.push(new Error('provider down'))
  assert.equal((await call('memory-view', { botId: 'b2', summarize: true })).value.fresh, false)
  await summarized(call)
  const failed = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([failed.summary.text, failed.fresh, failed.error], ['## Overview\nYou like tea.', false, 'provider down'])
  assert.equal(requests.length, 2)
  replies.push('## Overview\nYou like tea and live in Hangzhou.')
  await call('memory-view', { botId: 'b2', regenerate: true })
  await summarized(call)
  assert.equal((await call('memory-view', { botId: 'b2' })).value.summary.text, '## Overview\nYou like tea and live in Hangzhou.')
  assert.equal((await call('memory-view', { botId: 'nope' })).error.message, 'Unknown Bot')
})

test('a summary cut off at the output limit is written once more with a bigger budget, never kept half', async (t) => {
  const replies = [
    { text: '## Overview\nYou like', finish: 'max-tokens' },
    '## Overview\nYou like tea.',
  ]
  const { tool, call, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.fresh, done.error], ['## Overview\nYou like tea.', true, null])
  assert.deepEqual(requests.map(request => request.maxTokens), [2048, 8192])
})

test('a summary cut off at both budgets keeps the old one and says the reasoning used the budget', async (t) => {
  const replies = [
    '## Overview\nYou like tea.',
    { text: '', finish: 'max-tokens' },
    { text: '## Overview\nhalf', finish: 'max-tokens' },
  ]
  const { tool, call, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  // A new entry asks for a fresh summary; both its tries are cut off.
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const failed = (await call('memory-view', { botId: 'b2' })).value
  assert.equal(failed.summary.text, '## Overview\nYou like tea.')
  assert.match(failed.error, /reasoning.*output budget|output budget.*reasoning/i)
  assert.deepEqual(requests.map(request => request.maxTokens), [2048, 2048, 8192])
})

test('the panel call asks for the model\'s lowest thinking level when it has no "off"', async (t) => {
  const first = start({ replies: ['## ok'], reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
  t.after(() => first.stop())
  await first.tool('remember', { text: 'Likes tea' }, 'b2')
  await first.call('memory-view', { botId: 'b2', summarize: true })
  await summarized(first.call)
  assert.equal(first.requests[0].reasoningEffort, 'low')

  const second = start({ replies: ['## ok'], reasoning: {} })
  t.after(() => second.stop())
  await second.tool('remember', { text: 'Likes tea' }, 'b2')
  await second.call('memory-view', { botId: 'b2', summarize: true })
  await summarized(second.call)
  assert.equal(second.requests[0].reasoningEffort, undefined)
})

const routes = requests => requests.map(request => `${request.provider}/${request.model}@${request.maxTokens}`)

test('a summary the Bot\'s model refuses is written by the profile default model', async (t) => {
  const replies = [{ text: '', finish: 'error', failure: '403 Forbidden' }, '## Overview\nYou like tea.']
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.fresh, done.error], ['## Overview\nYou like tea.', true, null])
  assert.deepEqual(routes(requests), ['deepseek/v4@2048', 'deepseek/flash@2048'])
  assert.ok(requests.every(request => request.messages[0].content[0].text.includes('Likes tea')))
})

test('a summary cut off at both budgets on the Bot\'s model is written by the default model', async (t) => {
  const replies = [{ text: '', finish: 'max-tokens' }, { text: '## half', finish: 'max-tokens' }, '## Overview\nYou like tea.']
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.error], ['## Overview\nYou like tea.', null])
  assert.deepEqual(routes(requests), ['deepseek/v4@2048', 'deepseek/v4@8192', 'deepseek/flash@2048'])
})

test('a summary that failed on both models is tried again once the Bot has another model', async (t) => {
  const replies = [new Error('401: Unauthorized'), { text: '', finish: 'error', failure: '503 Service Unavailable' }]
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const failed = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.equal(failed.error, 'deepseek/v4: 401: Unauthorized; deepseek/flash: 503 Service Unavailable')
  assert.equal(failed.summarizing, false)
  assert.equal(requests.length, 2)

  assert.equal((await call('update-bot', { id: 'b2', model: 'deepseek/flash' })).ok, true)
  replies.push('## Overview\nYou like tea.')
  const retried = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([retried.summarizing, retried.error], [true, null])
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.error], ['## Overview\nYou like tea.', null])
  assert.deepEqual(routes(requests).slice(2), ['deepseek/flash@2048'])
})

test('"ask or update" falls back to the default model when the Bot\'s model fails', async (t) => {
  const replies = [new Error('403 Forbidden'), JSON.stringify({ reply: 'You like tea.', changes: [] })]
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  const answer = (await call('memory-ask', { botId: 'b2', text: 'What do I like?' })).value
  assert.equal(answer.reply, 'You like tea.')
  assert.deepEqual(routes(requests), ['deepseek/v4@2048', 'deepseek/flash@2048'])
})

test('"ask or update" answers from the entries and changes them through the same rules', async (t) => {
  const replies = []
  const { tool, call, read, journal, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await tool('remember', { text: 'Ship on Friday', scope: 'team', always: true }, 'm1')
  replies.push(JSON.stringify({
    reply: 'Done.',
    changes: [
      { op: 'edit', entry: 1, text: 'Likes green tea' },
      { op: 'add', text: 'Lives in Hangzhou' },
      { op: 'add', text: 'Team meets on Monday', team: true },
      { op: 'remove', entry: 2 },
      { op: 'add', text: 'token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f' },
      { op: 'remove', entry: 9 },
    ],
  }))
  const answer = (await call('memory-ask', { botId: 'b2', text: 'I like green tea now; I live in Hangzhou; we meet Mondays; Friday is off' })).value
  assert.match(requests[0].messages[0].content[0].text, /^Entries of Writer \(yours: Writer's own; team: shared by every Bot\):\n\[1\] \(own\) Likes tea\n\[2\] \(team\) Ship on Friday\n/)
  assert.equal(answer.reply, 'Done.')
  assert.deepEqual(answer.changes.map(change => [change.op, change.scope, change.ok]), [
    ['edit', 'own', true], ['add', 'own', true], ['add', 'team', true], ['remove', 'team', true], ['add', 'own', false], ['remove', 'own', false],
  ])
  assert.match(answer.changes[4].error, /looks like a key/)
  assert.equal(answer.changes[5].error, 'There is no entry 9.')
  assert.deepEqual(answer.view.entries.map(entry => entry.text), ['Likes green tea', 'Lives in Hangzhou', 'Team meets on Monday'])
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Likes green tea \[id: [0-9a-f]{4}; source: memory panel; by: user; added: /)
  assert.ok(journal().slice(-4).every(record => record.actor === 'user'))

  const forgot = (await call('memory-forget', { botId: 'b2', scope: 'team', topic: null, text: 'Team meets on Monday' })).value
  assert.deepEqual(forgot.entries.map(entry => entry.text), ['Likes green tea', 'Lives in Hangzhou'])
  assert.equal((await call('memory-ask', { botId: 'b2', text: ' ' })).error.message, 'Type a question or a change first')
})

test('a host that only reads the team shows memory but changes none of it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const { tool, call, section, stop } = start({ home })
  t.after(() => stop())
  await call('state', {})
  await assert.rejects(tool('remember', { text: 'Likes tea' }, 'b2'), /Memory cannot change now: The Bot team in .* is open in another dsh/)
  assert.equal((await call('memory-view', { botId: 'b2' })).ok, true)
  assert.equal((await call('memory-ask', { botId: 'b2', text: 'hi' })).error.code, 'bot/read-only')
  assert.match(section('b2'), /^# Your memory/)
  assert.equal(existsSync(join(home, 'memory', 'snapshots')), false)
})

// Until no review waits or runs.
async function reviewed(call) {
  for (let tries = 0; tries < 200; tries += 1) {
    await settle()
    if ((await call('state', {})).value.memoryReviews === 0) return
  }
  throw new Error('the memory review did not finish')
}

test('when a turn ends, the memory review keeps what the user said, through the same rules', async (t) => {
  const history = {
    b2: [
      { event: { seq: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Too busy. I like it plain, mostly black and white. I moved to Rust. The root password is hunter2' }] } } },
      { event: { seq: 21, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Here is a plainer one.' }] } } } },
    ],
  }
  const replies = []
  const { ctx, home, tool, call, read, journal, requests, section, stop } = start({ replies, history, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await tool('remember', { text: 'The user writes Go' }, 'b2')
  assert.equal((await call('state', {})).value.memoryNews.b2.text, 'The user writes Go')
  assert.match(section('b2'), /After each of your turns, a memory review reads the new messages/)

  replies.push(`\`\`\`json\n${JSON.stringify({
    changes: [
      { op: 'add', text: 'The user likes a plain style, mostly black and white' },
      { op: 'add', text: 'Everyone should keep it plain', team: true },
      { op: 'edit', entry: 1, text: 'The user writes Rust' },
      { op: 'add', text: 'The root password is hunter2' },
    ],
  })}\n\`\`\``)
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].system, /^You keep the long-term memory of one Bot/)
  assert.doesNotMatch(requests[0].system, /"team": true/)
  assert.equal(requests[0].messages[0].content[0].text, [
    'The Bot: Writer, 写作.',
    '',
    'MEMORY.md has 18 of 8000 characters (own) and 0 of 4000 (team).',
    '',
    'Its memory now (own: this Bot\'s; team: shared by every Bot):',
    '[1] (own) The user writes Go',
    '',
    'New in its own chat with the user, oldest first:',
    'User: Too busy. I like it plain, mostly black and white. I moved to Rust. The root password is hunter2',
    'Writer: Here is a plainer one.',
    '',
    'Write every new or changed entry in English.',
  ].join('\n'))
  // Writer writes no team memory, so the team entry stays its own; no password is kept.
  const entries = parseMemory(read('bots', 'b2', 'MEMORY.md')).entries
  assert.deepEqual(entries.map(entry => entry.text), ['The user writes Rust', 'The user likes a plain style, mostly black and white', 'Everyone should keep it plain'])
  assert.equal(entries[1].meta.source, 'part 1 #20')
  assert.deepEqual(journal().slice(1).map(record => [record.op, record.actorName, record.auto]), [
    ['replace', 'Writer', true], ['add', 'Writer', true], ['add', 'Writer', true],
  ])
  // The review's tokens count as the Bot's memory use, not as "Other".
  const meter = ctx.listeners.get('llm/stream').find(listener => /tags\.get/.test(String(listener)))
  for await (const chunk of meter(requests[0], async function* () { yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 2 } } })) assert.equal(chunk.type, 'usage')
  const usage = (await call('usage', { timeZone: 'UTC' })).value
  assert.deepEqual(usage.rows.map(row => [usage.owners[row[1]].name, usage.kinds[row[3]], row[4] + row[7]]), [['Writer', 'memory', 42]])
  const state = (await call('state', {})).value
  assert.deepEqual([state.memoryNews.b2.op, state.memoryNews.b2.text], ['add', 'Everyone should keep it plain'])
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 21 })

  // Nothing new, or nothing from the user: no model call, and the place moves on.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  history.b2.push({ event: { seq: 22, type: 'user/message', data: { source: { kind: 'bot' }, content: [{ type: 'text', text: '[Message from Chief] Status?' }] } } })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 22 })

  // A turn that starts again before the review is due is reviewed when it ends; a
  // Session that is no Bot's is never reviewed.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'running' })
  ctx.emit('agent/status', { agent: { id: 'stranger' }, status: 'idle' })
  assert.equal((await call('state', {})).value.memoryReviews, 0)
  assert.equal(existsSync(join(home, 'memory', 'team', 'MEMORY.md')), false)

  // Changes the user makes in the memory panel are no news.
  replies.push(JSON.stringify({ reply: 'Done.', changes: [{ op: 'add', text: 'Likes tea' }] }))
  await call('memory-ask', { botId: 'b2', text: 'I like tea' })
  assert.equal((await call('state', {})).value.memoryNews.b2.text, 'Everyone should keep it plain')
})

test('a group\'s review keeps what is said there in the group memory, read once for all its members', async (t) => {
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page', team: true }] })]
  const { ctx, call, read, home, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].system, /^You keep the long-term memory of one group chat/)
  // The admin's model reads it, but no team entry comes of a group's review.
  assert.doesNotMatch(requests[0].system, /"team": true/)
  assert.equal(requests[0].sessionId, 'r1')
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /^The group chat: "Launch", with the user and Writer, Coder \(admin\)\.\n\nMEMORY\.md has 0 of 12000 characters \(group\) and 0 of 4000 \(team\)\.\n\nIts memory now \(group: shared by the members of this group; team: shared by every Bot\):\n\(none yet\)\n/)
  assert.match(text, /New in the group chat "Launch", oldest first:\nUser: Keep everything you send me under one page\nCoder: Will do\.\n\nWrite every new or changed entry in English\.$/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The user wants everything under one page \[id: [0-9a-f]{4}; source: group "Launch" #\d+; added: /)
  for (const elsewhere of [['team'], ['bots', 'b2'], ['bots', 'b3']]) assert.equal(existsSync(join(home, 'memory', ...elsewhere, 'MEMORY.md')), false, elsewhere.join('/'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 3 })
  assert.equal((await call('state', {})).value.memoryNews.r1.op, 'add')
})

test('a group review that gets no list of changes is not re-armed by every member\'s idle', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, read, requests, warnings, stop } = start({ home, replies: ['Let me think about that out loud.'], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  // The batch is marked read even though nothing could be saved: the next member
  // to go idle finds nothing new and starts no model call.
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 3 })
  assert.ok(warnings.some(line => line.includes('no list of changes')), warnings.join('\n'))
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
})

test('a first group review reads back to the user\'s line past a round of replies', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const replies = Array.from({ length: 6 }, (_, at) => ({ who: at % 2 ? 'Coder' : 'Writer', botId: at % 2 ? 'b3' : 'b2', text: `Reply ${at + 1}`, seq: at + 2 }))
  const room = { ...TEAM.rooms.r1, seq: 7, log: [{ who: 'User', text: 'From now on, answer in Chinese', seq: 1 }, ...replies] }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: room } }))
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [] })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].messages[0].content[0].text, /oldest first:\nUser: From now on, answer in Chinese\nWriter: Reply 1\n/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 7 })
})

test('an answer that is no list of changes is said and passed over, never read again', async (t) => {
  const replies = ['Nothing worth keeping here.', JSON.stringify({ changes: [{ op: 'add', text: 'The user wants this remembered' }] })]
  const { ctx, call, read, requests, warnings, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.throws(() => read('bots', 'b2', 'MEMORY.md'), { code: 'ENOENT' })
  // The miss is said, and the batch is marked read: a later turn does not read it again.
  assert.ok(warnings.some(line => line.includes('no list of changes')), warnings.join('\n'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
})

test('a review keeps what it can, sets aside what memory cannot keep, and says each', async (t) => {
  const replies = [JSON.stringify({ changes: [
    { op: 'add', text: 'The user likes tea' },
    { op: 'remove', entry: 7 },
    { op: 'edit', entry: 9, text: 'The user likes black tea' },
    { op: 'add', text: `The user tells ${'a long story '.repeat(30)}` },
    { op: 'add', text: 'The user writes C++', topic: 'C++' },
    { op: 'add', text: 'I use hunter2 as my password' },
  ] })]
  const { ctx, call, read, requests, warnings, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  // What memory could keep was saved; the rest was set aside and said — except a
  // secret, whose text stays out of the log.
  assert.deepEqual(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.map(entry => entry.text), ['The user likes tea'])
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
  const dropped = warnings.filter(line => line.includes('left out a change'))
  assert.equal(dropped.length, 5, warnings.join('\n'))
  assert.ok(dropped.some(line => line.includes('entry 7, which is not listed')))
  assert.ok(dropped.some(line => line.includes('entry 9, which is not listed')))
  assert.ok(dropped.some(line => line.includes('at most 300 characters') && line.includes('a long story')))
  assert.ok(dropped.some(line => line.includes('the topic "C++", which cannot be a topic name')))
  assert.ok(dropped.some(line => line.includes('looks like a key, token, password, or ID number')))
  assert.ok(!dropped.some(line => line.includes('hunter2')), warnings.join('\n'))
  // The same lines are not read again: nothing was retried.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
})

test('a malformed change whose secret sits before the words that give it away is not written to the log', async (t) => {
  const text = 'This is a note about the staging system. '.repeat(3) + 'I use hunter2 as my password'
  const replies = [JSON.stringify({ changes: [{ op: 'edit', text }] })]
  const { ctx, call, requests, warnings, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.ok(warnings.some(line => line.includes('left out a change') && line.includes('looks like a key, token, password, or ID number')), warnings.join('\n'))
  assert.ok(!warnings.some(line => line.includes('hunter2')), warnings.join('\n'))
})

test('a review saves the well-formed changes of a partly-malformed answer, and says the rest', async (t) => {
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }, { op: 'add' }] })]
  const { ctx, call, read, requests, warnings, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  // The malformed change did not take the answer down: the well-formed one was
  // saved, the malformed one was said, and the batch is marked read.
  assert.deepEqual(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.map(entry => entry.text), ['The user likes tea'])
  assert.ok(warnings.some(line => line.includes('left out a change') && line.includes('not a well-formed change') && line.includes('{"op":"add"}')), warnings.join('\n'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
})

test('a backlog past the text limit is reviewed in passes, oldest first', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'chat:b2': 19 }))
  const notes = Array.from({ length: 8 }, (_, at) => ({ event: { seq: 20 + at, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Note ${at + 1} ${'x'.repeat(2480)}` }] } } }))
  const replies = [JSON.stringify({ changes: [] }), JSON.stringify({ changes: [] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, history: { b2: notes }, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  const [first, second] = requests.map(request => request.messages[0].content[0].text)
  assert.match(first, /oldest first \(newer messages come in the next review\):\nUser: Note 1 /)
  assert.deepEqual(first.match(/Note \d/g), ['Note 1', 'Note 2', 'Note 3', 'Note 4', 'Note 5', 'Note 6'])
  assert.deepEqual(second.match(/Note \d/g).slice(-2), ['Note 7', 'Note 8'])
  assert.match(second, /oldest first:\nUser: Note 7 /)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 27 })
})

test('an answer past the change limit is kept whole, and the same lines are read once more', async (t) => {
  const many = Array.from({ length: 9 }, (_, at) => ({ op: 'add', text: `The user likes thing ${at + 1}` }))
  const replies = [JSON.stringify({ changes: many }), JSON.stringify({ changes: [many[8]] })]
  const { ctx, call, read, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  // All nine changes of the first answer were kept, and a full answer still
  // re-read the same lines once: the repeat of an entry it holds changed
  // nothing, and the passes ended there.
  assert.equal(requests.length, 2)
  assert.match(requests[0].system, /At most 8 changes in one answer/)
  assert.match(requests[1].messages[0].content[0].text, /\[8\] \(own\) The user likes thing 8\n/)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 9)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('an answer that reaches the change limit exactly is followed by another pass', async (t) => {
  const many = Array.from({ length: 9 }, (_, at) => ({ op: 'add', text: `The user likes item ${at + 1}` }))
  const replies = [JSON.stringify({ changes: many.slice(0, 8) }), JSON.stringify({ changes: [many[8]] })]
  const { ctx, call, read, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 9)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('a change set aside inside a full answer does not take the ones after it with it', async (t) => {
  const replies = [
    JSON.stringify({ changes: [
      ...Array.from({ length: 7 }, (_, at) => ({ op: 'add', text: `The user likes thing ${at + 1}` })),
      { op: 'add', text: `The user tells ${'a long story '.repeat(30)}` },
      { op: 'add', text: 'The user likes thing 9' },
    ] }),
    JSON.stringify({ changes: [] }),
  ]
  const { ctx, call, read, requests, warnings, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  // Nine changes came in one answer: the long one was set aside and said, and
  // every other — the ninth included — was kept. A full answer was kept, so the
  // same lines were read once more.
  assert.equal(requests.length, 2)
  assert.deepEqual(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.map(entry => entry.text), [
    ...Array.from({ length: 7 }, (_, at) => `The user likes thing ${at + 1}`),
    'The user likes thing 9',
  ])
  const dropped = warnings.filter(line => line.includes('left out a change'))
  assert.equal(dropped.length, 1, warnings.join('\n'))
  assert.ok(dropped[0].includes('a long story'), warnings.join('\n'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('a change set aside is no part of the change limit, so the same lines are not read again for it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n')
  // Seven changes land; an eighth reaches the limit only by counting what was set aside.
  const replies = [JSON.stringify({
    changes: [
      ...Array.from({ length: 7 }, (_, at) => ({ op: 'add', text: `The user likes thing ${at + 1}` })),
      { op: 'add' },
    ],
  })]
  const { ctx, call, read, requests, warnings, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1, 'a change set aside made the review read the same lines again')
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 7)
  assert.ok(warnings.some(line => line.includes('left out a change') && line.includes('not a well-formed change')), warnings.join('\n'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('a full MEMORY.md takes a new entry and moves its oldest to a topic', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  const filler = Array.from({ length: 27 }, (_, at) => `- Filler fact number ${at + 1} ${'y'.repeat(280)} [added: 2026-01-${String(at + 1).padStart(2, '0')}]`)
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), `# Memory\n\n${filler.join('\n')}\n\n## Index\n`)
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user flies with Air China' }, { op: 'remove', entry: 2 }] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.match(requests[0].messages[0].content[0].text, /MEMORY\.md has \d+ of 8000 characters \(own\)/)
  const main = read('bots', 'b2', 'MEMORY.md')
  // The removal goes first and frees the room, so nothing has to move.
  assert.match(main, /- The user flies with Air China \[/)
  assert.doesNotMatch(main, /Filler fact number 2 /)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'earlier.md')), false)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('a size counts entry text only and follows the user\'s setting', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  // Metadata is three times the text, which a size in file characters would count.
  const line = at => `- Fact ${String(at).padStart(3, '0')} ${'y'.repeat(90)} [source: group "A rather long group name" 2026-11-08 10:00; by: Somebody; added: 2026-11-01]`
  writeFileSync(join(dir, 'MEMORY.md'), `# Memory\n\n${Array.from({ length: 79 }, (_, at) => line(at)).join('\n')}\n\n## Index\n`)
  const { tool, call, read, stop } = start({ home })
  t.after(() => stop())
  assert.doesNotMatch(await tool('remember', { text: 'Still fits' }, 'b2'), /oldest/)
  assert.equal(existsSync(join(dir, 'earlier.md')), false)
  assert.equal((await call('set-prefs', { memoryLimits: { bot: 2_000 } })).ok, true)
  assert.match(await tool('remember', { text: 'Now it does not' }, 'b2'), /of 2000 characters\)\. MEMORY\.md was at its size, so its \d+ oldest entries moved/)
  assert.ok(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 2_000)
  assert.equal((await call('memory-view', { botId: 'b2' })).value.limits.own, 2_000)
  // A size out of range changes nothing; null goes back to the default.
  await call('set-prefs', { memoryLimits: { bot: 5 } })
  assert.equal((await call('memory-view', { botId: 'b2' })).value.limits.own, MEMORY_LIMITS.bot)
})

test('a prompt shows what the model window has room for, the newest first, and says the rest', () => {
  const entries = Array.from({ length: 4 }, (_, at) => ({ text: `Fact ${at}`, meta: { added: `2026-11-0${at + 1}` } }))
  const { shown, left } = fitWindow(entries, 26, text => text.length)
  assert.deepEqual(shown.map(entry => entry.text), ['Fact 3'])
  assert.equal(left, 3)
  assert.deepEqual(fitWindow(entries, undefined, text => text.length), { shown: entries, left: 0 })
  assert.match(promptEntry(entries[0]), /^- Fact 0 \[[0-9a-f]{4} · 11-01\]$/)
  assert.match(promptEntry({ text: 'Undated', meta: {} }), /^- Undated \[[0-9a-f]{4}\]$/)
})

test('an entry has an id, can end on a day, and a pin keeps it from being moved or changed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const replies = [JSON.stringify({ changes: [{ op: 'remove', entry: 1 }, { op: 'edit', entry: 1, text: 'Changed' }, { op: 'add', text: 'Back on Monday', until: '2099-01-01' }] })]
  const { ctx, tool, call, read, warnings, journal, section, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await tool('remember', { text: 'Always sign as Fei', pin: true }, 'b2')
  const { meta } = parseMemory(read('bots', 'b2', 'MEMORY.md')).entries[0]
  assert.match(meta.id, /^[0-9a-f]{4}$/)
  assert.equal(meta.pinned, 'user')
  // The id names the entry for replace, which keeps it.
  await tool('remember', { text: 'Short lived' }, 'b2')
  const second = parseMemory(read('bots', 'b2', 'MEMORY.md')).entries[1]
  await tool('remember', { text: 'Replaced by id', replace: second.meta.id }, 'b2')
  const replaced = parseMemory(read('bots', 'b2', 'MEMORY.md')).entries[1]
  assert.deepEqual([replaced.text, replaced.meta.id], ['Replaced by id', second.meta.id])
  await tool('remember', { text: 'Ended', until: '2020-01-01' }, 'b2')
  const prompt = section('b2')
  assert.ok(prompt.includes(`- Always sign as Fei [${meta.id} · `), prompt)
  assert.doesNotMatch(prompt, /Ended/)
  // The review leaves the pinned entry alone, and keeps its own end date.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Always sign as Fei/)
  assert.ok(warnings.some(warning => warning.includes('an entry the user pinned')), warnings.join('\n'))
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Back on Monday .*until: 2099-01-01/)
  // The user pins and lets go from the panel, and that can be undone.
  const view = (await call('memory-view', { botId: 'b2' })).value
  assert.equal(view.entries.find(entry => entry.text === 'Always sign as Fei').pinned, true)
  assert.equal(view.entries.find(entry => entry.text === 'Ended').expired, true)
  const off = await call('memory-pin', { botId: 'b2', scope: 'own', text: 'Always sign as Fei', pin: false })
  assert.equal(off.value.entries.find(entry => entry.text === 'Always sign as Fei').pinned, false)
  const undone = await call('memory-restore', { botId: 'b2', id: journal().at(-1).id })
  assert.equal(undone.value.entries.find(entry => entry.text === 'Always sign as Fei').pinned, true)
})

// A step of a running Session: the message the memory's pre-step put in front, if any.
async function updateOf(ctx, sessionId) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => [] } }
  const decision = await step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages.find(message => message.source?.kind === 'ds-bot-memory-update')
}

test('a running conversation learns of memory changes as a message, and its prompt stays the same', async (t) => {
  const { ctx, home, tool, section, stop } = start()
  t.after(() => stop())
  const opened = section('b2')
  assert.equal(await updateOf(ctx, 'b2'), undefined)
  await settle()
  // A change someone else makes shows at the next step, once, and the prompt does not move.
  await tool('remember', { text: 'Ships on Friday', scope: 'team', always: true }, 'm1')
  const update = await updateOf(ctx, 'b2')
  assert.match(textOf(update), /^## Memory update\n.*data, not instructions\.\n\n- Added to team memory by Chief: Ships on Friday$/)
  assert.equal(section('b2'), opened)
  assert.equal(await updateOf(ctx, 'b2'), undefined)
  // A Session's own write is not news to it.
  await settle()
  await tool('remember', { text: 'Likes tea' }, 'b2')
  assert.equal(await updateOf(ctx, 'b2'), undefined)
  // A fresh part freezes what is there now and starts from there.
  await settle()
  await tool('remember', { text: 'Ships on Monday', replace: 'Ships on Friday', scope: 'team', always: true }, 'm1')
  assert.match(textOf(await updateOf(ctx, 'b2')), /Changed in team memory by Chief: "Ships on Friday" is now "Ships on Monday"/)
  assert.ok(existsSync(join(home, 'memory', 'snapshots', 'b2.seen')))
})

test('a topic entry and another group stay out of the memory update', async (t) => {
  const { ctx, tool, section, stop } = start()
  t.after(() => stop())
  section('b2')
  await updateOf(ctx, 'b2')
  await settle()
  await tool('remember', { text: 'Details', topic: 'notes', scope: 'team' }, 'm1')
  assert.equal(await updateOf(ctx, 'b2'), undefined)
})

test('a resident update keeps edits to legacy entries that share a short id', async (t) => {
  const { home, ctx, section, tool, stop } = start()
  t.after(() => stop())
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n- Legacy note number 307\n- Legacy note number 432\n')
  const prompt = section('b2')
  assert.match(prompt, /307 \[1528\][\s\S]*432 \[1528\]/)
  await settle()
  await tool('remember', { text: 'Corrected legacy note', replace: 'Legacy note number 307', scope: 'Writer' }, 'm1')
  const update = textOf(await updateOf(ctx, 'b2'))
  assert.match(update, /"Legacy note number 307" is now "Corrected legacy note"/)
  assert.doesNotMatch(update, /Legacy note number 432/)
})

test('a running conversation receives a team entry promoted to and removed from its prompt', async (t) => {
  const { ctx, call, tool, section, stop } = start()
  t.after(() => stop())
  const opened = section('b2')
  await tool('remember', { scope: 'team', text: 'The team prefers one-page reports' }, 'm1')
  const entry = { botId: 'b2', text: 'The team prefers one-page reports' }
  await call('memory-layer', { ...entry, topic: 'shared', always: true })
  assert.match(textOf(await updateOf(ctx, 'b2')), /Added to team memory by the user: The team prefers one-page reports/)
  await settle()
  await call('memory-layer', { ...entry, always: false })
  assert.match(textOf(await updateOf(ctx, 'b2')), /Removed from team memory by the user: The team prefers one-page reports/)
  assert.equal(section('b2'), opened)
})

test('team entries never fall back to the resident layer without always', async (t) => {
  const { home, tool, read, stop } = start()
  t.after(() => stop())
  await tool('remember', { scope: 'team', text: 'Always answer in Chinese', always: true }, 'm1')
  await assert.rejects(tool('remember', { scope: 'team', replace: 'Always answer in Chinese', text: 'Always answer in English' }, 'm1'), /requires always/)
  const dir = join(home, 'memory', 'team')
  for (let i = 0; i < MEMORY_LIMITS.topics; i += 1) writeFileSync(join(dir, `topic-${i}.md`), `# Topic ${i}\n`)
  await tool('remember', { scope: 'team', text: 'Coder knows the build' }, 'm1')
  assert.match(read('team', 'shared.md'), /Coder knows the build/)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /Coder knows the build|Always answer in English/)
})

test('a topic never shows its expired first entry as a navigation note', async (t) => {
  const { section, tool, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'The old launch is on Friday', topic: 'launch', until: '2020-01-01' }, 'b2')
  const prompt = section('b2')
  assert.match(prompt, /Topic \[\[launch\]\]/)
  assert.doesNotMatch(prompt, /The old launch is on Friday/)
})

test('topic navigation shares the resident prompt budget', async (t) => {
  const { ctx, tool, section, stop } = start()
  t.after(() => stop())
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 5_000 } })
  await updateOf(ctx, 'b2')
  await tool('remember', { text: 'The user prefers one-page reports' }, 'b2')
  for (let i = 0; i < 20; i += 1) await tool('remember', { text: `Launch reference number ${i}`, topic: `launch-${i}` }, 'b2')
  const own = section('b2').split('## Your memory (MEMORY.md)\n')[1].split('\n\n## Team memory')[0]
  assert.match(own, /The user prefers one-page reports/)
  assert.match(own, /Topic \[\[launch-0\]\]/)
  assert.ok(estimateTokens(own) <= 100)
})

test('the team memory every Bot always reads takes what the user says, and the rest waits in a topic', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const history = { m1: [...ownChat] }
  const replies = [JSON.stringify({ changes: [
    { op: 'add', text: 'Reviews go through Coder', team: true },
    { op: 'add', text: 'Writer drafts in plain words', for: 'Writer' },
    { op: 'add', text: 'Launch is on Friday', group: 'Launch' },
    { op: 'add', text: 'Never reaches anyone', for: 'Nobody' },
    { op: 'remove', entry: 1 },
  ] })]
  const { ctx, tool, call, read, section, warnings, stop } = start({ home, replies, history, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await tool('remember', { text: 'Always answer in Chinese', scope: 'team', always: true }, 'm1')
  await tool('remember', { text: 'Coder knows the build', scope: 'team' }, 'm1')
  assert.match(read('team', 'MEMORY.md'), /- Always answer in Chinese \[/)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /Coder knows the build/)
  assert.match(read('team', 'shared.md'), /- Coder knows the build \[/)
  assert.doesNotMatch(section('b2'), /Coder knows the build/)
  assert.match(await tool('recall', { query: 'build' }, 'b2'), /Coder knows the build/)
  // The review reaches the audience it names, and only the shared topic of the team.
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'm1' }, status: 'idle' })
  await reviewed(call)
  assert.match(read('team', 'MEMORY.md'), /Always answer in Chinese/, 'the review changed what every Bot always reads')
  assert.ok(warnings.some(line => line.includes('which only the user does')), warnings.join('\n'))
  assert.match(read('team', 'shared.md'), /- Reviews go through Coder \[/)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /Reviews go through Coder/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Writer drafts in plain words \[/)
  assert.ok(warnings.some(line => line.includes('no Bot named "Nobody"')), warnings.join('\n'))
  // The panel moves one between the two, in one change.
  const up = await call('memory-layer', { botId: 'b2', topic: 'shared', text: 'Coder knows the build', always: true })
  assert.equal(up.value.entries.find(entry => entry.text === 'Coder knows the build').topic, null)
  assert.match(read('team', 'MEMORY.md'), /- Coder knows the build \[/)
  assert.doesNotMatch(read('team', 'shared.md'), /Coder knows the build/)
  const down = await call('memory-layer', { botId: 'b2', text: 'Coder knows the build', always: false })
  assert.equal(down.value.entries.find(entry => entry.text === 'Coder knows the build').topic, 'shared')
})

test('the panel moves an entry to another memory, whole, and the first memory no longer has it', async (t) => {
  const { tool, call, read, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Coder drafts in plain words', until: '2099-01-01' }, 'b2')
  const pinned = await call('memory-pin', { botId: 'b2', scope: 'own', text: 'Coder drafts in plain words', pin: true })
  const before = pinned.value.entries.find(entry => entry.text === 'Coder drafts in plain words')
  assert.ok(pinned.value.places.some(place => place.kind === 'bot' && place.key === 'bot:b3'), JSON.stringify(pinned.value.places))
  assert.equal(pinned.value.keys.own, 'bot:b2')
  const idOf = file => /\bid: ?([\w-]+)/.exec(read(...file).split('\n').find(line => line.includes('Coder drafts')))?.[1]
  const id = idOf(['bots', 'b2', 'MEMORY.md'])
  assert.ok(id)
  // To another Bot: the line keeps its id, end date and pin.
  const moved = await call('memory-move', { botId: 'b2', scope: 'own', text: 'Coder drafts in plain words', to: 'bot:b3' })
  assert.equal(moved.value.entries.some(entry => entry.text === before.text), false)
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /Coder drafts/)
  const there = read('bots', 'b3', 'MEMORY.md').split('\n').find(line => line.includes('Coder drafts'))
  assert.match(there, /until: 2099-01-01/)
  assert.match(there, /pinned: user/)
  assert.equal(idOf(['bots', 'b3', 'MEMORY.md']), id)
  // To the team: it waits in a topic, and every Bot does not start reading it.
  await call('memory-move', { botId: 'b3', scope: 'own', text: 'Coder drafts in plain words', to: 'team' })
  assert.doesNotMatch(read('bots', 'b3', 'MEMORY.md'), /Coder drafts/)
  assert.doesNotMatch(read('team', 'MEMORY.md').replace(/\[\[shared\]\].*/g, ''), /Coder drafts/)
  assert.match(read('team', 'shared.md'), /Coder drafts in plain words/)
  // Back out of the team: the empty topic goes, and so does its link.
  await call('memory-move', { botId: 'b2', scope: 'team', topic: 'shared', text: 'Coder drafts in plain words', to: 'bot:b2' })
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Coder drafts in plain words/)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /\[\[shared\]\]/)
  // Where it already is, and a place that does not exist, change nothing.
  const same = await call('memory-move', { botId: 'b2', scope: 'own', text: 'Coder drafts in plain words', to: 'bot:b2' })
  assert.equal(same.value.entries.filter(entry => entry.text === 'Coder drafts in plain words').length, 1)
  const gone = await call('memory-move', { botId: 'b2', scope: 'own', text: 'Coder drafts in plain words', to: 'bot:nobody' })
  assert.equal(gone.ok ?? false, false, JSON.stringify(gone))
  const unknown = await call('memory-move', { botId: 'b2', scope: 'own', text: 'Coder drafts in plain words', to: 'somewhere' })
  assert.equal(unknown.ok ?? false, false, JSON.stringify(unknown))
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Coder drafts in plain words/)
})

test('a move keeps the source when the destination already has different metadata', async (t) => {
  const { call, tool, read, stop } = start()
  t.after(() => stop())
  const text = 'The user prefers one-page reports'
  await tool('remember', { text, pin: true, until: '2099-06-01' }, 'b2')
  await tool('remember', { text }, 'b3')
  const from = read('bots', 'b2', 'MEMORY.md')
  const to = read('bots', 'b3', 'MEMORY.md')
  const result = await call('memory-move', { botId: 'b2', scope: 'own', text, to: 'bot:b3' })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /different details/)
  assert.equal(read('bots', 'b2', 'MEMORY.md'), from)
  assert.equal(read('bots', 'b3', 'MEMORY.md'), to)
})

test('two moves of one entry only write one destination', async (t) => {
  const { call, tool, read, home, stop } = start()
  t.after(() => stop())
  const text = 'The user prefers one-page reports'
  await tool('remember', { text }, 'b2')
  const move = to => call('memory-move', { botId: 'b2', scope: 'own', text, to })
  const results = await Promise.all([move('bot:b3'), move('group:r1')])
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /one-page reports/)
  const destinations = [['bots', 'b3'], ['groups', 'r1']]
  assert.equal(destinations.filter(path => existsSync(join(home, 'memory', ...path, 'MEMORY.md')) && read(...path, 'MEMORY.md').includes(text)).length, 1)
})

test('a move can finish when its exact destination copy is already saved', async (t) => {
  const { call, tool, read, home, stop } = start()
  t.after(() => stop())
  const text = 'The user prefers one-page reports'
  await tool('remember', { text, pin: true, until: '2099-06-01' }, 'b2')
  const dir = join(home, 'memory', 'bots', 'b3')
  mkdirSync(dir, { recursive: true })
  const saved = read('bots', 'b2', 'MEMORY.md')
  writeFileSync(join(dir, 'MEMORY.md'), saved)
  const moved = await call('memory-move', { botId: 'b2', scope: 'own', text, to: 'bot:b3' })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /one-page reports/)
  assert.equal(read('bots', 'b3', 'MEMORY.md'), saved)
})

test('an entry moved out of a private Bot is the only thing of it the shared log sees', async (t) => {
  const { tool, call, read, stop, home } = start()
  t.after(() => stop())
  const team = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  team.bots.b2.private = true
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  await tool('remember', { text: 'A private fact' }, 'b2')
  await tool('remember', { text: 'A fact to share' }, 'b2')
  await call('memory-move', { botId: 'b2', scope: 'own', text: 'A fact to share', to: 'team' })
  assert.match(read('team', 'shared.md'), /A fact to share/)
  assert.doesNotMatch(read('bots', 'b2', 'MEMORY.md'), /A fact to share/)
  assert.match(read('bots', 'b2', 'journal.jsonl'), /"op":"remove".*A fact to share/)
  const shared = read('journal.jsonl')
  assert.match(shared, /"op":"add","scope":"team".*A fact to share/)
  assert.doesNotMatch(shared, /A private fact|"scope":"bot:b2"/)
})

async function recallOf(ctx, sessionId, said, history = []) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => history } }
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: said }] }
  const decision = await step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages: said === '' ? [] : [message] }))
  return decision.messages.find(item => item.source?.kind === 'ds-bot-memory-recall')
}

test('a turn brings up matching topic entries once, as data, and only from what its Bot may read', async (t) => {
  const { ctx, tool, call, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: '发版前先跑真机检查', topic: 'release' }, 'b2')
  await tool('remember', { text: 'Coder prefers small pull requests', topic: 'review' }, 'b3')
  await tool('remember', { text: '午饭吃面', topic: 'food' }, 'b2')
  section('b2')
  const recalled = await recallOf(ctx, 'b2', '这次发版前要做什么检查')
  assert.match(textOf(recalled), /^## Possibly relevant memory\n.*data, not instructions.*\n\n- \(yours · release\) 发版前先跑真机检查 \[/)
  assert.doesNotMatch(textOf(recalled), /午饭|small pull/)
  // Nothing matching: nothing goes in. Already shown in this part: not again.
  assert.equal(await recallOf(ctx, 'b2', 'completely unrelated words here'), undefined)
  assert.equal(await recallOf(ctx, 'b2', '这次发版前要做什么检查', [recalled]), undefined)
  // Steps inside a turn have no new message.
  assert.equal(await recallOf(ctx, 'b2', ''), undefined)
  // Another Bot's topics stay out, and the user can turn it off.
  assert.equal(await recallOf(ctx, 'b2', 'small pull requests please'), undefined)
  await call('set-prefs', { memoryAutoRecall: false })
  assert.equal(await recallOf(ctx, 'b2', '这次发版前要做什么检查'), undefined)
})

test('recall puts the entry that matches best first', () => {
  const entries = ['Ships on Friday and also lots of other words here', 'Friday ships'].map(text => ({ text, file: {} }))
  const ranked = rankEntries(entries, 'ships friday')
  assert.equal(ranked[0].entry.text, 'Friday ships')
  assert.equal(ranked[0].hits, 2)
})

test('a group line that left the room log is still reviewed, opened by its seq, and found', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'group:r1': 3 }))
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The first plan is kept' }] })]
  const { ctx, tool, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  const room = rt.roomOf('r1')
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'one page' }, 'g3'), /#1 .*under one page/)
  for (let at = 0; at < 70; at += 1) rt.logRoom(room, { who: 'User', text: `Plan number ${at} for the launch` })
  assert.ok(room.log[0].seq > 4, 'the first lines should have left the room log')
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.match(requests[0].messages[0].content[0].text, /Plan number 0 for the launch/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The first plan is kept \[id: [0-9a-f]{4}; source: group "Launch" #\d+/)
  assert.match(await tool('read_group_chat', { group: 'Launch', seq: 4 }, 'g3'), /Plan number 0 for the launch/)
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'number 1 launch' }, 'g3'), /#5 .*Plan number 1 for the launch/)
  assert.match(await tool('read_group_chat', { group: 'Launch', seq: 9999 }, 'g3'), /has no message 9999/)
})

test('group search after an upgrade reads the saved full text of a legacy line', async (t) => {
  const first = start()
  t.after(() => first.stop())
  await first.call('state', {})
  const room = rt.roomOf('r1')
  const text = `The launch notes follow. ${'Plan details. '.repeat(155)}Final deliverable appendix.`
  const line = rt.keepGroupLine(room.id, { who: 'User', seq: 4, text }, text)
  assert.doesNotMatch(line.text, /deliverable appendix/)
  writeFileSync(join(first.home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, seq: 4, log: [...TEAM.rooms.r1.log, line] } } }))
  await first.stop({ keep: true })
  const second = start({ home: first.home })
  t.after(() => second.ctx.dispose())
  assert.match(await second.tool('read_group_chat', { group: 'Launch', query: 'deliverable appendix' }, 'g3'), /#4 /)
})

test('a group review writes only to the group whose conversation it read', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const r2 = { ...TEAM.rooms.r1, id: 'r2', name: 'Other project', log: [], seq: 0, sessions: {} }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { ...TEAM.rooms, r2 } }))
  const replies = [JSON.stringify({ changes: [{ op: 'add', group: 'Other project', text: 'Launch reports fit one page' }] })]
  const { ctx, call, read, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /Launch reports fit one page/)
  assert.equal(existsSync(join(home, 'memory', 'groups', 'r2', 'MEMORY.md')), false)
})

test('a tidy does not retire an entry that changed after the model read it', async (t) => {
  const started = Promise.withResolvers()
  const answer = Promise.withResolvers()
  const { ctx, tool, read, home, stop } = start({ replies: [answer.promise] })
  t.after(() => stop())
  const stream = ctx.llm.stream
  ctx.llm.stream = async function* (request) {
    started.resolve()
    yield* stream(request)
  }
  await tool('remember', { text: 'The team met on Monday' }, 'b2')
  for (let i = 0; i < 7; i += 1) await tool('remember', { text: `Other fact number ${i}` }, 'b2')
  const tidying = rt.tidyMemoryNow('bot:b2')
  await started.promise
  await tool('remember', { replace: 'The team met on Monday', text: 'The team meets on Friday' }, 'b2')
  answer.resolve(JSON.stringify({ changes: [{ op: 'retire', entry: 1, why: 'The old meeting is over' }] }))
  await tidying
  assert.match(read('bots', 'b2', 'MEMORY.md'), /The team meets on Friday/)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'retired.jsonl')), false)
})

test('the tidy merges and archives within a fifth of the entries, leaves a pin, and a batch undoes whole', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  const facts = Array.from({ length: 20 }, (_, at) => `- Fact number ${at + 1} [id: a${String(at).padStart(3, '0')}; added: 2026-10-01]`)
  const original = `# Memory\n\n${facts.join('\n')}\n- Keep this forever [id: beef; added: 2026-01-01; pinned: user]\n- Over now [id: dead; added: 2026-01-01; until: 2020-01-01]\n\n## Index\n`
  writeFileSync(join(dir, 'MEMORY.md'), original)
  const replies = [JSON.stringify({ changes: [
    { op: 'merge', entries: [1, 2], text: 'Facts one and two' },
    { op: 'move', entry: 3, topic: 'details' },
    { op: 'about', topic: 'details', text: 'Small details' },
    { op: 'retire', entry: 4, why: 'over' },
    { op: 'retire', entry: 5, why: 'past the limit' },
    { op: 'retire', entry: 99 },
  ] })]
  const { ctx, call, read, requests, section, stop } = start({ home, replies })
  t.after(() => stop())
  await call('state', {})
  section('b2')
  await settle()
  await rt.tidyMemoryNow('bot:b2')
  assert.match(textOf(await updateOf(ctx, 'b2')), /Removed from your memory by the memory review: Fact number 3/)
  assert.equal(requests.length, 1)
  assert.doesNotMatch(requests[0].messages[0].content[0].text, /Keep this forever|Over now/)
  const main = read('bots', 'b2', 'MEMORY.md')
  assert.match(main, /- Facts one and two \[id: a000;.*merged: a000 a001/)
  assert.doesNotMatch(main, /Fact number 2 |Fact number 3 |Fact number 4 |Over now/)
  // Four entries of twenty-one is the limit: the next change was past it.
  assert.match(main, /Fact number 5 /)
  assert.match(main, /- Keep this forever \[/)
  assert.match(read('bots', 'b2', 'details.md'), /> Small details\n[\s\S]*- Fact number 3 /)
  const retired = read('bots', 'b2', 'retired.jsonl').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(retired.map(row => row.why).sort(), ['ended', 'merged', 'merged', 'over'])
  // Nothing new today: no second call. The panel shows it and undoes it.
  await rt.tidyMemoryNow('bot:b2')
  const view = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([view.tidy.scope, view.tidy.merged, view.tidy.moved], ['own', 2, 1])
  const undone = await call('memory-tidy-undo', { botId: 'b2', scope: 'own', batch: view.tidy.batch })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(read('bots', 'b2', 'MEMORY.md'), original)
  assert.equal(existsSync(join(dir, 'details.md')), false)
  assert.equal(existsSync(join(dir, 'retired.jsonl')), false)
  assert.equal(undone.value.tidy, null)
  assert.match(textOf(await updateOf(ctx, 'b2')), /Added to your memory by the user: Fact number 3/)
})

test('a tidy keeps its records in the memory folder it tidied', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), `# Memory\n\n${Array.from({ length: 10 }, (_, at) => `- Secret plan ${at} [id: c${String(at).padStart(3, '0')}]`).join('\n')}\n\n## Index\n`)
  const { call, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'retire', entry: 1, why: 'over' }] })] })
  t.after(() => stop())
  await call('state', {})
  await rt.tidyMemoryNow('bot:b2')
  assert.equal(existsSync(join(dir, 'tidied.json')), true)
  assert.equal(readdirSync(join(dir, 'tidy')).length, 1)
  assert.equal(existsSync(join(home, 'memory', 'tidy')), false)
  assert.equal(existsSync(join(home, 'memory', 'tidied.json')), false)
})

test('a team tidy never offers what every Bot always reads', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const dir = join(home, 'memory', 'team')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n- Always there\n\n## Index\n- [[shared]]\n')
  writeFileSync(join(dir, 'shared.md'), `# shared\n\n${Array.from({ length: 9 }, (_, at) => `- Shared note ${at}`).join('\n')}\n`)
  const { call, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [] })] })
  t.after(() => stop())
  await call('state', {})
  await rt.tidyMemoryNow('team')
  assert.match(requests[0].messages[0].content[0].text, /Shared note 0/)
  assert.doesNotMatch(requests[0].messages[0].content[0].text, /Always there/)
})

test('a new entry on a full MEMORY.md moves the oldest in the same change, and the log says so', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  const filler = Array.from({ length: 27 }, (_, at) => `- Filler fact number ${at + 1} ${'y'.repeat(280)} [added: 2026-01-${String(28 - at).padStart(2, '0')}]`)
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), `# Memory\n\n${filler.join('\n')}\n\n## Index\n`)
  const { tool, read, journal, stop } = start({ home })
  t.after(() => stop())
  await tool('remember', { text: 'A new fact' }, 'b2')
  const main = read('bots', 'b2', 'MEMORY.md')
  assert.match(main, /- A new fact \[/)
  // Number 27 has the earliest date, so it moves first, whatever its place.
  assert.doesNotMatch(main, /Filler fact number 27 /)
  assert.match(read('bots', 'b2', 'earlier.md'), /Filler fact number 27 /)
  assert.ok(parseMemory(main).entries.reduce((sum, entry) => sum + entry.text.length, 0) <= MEMORY_LIMITS.bot)
  const row = journal().at(-1)
  assert.equal(row.op, 'add')
  assert.deepEqual(row.movedTo, ['earlier.md'])
  assert.match(row.moved[0], /Filler fact number 27 /)
})

test('a full topic continues in a numbered one, and past the last topic the entry goes to MEMORY.md', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const dir = join(home, 'memory', 'bots', 'b2')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n## Index\n- [[tea]]\n')
  writeFileSync(join(dir, 'tea.md'), `# tea\n\n${Array.from({ length: 56 }, (_, at) => `- Tea ${at} ${'z'.repeat(290)}`).join('\n')}\n`)
  const { tool, read, stop } = start({ home })
  t.after(() => stop())
  assert.match(await tool('remember', { text: 'Likes oolong', topic: 'tea' }, 'b2'), /new topic \[\[tea-2\]\]/)
  assert.match(read('bots', 'b2', 'tea-2.md'), /- Likes oolong \[/)
  for (let at = 1; at <= MEMORY_LIMITS.topics - 2; at += 1) writeFileSync(join(dir, `topic-${at}.md`), `# topic-${at}\n\n- fact ${at}\n`)
  assert.match(await tool('remember', { text: 'Likes coffee too', topic: 'coffee' }, 'b2'), /in MEMORY\.md/)
  assert.equal(existsSync(join(dir, 'coffee.md')), false)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Likes coffee too \[/)
})

test('topic entries that share words with the user\'s new lines come first', () => {
  const own = [{ entries: [] }, { topic: 'work', entries: [
    { text: 'Ships on Fridays', meta: { added: '2026-01-01' } },
    { text: 'Drinks green tea', meta: { added: '2026-10-01' } },
    { text: '用户住在杭州的西湖区附近哦', meta: { added: '2026-02-01' } },
  ] }]
  const shown = about => reviewEntries(own, [{ entries: [] }], 16, about).numbered.map(entry => entry.text)
  assert.deepEqual(shown(''), ['Drinks green tea'])
  assert.deepEqual(shown('We no longer ship on Fridays'), ['Ships on Fridays'])
  assert.deepEqual(shown('我搬离杭州了'), ['用户住在杭州的西湖区附近哦'])
})

test('the pill opens the memory that changed last on the host, when one poll brings two', () => {
  const news = { b2: { at: 2_000, seen: 5_000 }, b3: { at: 3_000, seen: 5_000 }, b4: { at: 9_000, seen: 0 } }
  assert.equal(latestMemoryChange(news, ['b2', 'b3']), 'b3')
  assert.equal(latestMemoryChange(news, ['b4', 'b2']), 'b2')
  assert.equal(latestMemoryChange({}, ['b2']), 'b2')
  assert.equal(latestMemoryChange({}, []), null)
})

const twoMembers = home => writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, members: ['b2', 'b3', 'b4'], sessions: { b2: 'g2', b3: 'g3' } } } }))

test('the members of a group read its memory in their Sessions there, and no Bot reads it anywhere else', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, tool, section, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page' }] })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  // Two members' turns end: the group is reviewed once, not once per member.
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  for (const [member, bot] of [['g2', 'b2'], ['g3', 'b3']]) {
    // The prompt is the Bot's own, so the provider's cached prefix holds in both; the
    // group's memory comes in a snapshot message before the first step.
    assert.equal(section(member), section(bot))
    assert.match(textOf(await groupMemoryOf(ctx, member)), /^## Group memory, shared by the members of this group chat\nOnly the members of this group read it[^\n]*\n\n- The user wants everything under one page \[[0-9a-f]{4} · \d\d-\d\d\]$/)
    assert.match(await tool('recall', { query: 'page' }, member), /^Entries with "page" in your memory, the group memory, and the team memory:\n\[group · MEMORY\.md\] The user wants everything under one page/)
  }
  // Not in a member's own chat, nor for a Bot outside the group, a Main Bot included.
  for (const elsewhere of ['b2', 'b3', 'b4', 'm1']) {
    assert.doesNotMatch(section(elsewhere), /one page|Group memory/, elsewhere)
    assert.equal(await groupMemoryOf(ctx, elsewhere), undefined, elsewhere)
    assert.match(await tool('recall', { query: 'page' }, elsewhere), /^Nothing in your memory and the team memory mentions "page"/, elsewhere)
    assert.match(await tool('recall', { scope: 'group' }, elsewhere), /^There is no group memory here/, elsewhere)
  }
})

test('in a group, remember and forget write the group memory unless told otherwise, for any member', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, tool, call, read, journal, stop } = start({ home })
  t.after(() => stop())
  assert.match(await tool('remember', { text: 'Builds go in the out folder' }, 'g2'), /^Saved to the group memory, in MEMORY\.md \(MEMORY\.md: \d+ of 12000 characters\)\. The other members see it at their next step in this group; recall finds it now\.$/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- Builds go in the out folder \[id: [0-9a-f]{4}; source: group "Launch" #\d+; by: Writer; added: /)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
  // "own" keeps it for the Bot itself, in all its conversations.
  assert.match(await tool('remember', { text: 'I review drafts twice', scope: 'own' }, 'g2'), /^Saved to your memory/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- I review drafts twice \[id: [0-9a-f]{4}; source: group "Launch"/)
  // Another member changes the same memory.
  assert.match(await tool('remember', { text: 'Builds go in the dist folder', replace: 'out folder' }, 'g3'), /"Builds go in the out folder" is now "Builds go in the dist folder"/)
  assert.match(await tool('forget', { entry: 'dist folder' }, 'g3'), /^Removed from the group memory/)
  assert.deepEqual(journal().map(record => [record.op, record.scope, record.actorName]), [
    ['add', 'group:r1', 'Writer'], ['add', 'bot:b2', 'Writer'], ['replace', 'group:r1', 'Coder'], ['remove', 'group:r1', 'Coder'],
  ])
  // A Bot's own chat has no group memory to write.
  await assert.rejects(tool('remember', { text: 'x', scope: 'group' }, 'b2'), /There is no group memory here/)
  // A member removed from the group writes no more of it.
  await tool('remember', { text: 'Ship on Friday' }, 'g2')
  assert.equal((await call('update-room', { id: 'r1', remove: ['b2'] })).ok, true)
  await assert.rejects(tool('remember', { text: 'Still here' }, 'g2'), /Only Bots on the team keep a memory\./)
  await assert.rejects(tool('forget', { entry: 'Friday' }, 'g2'), /Only Bots on the team keep a memory\./)
  // Nor does it read it: its Session there gets no snapshot of the group's memory.
  assert.equal(await groupMemoryOf(ctx, 'g2'), undefined)
  assert.ok(await groupMemoryOf(ctx, 'g3'))
  assert.deepEqual(parseMemory(read('groups', 'r1', 'MEMORY.md')).entries.map(entry => entry.text), ['Ship on Friday'])
})

test('a group Session gets its group\'s memory as a message once, and again after a checkpoint condensed it', async (t) => {
  const { ctx, tool, section, home, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  writeFileSync(join(home, 'memory', 'snapshots', 'g3.md'), section('b3'))
  assert.equal(section('g3'), section('b3'))
  const first = await groupMemoryOf(ctx, 'g3')
  assert.match(textOf(first), /^## Group memory, shared by the members of this group chat\n[^\n]*\n\n- Ship on Friday \[/)
  // Still in the history: not put in again.
  assert.equal(await groupMemoryOf(ctx, 'g3', [first]), undefined)
  // Condensed away by a checkpoint: it comes again, as the memory is now.
  await tool('remember', { text: 'Demo on Monday' }, 'g3')
  assert.match(textOf(await groupMemoryOf(ctx, 'g3', [])), /- Ship on Friday \[[^\n]*\n- Demo on Monday \[/)
})

test('a group Session frozen with its group\'s memory in its prompt keeps it there, with no message', async (t) => {
  const { ctx, tool, section, home, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  const frozen = `${section('b3')}\n\n## Group memory, shared by the members of this group chat\n- Ship on Friday`
  writeFileSync(join(home, 'memory', 'snapshots', 'g3.md'), frozen)
  assert.equal(section('g3'), frozen)
  assert.equal(await groupMemoryOf(ctx, 'g3'), undefined)
})

test('deleting a group moves its memory to the archive, with its members\' snapshots gone', async (t) => {
  const { tool, call, home, journal, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  section('g3')
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'g3.md')), true)
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(existsSync(join(home, 'memory', 'groups', 'r1')), false)
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'g3.md')), false)
  const [archived] = readdirSync(join(home, 'memory', 'archive'))
  assert.match(archived, /^group-r1-\d{4}-/)
  assert.match(readFileSync(join(home, 'memory', 'archive', archived, 'MEMORY.md'), 'utf8'), /Ship on Friday/)
  assert.deepEqual([journal().at(-1).op, journal().at(-1).scope], ['archive', 'group:r1'])
})

test('a group\'s memory panel shows only the group memory, and what the user changes there stays there', async (t) => {
  const replies = ['## Overview\nThe group ships on Friday.', JSON.stringify({ reply: 'Done.', changes: [{ op: 'add', text: 'Demo on Monday', team: true }, { op: 'remove', entry: 1 }] })]
  const { tool, call, read, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  await tool('remember', { text: 'Likes tea' }, 'b3')
  await tool('remember', { text: 'Keep it short', scope: 'team' }, 'm1')
  const view = (await call('memory-view', { roomId: 'r1', summarize: true })).value
  assert.equal(view.roomId, 'r1')
  assert.deepEqual(view.entries.map(entry => [entry.scope, entry.text, entry.by]), [['group', 'Ship on Friday', 'Coder']])
  assert.deepEqual(Object.keys(view.sizes), ['group'])
  for (let tries = 0; tries < 200 && (await call('memory-view', { roomId: 'r1' })).value.summarizing; tries += 1) await settle()
  assert.match(requests[0].messages[0].content[0].text, /^Here is everything the group chat "Launch" remembers[^\n]*\n\n## Group memory\n- Ship on Friday\n/)
  assert.doesNotMatch(requests[0].messages[0].content[0].text, /Likes tea|Keep it short/)
  assert.equal(requests[0].sessionId, 'r1')
  assert.equal((await call('memory-view', { roomId: 'r1' })).value.summary.text, '## Overview\nThe group ships on Friday.')

  const answer = (await call('memory-ask', { roomId: 'r1', text: 'The demo is on Monday; Friday is off' })).value
  assert.match(requests[1].system, /^You keep the memory of one group chat/)
  assert.doesNotMatch(requests[1].system, /"team"/)
  assert.match(requests[1].messages[0].content[0].text, /^Entries of the group chat "Launch" \(group: shared by its members\):\n\[1\] \(group\) Ship on Friday\n/)
  assert.deepEqual(answer.changes.map(change => [change.op, change.scope, change.ok]), [['add', 'group', true], ['remove', 'group', true]])
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- Demo on Monday \[id: [0-9a-f]{4}; source: memory panel; by: user; added: /)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /Demo/)
  const forgot = (await call('memory-forget', { roomId: 'r1', scope: 'group', topic: null, text: 'Demo on Monday' })).value
  assert.deepEqual(forgot.entries, [])
  assert.equal((await call('memory-view', { roomId: 'nope' })).error.message, 'Unknown group chat')
})

// Lines reach a group's log as posts, through the relay; the aborted round lets no
// member speak.
const postToGroup = async (ctx, texts) => {
  for (const text of texts) {
    const event = { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'b3', senderName: 'Coder' }, content: [{ type: 'text', text }] } }
    for (const listener of ctx.listeners.get('session/event')) listener({ id: 'r1' }, event)
  }
  await rt.teamTools.find(d => d.name === 'group_relay').execute({}, { agent: { id: 'r1' }, callId: 'relay', signal: AbortSignal.abort() })
}

test('a queued review keeps the group lines that leave the log while it waits', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'chat:b2': 9, 'group:r1': 5 }))
  const log = [{ who: 'User', text: 'Call me Lu from now on', seq: 6 }, ...Array.from({ length: 39 }, (_, at) => ({ who: 'Coder', botId: 'b3', text: `Step ${at + 1}`, seq: at + 7 }))]
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, sessions: { b2: 'g2', b3: 'g3' }, seq: 45, log } } }))
  let release
  const replies = [new Promise(resolve => { release = resolve }), ...Array.from({ length: 6 }, () => JSON.stringify({ changes: [] }))]
  const { ctx, call, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  // A slow review of Writer's own chat holds the queue.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await until(() => requests.length === 1)
  assert.equal(requests.length, 1)
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await postToGroup(ctx, Array.from({ length: 50 }, (_, at) => `More ${at + 1}`))
  release(JSON.stringify({ changes: [] }))
  await reviewed(call)
  const group = requests.map(request => request.messages[0].content[0].text).filter(text => text.startsWith('The group chat: "Launch"'))
  assert.match(group[0], /\nUser: Call me Lu from now on\n/)
})

test('what is said after a member leaves is still reviewed, for the group', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The launch moved to Friday' }] })], config: { memoryReviewDelayMs: 200 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  assert.equal((await call('update-room', { id: 'r1', remove: ['b2'] })).ok, true)
  await postToGroup(ctx, ['The launch moved to Friday'])
  await reviewed(call)
  assert.equal(requests.length, 1)
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /^The group chat: "Launch", with the user and Coder \(admin\), Temp\./)
  assert.match(text, /\nUser: Keep everything you send me under one page\nCoder: Will do\.\n[\s\S]*The launch moved to Friday/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The launch moved to Friday \[id: [0-9a-f]{4}; source: group "Launch"/)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
})

test('a group deleted while its review writes keeps no more of it, and its folder stays gone', async (t) => {
  const many = Array.from({ length: 8 }, (_, at) => ({ op: 'add', text: `The group likes thing ${at + 1}` }))
  const { ctx, home, call, stop } = start({ replies: [JSON.stringify({ changes: many })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  const folder = join(home, 'memory', 'groups', 'r1')
  while (!existsSync(join(folder, 'MEMORY.md'))) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  await reviewed(call)
  assert.equal(existsSync(folder), false)
  const [archived] = readdirSync(join(home, 'memory', 'archive'))
  assert.ok(parseMemory(readFileSync(join(home, 'memory', 'archive', archived, 'MEMORY.md'), 'utf8')).entries.length < 8)
  assert.equal(existsSync(join(home, 'memory', 'team', 'MEMORY.md')), false)
})

test('a turn that ends after its member left the group is still reviewed, for the group', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants one page' }] })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'running' })
  assert.equal((await call('update-room', { id: 'r1', remove: ['b2'] })).ok, true)
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].messages[0].content[0].text, /^The group chat: "Launch"[\s\S]*\nUser: Keep everything you send me under one page\n/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The user wants one page \[id: [0-9a-f]{4}; source: group "Launch"/)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
})

test('a keeper out of the group during the review keeps the place, and the next keeper reads the lines again', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  let release
  const replies = [new Promise(resolve => { release = resolve }), JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page' }] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await until(() => requests.length === 1)
  // The admin — the review's keeper — leaves the group before its model answers.
  assert.equal((await call('update-room', { id: 'r1', remove: ['b3'] })).ok, true)
  release(JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page' }] }))
  await reviewed(call)
  // Nothing was written and the cursor stayed at the first pass's mark, so the same
  // lines are read again instead of being skipped for good.
  assert.throws(() => read('groups', 'r1', 'MEMORY.md'), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 0 })
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  assert.match(requests[1].messages[0].content[0].text, /\nUser: Keep everything you send me under one page\n/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The user wants everything under one page \[id: [0-9a-f]{4}; source: group "Launch"/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 3 })
})

test('a Bot deleted while its review writes keeps no more of it, and its folder stays gone', async (t) => {
  const many = Array.from({ length: 8 }, (_, at) => ({ op: 'add', text: `The user likes thing ${at + 1}` }))
  const { ctx, home, call, stop } = start({ replies: [JSON.stringify({ changes: many })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  const folder = join(home, 'memory', 'bots', 'b2')
  while (!existsSync(join(folder, 'MEMORY.md'))) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await reviewed(call)
  assert.equal(existsSync(folder), false)
})

test('a long user message keeps both ends for the review', async (t) => {
  const long = `Background ${'x'.repeat(5000)} From now on, always answer in English.`
  const history = { b2: [{ event: { seq: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: long }] } } }] }
  const { ctx, call, requests, stop } = start({ replies: [JSON.stringify({ changes: [] })], history, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /\nUser: Background x+ …\(middle cut\)… x+ From now on, always answer in English\.\n/)
  assert.ok(text.length < 3_400)
})

test('a group deleted before its review keeps nothing more, in no memory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants one page' }] })], config: { memoryReviewDelayMs: 200 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  await reviewed(call)
  assert.equal(requests.length, 0)
  for (const where of [['groups', 'r1'], ['bots', 'b2'], ['team']]) assert.equal(existsSync(join(home, 'memory', ...where)), false, where.join('/'))
})

test('a first chat review pages back to the user\'s latest line', async (t) => {
  const events = Array.from({ length: 900 }, (_, at) => (at + 1 === 50
    ? { event: { seq: 50, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I work on Linux' }] } } }
    : { event: { seq: at + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `ok ${at + 1}` }] } } } }))
  const { ctx, call, requests, stop } = start({ replies: [JSON.stringify({ changes: [] })], history: { b2: events }, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages[0].content[0].text.includes('\nUser: I work on Linux\n'))
})

test('a chat review reads back to its cursor through every page', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'chat:b2': 10 }))
  const events = Array.from({ length: 900 }, (_, at) => (at + 1 === 50
    ? { event: { seq: 50, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I work on Linux' }] } } }
    : { event: { seq: at + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `ok ${at + 1}` }] } } } }))
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [] })], history: { b2: events }, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages[0].content[0].text.includes('\nUser: I work on Linux\n'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 900 })
})

test('a review shows both MEMORY.md files whole, then the newest topic entries that fit', () => {
  const own = [{ entries: [{ text: 'A', meta: {} }] }, { topic: 't', entries: [{ text: 'old', meta: { added: '2026-01-01' } }, { text: 'new', meta: { added: '2026-10-01' } }] }]
  const team = [{ entries: [{ text: 'T', meta: {} }] }]
  const { numbered, left } = reviewEntries(own, team, 5)
  assert.deepEqual(numbered.map(entry => [entry.scope, entry.file.topic, entry.text]), [['own', undefined, 'A'], ['team', undefined, 'T'], ['own', 't', 'new']])
  assert.equal(left, 1)
  assert.equal(reviewEntries(own, team).left, 0)
  // One entry too long for what is left does not keep out a shorter one after it.
  const tight = [{ entries: [{ text: 'A', meta: {} }] }, { topic: 't', entries: [{ text: 'x'.repeat(5), meta: { added: '2026-10-01' } }, { text: 'yy', meta: { added: '2026-01-01' } }] }]
  const fit = reviewEntries(tight, [{ entries: [] }], 5)
  assert.deepEqual(fit.numbered.map(entry => entry.text), ['A', 'yy'])
  assert.equal(fit.left, 1)
})

test('a turn whose Session moves to a fresh part before its review is still reviewed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants short answers' }] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 200 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  // Before the review is due, the chat moves on to part 2 and this host takes over.
  const moved = { ...TEAM, bots: { ...TEAM.bots, b2: { ...TEAM.bots.b2, sessionId: 'b2-next', segments: [{ sessionId: 'b2', endedAt: Date.now() }] } } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(moved))
  rmSync(join(home, 'state.lock'))
  await call('state', {})
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- The user wants short answers \[id: [0-9a-f]{4}; source: part 1 #/)
  assert.deepEqual(Object.keys(JSON.parse(read('reviewed.json'))), ['chat:b2'])
})

test('config.memoryReview false leaves memory to the Bots\' own remember calls', async (t) => {
  const { ctx, call, section, requests, stop } = start({ config: { memoryReview: false, memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  assert.equal(ctx.calls.filter(entry => entry === 'on agent/status').length, 4)
  await call('state', {})
  assert.match(section('b2'), /Call it in that same turn, before you reply/)
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await settle()
  assert.equal((await call('state', {})).value.memoryReviews, 0)
  assert.equal(requests.length, 0)
})

test('config.memory false leaves the tools, the section, and the panel out', async (t) => {
  const { ctx, call, stop } = start({ config: { memory: false } })
  t.after(() => stop())
  assert.ok(!ctx.calls.some(entry => /tool (remember|forget|recall)|bot-memory/.test(entry)))
  assert.equal((await call('state', {})).value.memory, false)
  assert.equal((await call('memory-view', { botId: 'b2' })).error.message, 'Memory is turned off on this host')
  // The first state call applies the Bots' models and saves; let that finish first.
  await settle()
})

// Routes such as OpenCode Go turn down a request that names no Session. Each memory
// call names the Bot's own current chat.
const idleSession = { requestHeader: () => undefined }
test('a memory summary names the Bot chat on both of its tries', async (t) => {
  const { tool, call, requests, stop } = start({ requireSession: true, replies: [{ text: 'Half', finish: 'max-tokens' }, 'You like tea.'] })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const view = (await call('memory-view', { botId: 'b2' })).value
  assert.equal(view.error, null)
  assert.equal(view.summary?.text, 'You like tea.')
  assert.deepEqual(requests.map(request => [request.sessionId, request.maxTokens, request.purpose]), [['b2', 2048, undefined], ['b2', 8192, undefined]])
})

test('a memory panel question names the Bot chat', async (t) => {
  const { call, requests, stop } = start({ requireSession: true, replies: [JSON.stringify({ reply: 'You have no entries yet.', changes: [] })] })
  t.after(() => stop())
  const answer = await call('memory-ask', { botId: 'b2', text: 'What do you remember?' })
  assert.equal(answer.ok, true)
  assert.equal(answer.value.reply, 'You have no entries yet.')
  assert.equal(requests[0].sessionId, 'b2')
})

test('a memory review of a Bot chat names that chat and saves its changes', async (t) => {
  const { ctx, call, read, requests, stop } = start({
    requireSession: true, config: { memoryReviewDelayMs: 0 },
    replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants this remembered' }] })],
  })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2', session: idleSession }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'b2')
  assert.match(read('bots', 'b2', 'MEMORY.md'), /The user wants this remembered/)
})

test('a memory review of a group names the group chat', async (t) => {
  const { ctx, call, read, requests, stop } = start({
    requireSession: true, config: { memoryReviewDelayMs: 0 },
    replies: [JSON.stringify({ changes: [{ op: 'add', text: 'Keep replies under one page' }] })],
  })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3', session: idleSession }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'r1')
  assert.match(read('groups', 'r1', 'MEMORY.md'), /Keep replies under one page/)
})

test('a memory call names the current part of the Bot chat', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const team = structuredClone(TEAM)
  team.bots.b2.sessionId = 'b2-part2'
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const { call, requests, stop } = start({ home, requireSession: true, replies: [JSON.stringify({ reply: 'This part.', changes: [] })] })
  t.after(() => stop())
  const answer = await call('memory-ask', { botId: 'b2', text: 'Which part?' })
  assert.equal(answer.ok, true)
  assert.equal(requests[0].sessionId, 'b2-part2')
})
