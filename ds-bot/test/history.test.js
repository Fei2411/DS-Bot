import assert from 'node:assert/strict'
import { test } from 'node:test'
import { termQuery } from '../src/host/chat-index.js'
import { canonicalHeadings, cardText, historyEntry, questionReply, readReply, replyText, viewCardText } from '../src/host/parts.js'
import { VIEW_BYTE_LIMIT, viewBytes } from 'deep-view/core'

test('cardText shows a question card as the user saw it', () => {
  const card = { question: ' Start where? ', detail: 'pick one', options: [{ label: 'Plan' }, { label: ' ' }, { label: 'Draft' }] }
  assert.equal(cardText(card), '[Question card] Start where? (pick one)\nOptions: Plan / Draft')
  assert.equal(cardText(JSON.stringify({ question: 'Q', options: [{ label: 'A' }] })), '[Question card] Q\nOptions: A')
  assert.equal(cardText('{not json'), '')
  assert.equal(cardText({ question: 'Q', options: ['A'] }), '')
  assert.equal(cardText({ question: '', options: [{ label: 'A' }] }), '')
  assert.equal(cardText({ question: 'Q', options: [] }), '')
})

test('viewCardText records only a card the tool would show', () => {
  const meter = { type: 'metric', label: '进度', value: '70%' }
  const choices = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
  assert.equal(viewCardText({ title: 'Meter', view: meter }), '[View card] Meter\nmetric: 进度=70%')
  assert.equal(viewCardText(JSON.stringify({ title: 'Pick', view: choices })), '[View card] Pick\noptions: A/B')
  // A provider-wrapped array normalizes before the summary, as in the tool.
  const wrapped = { title: 'Pick', view: { type: 'stack', children: { item: { item: [choices] } } } }
  assert.equal(viewCardText(wrapped), '[View card] Pick\noptions: A/B')
  // A view needs no title.
  assert.equal(viewCardText({ title: ' ', view: meter }), '[View card]\nmetric: 进度=70%')
  // Calls the tool refuses showed no card: an unknown component or a broken one,
  // a wait the card cannot honor, or too many bytes as sent.
  assert.equal(viewCardText({ title: 'X', view: { type: 'chart' } }), '')
  assert.equal(viewCardText({ title: 'X', view: { type: 'gauge' } }), '')
  assert.equal(viewCardText({ title: 'Meter', view: meter, await_reply: true }), '')
  assert.equal(viewCardText({ title: 'Pick', view: choices, await_reply: false }), '')
  let children = [{ type: 'text', text: 'x' }]
  while (viewBytes('', { type: 'stack', children }) <= VIEW_BYTE_LIMIT) children = { item: children }
  assert.equal(viewCardText({ title: 'Big', view: { type: 'stack', children } }), '')
  const shown = { type: 'tool/call', data: { name: 'show_view', arguments: { title: 'Meter', view: meter } } }
  assert.deepEqual(historyEntry(shown, false), { answer: true, text: '[View card] Meter\nmetric: 进度=70%' })
  const refused = { type: 'tool/call', data: { name: 'show_view', arguments: { title: 'X', view: { type: 'chart' } } } }
  assert.equal(historyEntry(refused, false), undefined)
})

const said = (text, source) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source } })

test('historyEntry keeps answers, user and Bot messages, and skips setup', () => {
  assert.deepEqual(historyEntry({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hi' }] } } }, false), { answer: true, text: 'Hi' })
  assert.equal(historyEntry({ type: 'assistant/message', data: { message: { content: [] } } }, false), undefined)
  const ask = { type: 'tool/call', data: { name: 'ask_user', arguments: { question: 'Q', options: [{ label: 'A' }] } } }
  assert.deepEqual(historyEntry(ask, false), { answer: true, text: '[Question card] Q\nOptions: A' })
  assert.equal(historyEntry(ask, true), undefined)
  const asked = { type: 'tool/ptc-dispatch-start', data: { parentCallId: 'k1', subCallId: 'k1:ptc:1', name: 'ask_user', arguments: { question: 'Q', options: [{ label: 'A' }] } } }
  assert.deepEqual(historyEntry(asked, false), { answer: true, text: '[Question card] Q\nOptions: A' })
  assert.equal(historyEntry(asked, true), undefined)
  assert.equal(historyEntry({ ...asked, type: 'tool/ptc-dispatch' }, false), undefined)
  assert.deepEqual(historyEntry(said('hello', { kind: 'user' }), false), { answer: false, who: 'user', text: 'hello', keepAnswers: true })
  assert.deepEqual(historyEntry(said('[Reply from W]\nok', { kind: 'bot', role: 'reply' }), false), { answer: false, who: 'bot', text: '[Reply from W]\nok', keepAnswers: true })
  assert.deepEqual(historyEntry(said('[Bot team setup]\nhi', { kind: 'bot', role: 'kickoff' }), false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  assert.deepEqual(historyEntry(said('[Handoff · part 2]', { kind: 'bot', handoff: true }), false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  assert.deepEqual(historyEntry(said('[Handoff · part 2]', { kind: 'bot', handoff: true, resume: true }), false), { answer: false, who: 'bot', text: '', keepAnswers: true })
  assert.deepEqual(historyEntry(said('[Group chat "G" · new message]', { kind: 'bot', role: 'room' }), false), { answer: false, who: 'bot', text: '', keepAnswers: false })
  assert.equal(historyEntry(said('[Group chat "G" · new message]', { kind: 'bot', role: 'room' }), true).text, '[Group chat "G" · new message]')
  assert.equal(historyEntry(said('time: now', { kind: 'plugin' }), false), undefined)
})

test('termQuery matches long words with FTS5 and short ones with LIKE', () => {
  const sessions = ['s1', 's2']
  assert.deepEqual(termQuery(['needle', 'a"b"c'], sessions, 20), {
    sql: 'SELECT text, session, seq, time, who FROM lines WHERE lines MATCH ? AND session IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT 20',
    args: ['"needle" "a""b""c"', '["s1","s2"]'],
  })
  assert.deepEqual(termQuery(['会议', '5%'], sessions, 5, { session: 's2', from: 40 }), {
    sql: "SELECT text, session, seq, time, who FROM lines WHERE session IN (SELECT value FROM json_each(?)) AND NOT (session = ? AND seq >= ?) AND text LIKE ? ESCAPE '\\' AND text LIKE ? ESCAPE '\\' ORDER BY time DESC LIMIT 5",
    args: ['["s1","s2"]', 's2', 40, '%会议%', '%5\\%%'],
  })
})

test('a card answer carries its question, so it reads on its own', () => {
  const question = { id: 'q1', callId: 'call-1', question: 'Start where?', options: [{ label: 'Plan' }, { label: 'Draft' }], multiSelect: false }
  const reply = questionReply(question, { selected: ['Draft', 'Plan'], custom: '  ' })
  assert.deepEqual(reply.source, { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' })
  const payload = JSON.parse(reply.text)
  assert.equal(payload.tool, 'ask_user')
  assert.deepEqual(payload.answers, [{ id: 'q1', selected: ['Draft'] }])
  assert.equal(replyText(reply.text), '[Answer to question card] Start where?\nAnswer: Draft')
  const event = { type: 'user/message', data: { source: reply.source, content: [{ type: 'text', text: reply.text }] } }
  assert.deepEqual(historyEntry(event, false), { answer: false, who: 'user', text: '[Answer to question card] Start where?\nAnswer: Draft', keepAnswers: true })
  assert.deepEqual(readReply(reply.text).questions[0].options, question.options)
})

test('a card answer keeps several picks and the user\'s own words', () => {
  const question = { id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }
  const reply = questionReply(question, { selected: ['A', 'B', 'Z'], custom: 'also C' })
  assert.equal(reply.source.callId, 'q1')
  assert.equal(replyText(reply.text), '[Answer to question card] Which?\nAnswer: A, B, also C')
  assert.equal(questionReply(question, { selected: ['Z'], custom: '' }), undefined)
  assert.equal(replyText('plain words'), 'plain words')
})

test('canonicalHeadings restores translated note headings only when every heading is there', () => {
  const names = ['Goals', 'Next step']
  assert.equal(canonicalHeadings('## 目标\n- a\n## 下一步\n- b', names), '## Goals\n- a\n## Next step\n- b')
  assert.equal(canonicalHeadings('## 目标\n- a', names), '## 目标\n- a')
  assert.equal(canonicalHeadings('## Goals\n- a\n## Next step\n- b\n## extra', names), '## Goals\n- a\n## Next step\n- b\n## extra')
})

test('canonicalHeadings keeps a note whose known headings are repeated or out of order', () => {
  const names = ['Goals', 'Progress', 'Decisions']
  const repeated = '## 目标\n- a\n## Progress\n- b\n## Progress\n- c'
  assert.equal(canonicalHeadings(repeated, names), repeated)
  const swapped = '## Progress\n- b\n## 目标\n- a\n## 决定\n- c'
  assert.equal(canonicalHeadings(swapped, names), swapped)
  assert.equal(canonicalHeadings('## 目标\n- a\n## Progress\n- b\n## 决定\n- c', names), '## Goals\n- a\n## Progress\n- b\n## Decisions\n- c')
})
