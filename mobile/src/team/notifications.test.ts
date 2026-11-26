import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '../ui/i18n.ts'
import {
  androidNotificationStatus,
  classifyNotice,
  formatNoticeNotification,
  parseOpenChatUrl,
  readNotifyPrefsFromRecord,
  shouldPostSystemNotification,
} from './notifications.ts'

test('androidNotificationStatus reports runtime state on API 33+, system disabled below API 33, and avoids misreporting', () => {
  assert.equal(androidNotificationStatus(33, undefined), undefined)
  assert.equal(androidNotificationStatus(33, undefined, false), undefined)
  assert.equal(androidNotificationStatus(31, true), undefined)
  assert.equal(androidNotificationStatus(32, false), undefined)
  assert.equal(androidNotificationStatus(31, true, false), 'Off')
  assert.equal(androidNotificationStatus(31, true, true), 'Allowed')
  assert.equal(androidNotificationStatus(33, false), 'Allow')
  assert.equal(androidNotificationStatus(33, false, false), 'Allow')
  assert.equal(androidNotificationStatus(36, true, false), 'Off')
  assert.equal(androidNotificationStatus(36, true), 'Allowed')
})

test('classifyNotice routes urgent cards to needs_you channel and messages/groups to replies channel', () => {
  const approval = classifyNotice({ kind: 'approval', botId: 'b1', name: 'Chief', text: 'run_shell_command' }, 'h1')
  assert.deepEqual(approval, {
    channel: 'needs_you',
    category: 'needs_you',
    target: { kind: 'bot', id: 'b1' },
    chatKey: 'bot:b1',
    tag: 'h1:bot:b1',
  })

  const secret = classifyNotice({ kind: 'secret', botId: 'b1', name: 'Chief', text: 'GITHUB_TOKEN' }, 'h1')
  assert.equal(secret?.channel, 'needs_you')
  assert.equal(secret?.category, 'needs_you')

  const handoff = classifyNotice({ kind: 'handoff', botId: 'b1', name: 'Chief', text: 'Login' }, 'h1')
  assert.equal(handoff?.channel, 'needs_you')

  const groupMsg = classifyNotice({ kind: 'group', botId: 'b2', roomId: 'r1', title: 'Core', name: 'Coder', text: 'PR ready' }, 'h1')
  assert.deepEqual(groupMsg, {
    channel: 'replies',
    category: 'groups',
    target: { kind: 'room', id: 'r1' },
    chatKey: 'room:r1',
    tag: 'h1:room:r1',
  })

  assert.equal(classifyNotice({ kind: 'unknown', botId: 'b1' }), null)
  assert.equal(classifyNotice({ kind: 'message', botId: '' }), null)
})

test('shouldPostSystemNotification honors toggles and foreground suppression', () => {
  const defaults = readNotifyPrefsFromRecord({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.bgMode, 'periodic')

  const msg = { kind: 'message', botId: 'b1', name: 'Chief', text: 'Finished build' }
  assert.ok(shouldPostSystemNotification(msg, defaults, { appActive: false, activeChat: null, hostId: 'h1' }))
  assert.equal(shouldPostSystemNotification(msg, defaults, { appActive: true, activeChat: null, hostId: 'h1' }), null)

  const noReplies = readNotifyPrefsFromRecord({ notifyReplies: 'off' })
  assert.equal(shouldPostSystemNotification(msg, noReplies, { appActive: false, activeChat: null }), null)
  assert.ok(shouldPostSystemNotification({ kind: 'approval', botId: 'b1', text: 'rm' }, noReplies, { appActive: false, activeChat: null }))

  const disabled = readNotifyPrefsFromRecord({ notifyEnabled: 'off' })
  assert.equal(shouldPostSystemNotification({ kind: 'approval', botId: 'b1', text: 'rm' }, disabled, { appActive: false, activeChat: null }), null)
})

test('formatNoticeNotification respects message preview privacy, optional hostName, and localizes EN and ZH', () => {
  setLang('zh')
  assert.deepEqual(
    formatNoticeNotification({ kind: 'approval', name: 'Chief', text: 'write_file' }, { preview: true }),
    { title: 'Chief', body: '等待批准：write_file' },
  )
  assert.deepEqual(
    formatNoticeNotification({ kind: 'approval', name: 'Chief', text: 'write_file' }, { preview: false, hostName: 'Studio Mac' }),
    { title: 'Chief (Studio Mac)', body: '等待你的批准' },
  )
  assert.deepEqual(
    formatNoticeNotification({ kind: 'group', title: '研发群', name: 'Coder', text: '已修复' }, { preview: false }),
    { title: '研发群 · Coder', body: '有新的群消息' },
  )

  setLang('en')
  assert.deepEqual(
    formatNoticeNotification({ kind: 'secret', name: 'Chief', text: 'API_KEY' }, { preview: true }),
    { title: 'Chief', body: 'Asks for the secret API_KEY' },
  )
  assert.deepEqual(
    formatNoticeNotification({ kind: 'message', name: 'Chief', text: 'All green' }, { preview: false }),
    { title: 'Chief', body: 'New reply' },
  )
  setLang('system')
})

test('every kind the inbox announces goes to Needs you, and says nothing of its text without preview', () => {
  setLang('en')
  const defaults = readNotifyPrefsFromRecord({})
  for (const [kind, text, shown, hidden] of [
    ['mail', 'Weekly report', 'Wants to send “Weekly report”', 'Wants to send an email'],
    ['computer', 'Finder', 'Wants to use Finder', 'Needs your approval'],
    ['goal', 'Ship it', 'Waiting for you · Ship it', 'Waiting for you'],
    ['blocked', 'RATE_LIMIT', 'Needs a fix', 'Needs a fix'],
    ['paused', 'Which version?', 'Which version?', 'Paused'],
    ['alert', 'No progress for 20 minutes', 'No progress for 20 minutes', 'Waiting for you'],
  ]) {
    const notice = { kind, botId: 'b1', name: 'Chief', text }
    assert.equal(classifyNotice(notice)?.channel, 'needs_you', kind)
    assert.ok(shouldPostSystemNotification(notice, defaults, { appActive: false, activeChat: null }), kind)
    assert.equal(formatNoticeNotification(notice, { preview: true }).body, shown, kind)
    assert.equal(formatNoticeNotification(notice, { preview: false }).body, hidden, kind)
  }
  // A group's item opens the group.
  assert.deepEqual(classifyNotice({ kind: 'goal', botId: 'b1', roomId: 'r1', text: '' })?.target, { kind: 'room', id: 'r1' })
  setLang('system')
})

test('parseOpenChatUrl decodes bot, room, and needs notification tap links safely', () => {
  assert.deepEqual(parseOpenChatUrl('dsbot://open?kind=bot&id=b1&host=h1'), { kind: 'bot', id: 'b1', hostId: 'h1' })
  assert.deepEqual(parseOpenChatUrl('dsbot://open?kind=room&id=r9'), { kind: 'room', id: 'r9' })
  assert.deepEqual(parseOpenChatUrl('dsbot://open?kind=needs&host=h2'), { kind: 'needs', hostId: 'h2' })
  assert.equal(parseOpenChatUrl('dsbot://open?kind=bot'), null)
  assert.equal(parseOpenChatUrl('dsbot://pair?code=123'), null)
  assert.equal(parseOpenChatUrl('https://example.com'), null)
})
