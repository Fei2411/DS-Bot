const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { sign } = require('./android-release-signing.js')
const { versionCode } = require('../app.config.js')

// app/build.gradle as `expo prebuild` of Expo 58 writes it.
const gradle = readFileSync(join(__dirname, 'fixtures', 'expo-58-app-build.gradle'), 'utf8')

test('the release build signs with the upload key when the build names one, else with the debug key', () => {
  const signed = sign(gradle)
  assert.match(signed, /signingConfigs \{\n\s*debug \{[^}]*\}\n\s*release \{\n\s*if \(System\.getenv\('DSBOT_ANDROID_KEYSTORE'\)\)/)
  const release = signed.slice(signed.indexOf('buildTypes {'))
  assert.match(release, /release \{[\s\S]*signingConfig System\.getenv\('DSBOT_ANDROID_KEYSTORE'\) \? signingConfigs\.release : signingConfigs\.debug/)
  assert.match(release, /debug \{\n\s*signingConfig signingConfigs\.debug\n/)
  assert.equal(sign(signed), signed)
})

test('a build.gradle of another layout stops the build instead of shipping a debug-signed app', () => {
  assert.throws(() => sign('android {\n}\n'), /unexpected layout/)
})

test('versionCode grows with the version, and a pre-release stays below its release', () => {
  const order = ['0.3.2', '0.3.3-rc.1', '0.3.3-rc.2', '0.3.3', '0.4.0-rc.1', '0.4.0', '1.0.0']
  const codes = order.map(versionCode)
  assert.deepEqual([...codes].sort((a, b) => a - b), codes)
  assert.equal(versionCode('0.3.2'), 300299)
  assert.throws(() => versionCode('0.3'), /cannot make/)
})
