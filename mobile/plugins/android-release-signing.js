// Signs the Android release build with the upload key when the build names one, and
// with the debug key otherwise (a build on a developer's machine). Enables v1 (JAR),
// v2 and v3 APK signatures together because Android Gradle skips v1 and v3 by default
// when minSdkVersion >= 24, and several OEM pre-install scanners treat an APK without
// META-INF/*.RSA or v3 as lacking a developer certificate.
//
//   DSBOT_ANDROID_KEYSTORE           path of the keystore file
//   DSBOT_ANDROID_KEYSTORE_PASSWORD  its password
//   DSBOT_ANDROID_KEY_ALIAS          the key's alias
//   DSBOT_ANDROID_KEY_PASSWORD       the key's password, when it differs from the store's
const { withAppBuildGradle } = require('expo/config-plugins')

const SCHEMES = `
            enableV1Signing true
            enableV2Signing true
            enableV3Signing true`

const RELEASE_CONFIG = `
        release {
            if (System.getenv('DSBOT_ANDROID_KEYSTORE')) {
                storeFile file(System.getenv('DSBOT_ANDROID_KEYSTORE'))
                storePassword System.getenv('DSBOT_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('DSBOT_ANDROID_KEY_ALIAS')
                keyPassword System.getenv('DSBOT_ANDROID_KEY_PASSWORD') ?: System.getenv('DSBOT_ANDROID_KEYSTORE_PASSWORD')
            }${SCHEMES}
        }`

function sign(gradle) {
  if (gradle.includes("System.getenv('DSBOT_ANDROID_KEYSTORE')") && gradle.includes('enableV3Signing true')) return gradle
  const configs = /signingConfigs \{\n(\s*debug \{[^}]*?)(\n\s*\})(?:\n\s*release \{\n\s*if \(System\.getenv\('DSBOT_ANDROID_KEYSTORE'\)\) \{[^}]*\}\n\s*\})?/
  const release = /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig (?:signingConfigs\.debug|System\.getenv\('DSBOT_ANDROID_KEYSTORE'\) \? signingConfigs\.release : signingConfigs\.debug)/
  if (!configs.test(gradle) || !release.test(gradle)) throw new Error('android-release-signing: app/build.gradle has an unexpected layout')
  return gradle
    .replace(configs, (_whole, debug, close) => `signingConfigs {\n${debug}${SCHEMES}${close}${RELEASE_CONFIG}`)
    .replace(release, "$1signingConfig System.getenv('DSBOT_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug")
}

module.exports = config => withAppBuildGradle(config, (mod) => {
  mod.modResults.contents = sign(mod.modResults.contents)
  return mod
})
module.exports.sign = sign
