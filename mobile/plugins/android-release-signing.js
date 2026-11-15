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
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins')

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

const RELEASE_ABI_EXCLUDES = `
androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        variant.packaging.jniLibs.excludes.addAll(["**/x86/**", "**/x86_64/**"])
    }
}
`

function sign(gradle) {
  let next = gradle
  if (!(next.includes("System.getenv('DSBOT_ANDROID_KEYSTORE')") && next.includes('enableV3Signing true'))) {
    const configs = /signingConfigs \{\n(\s*debug \{[^}]*?)(\n\s*\})(?:\n\s*release \{\n\s*if \(System\.getenv\('DSBOT_ANDROID_KEYSTORE'\)\) \{[^}]*\}\n\s*\})?/
    const release = /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig (?:signingConfigs\.debug|System\.getenv\('DSBOT_ANDROID_KEYSTORE'\) \? signingConfigs\.release : signingConfigs\.debug)/
    if (!configs.test(next) || !release.test(next)) throw new Error('android-release-signing: app/build.gradle has an unexpected layout')
    next = next
      .replace(configs, (_whole, debug, close) => `signingConfigs {\n${debug}${SCHEMES}${close}${RELEASE_CONFIG}`)
      .replace(release, "$1signingConfig System.getenv('DSBOT_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug")
  }
  if (!next.includes('variant.packaging.jniLibs.excludes.addAll')) {
    next = `${next.trimEnd()}\n${RELEASE_ABI_EXCLUDES}`
  }
  return next
}

// Keep debug x86/x86_64 emulators working via default gradle.properties; only release strips
// simulator ABIs (via androidComponents above and -PreactNativeArchitectures in CI) while
// storing uncompressed, 16KB-aligned native libraries inside the APK (Android 15+ requirement).
const GRADLE_OVERRIDES = [
  ['expo.useLegacyPackaging', 'false'],
]

function applyArchs(properties) {
  const next = Array.isArray(properties) ? [...properties] : []
  for (const [key, value] of GRADLE_OVERRIDES) {
    const index = next.findIndex(item => item?.type === 'property' && item.key === key)
    const entry = { type: 'property', key, value }
    if (index >= 0) next[index] = entry
    else next.push(entry)
  }
  return next
}

module.exports = config => withGradleProperties(
  withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = sign(mod.modResults.contents)
    return mod
  }),
  (mod) => {
    mod.modResults = applyArchs(mod.modResults)
    return mod
  },
)
module.exports.sign = sign
module.exports.applyArchs = applyArchs
