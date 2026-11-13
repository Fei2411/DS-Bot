// A window that is not in front says a Bot answered, without taking focus (#1504).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { badgeCount, createNotifications } from '../src/notifications.mjs'

function harness({ authorizationStatus = 'authorized', supported = true } = {}) {
  const shown = []
  const Notification = class extends EventEmitter {
    static isSupported() { return supported }
    constructor(options) { super(); this.options = options }
    show() { shown.push(this) }
    close() { this.closed = true; this.emit('close') }
  }
  const systemPreferences = { getNotificationSettings: () => ({ authorizationStatus }) }
  const log = { warn() {} }
  return { notifications: createNotifications({ Notification, systemPreferences, platform: 'darwin', log }), shown }
}

describe('notifications', () => {
  test('a window that is not in front gets one, and the click opens its Session', () => {
    const { notifications, shown } = harness()
    let opened = 0
    const sent = notifications.show({ sessionId: 's-1', title: 'Writer', body: 'Finished the review' }, { focused: () => false, open: () => { opened += 1 } })
    assert.equal(sent, true)
    assert.equal(shown.length, 1)
    assert.deepEqual(shown[0].options, { title: 'Writer', body: 'Finished the review', silent: false })
    assert.equal(opened, 0, 'showing never opens anything by itself')
    shown[0].emit('click')
    assert.equal(opened, 1, 'the click opens the Session')
    shown[0].emit('click')
    assert.equal(opened, 1, 'a clicked banner opens once')
  })

  test('a window already in front is left alone', () => {
    const { notifications, shown } = harness()
    assert.equal(notifications.show({ title: 'Writer', body: 'Hi' }, { focused: () => true }), false)
    assert.equal(shown.length, 0)
  })

  test('a denied permission shows nothing, and says so', () => {
    const { notifications, shown } = harness({ authorizationStatus: 'denied' })
    assert.equal(notifications.status(), 'denied')
    assert.equal(notifications.show({ title: 'Writer', body: 'Hi' }, {}), false)
    assert.equal(shown.length, 0)
  })

  test('an unreported permission is attempted: other platforms ask at the first show', () => {
    const { notifications, shown } = harness({ authorizationStatus: 'notDetermined' })
    assert.equal(notifications.status(), 'unknown')
    assert.equal(notifications.show({ title: 'Writer', body: 'Hi' }, {}), true)
    assert.equal(shown.length, 1)
  })

  test('what goes out is capped, and an empty notice is no notice', () => {
    const { notifications, shown } = harness()
    assert.equal(notifications.show({ title: '', body: '' }, {}), false)
    notifications.show({ title: 'x'.repeat(400), body: 'y'.repeat(400) }, {})
    assert.equal(shown[0].options.title.length, 120)
    assert.equal(shown[0].options.body.length, 200)
  })

  test('focusing the window closes what is still up', () => {
    const { notifications, shown } = harness()
    notifications.show({ title: 'Writer', body: 'Hi' }, {})
    notifications.show({ title: 'Chief', body: 'Hi' }, {})
    notifications.clear()
    assert.deepEqual(shown.map(entry => entry.closed), [true, true])
  })

  test('a platform with no notifications reports it instead of failing', () => {
    const { notifications, shown } = harness({ supported: false })
    assert.equal(notifications.status(), 'unsupported')
    assert.equal(notifications.show({ title: 'Writer', body: 'Hi' }, {}), false)
    assert.equal(shown.length, 0)
  })

  test('the badge counts conversations, capped at what a dock shows', () => {
    assert.equal(badgeCount(0), 0)
    assert.equal(badgeCount(3), 3)
    assert.equal(badgeCount(-2), 0)
    assert.equal(badgeCount(2.7), 2)
    assert.equal(badgeCount(1000), 99)
    assert.equal(badgeCount('4'), 4)
  })
})
