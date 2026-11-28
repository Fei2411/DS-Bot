import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { LEGACY_PRODUCT_NAME } from '../src/legacy.mjs'

const include = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')

function macro(name) {
  const body = new RegExp(`^!macro ${name}\\r?\\n([\\s\\S]*?)^!macroend`, 'm').exec(include)?.[1]
  assert.ok(body, `NSIS must define ${name}`)
  return body
}

test('a silent Windows update prepares a complete backup before the old uninstaller runs', () => {
  // electron-builder calls customInit from .onInit, before the install section runs.
  const body = macro('customInit')
  assert.match(body, /\$\{Silent\}[\s\S]*\$\{isUpdated\}/)
  assert.match(body, /\$\{IfNot\} \$\{FileExists\} "\$\{DSB_ROLLBACK\}\\resources\\app\.asar"/)
  assert.match(body, /CopyFiles \/SILENT "\$INSTDIR\\\*" "\$\{DSB_ROLLBACK_STAGING\}"\s+IfErrors rollbackBackupFailed/)
  assert.match(body, /RMDir \/r "\$\{DSB_ROLLBACK\}"\s+ClearErrors\s+Rename "\$\{DSB_ROLLBACK_STAGING\}" "\$\{DSB_ROLLBACK\}"\s+IfErrors rollbackBackupFailed/)
})

test('a failed rollback backup cleans up staging and lets the silent update continue', () => {
  const body = macro('customInit')
  assert.doesNotMatch(body, /^\s*(?:Abort|Quit|SetErrorLevel)\b/im)
  assert.match(body, /rollbackBackupFailed:[\s\S]*?RMDir \/r "\$\{DSB_ROLLBACK_STAGING\}"\s+rollbackBackupDone:\s+ClearErrors\s*$/)
})

test('a silent update backs up the legacy executable in the registered installation directory', () => {
  const body = macro('customInit')
  assert.ok(include.includes(`!define DSB_LEGACY_EXECUTABLE "${LEGACY_PRODUCT_NAME}.exe"`))
  assert.match(body, /StrCpy \$R8 "\$\{APP_EXECUTABLE_FILENAME\}"\s+\$\{IfNot\} \$\{FileExists\} "\$INSTDIR\\\$R8"\s+StrCpy \$R8 "\$\{DSB_LEGACY_EXECUTABLE\}"/)
  assert.match(body, /\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\\$R8"/)
  assert.match(body, /IfFileExists "\$\{DSB_ROLLBACK_STAGING\}\\\$R8" 0 rollbackBackupFailed/)
})

test('the old copy is retired only after the installed application files are in place', () => {
  // electron-builder calls customInstall after installing files and writing registry entries.
  assert.doesNotMatch(macro('customInit'), /Rename "\$\{DSB_ROLLBACK\}" "\$\{DSB_ROLLBACK_STAGING\}"/)
  const body = macro('customInstall')
  assert.match(body, /IfFileExists "\$\{DSB_ROLLBACK\}\\resources\\app\.asar" 0 rollbackCleanupDone/)
  assert.match(body, /Rename "\$\{DSB_ROLLBACK\}" "\$\{DSB_ROLLBACK_STAGING\}"\s+IfErrors rollbackCleanupDone\s+RMDir \/r "\$\{DSB_ROLLBACK_STAGING\}"/)
})
