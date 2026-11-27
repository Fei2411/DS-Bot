import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { importTeam } from '../src/import.mjs'
import { createDeferredPrompt } from '../src/update-prompt.mjs'
import { summarizeReleaseNotes, watchReleases, watchUpdates } from '../src/updates.mjs'

describe('pre-update release notes summary', () => {
  test('summarizeReleaseNotes strips download blocks, tables, HTML, and PR citations', () => {
    const body = [
      '<!-- downloads -->',
      '## Download / 下载',
      '| System | File |',
      '| --- | --- |',
      '| macOS | DS-Bot.zip |',
      '<!-- /downloads -->',
      '',
      '### Added',
      '- **Settings console**: New [overview](https://example.com) and `⌘K` search. (#2028)',
      '- **Feature packs**: Load MCP and skills on demand. (by @alice; #2019)',
      '- Third item',
      '- Fourth item',
      '- Fifth item should be capped',
    ].join('\n')

    const summary = summarizeReleaseNotes(body)
    assert.equal(summary.split('\n').length, 4)
    assert.match(summary, /^• Settings console: New overview and ⌘K search\./)
    assert.doesNotMatch(summary, /Download|DS-Bot\.zip|#2028|@alice|Fifth item/)

    const htmlSummary = summarizeReleaseNotes([
      { version: '0.3.10', note: '<ul><li><strong>Clean UI</strong> (<a href="https://x">#12</a>)</li><li>Fast startup</li></ul>' },
    ])
    assert.equal(htmlSummary, '• Clean UI\n• Fast startup')

    const htmlWithDownloadsAndEntities = summarizeReleaseNotes(
      '<h2>Download / 下载</h2><table><tr><th>System</th><th>File</th></tr><tr><td>macOS</td><td>DS-Bot.zip</td></tr></table>'
      + '<p>Manual download instructions should be skipped</p>'
      + '<h2>Highlights</h2><ul><li>It&#x27;s faster &amp;amp; &#39;cleaner&#39;</li><li>Keep &amp;lt;tag&amp;gt; literal</li></ul>',
    )
    assert.equal(htmlWithDownloadsAndEntities, "• It's faster &amp; 'cleaner'\n• Keep &lt;tag&gt; literal")
    assert.doesNotMatch(htmlWithDownloadsAndEntities, /Download|DS-Bot\.zip|Manual download/)

    assert.equal(summarizeReleaseNotes(''), '')
    assert.equal(summarizeReleaseNotes(null), '')
  })

  test('watchReleases passes extracted summary through deferred prompt', async () => {
    const asked = []
    const state = { shown: false }
    const deferred = createDeferredPrompt({
      ask: async (version, meta) => { asked.push({ version, meta }); return false },
      shown: () => state.shown,
      log: { info: () => {}, error: () => {} },
    })
    const watcher = watchReleases({
      current: '0.3.9',
      arch: 'arm64',
      fetch: async () => ({
        ok: true,
        json: async () => [{
          tag_name: 'v0.3.10',
          html_url: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v0.3.10',
          body: '<!-- downloads -->\n| a | b |\n<!-- /downloads -->\n- Faster settings\n- Bug fixes (#99)',
          assets: [{ name: 'DS-Bot-0.3.10-mac-arm64.zip' }],
        }],
      }),
      ask: (version, meta) => deferred.prompt(version, meta),
      open: () => {},
      log: { info: () => {}, error: () => {} },
    })
    await watcher.latest()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(deferred.waiting(), '0.3.10')
    assert.equal(watcher.state().notes, '• Faster settings\n• Bug fixes')

    state.shown = true
    await deferred.flush()
    assert.deepEqual(asked, [{ version: '0.3.10', meta: { notes: '• Faster settings\n• Bug fixes' } }])
    watcher.stop()
  })

  test('watchUpdates forwards electron-updater releaseNotes to ask', async () => {
    const listeners = new Map()
    const updater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: (event, fn) => { listeners.set(event, fn) },
      checkForUpdates: async () => ({ isUpdateAvailable: false }),
      quitAndInstall: () => {},
    }
    const asked = []
    const watcher = watchUpdates({
      updater,
      beforeInstall: async () => {},
      ask: async (version, meta) => { asked.push({ version, meta }); return false },
      log: { info: () => {}, error: () => {} },
    })
    await watcher.latest()
    listeners.get('update-downloaded')({
      version: '0.3.10',
      releaseNotes: '<p>- Smoother chats</p><p>- Better stability</p>',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(asked, [{ version: '0.3.10', meta: { notes: '• Smoother chats\n• Better stability' } }])
    watcher.stop()
  })

  test('importTeam seeds currentVersion into staged state.json without modifying source DSH home', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'dsb-import-rn-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const from = join(root, 'from')
    const to = join(root, 'to')
    const workspace = join(root, 'workspace')
    mkdirSync(join(from, 'bot'), { recursive: true })
    mkdirSync(to, { recursive: true })
    const sourceState = {
      version: 1,
      mainBotIds: ['b1'],
      bots: { b1: { id: 'b1', name: 'Chief' } },
      rooms: {},
      agents: {},
    }
    writeFileSync(join(from, 'bot', 'state.json'), JSON.stringify(sourceState))

    await importTeam({ from, to, workspace, currentVersion: '0.3.10' })

    const imported = JSON.parse(readFileSync(join(to, 'bot', 'state.json'), 'utf8'))
    assert.equal(imported.lastSeenVersion, '0.3.10')
    // Source DSH home remains untouched.
    const untouched = JSON.parse(readFileSync(join(from, 'bot', 'state.json'), 'utf8'))
    assert.equal('lastSeenVersion' in untouched, false)
  })

  test('preserves backtick angle-bracket tokens and avoids double-decoding numeric entities in summaries', () => {
    const htmlWithCode = [
      '<ul>',
      '<li>Preserve `</DSML>` and `<ThemedShell />` tokens in summaries</li>',
      '<li>Literal &#38;lt; and &amp;lt; stay escaped, while &#x27;ok&#x27; decodes</li>',
      '</ul>',
    ].join('\n')
    const summary = summarizeReleaseNotes(htmlWithCode)
    assert.match(summary, /<\/DSML>/)
    assert.match(summary, /<ThemedShell \/>/)
    assert.match(summary, /&lt;/)
    assert.match(summary, /'ok'/)
  })
})
