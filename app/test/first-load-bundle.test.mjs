import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(appDir, 'ui/dist')

function ensureBuiltDist() {
  if (!existsSync(join(distDir, 'index.html'))) {
    execFileSync(process.execPath, [join(appDir, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: appDir,
      stdio: 'pipe',
    })
  }
}

test('desktop first-load eager bundle excludes non-English locales, xterm, and on-demand Settings pages', () => {
  ensureBuiltDist()
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const eagerFiles = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map(match => match[1])
  const eagerJs = eagerFiles.filter(file => file.endsWith('.js'))
  assert.ok(eagerJs.length > 0, 'index.html should reference at least one eager JS asset')

  const forbiddenEagerPatterns = [
    /^assets\/ds-bot-locales-/,
    /^assets\/(?:zh|zh-tw|ja|ko|es|fr|de)-/,
    /^assets\/vendor-xterm-/,
    /^assets\/workspace-terminal-/,
    /^assets\/settings-/,
    /^assets\/usage-page-/,
    /^assets\/providers-page-/,
    /^assets\/plugins-page-/,
  ]
  for (const file of eagerJs) {
    for (const pattern of forbiddenEagerPatterns) {
      assert.doesNotMatch(file, pattern, `eager bundle must not preload ${file}`)
    }
  }

  // Verify the eager JS source text itself does not inline non-English locale dictionaries or xterm.
  let eagerCode = ''
  for (const file of eagerJs) eagerCode += readFileSync(join(distDir, file), 'utf8')
  assert.doesNotMatch(eagerCode, /自动审批/, 'zh dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /自動審批/, 'zh-TW dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /自動レビュー|自動承認/, 'ja dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /자동 검토/, 'ko dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /Revisión automática/, 'es dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /Vérification automatique/, 'fr dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /Automatische Prüfung/, 'de dictionary must not be inlined in eager JS')
  assert.doesNotMatch(eagerCode, /xterm-screen/, 'xterm runtime must not be inlined in eager JS')

  // Verify all split lazy chunks were emitted in assets/.
  const allAssets = readdirSync(join(distDir, 'assets'))
  for (const prefix of ['zh-', 'ja-', 'ko-', 'es-', 'fr-', 'de-', 'vendor-xterm-', 'workspace-terminal-', 'settings-', 'usage-page-', 'providers-page-', 'plugins-page-']) {
    assert.ok(allAssets.some(name => name.startsWith(prefix) && name.endsWith('.js')), `expected lazy chunk starting with ${prefix}`)
  }
})
