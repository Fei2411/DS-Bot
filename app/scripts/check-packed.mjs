// Check a packaged app: copy files that end in .asar with its copy of a user's folders, process an image with its sharp, convert a Word document with its LibreOffice engine, then start it on throwaway folders with the ds-bot mock model, choose a model,
// send a message, wait for the reply, then close the window the way a user does: the window hides
// and the app goes on. The window comes back when the app is started again, and the app ends the
// way the tray's Quit ends it. Fails on a page error or a non-zero exit.
// Usage: node scripts/check-packed.mjs [app executable] [screenshot.png]
// The executable defaults to the one that `npm run pack` or `npm run dist` writes into dist-pack/.
import { spawn, spawnSync } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { hostExecutable } from '../src/host-process.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, shotFile] = process.argv.slice(2)
const executable = given || packedExecutable()

function packedExecutable() {
  const out = join(root, 'dist-pack')
  if (process.platform === 'win32') return join(out, 'win-unpacked', 'DS Bot.exe')
  // executableName in electron-builder.yml.
  if (process.platform === 'linux') return join(out, 'linux-unpacked', 'dsbot')
  const dir = ['mac-arm64', 'mac'].find(name => existsSync(join(out, name))) ?? 'mac'
  return join(out, dir, 'DS Bot.app', 'Contents', 'MacOS', 'DS Bot')
}

if (!existsSync(executable)) {
  console.error(`check-packed: no app at ${executable}. Run npm run pack first.`)
  process.exit(2)
}

// The Office payload sits next to the asar as extraResources, and the LibreOffice Kit CLI is a
// plain file in the unpacked tree; without them the app's Office skills and tools cannot run.
{
  const resources = process.platform === 'darwin' ? join(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources')
  const windows = process.platform === 'win32'
  const unpacked = process.platform === 'linux' ? 'app' : 'app.asar.unpacked'
  const required = [
    'primary-runtime/runtime.json',
    join('primary-runtime', 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    join('primary-runtime', 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node'),
    join('office-skills', 'office', 'SKILL.md'),
    join(unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'),
    join(unpacked, 'node_modules', 'ds-bot', 'office.js'),
  ]
  const missing = required.filter((entry) => !existsSync(join(resources, entry)))
  // macOS carries the signed "DSH Computer Use" helper outside the asar, in a
  // hash-named folder; find it by its name rather than the changing hash.
  if (process.platform === 'darwin') {
    const rootDir = join(resources, unpacked, 'node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos', 'native', 'bin')
    const dirs = existsSync(rootDir) ? readdirSync(rootDir) : []
    const helper = dirs.flatMap(dir => {
      const here = join(rootDir, dir)
      return existsSync(here) ? readdirSync(here).map(hash => join(here, hash, 'DSH Computer Use.app')) : []
    }).find(entry => existsSync(entry))
    if (helper === undefined) missing.push(join(unpacked, 'node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos', 'native', 'bin', '<arch>', '<hash>', 'DSH Computer Use.app'))
  }
  if (missing.length > 0) {
    console.error(`check-packed: FAILED: missing from ${resources}:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
}

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ds-bot-packed-')))
mkdirSync(join(work, 'home'))
mkdirSync(join(work, 'shell'))
// CDP cannot answer the native first-close dialog. The notice has its own tests; this check
// exercises hiding and reopening a window after the user has acknowledged it.
writeFileSync(join(work, 'shell', 'tray-close-acknowledged'), '')
const children = []

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    // On Windows a plain kill ends only the main process; /T takes the Host and Electron's helpers along.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill()
  }
}

// An app that hangs, for example behind its error box, must not hold up CI.
setTimeout(() => {
  console.error('check-packed: FAILED: gave up after 8 minutes')
  stopChildren()
  process.exit(1)
}, 8 * 60_000).unref()

// Run from inside this checkout, the app would find a module that the build left out in the
// checkout's own node_modules, so the check runs a copy of the app from the throwaway folder.
function outsideCheckout(file) {
  const fromCheckout = relative(resolve(root, '..'), file)
  if (fromCheckout.startsWith('..') || isAbsolute(fromCheckout)) return file
  const appDir = process.platform === 'darwin' ? resolve(file, '..', '..', '..') : dirname(file)
  const copy = join(work, basename(appDir))
  cpSync(appDir, copy, { recursive: true, verbatimSymlinks: true })
  console.log(`check-packed: runs a copy of ${appDir} in ${work}`)
  return join(copy, relative(appDir, file))
}

// The copy that the import and the data move share, in Electron's own fs, which plain Node and so
// the tests do not have: a user's files that end in .asar arrive as they are and can be removed.
function checkAsarCopy(app) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const tree = join(resources, process.platform === 'linux' ? 'app' : 'app.asar', 'src', 'copy-tree.mjs')
  const result = spawnSync(app, ['-e', `
    const assert = require('node:assert/strict')
    const { join } = require('node:path')
    const { pathToFileURL } = require('node:url')
    const work = ${JSON.stringify(join(work, 'asar-copy'))}
    // asar's own format: two size headers, the length of the JSON, the JSON padded to 4 bytes, the files.
    const json = Buffer.from(JSON.stringify({ files: { 'f.txt': { size: 2, offset: '0' } } }))
    const padded = Math.ceil(json.length / 4) * 4
    const archive = Buffer.alloc(16 + padded + 2)
    for (const [at, size] of [[0, 4], [4, 8 + padded], [8, 4 + padded], [12, json.length]]) archive.writeUInt32LE(size, at)
    json.copy(archive, 16)
    archive.write('hi', 16 + padded)
    import(pathToFileURL(${JSON.stringify(tree)}).href).then(async ({ copyTree, disk }) => {
      assert.ok(process.versions.electron, 'this check needs Electron')
      const files = { 'valid.asar': archive, 'junk.asar': Buffer.from('no archive'), 'folder.asar/in.txt': Buffer.from('in') }
      for (const [name, content] of Object.entries(files)) {
        disk.mkdirSync(join(work, 'from', name, '..'), { recursive: true })
        disk.writeFileSync(join(work, 'from', name), content)
      }
      assert.deepEqual(await copyTree(join(work, 'from'), join(work, 'to'), { skip: true }), [])
      for (const [name, content] of Object.entries(files)) assert.ok(disk.readFileSync(join(work, 'to', name)).equals(content), name)
      await disk.promises.rm(join(work, 'to'), { recursive: true })
      assert.equal(disk.existsSync(join(work, 'to')), false)
      console.log('check-packed: files that end in .asar are copied as they are')
    }).catch((error) => { console.error(error); process.exit(1) })
  `], { cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(`the .asar copy check failed (exit ${String(result.status)}): ${result.error?.message ?? result.stderr}`)
  console.log(result.stdout.trim())
}

// Run a script with the Host's runtime and the app's dependencies as the Host loads them,
// outside the checkout and not with the CI runner's Node.
function runInHost(app, what, script, timeout) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const linux = process.platform === 'linux'
  const prelude = `
    const assert = require('node:assert/strict')
    const { createRequire } = require('node:module')
    ${linux ? "assert.equal(process.versions.electron, undefined, 'the Linux Host must not run in Electron')" : ''}
    const appRequire = createRequire(${JSON.stringify(join(resources, linux ? 'app' : 'app.asar', 'package.json'))})
  `
  const result = spawnSync(linux ? hostExecutable(resources) : app, ['-e', prelude + script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    encoding: 'utf8', timeout,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged ${what} failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}`)
  console.log(result.stdout.trim())
}

function checkSharp(app) {
  runInHost(app, 'sharp', `
    const sharp = appRequire('sharp')
    ;(async () => {
      const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
      const { data, info } = await sharp(image).resize(2, 2).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 2)
      assert.equal(info.height, 2)
      assert.deepEqual([...data], Array.from({ length: 4 }, () => [255, 0, 0]).flat())
      console.log('check-packed: sharp image processing passed (libvips ' + sharp.versions.vips + ')')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `, 30_000)
}

// A zip archive of stored (uncompressed) files.
function zip(files) {
  const records = []
  const directory = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path)
    const data = Buffer.from(text)
    // The fields that the local header and the directory entry share: zip 2.0, stored, dated 1980-01-01.
    const shared = Buffer.alloc(26)
    shared.writeUInt16LE(20, 0)
    shared.writeUInt16LE(0x21, 8)
    shared.writeUInt32LE(crc32(data), 10)
    shared.writeUInt32LE(data.length, 14)
    shared.writeUInt32LE(data.length, 18)
    shared.writeUInt16LE(name.length, 22)
    const local = Buffer.alloc(4)
    local.writeUInt32LE(0x04034b50)
    const entry = Buffer.alloc(6)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4)
    const entryEnd = Buffer.alloc(14)
    entryEnd.writeUInt32LE(offset, 10)
    records.push(local, shared, name, data)
    directory.push(entry, shared, entryEnd, name)
    offset += local.length + shared.length + name.length + data.length
  }
  const listing = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(listing.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...records, listing, end])
}

function wordDocument(text) {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  })
}

// File previews convert Office files with the LibreOffice engine, a program that the kit
// resolves and starts. From inside the asar it cannot start, and every preview fails (#679).
function checkOffice(app) {
  const folder = join(work, 'office')
  mkdirSync(folder)
  const input = join(folder, 'check.docx')
  const output = join(folder, 'check.pdf')
  writeFileSync(input, wordDocument('packaged app check'))
  runInHost(app, 'Office conversion', `
    const { readFileSync } = require('node:fs')
    const { pathToFileURL } = require('node:url')
    ;(async () => {
      const kit = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/libreoffice-kit')).href)
      const { backend } = await kit.discoverRuntime()
      const converter = await kit.createConverter({ fontMetadataCacheDirectory: ${JSON.stringify(join(folder, 'fonts'))} })
      try {
        await converter.render({ inputPath: ${JSON.stringify(input)}, outputPath: ${JSON.stringify(output)} })
      } finally {
        await converter.dispose()
      }
      assert.equal(readFileSync(${JSON.stringify(output)}).subarray(0, 5).toString('latin1'), '%PDF-')
      console.log('check-packed: Office conversion passed (' + backend + ' engine)')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `, 180_000)
}

// The browser plugins drive the app's own browser through Playwright; without it in the package
// every browser tool failed before it did anything.
function checkPlaywright(app) {
  runInHost(app, 'Playwright', `
    const { chromium } = createRequire(appRequire.resolve('ds-bot/package.json'))('playwright-core')
    assert.equal(typeof chromium.connectOverCDP, 'function')
    console.log('check-packed: the browser plugins find Playwright')
  `, 30_000)
}

// Computer use on Windows loads the Cua Driver SDK's DLL by a path that the SDK derives from its
// own module; a module inside the asar gives a path that Windows' loader cannot open (#1025).
// The SDK is found the way the provider's import finds it, then asked for its tools.
function checkComputerUse(app) {
  runInHost(app, 'computer use driver', `
    const { existsSync } = require('node:fs')
    const { join } = require('node:path')
    const { pathToFileURL } = require('node:url')
    ;(async () => {
      const provider = appRequire.resolve('@deepseek-ai/dsh-experimental-computer-use-cua-driver-native')
      const sdk = createRequire(provider).resolve.paths('@trycua/cua-driver')
        .map(dir => join(dir, '@trycua', 'cua-driver')).find(dir => existsSync(join(dir, 'package.json')))
      assert.ok(sdk !== undefined, 'the provider finds no @trycua/cua-driver')
      assert.ok(!/[\\\\/]app\\.asar[\\\\/]/u.test(sdk), 'the Cua Driver SDK is inside the asar: ' + sdk)
      const { CuaDriver } = await import(pathToFileURL(join(sdk, 'dist', 'index.js')).href)
      const driver = CuaDriver.create(undefined)
      const { tools } = JSON.parse(await driver.listToolsJson())
      assert.ok(tools.length > 0, 'the Cua Driver lists no tools')
      await driver.shutdown?.()
      console.log('check-packed: the Cua Driver loads from ' + sdk + ' and lists ' + tools.length + ' tools')
    })().then(() => process.exit(process.exitCode ?? 0), error => { console.error(error); process.exit(1) })
  `, 60_000)
}

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'ds-bot', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(work, 'mock.log') }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(mock)
  return new Promise((done, reject) => {
    let text = ''
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', (chunk) => {
      text += chunk
      const url = /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(text)?.[0]
      if (url) done(url)
    })
    mock.once('exit', (code) => { reject(new Error(`check-packed: the mock model stopped (exit ${String(code)})`)) })
  })
}

// Let the OS avoid occupied and reserved ports instead of guessing a fixed range.
async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()) })
  return port
}

async function appPage(port, deadline, main = false) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => main ? target.type === 'node' : target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch {
      // The debugging port is not listening yet.
    }
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

// The Host goes on while the window is hidden: its port answers.
async function hostAlive() {
  const { port } = JSON.parse(readFileSync(join(work, 'shell', 'host-port.json'), 'utf8'))
  await new Promise((done, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); done() })
    socket.once('error', reject)
  })
}

// The tray's Quit ends the app. The check cannot click the tray icon, so it asks the browser
// target of the debugging port to close, which ends the app gracefully.
async function browserClose(port) {
  const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  socket.close()
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer ${method}`))
    }, 30_000)
    const settle = action => (value) => { clearTimeout(timer); action(value) }
    pending.set(id, { resolve: settle(done), reject: settle(reject) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

// material.css and macos.css style DSH's own page, which can change with a DSH upgrade; every
// rule must still find an element, on every platform, so the change shows here and not as a
// broken window. The page is not in fullscreen here, so a rule's html:not([data-fullscreen])
// is dropped before the look. DSH draws its session tree only in the classic Agent view, which
// the check does not open, so the rules for the tree are not looked for.
const frameSheets = ['material.css', 'macos.css']
function frameRules(file) {
  const css = readFileSync(join(root, 'src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  return [...css.matchAll(/([^{}]+)\{/gu)].map(([, selectors]) => selectors.split(',')
    .map(selector => selector.trim().replace(/::(?:before|after)$/u, '').replace(/^html(?::not\(\[data-fullscreen\]\))?\s*/u, ''))
    .filter(selector => selector !== '' && selector !== 'body' && !selector.includes('_treeBody') && !selector.includes('_scrollRegion')))
    .filter(rule => rule.length > 0)
}

async function chat(cdp) {
  const evaluate = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  const until = async (expression, label, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  // DSH shows a preview notice once per profile; it would keep the focus away from the composer.
  const dismissNotice = () => evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  const text = needle => `document.body.innerText.includes(${JSON.stringify(needle)})`
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await until("document.querySelector('.bt-tile, .bt-row')", 'the team')
  for (const file of frameSheets) {
    const stale = await evaluate(`${JSON.stringify(frameRules(file))}.filter(rule => !rule.some(selector => document.querySelector(selector) !== null)).map(rule => rule.join(', '))`)
    if (stale.length > 0) throw new Error(`src/${file} no longer matches DSH's page: ${stale.join(' | ')}`)
  }
  await dismissNotice()
  const main = await evaluate("fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state', payload: {} }) }).then(r => r.json()).then(r => r.value.mainBotId)")
  await evaluate(`document.querySelector(${JSON.stringify(`[data-bot-id="${main}"]`)}).click()`)
  await until("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)')", 'the model choice')
  await evaluate("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)').click()")
  // The mock model's greeting for a new team.
  await until(text('先让团队帮你做哪块'), 'the greeting')
  await dismissNotice()
  // Click the composer through the input pipeline. A bare focus() is not enough where no window
  // manager gives the window focus (xvfb in CI): the text and the Enter would go nowhere.
  const box = "[...document.querySelectorAll('[role=textbox][contenteditable=true], textarea')].at(-1)"
  const focusCheck = "(document.activeElement?.isContentEditable ?? false) || document.activeElement?.tagName === 'TEXTAREA'"
  // A greeting that just arrived leaves the composer rebinding: for a moment the field is
  // not editable, so a click lands on it but does not focus it. The probe and the click are
  // separate round trips, so keep probing and click only where the field itself is on top
  // until the field holds focus.
  const probe = `(() => {
    const el = ${box}
    if (el === undefined) return null
    const rect = el.getBoundingClientRect()
    for (const part of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const point = { x: rect.x + rect.width * part, y: rect.y + rect.height / 2 }
      const hit = document.elementFromPoint(point.x, point.y)
      if (hit === el || (hit !== null && el.contains(hit))) return { x: point.x, y: point.y }
    }
    return null
  })()`
  let shot = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !(await evaluate(`Boolean(${focusCheck})`))) {
    const point = await evaluate(probe)
    if (point !== null && point !== undefined) {
      shot = point
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sleep(300)
    } else await sleep(250)
  }
  if (!(await evaluate(`Boolean(${focusCheck})`))) {
    // Say what was under the cursor, what held the focus and how large the window was.
    const state = await evaluate(`(() => {
      const el = ${box}
      const rect = el === undefined ? null : el.getBoundingClientRect().toJSON()
      const point = rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      const hit = point === null ? null : document.elementFromPoint(point.x, point.y)
      const cover = hit?.closest?.('[role=dialog],[aria-modal=true],[data-slot]')
      const brief = node => (node === null || node === undefined ? null : { tag: node.tagName ?? null, class: String(node.getAttribute?.('class') ?? '').slice(0, 160) })
      return JSON.stringify({
        inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height], dpr: devicePixelRatio, focused: document.hasFocus(),
        click: ${JSON.stringify(shot)}, probe: point, box: rect,
        hit: brief(hit),
        cover: cover === null || cover === undefined ? null : { tag: cover.tagName, slot: cover.getAttribute('data-slot'), role: cover.getAttribute('role'), modal: cover.getAttribute('aria-modal') },
        active: brief(document.activeElement),
      })
    })()`)
    throw new Error(`timed out waiting for the focused composer; page state: ${state}`)
  }
  await cdp.call('Input.insertText', { text: 'packaged app check' })
  await until(text('packaged app check'), 'the typed message', 10_000)
  // DSH's composer drops an Enter while it cannot send: while it is busy, or before it has taken
  // in the inserted text. Its send button is disabled under the same conditions, so press Enter
  // once a user could click the button, as a user who sees it greyed out would wait.
  const send = `(() => {
    let node = ${box}
    while (node && !node.querySelector?.('button[aria-busy]')) node = node.parentElement
    return node?.querySelector('button[aria-busy]') ?? null
  })()`
  const composerState = () => evaluate(`(() => {
    const el = ${box}
    const button = ${send}
    return JSON.stringify({
      active: document.activeElement?.tagName ?? null, editable: document.activeElement?.isContentEditable ?? null,
      draft: el?.innerText ?? null, send: button === null ? null : { label: button.getAttribute('aria-label'), disabled: button.disabled },
      tail: document.body.innerText.slice(-300),
    })
  })()`)
  try {
    await until(`(() => { const button = ${send}; return button !== null && !button.disabled })()`, 'the send button', 30_000)
  } catch (error) {
    throw new Error(`${error.message}; composer: ${await composerState()}`)
  }
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  try {
    await until(`!(${box}?.innerText ?? '').includes('packaged app check')`, 'Enter to send the message', 10_000)
  } catch (error) {
    throw new Error(`${error.message}; composer: ${await composerState()}`)
  }
  // The mock model starts its reply with 收到： and the message.
  try {
    await until(text('收到：packaged app check'), 'the reply')
  } catch (error) {
    throw new Error(`${error.message}; composer: ${await composerState()}`)
  }
  await sleep(1000)
  console.log(`check-packed: chat ${JSON.stringify(await evaluate('document.body.innerText.slice(-200)'))}`)
  if (process.platform === 'darwin') await checkComputerHelper(evaluate, until)
}

async function checkComputerHelper(evaluate, until) {
  const helperHome = join(work, 'shell', 'computer-use')
  const call = (endpoint, payload = {}) => `fetch('api/bot', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: ${JSON.stringify(JSON.stringify({ endpoint, payload }))},
  }).then(r => r.json()).then(r => r.value)`
  const provider = `${call('state')}.then(state => state.computer.provider)`

  // A file at the copy location forces a real filesystem error without touching the bundle.
  writeFileSync(helperHome, '')
  await evaluate(call('computer-set-enabled', { enabled: true }))
  await until(`${provider}.then(provider => provider.state !== 'loading')`, 'the computer-use provider error')
  const failure = await evaluate(provider)
  if (failure.state !== 'error' || !failure.message.startsWith('Could not prepare the macOS computer-use helper:')) {
    throw new Error(`expected the helper preparation error: ${JSON.stringify(failure)}`)
  }
  rmSync(helperHome)
  const retry = await evaluate(call('computer-provider-retry'))
  if (retry?.provider?.state !== 'ready') {
    throw new Error(`the computer-use provider could not retry: ${JSON.stringify(retry?.provider)}`)
  }
  console.log('check-packed: retry prepared the computer-use helper outside the app')

  // The hosted macOS 26 Intel runner hangs in IconServices when the DSH helper starts.
  if (process.arch === 'x64' && process.env.GITHUB_ACTIONS === 'true') {
    console.log('check-packed: skipping the native permission query on the hosted Intel runner')
  } else {
    const status = await evaluate(call('computer-system-status'))
    if (typeof status?.accessibility !== 'boolean' || !status?.helper?.path?.startsWith(helperHome + '/')) {
      throw new Error(`the computer-use helper did not answer from outside the app: ${JSON.stringify(status)}`)
    }
    console.log(`check-packed: the computer-use helper answers from ${status.helper.path}`)
  }
  await evaluate(call('computer-set-enabled', { enabled: false }))
}

let failed = false
const problems = []
try {
  const packedApp = outsideCheckout(resolve(executable))
  checkAsarCopy(packedApp)
  checkSharp(packedApp)
  checkOffice(packedApp)
  checkPlaywright(packedApp)
  if (process.platform === 'win32') checkComputerUse(packedApp)
  const modelUrl = await startMock()
  const port = await freePort()
  const mainPort = await freePort()
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, {
    DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  const app = spawn(packedApp, [`--remote-debugging-port=${String(port)}`, `--inspect=127.0.0.1:${String(mainPort)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const main = devtools((await appPage(mainPort, Date.now() + 30_000, true)).webSocketDebuggerUrl, problems)
  await main.opened
  const windowState = async expression => {
    const answer = await main.call('Runtime.evaluate', {
      expression: `(() => { const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const win = BrowserWindow.getAllWindows()[0]; return ${expression} })()`,
      returnByValue: true, awaitPromise: true,
    })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result?.value
  }
  const chatError = await chat(cdp).then(() => undefined, error => error)
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${resolve(shotFile)}`)
  }
  if (chatError) throw chatError
  // Close the native window: a renderer-initiated close can stop page CDP evaluations even
  // when Electron prevents the close. Read visibility from the main process as well.
  await windowState('win.close()')
  await sleep(4000)
  if (app.exitCode !== null) throw new Error('the app ended with its window')
  if (await windowState('win !== undefined && !win.isDestroyed() && !win.isVisible()') !== true) throw new Error('the window is not hidden')
  await hostAlive()
  console.log('check-packed: the window is hidden and the Host goes on')
  // Starting the app again brings the window back; the second copy ends at once, because the
  // first one holds the lock.
  const second = spawn(packedApp, [`--remote-debugging-port=${String(await freePort())}`], { stdio: 'ignore', env })
  children.push(second)
  const secondExit = await Promise.race([new Promise((done) => { second.once('exit', (code) => { done(code) }) }), sleep(30_000).then(() => undefined)])
  if (secondExit === undefined) throw new Error('the second copy of the app did not end')
  if (app.exitCode !== null) throw new Error('the app ended when it was started again')
  if (await windowState('win !== undefined && !win.isDestroyed() && win.isVisible()') !== true) throw new Error('the window did not come back')
  console.log('check-packed: the window came back when the app was started again')
  // The tray's Quit is the way out; the check cannot click the tray, so it asks the browser
  // target to close, which ends the app gracefully.
  // Stopping the Host closes its event stream; that expected shutdown is not a page failure.
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  cdp.close()
  main.close()
  await browserClose(port)
  const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
  if (outcome === undefined) throw new Error('the app did not exit after the quit')
  console.log(`check-packed: app exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.message : String(error)}`)
}
stopChildren()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
