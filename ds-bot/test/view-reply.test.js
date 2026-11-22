import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { normalizeView, VIEW_BYTE_LIMIT, viewBytes } from 'deep-view/core'
import { goalProvider } from '../src/host/goal-skills.js'
import { replyText } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

let rt

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: {
      id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer-now', createdAt: 2,
      segments: [{ sessionId: 'writer-old', endedAt: 1 }],
    },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['writer'], mode: 'admin', admin: 'writer', named: true, sessions: { writer: 'writer-group' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const CHOICES = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const METER = { type: 'metric', label: '进度', value: '70%' }

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-views-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const sent = []
  let flushError
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, unarchiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup(message) { sent.push({ sessionId, message }) } } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => { if (flushError !== undefined) throw flushError } },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  // show_view lives in the agent scope; a Bot agent appearing registers it.
  await ctx.emitAsync('agent/created', { agent: ctx.scopeAgent('writer-now') })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const show = async (sessionId, args, callId = 'call-1') => {
    let concluded = false
    const text = await rt.teamTools.find(d => d.name === 'show_view').execute(args, {
      agent: { id: sessionId }, callId, concludeTurn() { concluded = true },
    })
    return { text, concluded }
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const team = async () => (await call('state', {})).value
  return {
    ctx, emit, show, call, team, sent,
    failFlush(error) { flushError = error },
    stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) },
  }
}

const text = value => [{ type: 'text', text: value }]

async function prepareIssue(args = {}) {
  const prepared = await rt.teamTools.find(tool => tool.name === 'prepare_ds_bot_issue').execute({
    title: 'Chat history disappears',
    what: 'Expected the conversation to stay open.',
    steps: '1. Open chat.\n2. Reload.',
    ...args,
  }, { agent: { id: 'writer-now' } })
  return JSON.parse(prepared.slice(prepared.indexOf('\n') + 1))
}

test('the bundled report skill can be invoked by the model and by the user', async () => {
  const provider = goalProvider()
  const item = (await provider.list()).find(skill => skill.name === 'report-ds-bot-issue')
  assert.deepEqual(item.invocation, { modelInvocable: true, userInvocable: true })
  assert.match((await provider.get(item)).content, /prepare_ds_bot_issue.*show_view/)
})

test('only the matching affirmative view reply publishes the redacted issue shown to the user', async (t) => {
  const { call, show, team, sent, stop } = await start()
  t.after(stop)
  const writes = []
  const savedSecret = ['only', 'known', 'to', 'host'].join('-')
  rt.redactSecrets = value => value.replaceAll(savedSecret, '[hidden]')
  rt.publishDsBotIssue = async (botId, draft) => {
    writes.push({ botId, ...draft })
    return 'https://github.com/Fei2411/DS-Bot/issues/42'
  }
  const draft = await prepareIssue({ what: `Error in ${homedir()}/a with ${savedSecret}` })
  const action = draft.view.children.at(-1).id
  const tampered = await show('writer-now', { ...draft, title: 'Not the approved title' })
  assert.match(tampered.text, /draft changed or expired/)
  const wrongChat = await show('chief', draft)
  assert.match(wrongChat.text, /draft changed or expired/)
  assert.equal((await show('writer-now', draft)).concluded, true)
  assert.match((await show('writer-now', draft)).text, /draft changed or expired/)
  const pending = (await team()).views['writer-now']
  assert.equal(writes.length, 0)
  const reply = { sessionId: 'writer-now', viewId: pending.id, action, values: { confirmed: true } }
  assert.equal((await call('view-reply', { ...reply, viewId: 'stale' })).ok, false)
  assert.equal((await call('view-reply', { ...reply, values: { confirmed: 'yes' } })).ok, false)
  const answers = await Promise.all([call('view-reply', reply), call('view-reply', reply)])
  assert.equal(answers.filter(result => result.ok).length, 1)
  assert.deepEqual(answers.find(result => result.ok).value, { issueReportResult: 'Issue published: https://github.com/Fei2411/DS-Bot/issues/42' })
  assert.equal(writes.length, 1)
  const [{ botId, title, body }] = writes
  assert.equal(botId, 'writer')
  assert.equal(title, draft.title)
  assert.equal(pending.view.children[1].text, `\`\`\`\n${body}\n\`\`\``)
  assert.match(body, /Error in ~\/a with \[hidden\]/)
  assert.match(body, /### Diagnostics\n\nDS Bot: .+\n[\s\S]*OS: /)
  assert.ok(!JSON.stringify(draft).includes(savedSecret))
  const followup = sent.at(-1).message.content[0].text
  assert.equal(JSON.parse(followup).answers[0].values.confirmed, true)
  assert.match(replyText(followup), /Issue published: https:\/\/github\.com\/Fei2411\/DS-Bot\/issues\/42$/)
})

test('cancel, dismiss, a typed yes, and a plain confirmation card never publish an issue', async (t) => {
  const { call, emit, show, team, stop } = await start()
  t.after(stop)
  let writes = 0
  rt.publishDsBotIssue = async () => { writes += 1 }
  const approve = async (confirmed = true) => {
    const { id, view } = (await team()).views['writer-now']
    return { sessionId: 'writer-now', viewId: id, action: view.children.at(-1).id, values: { confirmed } }
  }
  const args = await prepareIssue()
  await show('writer-now', args)
  assert.equal((await call('view-reply', await approve(false))).ok, true)
  await show('writer-now', await prepareIssue())
  const dismissed = await approve()
  await call('dismiss-view', { sessionId: dismissed.sessionId })
  assert.equal((await call('view-reply', dismissed)).ok, false)
  await show('writer-now', await prepareIssue())
  const typed = await approve()
  emit('writer-now', 'user/message', { content: text('yes'), source: { kind: 'user' } })
  assert.equal((await call('view-reply', typed)).ok, false)
  await show('writer-now', { title: args.title, view: args.view })
  assert.equal((await call('view-reply', await approve())).ok, true)
  assert.equal(writes, 0)
})

test('an unconnected report returns a capped prefilled link, and a failed followup cannot replay approval', async (t) => {
  const { call, failFlush, show, team, stop } = await start()
  t.after(stop)
  const args = await prepareIssue({ what: '故障😀'.repeat(300) })
  const open = async () => {
    const { id, view } = (await team()).views['writer-now']
    return { sessionId: 'writer-now', viewId: id, action: view.children.at(-1).id, values: { confirmed: true } }
  }
  assert.equal((await show('writer-now', args)).concluded, true)
  const fallback = await call('view-reply', await open())
  assert.equal(fallback.ok, true)
  const link = fallback.value.issueReportResult.match(/https:\/\/\S+/)[0]
  assert.ok(link.length <= 4000)
  const url = new URL(link)
  assert.equal(url.origin + url.pathname, 'https://github.com/Fei2411/DS-Bot/issues/new')
  assert.equal(url.searchParams.get('template'), 'bug.yml')
  assert.equal(url.searchParams.get('title'), args.title)
  assert.match(url.searchParams.get('what'), /^(?:故障😀)+故?障?…$/)
  assert.equal(url.searchParams.get('steps'), '1. Open chat.\n2. Reload.')
  assert.match(url.searchParams.get('diagnostics'), /^DS Bot: .+\n[\s\S]*OS: /)
  assert.equal(url.searchParams.has('body'), false)
  assert.equal(url.searchParams.has('clean'), false)

  rt.publishDsBotIssue = async () => { throw new Error('Could not confirm whether GitHub accepted the issue') }
  await show('writer-now', await prepareIssue())
  const uncertain = await call('view-reply', await open())
  assert.match(uncertain.value.issueReportResult, /Check existing issues before submitting manually: https:\/\//)

  let writes = 0
  rt.publishDsBotIssue = async () => { writes += 1; return 'https://github.com/Fei2411/DS-Bot/issues/42' }
  await show('writer-now', await prepareIssue())
  const reply = await open()
  failFlush(new Error('could not flush'))
  assert.equal((await call('view-reply', reply)).ok, false)
  assert.equal((await call('view-reply', reply)).ok, false)
  assert.equal(writes, 1)
})

test('the capped fallback keeps a complete field when dropping its ellipsis makes it fit', async (t) => {
  const { call, show, team, stop } = await start()
  t.after(stop)
  rt.diagnostics.issueFacts = () => 'OS: mocked'
  const steps = 'x'.repeat(443) + 'turn automatic refresh off.'
  const args = await prepareIssue({ what: '故'.repeat(365) + 'x'.repeat(405), steps })
  assert.equal((await show('writer-now', args)).concluded, true)
  const { id, view } = (await team()).views['writer-now']
  const reply = await call('view-reply', {
    sessionId: 'writer-now', viewId: id, action: view.children.at(-1).id, values: { confirmed: true },
  })
  const link = reply.value.issueReportResult.match(/https:\/\/\S+/)[0]
  const url = new URL(link)
  assert.ok(link.length <= 4000)
  assert.match(url.searchParams.get('what'), /…$/)
  assert.equal(url.searchParams.get('steps'), steps)
})

test('someone else’s home paths are redacted from the public preview and manual report', async (t) => {
  const { call, show, team, stop } = await start()
  t.after(stop)
  const args = await prepareIssue({
    title: 'Could not open /Users/Shared/Documents/notes.txt from /Users/Shared.',
    what: 'Reload fails in /home/user/work/project (/home/user)',
    diagnostics: 'Windows failed in C:\\Users\\John Smith\\AppData\\x.log\nProfile: C:\\Users\\Jane Doe',
  })
  assert.equal(args.title, 'Could not open ~/Documents/notes.txt from ~.')
  assert.match(args.view.children[1].text, /Reload fails in ~\/work\/project \(~\)/)
  assert.match(args.view.children[1].text, /Windows failed in ~\/AppData\\x\.log\nProfile: ~\n/)
  assert.equal((await show('writer-now', args)).concluded, true)
  const { id, view } = (await team()).views['writer-now']
  const reply = await call('view-reply', {
    sessionId: 'writer-now', viewId: id, action: view.children.at(-1).id, values: { confirmed: true },
  })
  const url = new URL(reply.value.issueReportResult.match(/https:\/\/\S+/)[0])
  assert.equal(url.searchParams.get('title'), args.title)
  assert.equal(url.searchParams.get('what'), 'Reload fails in ~/work/project (~)')
  assert.match(url.searchParams.get('diagnostics'), /Windows failed in ~\/AppData\\x\.log\nProfile: ~$/)
})

test('issue report redaction preserves prose after bare Windows homes', async (t) => {
  const { call, show, team, stop } = await start()
  t.after(stop)
  const args = await prepareIssue({
    what: 'Could not open C:\\Users\\Jane Doe and more text',
    steps: 'Open C:\\Users\\Jane Doe but keep the log. Then open "C:\\Users\\Research and Development".',
    diagnostics: 'Failed at "C:\\Users\\Jane (and Doe)" and (C:\\Users\\Jane and Doe).',
  })
  const what = 'Could not open ~ and more text'
  const steps = 'Open ~ but keep the log. Then open "~".'
  const diagnostics = 'Failed at "~)" and (~).'
  assert.ok(args.view.children[1].text.includes(what))
  assert.ok(args.view.children[1].text.includes(steps))
  assert.ok(args.view.children[1].text.includes(diagnostics))
  assert.equal((await show('writer-now', args)).concluded, true)
  const { id, view } = (await team()).views['writer-now']
  const reply = await call('view-reply', {
    sessionId: 'writer-now', viewId: id, action: view.children.at(-1).id, values: { confirmed: true },
  })
  const url = new URL(reply.value.issueReportResult.match(/https:\/\/\S+/)[0])
  assert.equal(url.searchParams.get('what'), what)
  assert.equal(url.searchParams.get('steps'), steps)
  assert.ok(url.searchParams.get('diagnostics').endsWith(diagnostics))
})

test('issue report redaction hides both bare Windows homes on the same line', async (t) => {
  const { call, show, team, stop } = await start()
  t.after(stop)
  const what = [
    'C:\\Users\\Jane Doe then C:\\Users\\Bob Ray or so',
    'C:\\Users\\Jane Doe and C:\\Users\\Bob Ray',
    '(C:\\Users\\Jane Doe then C:\\Users\\Bob Ray)',
    'C:\\Users\\Jane Doe and more text',
    'C:\\Users\\Jane Doe.',
    'C:\\Users\\John Smith\\AppData',
  ].join('\n')
  const expected = ['~ ~ or so', '~ ~', '(~ ~)', '~ and more text', '~.', '~/AppData'].join('\n')
  const args = await prepareIssue({ what })
  assert.ok(args.view.children[1].text.includes(expected))
  assert.equal((await show('writer-now', args)).concluded, true)
  const { id, view } = (await team()).views['writer-now']
  const reply = await call('view-reply', {
    sessionId: 'writer-now', viewId: id, action: view.children.at(-1).id, values: { confirmed: true },
  })
  const url = new URL(reply.value.issueReportResult.match(/https:\/\/\S+/)[0])
  assert.equal(url.searchParams.get('what'), expected)
})

test('issue report redaction preserves the destination of a failed rename', async (t) => {
  const { stop } = await start()
  t.after(stop)
  const messages = [
    "rename '/Users/Shared' -> '/opt/notes.txt'",
    'rename /home/user -> /opt/notes.txt',
    'rename "C:\\Users\\Public" -> "D:\\data\\notes.txt"',
    'rename C:\\Users\\Public -> D:\\data\\notes.txt',
  ]
  const args = await prepareIssue({ what: messages.join('\n') })
  const expected = [
    "rename '~' -> '/opt/notes.txt'",
    'rename ~ -> /opt/notes.txt',
    'rename "~" -> "D:\\data\\notes.txt"',
    'rename ~ -> D:\\data\\notes.txt',
  ]
  assert.ok(args.view.children[1].text.includes(expected.join('\n')))
})

test('show_view registers an interactive card, refuses a group and a display-only wait, and leaves a display-only card unregistered', async (t) => {
  const { emit, show, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })

  const group = await show('writer-group', { title: 'Pick', view: CHOICES })
  assert.equal(group.text, 'View cards only work in your own chat. In a group, ask in your message instead.')
  assert.equal(group.concluded, false)
  const stranger = await show('outsider', { title: 'Pick', view: CHOICES })
  assert.match(stranger.text, /^Only Bots on the team can use show_view\. Use ask_user_question if it is available in this session, or ask the user in your reply\.$/)
  assert.equal(stranger.concluded, false)

  const waiting = await show('writer-now', { title: 'Meter', view: METER, await_reply: true })
  assert.equal(waiting.text, 'This view has nothing to submit; call show_view with await_reply: false.')
  assert.equal(waiting.concluded, false)
  assert.equal((await team()).views['writer-now'], undefined)

  // An interactive card cannot be told not to wait: refused, nothing stored.
  const skipped = await show('writer-now', { title: 'Pick', view: CHOICES, await_reply: false })
  assert.equal(skipped.text, 'This view has controls to submit, so it waits for the user\'s answer; call show_view without await_reply: false.')
  assert.equal(skipped.concluded, false)
  assert.equal((await team()).views['writer-now'], undefined)

  // `__proto__` is no id: the answer object would lose the value to its prototype.
  const protoCall = await show('writer-now', { title: 'Pick', view: { ...CHOICES, id: '__proto__' } })
  assert.equal(protoCall.text, 'view.id: "__proto__" cannot be an id')
  const protoField = await show('writer-now', { title: 'Ask', view: { type: 'form', id: 'ask', fields: [{ id: '__proto__', label: 'Name' }] } })
  assert.equal(protoField.text, 'view.fields[0].id: "__proto__" cannot be an id')
  assert.equal((await team()).views['writer-now'], undefined)

  const shown = await show('writer-now', { title: 'Meter', view: METER })
  assert.equal(shown.text, 'The view is on screen.')
  assert.equal(shown.concluded, false)
  assert.equal((await team()).views['writer-now'], undefined)

  // A question card and a view card in the same chat do not replace each other.
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  const asked = await show('writer-now', { title: 'Pick', view: CHOICES })
  assert.equal(asked.text, 'The view is on screen; the user\'s answer arrives as their next message.')
  assert.equal(asked.concluded, true)
  const open = await team()
  assert.equal(open.questions['writer-now'].question, 'Which name?')
  assert.equal(open.views['writer-now'].title, 'Pick')
  assert.equal(open.views['writer-now'].callId, 'call-1')
  assert.equal(typeof open.views['writer-now'].id, 'string')
  assert.equal(typeof open.views['writer-now'].askedAt, 'number')
  assert.deepEqual(open.views['writer-now'].view, CHOICES)

  // A hidden Bot-to-Bot turn keeps both the card and its call id.
  emit('writer-now', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('writer-now', 'turn/start', { turn: 2 })
  emit('writer-now', 'user/message', { content: text('[Message from Chief]\nAsk them'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x1', hop: 0 } })
  const hidden = await show('writer-now', { title: 'Pick', view: CHOICES }, 'call-hidden')
  assert.equal(hidden.concluded, true)
  assert.equal((await team()).views['writer-now'].callId, 'call-hidden')
  assert.equal((await team()).views['writer-now'].title, 'Pick')

  const body = JSON.stringify(METER)
  const room = VIEW_BYTE_LIMIT - viewBytes('', METER)
  const exact = await show('writer-now', { title: 'x'.repeat(room), view: METER, await_reply: false })
  assert.equal(exact.text, 'The view is on screen.')
  const over = await show('writer-now', { title: `${'x'.repeat(room)}y`, view: METER })
  assert.equal(over.text, `The view is ${viewBytes(`${'x'.repeat(room)}y`, METER)} bytes; the limit is ${VIEW_BYTE_LIMIT}.`)
  assert.equal(over.concluded, false)
  assert.equal((await team()).views['writer-now'].title, 'Pick')
  assert.ok(body.length > 0)
})

test('view-reply claims the card, refuses a stale or invalid answer, and restores the card when queueing fails', async (t) => {
  const { show, call, team, sent, failFlush, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Keep me', options: [{ label: 'Yes' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES }, 'call-view')
  const pending = (await team()).views['writer-now']

  const stale = await call('view-reply', { sessionId: 'writer-now', viewId: 'gone', action: 'pick', values: { selected: ['A'] } })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'bot/stale')
  assert.equal(stale.error.message, 'This view is no longer open')
  assert.equal((await team()).views['writer-now'].id, pending.id)

  const invalid = await call('view-reply', { sessionId: 'writer-now', viewId: pending.id, action: 'pick', values: { selected: [] } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'bot/invalid')
  assert.match(invalid.error.message, /select at least one option/)
  assert.equal((await team()).views['writer-now'].id, pending.id)
  assert.equal(sent.length, 0)

  failFlush(new Error('flush failed'))
  const failed = await call('view-reply', { sessionId: 'writer', viewId: pending.id, action: 'pick', values: { selected: ['B', 'A'] } })
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /flush failed/)
  assert.equal(sent.length, 1)
  assert.equal((await team()).views['writer-now'].id, pending.id)
  sent.length = 0

  failFlush(undefined)
  // A Bot id, and an earlier part, both mean the current part.
  const answered = await call('view-reply', { sessionId: 'writer-old', viewId: pending.id, action: 'pick', values: { selected: ['B', 'nope'] } })
  assert.equal(answered.ok, true)
  assert.equal((await team()).views['writer-now'], undefined)
  // The question card is a different store; answering the view does not claim it.
  assert.equal((await team()).questions['writer-now'].question, 'Keep me')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'writer-now')
  const message = sent[0].message
  assert.equal(message.source.kind, 'user-question-reply')
  assert.equal(message.source.callId, 'call-view')
  assert.equal(message.source.outcome, 'answered')
  const payload = JSON.parse(message.content[0].text)
  assert.equal(payload.kind, 'answer_to_pending_view')
  assert.equal(payload.tool, 'show_view')
  assert.deepEqual(payload.answers, [{ id: pending.id, action: 'pick', values: { selected: ['B'] } }])
  assert.equal(payload.views[0].title, 'Pick')
  assert.deepEqual(payload.views[0].view, CHOICES)

  const again = await call('view-reply', { sessionId: 'writer-now', viewId: pending.id, action: 'pick', values: { selected: ['A'] } })
  assert.equal(again.error.message, 'This view is no longer open')
})

test('dismiss-view drops the open view, keeps it as a closed card, and leaves a question card alone', async (t) => {
  const { show, call, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Keep me', options: [{ label: 'Yes' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES })
  assert.equal((await call('dismiss-view', { sessionId: 'writer-now' })).ok, true)
  const open = await team()
  assert.equal(open.views['writer-now'], undefined)
  assert.equal(open.questions['writer-now'].question, 'Keep me')
  assert.deepEqual(open.closedCards, { 'writer-now': { 'call-1': 'dismissed' } })
  assert.equal((await call('dismiss-view', { sessionId: 'writer-now' })).ok, true)
  assert.equal((await call('dismiss-question', { sessionId: 'writer-now' })).ok, true)
  assert.deepEqual((await team()).closedCards, { 'writer-now': { 'call-1': 'dismissed', 'q-call': 'dismissed' } })
})

test('an answered view is not kept as a closed card: its reply message carries it', async (t) => {
  const { show, call, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await show('writer-now', { title: 'Pick', view: CHOICES })
  const pending = (await team()).views['writer-now']
  assert.equal((await call('view-reply', { sessionId: 'writer-now', viewId: pending.id, action: 'pick', values: { selected: ['A'] } })).ok, true)
  assert.deepEqual((await team()).closedCards, {})
})

test('a user message drops the open question and the open view together', async (t) => {
  const { emit, show, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }] },
    { agent: { id: 'writer-now' }, callId: 'q-call', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES })
  assert.equal((await team()).questions['writer-now'].question, 'Which name?')
  assert.equal((await team()).views['writer-now'].title, 'Pick')
  emit('writer-now', 'user/message', { content: text('never mind'), source: { kind: 'user' } })
  const open = await team()
  assert.equal(open.questions['writer-now'], undefined)
  assert.equal(open.views['writer-now'], undefined)
  // Both cards stay in the chat as answered by that message; nothing stays in a dock store.
  assert.deepEqual(open.closedCards, { 'writer-now': { 'q-call': 'replied', 'call-1': 'replied' } })
  assert.equal(open.closedViews, undefined)
})

test('a hidden-turn card closes into closedCards at its call, never into a dock record', async (t) => {
  const { emit, show, call, team, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  emit('writer-now', 'turn/start', { turn: 1 })
  emit('writer-now', 'user/message', { content: text('[Message from Chief]\nAsk them'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x1', hop: 0 } })
  await rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }] },
    { agent: { id: 'writer-now' }, callId: 'q-hidden', concludeTurn() {} },
  )
  await show('writer-now', { title: 'Pick', view: CHOICES }, 'v-hidden')
  emit('writer-now', 'user/message', { content: text('never mind'), source: { kind: 'user' } })
  let open = await team()
  assert.equal(open.questions['writer-now'], undefined)
  assert.equal(open.views['writer-now'], undefined)
  assert.deepEqual(open.closedCards, { 'writer-now': { 'q-hidden': 'replied', 'v-hidden': 'replied' } })
  assert.equal(open.closedViews, undefined)

  await show('writer-now', { title: 'Next', view: CHOICES }, 'v-hidden-2')
  assert.equal((await call('dismiss-view', { sessionId: 'writer-now' })).ok, true)
  open = await team()
  assert.equal(open.views['writer-now'], undefined)
  assert.equal(open.closedCards['writer-now']['v-hidden-2'], 'dismissed')
})

test('show_view measures the bytes the model sent, before unwrapping the provider encoding', async (t) => {
  const { show, stop } = await start()
  t.after(stop)
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  // Nested { item: ... } wrappers all disappear in normalization: measured after
  // unwrapping this card would pass with a fraction of the bytes it was sent with.
  let children = [{ type: 'text', text: 'x' }]
  while (viewBytes('', { type: 'stack', children }) <= VIEW_BYTE_LIMIT) children = { item: children }
  const wrapped = { type: 'stack', children }
  assert.ok(viewBytes('Meter', normalizeView(wrapped)) < VIEW_BYTE_LIMIT)
  const over = await show('writer-now', { title: 'Meter', view: wrapped, await_reply: false })
  assert.equal(over.text, `The view is ${viewBytes('Meter', wrapped)} bytes; the limit is ${VIEW_BYTE_LIMIT}.`)
  assert.equal(over.concluded, false)
})

test('a card carried from an earlier part records its close on the part that asked it, and legacy closedViews is dropped', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-views-legacy-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    ...TEAM,
    questions: { 'writer-now': { id: 'q1', callId: 'q-old', callSessionId: 'writer-old', question: 'Keep me', options: [{ label: 'Yes' }], askedAt: 1 } },
    views: { 'writer-now': { id: 'v1', callId: 'v-old', callSessionId: 'writer-old', title: 'First', view: CHOICES, askedAt: 1 } },
    closedViews: { 'writer-now': { id: 'stale', title: 'Stuck', closed: 'replied' } },
  }))
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, unarchiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const host = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  let open = (await call('state')).value
  assert.equal(open.closedViews, undefined)
  assert.equal('closedViews' in host.state, false)
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) listener({ id: 'writer-now' }, { type: 'user/message', seq: 1, data: { content: text('never mind'), source: { kind: 'user' } } })
  }
  open = (await call('state')).value
  assert.equal(open.questions['writer-now'], undefined)
  assert.equal(open.views['writer-now'], undefined)
  assert.deepEqual(open.closedCards, { 'writer-old': { 'q-old': 'replied', 'v-old': 'replied' } })
})
