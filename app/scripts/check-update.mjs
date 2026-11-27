// Check a packaged app's update on throwaway folders. Windows, writable macOS .app bundles, and
// a Linux AppImage download and install a feed; a Linux deb reads the latest release and opens no
// browser.
// Usage: node scripts/check-update.mjs <app executable> <feed folder with latest.yml, latest-linux.yml, or mac zip> [--kill]
//        node scripts/check-update.mjs <app executable> <version> (Linux deb)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { mockKeychainArgs } from '../src/legacy.mjs'
import { resolveMacAppBundle } from '../src/mac-updater.mjs'

const [executable, source, mode] = process.argv.slice(2)
const mac = process.platform === 'darwin'
// Windows, writable macOS .app bundles, and Linux AppImages update themselves; Linux debs only
// hear of the release.
const releasePage = process.platform === 'linux' && !executable?.endsWith('.AppImage')
const manifest = process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'
// The asset the fake release lists for a Linux deb install (x64 → amd64).
const debAsset = version => `DS-Bot-${version}-linux-${{ x64: 'amd64' }[process.arch] ?? process.arch}.deb`

let macZipName
let macZipVersion
let macZipSha256
if (mac && source && existsSync(source) && statSync(source).isDirectory()) {
  const pattern = new RegExp(`^DS-Bot-(.+)-mac-${process.arch}\\.zip$`, 'u')
  for (const entry of readdirSync(source)) {
    const match = pattern.exec(entry)
    if (match !== null) {
      macZipName = entry
      macZipVersion = match[1]
      break
    }
  }
}

const macValid = mac ? (macZipName !== undefined && (mode === undefined || mode === '--kill')) : true
const nonMacValid = releasePage
  ? mode === undefined
  : (!mac && existsSync(join(source ?? '', manifest)) && (mode === undefined || mode === '--kill'))

if (!executable || !source || !existsSync(executable) || !(mac ? macValid : nonMacValid)) {
  console.error(`check-update: usage: ${releasePage
    ? 'node scripts/check-update.mjs <app executable> <version>'
    : mac
      ? `node scripts/check-update.mjs <app executable> <feed folder with DS-Bot-<version>-mac-${process.arch}.zip> [--kill]`
      : `node scripts/check-update.mjs <app executable> <feed folder with ${manifest}> [--kill]`}`)
  process.exit(2)
}

if (mac) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(source, macZipName))) hash.update(chunk)
  macZipSha256 = hash.digest('hex')
}

const version = releasePage
  ? source
  : mac
    ? macZipVersion
    : /^version:\s*(\S+)/mu.exec(readFileSync(join(source, manifest), 'utf8'))?.[1]
const macBundle = mac ? resolveMacAppBundle(resolve(executable)) : null
if (mac && !macBundle?.eligible) {
  console.error(`check-update: macOS executable is not in a writable .app bundle (${macBundle?.reason})`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
mkdirSync(join(work, 'home'))

let feed = ''
const served = []
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://feed/').pathname
  if (releasePage) {
    if (request.method !== 'GET' || pathname !== '/') { response.writeHead(404).end(); return }
    served.push(pathname)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
      tag_name: `v${version}`,
      html_url: `https://github.com/Fei-Craft/DS-Bot/releases/tag/v${version}`,
      draft: false,
      prerelease: false,
      assets: [{ name: debAsset(version) }],
    }]))
    return
  }
  if (mac) {
    if (request.method !== 'GET') { response.writeHead(404).end(); return }
    if (pathname === '/') {
      served.push('/')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
        tag_name: `v${version}`,
        html_url: `https://github.com/Fei-Craft/DS-Bot/releases/tag/v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          { name: macZipName, browser_download_url: `${feed}${encodeURIComponent(macZipName)}` },
          { name: 'SHA256SUMS.txt', browser_download_url: `${feed}SHA256SUMS.txt` },
        ],
      }]))
      return
    }
    if (pathname === '/SHA256SUMS.txt') {
      served.push('SHA256SUMS.txt')
      const body = `${macZipSha256}  ${macZipName}\n`
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }).end(body)
      return
    }
    const name = basename(decodeURIComponent(pathname))
    if (name !== macZipName) { response.writeHead(404).end(); return }
    const file = join(source, macZipName)
    served.push(name)
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': statSync(file).size })
    createReadStream(file).pipe(response)
    return
  }
  const name = basename(decodeURIComponent(pathname))
  const file = join(source, name)
  served.push(name)
  if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-length': statSync(file).size })
  createReadStream(file).pipe(response)
})
await new Promise((done) => { server.listen(0, '127.0.0.1', done) })
feed = `http://127.0.0.1:${String(server.address().port)}/`

// The tray's Quit ends the app. The check cannot click the tray icon, so it asks the browser
// target of the debugging port to close. Tray menu dispatch is covered by the main-process tests.
async function quitApp(port, waitForReady = false) {
  // Until the Host is ready only the start window is there (a file: page); the team window
  // loads the Host's address once the engine is up.
  const find = async () => {
    const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
    const pages = targets.filter(target => target.type === 'page' && (/^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url) || /\/src\/start\/start\.html\?start=/u.test(target.url)))
    return pages.find(target => target.url.startsWith('http:')) ?? (waitForReady ? undefined : pages[0])
  }
  let page = await find()
  for (const end = Date.now() + 120_000; page === undefined && waitForReady && Date.now() < end; page = await find()) await sleep(500)
  if (!page) throw new Error('the app window is not there')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  if (waitForReady) {
    const ready = await new Promise((done, reject) => {
      const timer = setTimeout(() => { reject(new Error('the app window did not finish booting')) }, 120_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else done(message.result?.result?.value === true)
      })
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: "new Promise(resolve => { const end = Date.now() + 120000; const check = () => { if (document.querySelector('.bt-tile, .bt-row')) resolve(true); else if (Date.now() >= end) resolve(false); else setTimeout(check, 250) }; check() })",
          returnByValue: true,
          awaitPromise: true,
        },
      }))
    })
    if (!ready) throw new Error('the app window did not finish booting')
  }
  socket.close()
  const browserVersion = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const browser = new WebSocket(browserVersion.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    browser.addEventListener('open', done, { once: true })
    browser.addEventListener('error', reject, { once: true })
  })
  browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  browser.close()
}

// taskkill /T takes the Host and Electron's helpers along; a unix kill ends the tree's root,
// and the app's own children go with it.
function killApp() {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  else app?.kill()
}

let failed = false
let app
try {
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, { DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'), DS_BOT_UPDATE_URL: feed, DS_BOT_TELEMETRY_DISABLED: '1' })
  const port = 9300 + Math.floor(Math.random() * 600)
  app = spawn(resolve(executable), [...mockKeychainArgs(), `--remote-debugging-port=${String(port)}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((done) => { app.once('exit', (code) => { done(code) }) })
  let output = ''
  for (const stream of [app.stdout, app.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
  }
  const updateLine = `DS Bot: update ${String(version)} ${releasePage ? 'available' : 'downloaded'}`
  const end = Date.now() + (releasePage ? 3 : 5) * 60_000
  while (!output.includes(updateLine)) {
    if (releasePage ? /DS Bot: update check failed/u.test(output) : /DS Bot: update failed/u.test(output)) {
      throw new Error('the app reported a failed update')
    }
    if (app.exitCode !== null) {
      const status = releasePage ? 'the update was found' : 'the update was downloaded'
      throw new Error(`the app exited (code ${String(app.exitCode)}) before ${status}`)
    }
    if (Date.now() > end) throw new Error(releasePage ? 'the update was not found within 3 minutes' : 'the update was not downloaded within 5 minutes')
    await sleep(500)
  }
  if (releasePage && !served.includes('/')) throw new Error('the release feed was not requested')
  console.log(`check-update: ${updateLine}; the feed served ${served.join(', ')}`)
  if (releasePage) {
    await quitApp(port, true)
    const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout')])
    if (code === 'timeout') throw new Error('the app did not exit after its window closed')
    if (code !== 0) throw new Error(`the app exited with code ${String(code)}`)
    console.log('check-update: the app quit without installing')
  } else if (mode === '--kill') {
    killApp()
    await exited
    console.log('check-update: ended the app, so nothing was installed')
  } else {
    await quitApp(port)
    const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout')])
    if (code === 'timeout') throw new Error('the app did not exit after its window closed')
    if (code !== 0) throw new Error(`the app exited with code ${String(code)}, so it does not install the update`)
    console.log('check-update: the app quit; its installer runs now')
    if (mac) {
      // Wait for the detached macOS swap helper to finish replacing the bundle BEFORE removing
      // `work` (which holds DS_BOT_SHELL_DATA/mac-updates staging).
      const swapDeadline = Date.now() + 90_000
      let swapped = ''
      while (Date.now() < swapDeadline) {
        try {
          swapped = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(macBundle.appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
          if (swapped === version) break
        } catch { /* mid-swap */ }
        await sleep(250)
      }
      if (swapped !== version) {
        const logPath = join(work, 'shell', 'logs', 'mac-updater.log')
        const logTail = existsSync(logPath) ? `\n${readFileSync(logPath, 'utf8')}` : ''
        throw new Error(`macOS bundle version is ${swapped || '<unreadable>'}, expected ${version}${logTail}`)
      }
      console.log(`check-update: macOS bundle swapped to ${swapped}`)
    }
  }
  console.log('check-update: passed')
} catch (error) {
  failed = true
  console.error(`check-update: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  if (app?.exitCode === null) killApp()
}
server.close()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
