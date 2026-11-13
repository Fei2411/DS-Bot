const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { applyArchs, sign } = require('./android-release-signing.js')
const { versionCode } = require('../app.config.js')

// app/build.gradle as `expo prebuild` of Expo 58 writes it.
const gradle = readFileSync(join(__dirname, 'fixtures', 'expo-58-app-build.gradle'), 'utf8')

test('the release build signs with the upload key when the build names one, else with the debug key', () => {
  const signed = sign(gradle)
  assert.match(signed, /signingConfigs \{\n\s*debug \{[^}]*enableV1Signing true\n\s*enableV2Signing true\n\s*enableV3Signing true\n\s*\}\n\s*release \{\n\s*if \(System\.getenv\('DSBOT_ANDROID_KEYSTORE'\)\)[\s\S]*?enableV1Signing true\n\s*enableV2Signing true\n\s*enableV3Signing true\n\s*\}/)
  const release = signed.slice(signed.indexOf('buildTypes {'))
  assert.match(release, /release \{[\s\S]*signingConfig System\.getenv\('DSBOT_ANDROID_KEYSTORE'\) \? signingConfigs\.release : signingConfigs\.debug/)
  assert.match(release, /debug \{\n\s*signingConfig signingConfigs\.debug\n/)
  assert.match(signed, /withBuildType\("release"\)[\s\S]*variant\.packaging\.jniLibs\.excludes\.addAll\(\["\*\*\/x86\/\*\*", "\*\*\/x86_64\/\*\*"\]\)/)
  assert.equal(sign(signed), signed)
})

test('incremental prebuild upgrades an older v2-only signing block in place', () => {
  const legacy = gradle
    .replace(/signingConfigs \{\n(\s*debug \{[^}]*\})/, (_w, debug) => `signingConfigs {\n${debug}\n        release {\n            if (System.getenv('DSBOT_ANDROID_KEYSTORE')) {\n                storeFile file(System.getenv('DSBOT_ANDROID_KEYSTORE'))\n                storePassword System.getenv('DSBOT_ANDROID_KEYSTORE_PASSWORD')\n                keyAlias System.getenv('DSBOT_ANDROID_KEY_ALIAS')\n                keyPassword System.getenv('DSBOT_ANDROID_KEY_PASSWORD') ?: System.getenv('DSBOT_ANDROID_KEYSTORE_PASSWORD')\n            }\n        }`)
    .replace(/(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/, "$1signingConfig System.getenv('DSBOT_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug")
  assert.equal(sign(legacy), sign(gradle))
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

test('applyArchs preserves debug architectures while enabling uncompressed 16KB packaging', () => {
  const existing = [
    { type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' },
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'true' },
  ]
  assert.deepEqual(applyArchs(existing), [
    { type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' },
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' },
  ])
  assert.deepEqual(applyArchs([]), [
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' },
  ])
})
