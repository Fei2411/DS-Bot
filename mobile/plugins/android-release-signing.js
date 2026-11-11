// Signs the Android release build with the upload key when the build names one, and
// with the debug key otherwise (a build on a developer's machine). The key never
// enters the project: its path and passwords come from the environment of the build.
//
//   DSBOT_ANDROID_KEYSTORE           path of the keystore file
//   DSBOT_ANDROID_KEYSTORE_PASSWORD  its password
//   DSBOT_ANDROID_KEY_ALIAS          the key's alias
//   DSBOT_ANDROID_KEY_PASSWORD       the key's password, when it differs from the store's
const { withAppBuildGradle } = require('expo/config-plugins')

const RELEASE_CONFIG = `
        release {
            if (System.getenv('DSBOT_ANDROID_KEYSTORE')) {
                storeFile file(System.getenv('DSBOT_ANDROID_KEYSTORE'))
                storePassword System.getenv('DSBOT_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('DSBOT_ANDROID_KEY_ALIAS')
                keyPassword System.getenv('DSBOT_ANDROID_KEY_PASSWORD') ?: System.getenv('DSBOT_ANDROID_KEYSTORE_PASSWORD')
            }
        }`

function sign(gradle) {
  if (gradle.includes("System.getenv('DSBOT_ANDROID_KEYSTORE')")) return gradle
  const configs = /signingConfigs \{\n(\s*debug \{[^}]*\})/
  const release = /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/
  if (!configs.test(gradle) || !release.test(gradle)) throw new Error('android-release-signing: app/build.gradle has an unexpected layout')
  return gradle
    .replace(configs, (_whole, debug) => `signingConfigs {\n${debug}${RELEASE_CONFIG}`)
    .replace(release, "$1signingConfig System.getenv('DSBOT_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug")
}

module.exports = config => withAppBuildGradle(config, (mod) => {
  mod.modResults.contents = sign(mod.modResults.contents)
  return mod
})
module.exports.sign = sign
