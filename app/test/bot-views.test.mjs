import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { BotViews, isBotId } from '../src/bot-views.mjs'

// Windows makes a junction to a folder without special rights; elsewhere it is a plain
// symbolic link to the folder.
const folderLink = process.platform === 'win32' ? 'junction' : 'dir'

function fixture({ statePath, zoom = 1, ...extra } = {}) {
  const changes = []
  const handlers = new Map()
  const views = []
  class WebContents extends EventEmitter {
    constructor() {
      super()
      this.url = 'about:blank'
      this.loadedUrls = []
      this.reloadCount = 0
      this.closedCount = 0
      this.closedOptions = []
      this.audioMuted = undefined
      this.debugger = Object.assign(new EventEmitter(), {
        attached: false,
        attachCount: 0,
        detachCount: 0,
        isAttached() { return this.attached },
        attach() { this.attached = true; this.attachCount += 1 },
        detach() { this.attached = false; this.detachCount += 1 },
        async sendCommand(method) {
          if (!this.attached) throw new Error('Debugger is not attached')
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', url: 'https://example.com/' } } }
          return { method }
        },
      })
    }
    getURL() { return this.url }
    getTitle() { return this.url }
    isLoading() { return false }
    canGoBack() { return false }
    canGoForward() { return false }
    isDestroyed() { return false }
    setAudioMuted(muted) { this.audioMuted = muted }
    async loadURL(url) { this.url = url; this.loadedUrls.push(url) }
    reload() { this.reloadCount += 1 }
    async executeJavaScript(script) { return script }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
    close(options) { this.closedCount += 1; this.closedOptions.push(options) }
    focus() {}
  }
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.webContents = new WebContents()
      views.push(this)
    }
    setBounds(bounds) { this.bounds = bounds }
    setVisible(visible) { this.visible = visible }
  }
  const guests = {
    storageFor(key) { return { partition: `persist:${key}` } },
    setDownloadHandler(key, handler) { handlers.set(key, handler) },
  }
  const added = []
  const removed = []
  let window = { webContents: { getZoomFactor: () => zoom }, contentView: { addChildView(view) { added.push(view) }, removeChildView(view) { removed.push(view) } } }
  const manager = new BotViews({ window: () => window, WebContentsView, guests, origin: () => 'http://127.0.0.1:43117', statePath, onChange: change => changes.push(change), ...extra })
  return { manager, handlers, views, changes, added, removed, setWindow: (next) => { window = next }, setZoom: (value) => { zoom = value } }
}

test('pane placement converts CSS pixels to window DIPs at the current page zoom', t => {
  const { manager, views, setZoom } = fixture({ zoom: 2 })
  t.after(() => manager.dispose())
  manager.create('a', { tabId: 'A' })
  const rect = { left: 120.25, top: 40.25, width: 400.25, height: 300.25 }
  manager.place('A', rect, true)
  assert.deepEqual(views[0].bounds, { x: 241, y: 81, width: 801, height: 601 })
  setZoom(0.5)
  manager.place('A', rect, true)
  assert.deepEqual(views[0].bounds, { x: 60, y: 20, width: 200, height: 150 })
  setZoom(1)
  manager.place('A', rect, true)
  assert.deepEqual(views[0].bounds, { x: 120, y: 40, width: 400, height: 300 })
  manager.place('A', null, false)
  assert.equal(views[0].visible, false)
  assert.deepEqual(views[0].bounds, { x: 120, y: 40, width: 400, height: 300 })
  assert.equal(manager.place('missing', rect, true), false)
})

test('Bot endpoint identifiers follow DSH session.create IDs', () => {
  assert.equal(isBotId('session-7e90ddf9-38a7-4c6c-b37a-1c445f771234'), true)
  assert.equal(isBotId('7e90ddf9-38a7-4c6c-b37a-1c445f771234'), false)
  assert.equal(isBotId('session-1'), false)
})

test('Bot endpoints accept only up to four absolute download roots', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  await assert.rejects(() => manager.endpoint('a', { downloadRoots: ['relative'] }), /Invalid browser download roots/u)
  await assert.rejects(() => manager.endpoint('a', { downloadRoots: new Array(1) }), /Invalid browser download roots/u)
  await assert.rejects(() => manager.endpoint('a', { downloadRoots: ['/a', '/b', '/c', '/d', '/e'] }), /Invalid browser download roots/u)
  assert.match(await manager.endpoint('a', { downloadRoots: ['/a', '/b', '/c', '/d'] }), /^ws:\/\//u)
})

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function closed(socket) {
  return new Promise(resolve => {
    socket.on('error', () => {})
    socket.once('close', resolve)
  })
}

function request(socket, id, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 1000)
    const onMessage = raw => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

test('CDP endpoint creates and loads an initial view for a Bot with no tabs', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  assert.deepEqual(views[0].webContents.loadedUrls, ['about:blank'])
  const socket = await openSocket(endpoint)
  t.after(() => socket.close())

  const targets = await request(socket, 1, 'Target.getTargets')
  assert.equal(targets.result.targetInfos.length, 1)
  assert.equal(targets.result.targetInfos[0].url, 'about:blank')
  const info = await request(socket, 2, 'Target.getTargetInfo')
  assert.equal(info.result.targetInfo.targetId, targets.result.targetInfos[0].targetId)
})

test('CDP relay limits targets and created tabs to the token Bot', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  manager.create('a')
  manager.create('b')
  const [a, b] = await Promise.all([manager.endpoint('a'), manager.endpoint('b')])
  const socketA = await openSocket(a)
  const socketB = await openSocket(b)
  t.after(() => { socketA.close(); socketB.close() })
  const targetsA = await request(socketA, 1, 'Target.getTargets')
  const targetsB = await request(socketB, 2, 'Target.getTargets')
  assert.equal(targetsA.result.targetInfos.length, 1)
  assert.equal(targetsA.result.targetInfos[0].browserContextId, 'bot:a')
  assert.equal(targetsB.result.targetInfos.length, 1)
  assert.equal(targetsB.result.targetInfos[0].browserContextId, 'bot:b')
  const rootInfo = await request(socketA, 3, 'Target.getTargetInfo')
  assert.equal(rootInfo.result.targetInfo.targetId, targetsA.result.targetInfos[0].targetId)
  const foreignInfo = await request(socketA, 4, 'Target.getTargetInfo', { targetId: targetsB.result.targetInfos[0].targetId })
  assert.equal(foreignInfo.error.message, 'Browser tab does not belong to this Bot')
  const attached = await request(socketA, 5, 'Target.attachToTarget', { targetId: targetsA.result.targetInfos[0].targetId, flatten: true })
  const sessionId = attached.result.sessionId
  const pageEnabled = await request(socketA, 6, 'Page.enable', {}, sessionId)
  assert.equal(pageEnabled.sessionId, sessionId)
  assert.deepEqual(pageEnabled.result, { method: 'Page.enable' })
  const frameTree = await request(socketA, 7, 'Page.getFrameTree', {}, sessionId)
  assert.equal(frameTree.result.frameTree.frame.id, targetsA.result.targetInfos[0].targetId)
  const created = await request(socketA, 8, 'Target.createTarget', { url: 'about:blank' })
  assert.equal(created.result.targetId, manager.sync('a')[1].tabId)
  assert.equal(manager.sync('a').length, 2)
  assert.equal(manager.sync('b').length, 1)
})

test('CDP relay rejects invalid paths and Origin headers', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  const valid = await openSocket(endpoint)
  t.after(() => valid.close())
  const originSocket = new WebSocket(endpoint, { headers: { Origin: 'https://example.com' } })
  await closed(originSocket)
  const badPath = new WebSocket(endpoint.replace(/\/devtools\/browser\/[^/]+$/u, '/invalid'))
  await closed(badPath)
})

test('CDP download behavior saves to the Bot path and emits download events', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootPath = mkdtempSync(join(tmpdir(), 'bot-views-download-root-'))
  const downloadPath = join(rootPath, 'downloads')
  t.after(() => rmSync(rootPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a', { downloadRoots: [rootPath] }))
  t.after(() => socket.close())
  const discovered = await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  assert.ok(discovered.result.sessionId)
  const sessionId = discovered.result.sessionId
  await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  const events = []
  let resolveEvents
  const eventsReady = new Promise(resolve => { resolveEvents = resolve })
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.method?.startsWith('Browser.download')) {
      events.push(message)
      if (events.length === 3) resolveEvents()
    }
  })
  const saved = []
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { saved.push(path) },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
    getReceivedBytes() { return 3 },
    getTotalBytes() { return 3 },
  })
  const event = { preventDefault() { throw new Error('download was unexpectedly prevented') } }
  handlers.get('bot:a')(event, item, views[0].webContents)
  item.emit('updated', {}, 'progressing')
  item.emit('done', {}, 'completed')
  await Promise.race([eventsReady, new Promise((_, reject) => setTimeout(() => reject(new Error('download events were not relayed')), 1000))])
  assert.equal(saved.length, 1)
  assert.match(saved[0], new RegExp(`^${realpathSync(downloadPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
  assert.equal(events[0].params.suggestedFilename, 'report.pdf')
  assert.equal(events.some(message => message.method === 'Browser.downloadProgress' && message.params.state === 'completed'), true)
  assert.equal(sessionId.length > 0, true)
})

test('CDP accepts a download root created after endpoint setup', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const parentPath = mkdtempSync(join(tmpdir(), 'bot-views-download-late-root-'))
  const rootPath = join(parentPath, 'downloads-root')
  t.after(() => rmSync(parentPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a', { downloadRoots: [rootPath] }))
  t.after(() => socket.close())
  assert.equal(existsSync(rootPath), false)
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  const downloadPath = join(rootPath, 'downloads')
  const response = await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  assert.deepEqual(response.result, {})
  let savePath
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { savePath = path; writeFileSync(path, 'download') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  let prevented = false
  handlers.get('bot:a')({ preventDefault() { prevented = true } }, item, views[0].webContents)
  assert.equal(prevented, false)
  assert.equal(existsSync(savePath), true)
  assert.equal(readFileSync(savePath, 'utf8'), 'download')
})

test('download roots are isolated per Bot', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootA = mkdtempSync(join(tmpdir(), 'bot-views-download-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'bot-views-download-b-'))
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })
  const entryA = manager.create('a')
  const entryB = manager.create('b')
  const [endpointA, endpointB] = await Promise.all([
    manager.endpoint('a', { downloadRoots: [rootA] }),
    manager.endpoint('b', { downloadRoots: [rootB] }),
  ])
  const socketA = await openSocket(endpointA)
  const socketB = await openSocket(endpointB)
  t.after(() => { socketA.close(); socketB.close() })
  await request(socketA, 1, 'Target.attachToTarget', { targetId: entryA.tabId, flatten: true })
  await request(socketB, 2, 'Target.attachToTarget', { targetId: entryB.tabId, flatten: true })
  await request(socketA, 3, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: rootA })
  await request(socketB, 4, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: rootA })
  let savedByA
  const accepted = Object.assign(new EventEmitter(), {
    setSavePath(path) { savedByA = path },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:a')({ preventDefault() { throw new Error('Bot A download was refused') } }, accepted, views[0].webContents)
  assert.match(savedByA, new RegExp(`^${realpathSync(rootA).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
  let preventedForB = false
  const refused = Object.assign(new EventEmitter(), {
    setSavePath() { throw new Error('Bot B must not use Bot A download root') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:b')({ preventDefault() { preventedForB = true } }, refused, views[1].webContents)
  assert.equal(preventedForB, true)
})

test('cancelling a relay download removes its save path', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const downloadPath = mkdtempSync(join(tmpdir(), 'playwright-artifacts-bot-views-cancel-'))
  t.after(() => rmSync(downloadPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a'))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  const events = []
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.method?.startsWith('Browser.download')) events.push(message)
  })
  let savePath
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { savePath = path; writeFileSync(path, 'partial') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
    getReceivedBytes() { return 1 },
    getTotalBytes() { return 2 },
    async cancel() { this.emit('done', {}, 'cancelled') },
  })
  handlers.get('bot:a')({ preventDefault() {} }, item, views[0].webContents)
  let willBegin
  for (let tries = 0; tries < 100 && !willBegin; tries++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    willBegin = events.find(message => message.method === 'Browser.downloadWillBegin')
  }
  const guid = willBegin.params.guid
  await request(socket, 3, 'Browser.cancelDownload', { guid })
  for (let tries = 0; tries < 100 && existsSync(savePath); tries++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(existsSync(savePath), false)
})

test('CDP rejects outside, traversal, and symlink download paths and cancels downloads', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootPath = mkdtempSync(join(tmpdir(), 'bot-views-download-root-'))
  const outsidePath = mkdtempSync(join(tmpdir(), 'bot-views-download-outside-'))
  symlinkSync(outsidePath, join(rootPath, 'outside-link'), folderLink)
  t.after(() => {
    rmSync(rootPath, { recursive: true, force: true })
    rmSync(outsidePath, { recursive: true, force: true })
  })
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a', { downloadRoots: [rootPath] }))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  const refusedPaths = [
    '/etc/x',
    join(rootPath, '..', 'bot-views-download-escape'),
    join(rootPath, 'outside-link'),
  ]
  let id = 2
  for (const downloadPath of refusedPaths) {
    await request(socket, id++, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rootPath })
    const response = await request(socket, id++, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath })
    assert.deepEqual(response.result, {})
    let prevented = false
    let savePath
    const item = Object.assign(new EventEmitter(), {
      setSavePath(path) { savePath = path },
      getURL() { return 'https://example.com/file' },
      getFilename() { return 'report.pdf' },
    })
    handlers.get('bot:a')({ preventDefault() { prevented = true } }, item, views[0].webContents)
    assert.equal(prevented, true)
    assert.equal(savePath, undefined)
  }
  await request(socket, id++, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rootPath })
  await request(socket, id, 'Browser.setDownloadBehavior', { behavior: 'deny', downloadPath: rootPath })
  let denied = false
  const item = Object.assign(new EventEmitter(), {
    setSavePath() { throw new Error('denied downloads must not get a save path') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:a')({ preventDefault() { denied = true } }, item, views[0].webContents)
  assert.equal(denied, true)
})

test('CDP accepts a direct Playwright artifacts directory under os.tmpdir()', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const downloadPath = mkdtempSync(join(tmpdir(), 'playwright-artifacts-bot-views-'))
  t.after(() => rmSync(downloadPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a'))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  const response = await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  assert.deepEqual(response.result, {})
  let savePath
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { savePath = path },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  let prevented = false
  handlers.get('bot:a')({ preventDefault() { prevented = true } }, item, views[0].webContents)
  assert.equal(prevented, false)
  assert.match(savePath, new RegExp(`^${realpathSync(downloadPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
})

test('a relay download is cancelled if its accepted directory is swapped for an outside symlink', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootPath = mkdtempSync(join(tmpdir(), 'bot-views-download-symlink-swap-'))
  const downloadPath = join(rootPath, 'downloads')
  const outsidePath = mkdtempSync(join(tmpdir(), 'bot-views-download-outside-'))
  t.after(() => rmSync(outsidePath, { recursive: true, force: true }))
  t.after(() => rmSync(rootPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a', { downloadRoots: [rootPath] }))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  const accepted = await request(socket, 2, 'Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath,
  })
  assert.deepEqual(accepted.result, {})

  rmSync(downloadPath, { recursive: true, force: true })
  symlinkSync(outsidePath, downloadPath, folderLink)
  let prevented = false
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { writeFileSync(path, 'outside') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:a')({ preventDefault() { prevented = true } }, item, views[0].webContents)
  assert.equal(prevented, true)
  assert.deepEqual(readdirSync(outsidePath), [])
})

test('user hold closes relay sockets, rejects endpoints, and allows a new endpoint after give-back', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  const socket = await openSocket(endpoint)
  const closedPromise = closed(socket)
  await manager.hold('a', true)
  await closedPromise
  await assert.rejects(() => manager.endpoint('a'), /The user has taken over this browser/u)
  await manager.hold('a', false)
  const resumed = await manager.endpoint('a')
  const resumedSocket = await openSocket(resumed)
  t.after(() => resumedSocket.close())
  assert.equal((await request(resumedSocket, 3, 'Target.getTargets')).result.targetInfos.length, 1)
})

test('navigation guard rejects the app origin and popup tabs work before relay attachment', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  const entry = manager.create('a')
  let prevented = false
  entry.view.webContents.emit('will-frame-navigate', { url: 'http://127.0.0.1:43117/settings', isMainFrame: true, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  const popup = entry.view.webContents.windowOpenHandler({ url: 'http://127.0.0.1:43118/popup', postBody: undefined })
  assert.deepEqual(popup, { action: 'deny' })
  assert.equal(views.length, 2)
  assert.equal(manager.sync('a')[1].url, 'http://127.0.0.1:43118/popup')
})

test('saved active tabs restore their tab id and URL', async t => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'bot-views-state-')), 'bot-views.json')
  t.after(() => rmSync(statePath, { force: true }))
  const first = fixture({ statePath })
  const entry = first.manager.create('a', { tabId: 'saved-tab', url: 'http://127.0.0.1:43118/form' })
  assert.equal(first.manager.create('a', { tabId: 'saved-tab' }), entry)
  first.manager.dispose()
  const second = fixture({ statePath })
  t.after(() => second.manager.dispose())
  const endpoint = await second.manager.endpoint('a')
  assert.equal(second.manager.sync('a')[0].tabId, entry.tabId)
  assert.equal(second.manager.sync('a')[0].url, 'http://127.0.0.1:43118/form')
  const socket = await openSocket(endpoint)
  t.after(() => socket.close())
})

test('the views stay hidden while the app’s card is up, and the shown ones come back after it', t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  manager.create('a', { tabId: 'A' })
  manager.create('a', { tabId: 'B' })
  const rect = { left: 0, top: 0, width: 400, height: 300 }
  manager.place('A', rect, true)
  manager.cover(true)
  assert.deepEqual(views.map(view => view.visible), [false, false])
  // The page places its view again while the card is up: it still waits.
  manager.place('B', rect, true)
  assert.equal(views[1].visible, false)
  manager.cover(false)
  assert.deepEqual(views.map(view => view.visible), [true, true])
  manager.place('A', rect, false)
  manager.cover(true)
  manager.cover(false)
  assert.deepEqual(views.map(view => view.visible), [false, true])
})

test('closing the active saved tab preserves the replacement after another page updates', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-views-active-state-'))
  const statePath = join(directory, 'bot-views.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = fixture({ statePath })
  first.manager.create('a', { tabId: 'A', url: 'http://127.0.0.1:43118/a' })
  first.manager.create('a', { tabId: 'B', url: 'http://127.0.0.1:43118/b' })
  first.manager.create('a', { tabId: 'C', url: 'http://127.0.0.1:43118/c' })
  first.manager.place('B', { left: 0, top: 0, width: 400, height: 300 }, true)
  await first.manager.close('a', 'B')
  first.views[0].webContents.url = 'http://127.0.0.1:43118/a-updated'
  first.views[0].webContents.emit('did-navigate')
  first.manager.dispose()

  const second = fixture({ statePath })
  t.after(() => second.manager.dispose())
  await second.manager.endpoint('a')
  assert.deepEqual(second.manager.sync('a').map(({ tabId, url }) => ({ tabId, url })), [
    { tabId: 'C', url: 'http://127.0.0.1:43118/c' },
  ])
})

test('saved file and app-origin URLs restore as blank with their tab ids', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-views-unsafe-state-'))
  const statePath = join(directory, 'bot-views.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(statePath, JSON.stringify({ version: 1, bots: {
    file: { tabs: [{ tabId: 'file-tab', url: 'file:///etc/passwd', title: 'passwd' }], active: 'file-tab' },
    app: { tabs: [{ tabId: 'app-tab', url: 'http://127.0.0.1:43117/settings', title: 'Settings' }], active: 'app-tab' },
  } }))
  const { manager } = fixture({ statePath })
  t.after(() => manager.dispose())
  const stored = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(stored.bots.file.tabs, [{ tabId: 'file-tab', url: 'about:blank', title: '' }])
  assert.deepEqual(stored.bots.app.tabs, [{ tabId: 'app-tab', url: 'about:blank', title: '' }])
  for (const [botId, tabId] of [['file', 'file-tab'], ['app', 'app-tab']]) {
    await manager.endpoint(botId)
    assert.deepEqual(manager.sync(botId).map(({ tabId: actualId, url }) => ({ tabId: actualId, url })), [
      { tabId, url: 'about:blank' },
    ])
  }
})

test('load errors remain published until a real main-frame navigation starts', async t => {
  const { manager, views, changes } = fixture()
  t.after(() => manager.dispose())
  const entry = manager.create('a')
  const contents = views[0].webContents
  contents.emit('did-fail-load', {}, -105, 'offline', contents.getURL(), true)
  contents.emit('did-stop-loading')
  assert.equal(changes.at(-1).error, 'offline')
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(changes.at(-1).error, null)
  assert.ok(entry)
})

test('a tab whose window is gone joins the next window', async t => {
  const { manager, views, added } = fixture()
  t.after(() => manager.dispose())
  manager.create('a')
  assert.equal(added.length, 1, 'the view belongs to the window')
  // The window is gone, but its view is still alive.
  manager.release()
  const next = { contentView: { addChildView(view) { added.push(view) } } }
  manager.attach(next)
  assert.equal(added.length, 2, 'the view joins the next window')
  assert.equal(added[1], views[0], 'it is the same view')
})

test('a view that went with its window is dropped', async t => {
  const { manager, views, added } = fixture()
  t.after(() => manager.dispose())
  manager.create('a')
  views[0].webContents.isDestroyed = () => true
  manager.release()
  const next = { contentView: { addChildView(view) { added.push(view) } } }
  manager.attach(next)
  assert.equal(added.length, 1, 'the dead view is not attached again')
  assert.deepEqual(manager.sync('a'), [], 'the tab is gone')
})

test('a view that is built without a window waits for one', async t => {
  const { manager, views, added, setWindow } = fixture()
  t.after(() => manager.dispose())
  setWindow(undefined)
  manager.create('a')
  assert.equal(added.length, 0, 'there is no window to hold it')
  const next = { contentView: { addChildView(view) { added.push(view) } } }
  manager.attach(next)
  assert.equal(added.length, 1, 'the view joins the window that comes')
  assert.equal(added[0], views[0], 'it is the same view')
})

test('CDP debugger attaches lazily on first WS attach, short-circuits idle messages, and detaches when last session leaves', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  const entry = manager.create('a', { tabId: 'T1' })
  const dbg = views[0].webContents.debugger
  assert.equal(dbg.attachCount, 0, 'create() must not eagerly attach CDP debugger')
  assert.equal(dbg.attached, false)

  const socket = await openSocket(await manager.endpoint('a'))
  assert.equal(dbg.attachCount, 0, 'opening socket alone does not attach debugger before Target.attachToTarget')
  const attached = await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  assert.equal(dbg.attachCount, 1, 'first Target.attachToTarget attaches CDP debugger once')
  assert.equal(dbg.attached, true)

  // Detaching the root session detaches the debugger when no sessions remain.
  await request(socket, 2, 'Target.detachFromTarget', { sessionId: attached.result.sessionId })
  assert.equal(dbg.detachCount, 1, 'last session detach detaches CDP debugger')
  assert.equal(dbg.attached, false)

  // Debugger message with 0 sessions short-circuits before structuredClone (passing uncloneable function does not throw!).
  assert.doesNotThrow(() => dbg.emit('message', {}, 'Runtime.consoleAPICalled', { bad: () => {} }))

  // Re-attach then simulate external Electron debugger 'detach' -> next CDP command recovers by re-attaching.
  const reattached = await request(socket, 3, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  assert.equal(dbg.attachCount, 2)
  dbg.attached = false
  dbg.emit('detach', {}, 'target closed')
  const recovered = await request(socket, 4, 'Page.getFrameTree', {}, reattached.result.sessionId)
  assert.equal(recovered.error, undefined, 'CDP command after external detach must re-attach and succeed')
  assert.equal(dbg.attachCount, 3, 'external detach triggers transparent re-attach on next command')

  const done = closed(socket)
  socket.close()
  await done
  const deadline = Date.now() + 2000
  while (dbg.attached && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(dbg.detachCount, 2, 'closing WS client detaches CDP debugger')
  assert.equal(dbg.attached, false)
})

test('BotViews debounces async persistence, skips bounds-only place() writes, and flushes synchronously on dispose', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-views-debounce-'))
  const statePath = join(dir, 'bot-views.json')
  const { manager } = fixture({ statePath, persistDebounceMs: 40 })
  t.after(() => {
    manager.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  manager.create('a', { tabId: 'T1', url: 'http://127.0.0.1:43118/one' })
  // Immediately after create(), state file is NOT yet synchronously written.
  assert.equal(existsSync(statePath), false, 'create() debounces persist instead of blocking with writeFileSync')
  let before
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      try {
        before = JSON.parse(readFileSync(statePath, 'utf8'))
        break
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(before !== undefined, 'debounced async persist writes state')
  assert.equal(before.bots.a.active, 'T1')

  // Repeated bounds-only place() updates on already-active T1 must not rewrite disk.
  writeFileSync(statePath, '{"sentinel":true}')
  manager.place('T1', { left: 10, top: 10, width: 300, height: 200 }, true)
  manager.place('T1', { left: 20, top: 20, width: 400, height: 300 }, true)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(readFileSync(statePath, 'utf8'), '{"sentinel":true}', 'pure bounds updates do not trigger disk writes')

  // Dispose flushes dirty state synchronously.
  manager.create('a', { tabId: 'T2', url: 'http://127.0.0.1:43118/two' })
  manager.dispose()
  const after = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(after.bots.a.active, 'T2', 'dispose() flushes synchronously')
})

test('BotViews enforces maxLiveViews LRU eviction safely with real createBotBrowsers, ownership isolation, and transparent read/reload', async t => {
  const { createBotBrowsers } = await import('../../ds-bot/src/client/bot-browsers.js')
  const { createSource } = await import('../../ds-bot/src/client/sources.js')
  const listeners = new Set()
  const { manager, views, changes } = fixture({
    maxLiveViews: 2,
    idleMs: 0,
    onChange(event) { for (const fn of listeners) fn(event) },
  })
  t.after(() => manager.dispose())

  const bridge = {
    views: {
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      async create(botId, tabId, url) { manager.create(botId, { tabId, url: url || 'about:blank' }) },
      async place(tabId, rect, visible) { return manager.place(tabId, rect, visible) },
      async navigate(botId, tabId, url) { return manager.operate(botId, 'navigate', { tabId, url }) },
      async command(botId, tabId, command) { return manager.operate(botId, 'command', { tabId, command }) },
      async focus(botId, tabId) { return manager.operate(botId, 'focus', { tabId }) },
      async read(botId, tabId, script) { return manager.operate(botId, 'read', { tabId, script }) },
      async close(botId, tabId) { return manager.close(botId, tabId) },
      async sync(botId) { return manager.sync(botId) },
    },
  }
  const storageMap = new Map()
  const storage = { getItem: k => storageMap.get(k) ?? null, setItem: (k, v) => storageMap.set(k, String(v)) }
  const browsers = createBotBrowsers({ bridge, createSource, storage, document: {} })
  t.after(() => browsers.dispose())

  const tab1 = browsers.openTab('a', 'http://127.0.0.1:43118/1')
  await browsers.show(tab1, { left: 0, top: 0, width: 400, height: 300 }, true)
  const tab2 = browsers.openTab('a', 'http://127.0.0.1:43118/2')
  // Wait for tab2 creation without showing it (tab1 stays shown).
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const tab3 = browsers.openTab('a', 'http://127.0.0.1:43118/3')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(views[0].webContents.closedCount, 0, 'shown view T1 is never evicted')
  assert.equal(views[1].webContents.closedCount, 1, 'LRU hidden view T2 is evicted')
  assert.deepEqual(views[1].webContents.closedOptions[0], { waitForBeforeUnload: false })
  assert.equal(changes.some(c => c.type === 'closed' && c.tabId === tab2), false, 'LRU eviction must NOT emit closed')
  assert.equal(views.length, 3, 'silent eviction must not trigger client preview() to resurrect T2 immediately')

  // Cross-Bot create() with a dormant tabId owned by Bot 'a' must throw.
  assert.throws(() => manager.create('b', { tabId: tab2, url: 'http://127.0.0.1:43118/steal' }), /another Bot/)

  // Hidden place() on dormant tab2 must NOT resurrect it.
  assert.equal(manager.place(tab2, { left: 0, top: 0, width: 400, height: 300 }, false), true)
  assert.equal(views.length, 3, 'hidden place() keeps dormant tab unloaded')

  // Reload on dormant tab2 resurrects with loadURL once (no duplicate contents.reload()).
  assert.equal(await manager.operate('a', 'command', { tabId: tab2, command: 'reload' }), true)
  assert.equal(views.length, 4)
  assert.equal(views[3].webContents.reloadCount, 0, 'dormant reload uses initial loadURL without duplicate reload()')

  // Evict tab2 again by creating tab4, then read() on dormant tab2 resurrects and reads cleanly.
  manager.create('a', { tabId: 'T4', url: 'http://127.0.0.1:43118/4' })
  const readResult = await manager.operate('a', 'read', { tabId: tab2, script: 'document.title' })
  assert.equal(readResult, 'document.title', 'operate(read) on dormant tab transparently resurrects and reads')

  // Showing an evicted tab lazily recreates it with its saved URL.
  assert.equal(manager.place(tab3, { left: 0, top: 0, width: 400, height: 300 }, true), true)
})

test('BotViews idle timer evicts idle hidden views, mutes hidden views, composes windowHidden/cover/systemPaused, caps popups, and cleans up on forget', async t => {
  const { manager, views } = fixture({ idleMs: 40, maxTabsPerBot: 3 })
  t.after(() => manager.dispose())
  const entry = manager.create('a', { tabId: 'T1', url: 'http://127.0.0.1:43118/1' })
  assert.equal(views[0].webContents.audioMuted, true, 'newly created hidden view starts muted')

  manager.place('T1', { left: 0, top: 0, width: 400, height: 300 }, true)
  assert.equal(views[0].visible, true)
  assert.equal(views[0].webContents.audioMuted, false, 'shown view is unmuted')

  // setWindowHidden and cover compose independently.
  manager.setWindowHidden(true)
  assert.equal(views[0].visible, false)
  assert.equal(views[0].webContents.audioMuted, true, 'windowHidden mutes views')
  manager.cover(true)
  manager.cover(false)
  assert.equal(views[0].visible, false, 'clearing cover while windowHidden keeps views hidden')
  manager.setWindowHidden(false)
  assert.equal(views[0].visible, true)
  assert.equal(views[0].webContents.audioMuted, false)

  manager.setSystemPaused(true)
  assert.equal(views[0].visible, false)
  assert.equal(views[0].webContents.audioMuted, true)
  manager.setSystemPaused(false)
  assert.equal(views[0].visible, true)

  // Popup cap enforces maxTabsPerBot = 3.
  for (let i = 0; i < 5; i += 1) {
    entry.view.webContents.windowOpenHandler({ url: `http://127.0.0.1:43118/p${i}`, postBody: undefined })
  }
  assert.equal(manager.sync('a').length, 3, 'popups are capped at maxTabsPerBot')

  // Idle timer evicts hidden idle tabs (T1 is shown, popups are hidden).
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(manager.sync('a').length, 1, 'hidden idle popups are evicted while shown T1 stays live')
  assert.equal(manager.sync('a')[0].tabId, 'T1')

  // forget(botId) terminates connected WS clients.
  const socket = await openSocket(await manager.endpoint('a'))
  const wsClosed = closed(socket)
  await manager.forget('a')
  await wsClosed
  assert.equal(manager.sync('a').length, 0)
})

test('BotViews ignores did-stop-loading emitted during eviction/close and preserves URL/title across async dormant navigate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-views-r2-'))
  const statePath = join(dir, 'bot-views.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const changes = []
  const views = []
  let deferLoad = false
  let finishDeferredLoad
  class AsyncWebContents extends EventEmitter {
    constructor() {
      super()
      this.url = ''
      this.title = ''
      this.loading = false
      this.destroyed = false
      this.debugger = Object.assign(new EventEmitter(), {
        attached: false,
        isAttached() { return this.attached },
        attach() { this.attached = true },
        detach() { this.attached = false },
        async sendCommand() { return {} },
      })
    }
    getURL() { return this.url }
    getTitle() { return this.title }
    isLoading() { return this.loading }
    canGoBack() { return false }
    canGoForward() { return false }
    isDestroyed() { return this.destroyed }
    setAudioMuted() {}
    setWindowOpenHandler() {}
    focus() {}
    async executeJavaScript(script) { return `${this.url}:${script}` }
    loadURL(url) {
      if (!deferLoad) {
        this.url = url
        this.title = `Title(${url})`
        return Promise.resolve()
      }
      this.loading = true
      return new Promise((resolve, reject) => {
        finishDeferredLoad = (err) => {
          this.loading = false
          if (err) { reject(err); return }
          this.url = url
          this.title = `Title(${url})`
          this.emit('did-navigate')
          this.emit('did-stop-loading')
          resolve()
        }
      })
    }
    close() {
      // Real Electron fires did-stop-loading before isDestroyed() flips true!
      this.emit('did-stop-loading')
      this.destroyed = true
    }
  }
  class AsyncWebContentsView {
    constructor() { this.webContents = new AsyncWebContents(); views.push(this) }
    setBounds() {}
    setVisible() {}
  }
  const win = {
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: { getZoomFactor: () => 1 },
  }
  const manager = new BotViews({
    window: () => win,
    WebContentsView: AsyncWebContentsView,
    guests: { storageFor: k => ({ partition: `persist:${k}` }), setDownloadHandler() {} },
    origin: () => 'http://127.0.0.1:43117',
    onChange: ev => changes.push(ev),
    statePath,
    maxLiveViews: 2,
    idleMs: 0,
    persistDebounceMs: 10,
  })
  t.after(() => manager.dispose())

  manager.create('a', { tabId: 'T1', url: 'http://127.0.0.1:43118/1' })
  manager.place('T1', { left: 0, top: 0, width: 400, height: 300 }, true)
  manager.create('a', { tabId: 'T2', url: 'http://127.0.0.1:43118/2' })
  views[1].webContents.emit('page-favicon-updated', {}, ['data:image/png;base64,AA=='])
  const changesBeforeEvict = changes.length
  // Creating T3 evicts T2; close() fires did-stop-loading which MUST be ignored by #publish.
  manager.create('a', { tabId: 'T3', url: 'http://127.0.0.1:43118/3' })
  assert.equal(changes.slice(changesBeforeEvict).some(c => c.tabId === 'T2'), false, 'evicted view did-stop-loading must not emit changed')

  // Closing T3 whose close() emits did-stop-loading must NOT re-save T3 into #saved or emit post-close changed.
  const beforeClose = changes.length
  await manager.close('a', 'T3')
  assert.equal(changes.slice(beforeClose).filter(c => c.tabId === 'T3').length, 1)
  assert.equal(changes.at(-1).type, 'closed')
  manager.dispose()
  const persistedAfterClose = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(persistedAfterClose.bots.a.tabs.some(tab => tab.tabId === 'T3'), false, 'closed tab must not be re-saved by did-stop-loading')

  // Test async dormant resurrection + operate('navigate') awaiting rawInitialLoad and preserving metadata.
  const changes2 = []
  views.length = 0
  const manager2 = new BotViews({
    window: () => win,
    WebContentsView: AsyncWebContentsView,
    guests: { storageFor: k => ({ partition: `persist:${k}` }), setDownloadHandler() {} },
    origin: () => 'http://127.0.0.1:43117',
    onChange: ev => changes2.push(ev),
    maxLiveViews: 2,
    idleMs: 0,
  })
  t.after(() => manager2.dispose())
  manager2.create('a', { tabId: 'T1', url: 'http://127.0.0.1:43118/1' })
  manager2.place('T1', { left: 0, top: 0, width: 400, height: 300 }, true)
  manager2.create('a', { tabId: 'T2', url: 'http://127.0.0.1:43118/2' })
  views[1].webContents.emit('page-favicon-updated', {}, ['data:image/png;base64,BB=='])
  manager2.create('a', { tabId: 'T3', url: 'http://127.0.0.1:43118/3' }) // evicts T2

  deferLoad = true
  let navResolved = false
  const navPromise = manager2.operate('a', 'navigate', { tabId: 'T2', url: 'http://127.0.0.1:43118/2-new' }).then(() => { navResolved = true })
  await new Promise(resolve => setImmediate(resolve))
  const resurrectEvent = changes2.at(-1)
  assert.equal(resurrectEvent.type, 'changed', 'resurrection emits changed rather than blank created')
  assert.equal(resurrectEvent.url, 'http://127.0.0.1:43118/2-new', 'initial URL is preserved while loadURL is pending')
  assert.equal(resurrectEvent.title, 'Title(http://127.0.0.1:43118/2)', 'saved title is preserved until navigation commits')
  assert.equal(resurrectEvent.favicon, 'data:image/png;base64,BB==', 'saved favicon is preserved across dormancy')
  assert.equal(resurrectEvent.loading, true, 'resurrection reports loading: true until loadURL finishes')
  assert.equal(navResolved, false, 'dormant operate(navigate) awaits loadURL completion')
  finishDeferredLoad()
  await navPromise
  assert.equal(navResolved, true)
  assert.equal(await manager2.operate('a', 'read', { tabId: 'T2', script: 'ok' }), 'http://127.0.0.1:43118/2-new:ok')
})
