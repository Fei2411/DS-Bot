// On macOS, a packaged app running from a writable .app bundle uses the in-place self-updater
// (downloading from the configured feed, showing a restart card, and stopping the Host on accept),
// while a non-bundle or read-only install falls back to the release page.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { answerCard, handOff, startApp, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const REAL_PLATFORM = process.platform
if (REAL_PLATFORM === 'darwin') Object.defineProperty(process, 'platform', { value: 'darwin' })

test('packaged macOS .app bundle downloads update and prompts to restart in main.mjs', { skip: REAL_PLATFORM !== 'darwin' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-main-darwin-self-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const buildBundle = (dir, version) => {
    const appPath = join(dir, 'DS Bot.app')
    const macosDir = join(appPath, 'Contents', 'MacOS')
    mkdirSync(macosDir, { recursive: true })
    writeFileSync(join(appPath, 'Contents', 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>CFBundleIdentifier</key><string>io.github.fei2411.dsbot</string>',
      '  <key>CFBundleName</key><string>DS Bot</string>',
      '  <key>CFBundleExecutable</key><string>DS Bot</string>',
      `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
      `  <key>CFBundleVersion</key><string>${version}</string>`,
      '  <key>CFBundlePackageType</key><string>APPL</string>',
      '</dict></plist>',
    ].join('\n'))
    const exe = join(macosDir, 'DS Bot')
    writeFileSync(exe, `#!/bin/sh\necho "${version}"\n`)
    chmodSync(exe, 0o755)
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
    return { appPath, exe }
  }

  const installDir = join(root, 'Applications')
  const buildDir = join(root, 'build')
  mkdirSync(installDir, { recursive: true })
  mkdirSync(buildDir, { recursive: true })
  const currentBundle = buildBundle(installDir, '0.2.2')
  const nextBundle = buildBundle(buildDir, '9.9.9')

  const assetName = `DS-Bot-9.9.9-mac-${process.arch}.zip`
  const zipFile = join(root, assetName)
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', nextBundle.appPath, zipFile])
  const zipBytes = readFileSync(zipFile)
  const zipHash = createHash('sha256').update(zipBytes).digest('hex')
  const sumsText = `${zipHash}  ${assetName}\n`

  let baseUrl = ''
  const server = createServer((req, res) => {
    if (req.url === '/releases.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v9.9.9',
        draft: false,
        prerelease: false,
        body: '- Native macOS self-update (#999)',
        assets: [
          { name: assetName, browser_download_url: `${baseUrl}/v9.9.9/${assetName}` },
          { name: 'SHA256SUMS.txt', browser_download_url: `${baseUrl}/v9.9.9/SHA256SUMS.txt` },
        ],
      }]))
      return
    }
    if (req.url === `/v9.9.9/${assetName}`) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBytes.length) })
      res.end(zipBytes)
      return
    }
    if (req.url === '/v9.9.9/SHA256SUMS.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(sumsText)) })
      res.end(sumsText)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  baseUrl = `http://127.0.0.1:${String(server.address().port)}`

  const origExecPath = process.execPath
  Object.defineProperty(process, 'execPath', { value: currentBundle.exe, configurable: true })
  process.env.DS_BOT_UPDATE_URL = `${baseUrl}/releases.json`
  t.after(() => {
    Object.defineProperty(process, 'execPath', { value: origExecPath, configurable: true })
    delete process.env.DS_BOT_UPDATE_URL
  })

  try {
    await startApp()
    await waitFor(() => window() !== undefined, 'open the window')
    await waitFor(() => state.tray !== undefined, 'build the tray')
    const win = window()
    hostState.release()
    await handOff()

    // Wait for the downloaded update to pop the restart card (not the release-page download card).
    await waitFor(() => windowCards(win).length === 1, 'show the restart card')
    const card = windowCards(win)[0]
    assert.match(card.message, /9\.9\.9/u)
    assert.match(card.detail, /Native macOS self-update/u)

    const winEvent = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    const updateState = await state.ipc.get('ds-bot:app-update-state')(winEvent)
    assert.equal(updateState.phase, 'downloaded')
    assert.equal(updateState.version, '9.9.9')
    assert.equal(updateState.autoInstall, true)

    // Choose "Later" (leaving autoInstall=true armed), then perform a data move from Settings.
    // The data-move relaunch must suppress install-on-quit so the detached swap helper never
    // races with Electron's app.relaunch().
    answerCard(1, win)
    const moveDest = join(root, 'moved-data')
    state.openAnswer = { canceled: false, filePaths: [moveDest] }
    const moving = state.ipc.get('ds-bot:move-data')(winEvent)
    await waitFor(() => windowCards(win).length === 2, 'show the move confirmation card')
    answerCard(0, win)
    assert.equal(await moving, true)
    await waitFor(() => state.relaunches.length === 1, 'relaunch after data move')
    await waitFor(() => state.tray?.destroyed === true, 'quit after data move')
    assert.equal(existsSync(join(paths.userData, 'logs', 'mac-updater.log')), false, 'data-move relaunch must not spawn swap helper')
    assert.equal(execFileSync(currentBundle.exe, [], { encoding: 'utf8' }).trim(), '0.2.2', 'bundle stays untouched during data-move relaunch')
  } finally {
    if (!state.tray?.destroyed) {
      app.quit()
      await waitFor(() => state.tray?.destroyed === true, 'take the tray away')
    }
  }
})
