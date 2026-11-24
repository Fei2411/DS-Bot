// Expo config plugin that installs DS Bot's Android native modules (in-app APK
// updater with streaming SHA-256 verification and FileProvider handoff, plus
// native notification channels, Foreground Service, JobScheduler sync, and
// UnifiedPush v2 connector) without affecting iOS or Web builds.
const { copyFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('expo/config-plugins')

const SYSTEM_PKG = 'io.github.fei2411.dsbot.system'
const PACKAGE_IMPORT = `import ${SYSTEM_PKG}.DsBotAndroidPackage`
const PACKAGE_ADD = '          add(DsBotAndroidPackage())'

const KOTLIN_FILES = [
  'ApkFileProvider.kt',
  'DsBotAndroidPackage.kt',
  'DsBotBackgroundService.kt',
  'DsBotBootReceiver.kt',
  'DsBotHeadlessRunner.kt',
  'DsBotNotificationsModule.kt',
  'DsBotNotifyHelper.kt',
  'DsBotSyncJobService.kt',
  'DsBotUnifiedPushReceiver.kt',
  'DsBotUpdaterModule.kt',
]

const REQUIRED_PERMISSIONS = [
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
]

function patchMainApplication(contents) {
  let next = contents
  if (!next.includes(PACKAGE_IMPORT)) {
    const pkgMatch = /^package\s+[^\r\n]+\r?\n/u.exec(next)
    if (!pkgMatch) throw new Error('android-native: MainApplication.kt has no package declaration')
    next = `${pkgMatch[0]}\n${PACKAGE_IMPORT}\n${next.slice(pkgMatch[0].length)}`
  }
  if (!next.includes('add(DsBotAndroidPackage())')) {
    const anchor = /(PackageList\(this\)\.packages\.apply\s*\{)/u
    if (!anchor.test(next)) throw new Error('android-native: MainApplication.kt has an unexpected PackageList layout')
    next = next.replace(anchor, `$1\n${PACKAGE_ADD}`)
  }
  return next
}

function ensureList(parent, key) {
  if (!Array.isArray(parent[key])) parent[key] = []
  return parent[key]
}

function upsertByName(list, entry) {
  const name = entry.$['android:name']
  const idx = list.findIndex(item => item?.$?.['android:name'] === name)
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
}

function patchManifest(manifest) {
  const root = manifest.manifest
  const perms = ensureList(root, 'uses-permission')
  for (const name of REQUIRED_PERMISSIONS) {
    if (!perms.some(item => item?.$?.['android:name'] === name)) {
      perms.push({ $: { 'android:name': name } })
    }
  }

  // Package visibility for discovering UnifiedPush distributors on Android 11+.
  const queries = ensureList(root, 'queries')
  const queryBlock = queries[0] ?? (queries.push({}) && queries[0])
  const queryIntents = ensureList(queryBlock, 'intent')
  const upAction = 'org.unifiedpush.android.distributor.REGISTER'
  if (!queryIntents.some(intent => Array.isArray(intent?.action) && intent.action.some(a => a?.$?.['android:name'] === upAction))) {
    queryIntents.push({ action: [{ $: { 'android:name': upAction } }] })
  }

  const app = root.application?.[0]
  if (!app) throw new Error('android-native: AndroidManifest.xml has no <application>')

  const providers = ensureList(app, 'provider')
  upsertByName(providers, {
    $: {
      'android:name': `${SYSTEM_PKG}.ApkFileProvider`,
      'android:authorities': '${applicationId}.dsbot.apkprovider',
      'android:exported': 'false',
      'android:grantUriPermissions': 'true',
    },
    'meta-data': [
      {
        $: {
          'android:name': 'android.support.FILE_PROVIDER_PATHS',
          'android:resource': '@xml/dsbot_update_paths',
        },
      },
    ],
  })

  const services = ensureList(app, 'service')
  upsertByName(services, {
    $: {
      'android:name': `${SYSTEM_PKG}.DsBotBackgroundService`,
      'android:exported': 'false',
      'android:foregroundServiceType': 'remoteMessaging',
    },
  })
  upsertByName(services, {
    $: {
      'android:name': `${SYSTEM_PKG}.DsBotSyncJobService`,
      'android:exported': 'false',
      'android:permission': 'android.permission.BIND_JOB_SERVICE',
    },
  })

  const receivers = ensureList(app, 'receiver')
  upsertByName(receivers, {
    $: {
      'android:name': `${SYSTEM_PKG}.DsBotUnifiedPushReceiver`,
      'android:exported': 'true',
    },
    'intent-filter': [
      {
        action: [
          { $: { 'android:name': 'org.unifiedpush.android.connector.MESSAGE' } },
          { $: { 'android:name': 'org.unifiedpush.android.connector.NEW_ENDPOINT' } },
          { $: { 'android:name': 'org.unifiedpush.android.connector.REGISTRATION_FAILED' } },
          { $: { 'android:name': 'org.unifiedpush.android.connector.UNREGISTERED' } },
        ],
      },
    ],
  })
  upsertByName(receivers, {
    $: {
      'android:name': `${SYSTEM_PKG}.DsBotBootReceiver`,
      'android:exported': 'false',
    },
    'intent-filter': [
      {
        action: [
          { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
          { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
        ],
      },
    ],
  })

  return manifest
}

function withAndroidNativeFiles(config) {
  return withDangerousMod(config, ['android', async (mod) => {
    const srcDir = join(__dirname, 'android-native')
    const kotlinDest = join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', ...SYSTEM_PKG.split('.'))
    const xmlDest = join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml')
    const drawableDest = join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable')
    mkdirSync(kotlinDest, { recursive: true })
    mkdirSync(xmlDest, { recursive: true })
    mkdirSync(drawableDest, { recursive: true })
    for (const file of KOTLIN_FILES) {
      copyFileSync(join(srcDir, file), join(kotlinDest, file))
    }
    copyFileSync(join(srcDir, 'dsbot_update_paths.xml'), join(xmlDest, 'dsbot_update_paths.xml'))
    copyFileSync(join(srcDir, 'ic_dsbot_notification.xml'), join(drawableDest, 'ic_dsbot_notification.xml'))
    return mod
  }])
}

module.exports = (config) => {
  let next = withAndroidNativeFiles(config)
  next = withMainApplication(next, (mod) => {
    mod.modResults.contents = patchMainApplication(mod.modResults.contents)
    return mod
  })
  next = withAndroidManifest(next, (mod) => {
    mod.modResults = patchManifest(mod.modResults)
    return mod
  })
  return next
}

module.exports.patchMainApplication = patchMainApplication
module.exports.patchManifest = patchManifest
module.exports.REQUIRED_PERMISSIONS = REQUIRED_PERMISSIONS
module.exports.KOTLIN_FILES = KOTLIN_FILES
