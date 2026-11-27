import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesPendingView, splitChatViews, viewFocusKey, viewHasControls, viewReminderLabel } from './inline-views.ts'
import { setLang, t } from '../../ui/i18n.ts'

test('splitChatViews places transcript-backed views inline and falls back missing ones to the dock', () => {
  const rows = [
    { key: 'bot-3', item: { kind: 'bot' } },
    { key: 'view-v-1', item: { kind: 'view', id: 'v-1', callId: 'c-1', pending: true } },
    { key: 'view-display', item: { kind: 'view', callId: 'c-0' } },
  ]
  const inlineEntry = { sessionId: 's1', view: { id: 'v-1', callId: 'c-1', title: 'Release readiness', view: {} } }
  const hiddenEntry = { sessionId: 's1', view: { id: 'v-2', callId: 'c-hidden', title: 'Hidden card', view: {} } }
  const rolledOverEntry = { sessionId: 's2', view: { id: 'v-3', title: 'From earlier part', view: {} } }

  const split = splitChatViews(rows, [inlineEntry, hiddenEntry, rolledOverEntry])
  assert.equal(split.inline.length, 1)
  assert.equal(split.inline[0].rowIndex, 1)
  assert.equal(split.inline[0].rowKey, 'view-v-1')
  assert.equal(split.inlineByKey.get('view-v-1'), inlineEntry)
  assert.deepEqual(split.dock, [hiddenEntry, rolledOverEntry])
})

test('matchesPendingView matches by id or callId and ignores non-view rows', () => {
  assert.equal(matchesPendingView({ kind: 'bot', id: 'v-1' }, { id: 'v-1' }), false)
  assert.equal(matchesPendingView({ kind: 'view', id: 'v-1' }, { id: 'v-1' }), true)
  assert.equal(matchesPendingView({ kind: 'view', callId: 'c-9' }, { id: 'v-other', callId: 'c-9' }), true)
  assert.equal(matchesPendingView({ kind: 'view', callId: 'c-1' }, { id: 'v-1', callId: 'c-2' }), false)
})

test('viewHasControls distinguishes frameless display views from framed interactive views', () => {
  assert.equal(viewHasControls({ type: 'stack', children: [{ type: 'metric', label: 'A', value: 1 }, { type: 'table', columns: [], rows: [] }] }), false)
  assert.equal(viewHasControls({ type: 'stack', children: [{ type: 'chart' }, { type: 'slider', id: 's', value: 1 }] }), true)
  assert.equal(viewHasControls({ type: 'options', id: 'o', options: [] }), true)
  assert.equal(viewHasControls(null), false)
})

test('viewReminderLabel formats single-line jump copy in English and Chinese', () => {
  setLang('en')
  assert.equal(viewReminderLabel('Chief', 'Release readiness', t), 'Chief is waiting for your reply: Release readiness')
  assert.equal(viewReminderLabel('Chief', '', t), 'Chief is waiting for your reply')
  setLang('zh')
  assert.equal(viewReminderLabel('Chief', 'Release readiness', t), 'Chief 等你回复：Release readiness')
  assert.equal(viewReminderLabel(undefined, '部署确认', t), 'Bot 等你回复：部署确认')
  setLang('system')
  assert.equal(viewFocusKey({ sessionId: 's1', view: { id: 'v-1' } }), 'view-v-1')
  assert.equal(viewFocusKey({ sessionId: 's1', view: {} }), 'view-s1')
})
