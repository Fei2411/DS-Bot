import assert from 'node:assert/strict'
import { test } from 'node:test'
import { androidNotificationStatus } from './notifications.ts'

test('androidNotificationStatus reports runtime state on API 33+ and avoids misreporting below API 33', () => {
  // Below API 33 there is no POST_NOTIFICATIONS runtime permission, so system-disabled
  // notifications cannot be read via PermissionsAndroid and must not claim "Allowed".
  assert.equal(androidNotificationStatus(31, true), undefined)
  assert.equal(androidNotificationStatus(32, false), undefined)
  assert.equal(androidNotificationStatus(33, false), 'Allow')
  assert.equal(androidNotificationStatus(36, true), 'Allowed')
})
