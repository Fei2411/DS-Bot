const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { applyArchs, sign } = require('./android-release-signing.js')
const { patchMainApplication, patchManifest, REQUIRED_PERMISSIONS, KOTLIN_FILES } = require('./android-native.js')
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

test('applyArchs preserves debug architectures while enabling uncompressed 16KB packaging and Gradle tuning', () => {
  const existing = [
    { type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' },
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'true' },
    { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2048m -XX:MaxMetaspaceSize=512m' },
  ]
  assert.deepEqual(applyArchs(existing), [
    { type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' },
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' },
    { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4096m -XX:MaxMetaspaceSize=1024m' },
    { type: 'property', key: 'android.experimental.disableCompileSdkChecks', value: 'true' },
  ])
  assert.deepEqual(applyArchs([]), [
    { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' },
    { type: 'property', key: 'android.experimental.disableCompileSdkChecks', value: 'true' },
    { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4096m -XX:MaxMetaspaceSize=1024m' },
  ])
})

test('Android config pins compileSdkVersion <= targetSdkVersion (36) and declares POST_NOTIFICATIONS', () => {
  const { expo } = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8'))
  assert.ok(Array.isArray(expo.android.permissions))
  assert.ok(expo.android.permissions.includes('android.permission.POST_NOTIFICATIONS'))
  const buildProps = expo.plugins.find(entry => Array.isArray(entry) && entry[0] === 'expo-build-properties')?.[1]
  assert.equal(buildProps?.android?.targetSdkVersion, 36)
  assert.equal(buildProps?.android?.compileSdkVersion, 36)
  assert.ok(buildProps.android.compileSdkVersion <= buildProps.android.targetSdkVersion)
  assert.match(buildProps.android.extraProguardRules, /io\.github\.fei2411\.dsbot\.system\.\*\*/)
})

test('android-native plugin patches MainApplication and AndroidManifest idempotently', () => {
  const sampleMain = [
    'package io.github.fei2411.dsbot',
    '',
    'import com.facebook.react.PackageList',
    '',
    'class MainApplication {',
    '  val packages = PackageList(this).packages.apply {',
    '  }',
    '}',
    '',
  ].join('\n')
  const patched = patchMainApplication(sampleMain)
  assert.match(patched, /import io\.github\.fei2411\.dsbot\.system\.DsBotAndroidPackage/)
  assert.match(patched, /add\(DsBotAndroidPackage\(\)\)/)
  assert.equal(patchMainApplication(patched), patched)
  assert.throws(() => patchMainApplication('class Broken {}'), /package declaration/)

  const manifest = {
    manifest: {
      'uses-permission': [{ $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } }],
      application: [{ $: { 'android:name': '.MainApplication' } }],
    },
  }
  const patchedManifest = patchManifest(manifest)
  const perms = patchedManifest.manifest['uses-permission'].map(item => item.$['android:name'])
  for (const perm of REQUIRED_PERMISSIONS) assert.ok(perms.includes(perm), `missing ${perm}`)
  const app = patchedManifest.manifest.application[0]
  assert.equal(app.provider.length, 1)
  assert.equal(app.provider[0].$['android:authorities'], '${applicationId}.dsbot.apkprovider')
  assert.equal(app.service.length, 2)
  assert.equal(app.service[0].$['android:foregroundServiceType'], 'remoteMessaging')
  assert.equal(app.receiver.length, 2)
  assert.equal(app.receiver[0].$['android:exported'], 'true')
  // Re-running patchManifest does not duplicate entries.
  const again = patchManifest(patchedManifest)
  assert.equal(again.manifest.application[0].provider.length, 1)
  assert.equal(again.manifest.application[0].service.length, 2)
  assert.equal(again.manifest.application[0].receiver.length, 2)
  assert.ok(KOTLIN_FILES.length >= 10)
})
