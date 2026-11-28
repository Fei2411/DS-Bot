import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const include = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')

function macro(name) {
  const body = new RegExp(`^!macro ${name}\\r?\\n([\\s\\S]*?)^!macroend`, 'm').exec(include)?.[1]
  assert.ok(body, `NSIS must define ${name}`)
  return body
}

test('a silent Windows update must publish a complete backup before the old uninstaller runs', () => {
  // electron-builder calls customInit from .onInit, before the install section runs.
  const body = macro('customInit')
  assert.match(body, /\$\{Silent\}[\s\S]*\$\{isUpdated\}/)
  assert.match(body, /\$\{FileExists\} "\$\{DSB_ROLLBACK\}\\\$\{APP_EXECUTABLE_FILENAME\}"[\s\S]*\$\{ElseIf\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(body, /CopyFiles \/SILENT "\$INSTDIR\\\*" "\$\{DSB_ROLLBACK_STAGING\}"\s+IfErrors rollbackBackupFailed/)
  assert.match(body, /Rename "\$\{DSB_ROLLBACK_STAGING\}" "\$\{DSB_ROLLBACK\}"\s+IfErrors rollbackBackupFailed[\s\S]*rollbackBackupFailed:\s+SetErrorLevel 2\s+Abort/)
})

test('the old copy is retired only after the installed application files are in place', () => {
  // electron-builder calls customInstall after installing files and writing registry entries.
  assert.doesNotMatch(macro('customInit'), /RMDir \/r "\$\{DSB_ROLLBACK\}"/)
  const body = macro('customInstall')
  assert.match(body, /Rename "\$\{DSB_ROLLBACK\}" "\$\{DSB_ROLLBACK_STAGING\}"\s+IfErrors rollbackCleanupDone\s+RMDir \/r "\$\{DSB_ROLLBACK_STAGING\}"/)
})
