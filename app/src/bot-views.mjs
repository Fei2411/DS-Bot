import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { allowedNavigation } from './bot-browser.mjs'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PLAYWRIGHT_ARTIFACT_PREFIX = 'playwright-artifacts-'
const MAX_LIVE_VIEWS = 6
const IDLE_EVICT_MS = 15 * 60_000
const MAX_TABS_PER_BOT = 12
const PERSIST_DEBOUNCE_MS = 400
const rectOf = (rect, zoom = 1) => ({
  x: Math.max(0, Math.round((rect?.left ?? 0) * zoom)),
  y: Math.max(0, Math.round((rect?.top ?? 0) * zoom)),
  width: Math.max(1, Math.round((rect?.width ?? 800) * zoom)),
  height: Math.max(1, Math.round((rect?.height ?? 600) * zoom)),
})
const BOT_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const isBotId = value => typeof value === 'string' && BOT_ID.test(value)

function containsPath(root, target) {
  const relative = relativePath(resolve(root), resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${sep}`) && !isAbsolute(relative))
}

function isDirectChild(root, target) {
  const relative = relativePath(resolve(root), resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${sep}`) && !relative.includes(sep) && !isAbsolute(relative)
}

export class BotViews {
  #window
  #WebContentsView
  #guests
  #origin
  #devTools
  #views = new Map()
  // Evicted tabs kept alive in the UI tab strip and lazily recreated when shown or operated on.
  #dormant = new Map()
  #tokens = new Map()
  #clients = new Map()
  #server
  #wss
  #address
  #onChange
  #onInputShortcut
  #downloadPaths = new Map()
  #downloadRoots = new Map()
  #statePath
  #saved = {}
  #active = new Map()
  #held = new Set()
  #covered = false
  #windowHidden = false
  #systemPaused = false
  // The tabs whose view waits for a window to belong to.
  #waiting = new Set()
  #maxLiveViews
  #idleMs
  #maxTabsPerBot
  #persistDebounceMs
  #useSeq = 0
  #idleTimer = null
  #persistTimer = null
  #persistChain = Promise.resolve()
  #persistGen = 0
  #lastPersistedJson = null
  #disposed = false

  constructor({
    window, WebContentsView, guests, origin, devTools = false, onChange = () => {}, onInputShortcut = () => false, statePath,
    maxLiveViews = MAX_LIVE_VIEWS, idleMs = IDLE_EVICT_MS, maxTabsPerBot = MAX_TABS_PER_BOT,
    persistDebounceMs = PERSIST_DEBOUNCE_MS,
  }) {
    this.#window = window
    this.#WebContentsView = WebContentsView
    this.#guests = guests
    this.#origin = origin
    this.#devTools = devTools
    this.#onChange = onChange
    this.#onInputShortcut = onInputShortcut
    this.#statePath = statePath
    this.#maxLiveViews = maxLiveViews
    this.#idleMs = idleMs
    this.#maxTabsPerBot = maxTabsPerBot
    this.#persistDebounceMs = persistDebounceMs
    if (statePath !== undefined) {
      try {
        const stored = JSON.parse(readFileSync(statePath, 'utf8'))
        if (stored && typeof stored === 'object' && stored.bots && typeof stored.bots === 'object') {
          const bots = {}
          let changed = false
          for (const [botId, saved] of Object.entries(stored.bots)) {
            if (!saved || !Array.isArray(saved.tabs)) { changed = true; continue }
            const tabs = saved.tabs.flatMap(tab => {
              if (!tab || typeof tab.tabId !== 'string' || tab.tabId.length === 0) { changed = true; return [] }
              const url = typeof tab.url === 'string' ? tab.url : 'about:blank'
              const safeUrl = allowedNavigation(url, this.#origin()) ? url : 'about:blank'
              const title = safeUrl === url && typeof tab.title === 'string' ? tab.title : ''
              if (safeUrl !== url || title !== tab.title) changed = true
              return [{ tabId: tab.tabId, url: safeUrl, title }]
            })
            const active = tabs.some(tab => tab.tabId === saved.active) ? saved.active : tabs[0]?.tabId ?? null
            if (tabs.length !== saved.tabs.length || active !== saved.active) changed = true
            if (tabs.length === 0) { changed = true; continue }
            bots[botId] = { tabs, active }
          }
          if (Object.keys(bots).length !== Object.keys(stored.bots).length) changed = true
          this.#saved = bots
          if (changed) this.#persistSync()
          else this.#lastPersistedJson = this.#serializeState()
        }
      } catch {}
    }
    this.#server = createServer((_request, response) => { response.writeHead(404).end() })
    this.#wss = new WebSocketServer({ noServer: true })
    this.#server.on('upgrade', (request, socket, head) => {
      const peer = request.socket.remoteAddress
      const token = /^\/devtools\/browser\/([a-f0-9]{64})$/u.exec(request.url ?? '')?.[1]
      if (request.headers.origin !== undefined || !LOOPBACK.has(peer) || token === undefined || !this.#tokens.has(token)) {
        socket.destroy()
        return
      }
      this.#wss.handleUpgrade(request, socket, head, client => {
        this.#wss.emit('connection', client, request, this.#tokens.get(token))
      })
    })
    this.#wss.on('connection', (client, _request, botId) => this.#connect(client, botId))
    this.#server.listen(0, '127.0.0.1')
    this.#server.on('listening', () => { this.#address = this.#server.address() })
    if (Number.isFinite(this.#idleMs) && this.#idleMs > 0) {
      const interval = Math.min(Math.max(Math.floor(this.#idleMs / 3), 50), 60_000)
      this.#idleTimer = setInterval(() => this.#evictIdle(), interval)
      this.#idleTimer.unref?.()
    }
  }

  create(botId, { url = 'about:blank', createdByBot = false, openerId, tabId: requestedTabId, activate = true } = {}) {
    const tabId = requestedTabId ?? randomUUID()
    const existing = this.#views.get(tabId)
    if (existing) {
      if (existing.botId !== botId) throw new Error('Browser tab belongs to another Bot')
      this.#touch(existing)
      return existing
    }
    const dormant = this.#dormant.get(tabId)
    const wasDormant = dormant !== undefined
    if (dormant) {
      if (dormant.botId !== botId) throw new Error('Browser tab belongs to another Bot')
      this.#dormant.delete(tabId)
    }
    const { partition } = this.#guests.storageFor(`bot:${botId}`)
    const view = new this.#WebContentsView({
      webPreferences: {
        partition, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: this.#devTools,
      },
    })
    const entry = {
      tabId, botId, view, createdByBot, openerId, shown: false,
      favicon: dormant?.favicon ?? null,
      fallbackUrl: url || dormant?.url || 'about:blank',
      fallbackTitle: dormant?.title ?? '',
      sessions: new Map(), sessionMaps: new Map(), downloads: new Map(),
      downloadPath: this.#downloadPaths.get(botId), mainFrameId: undefined,
      debuggerWired: false, debuggerAttached: false,
      initialLoading: false, rawInitialLoad: Promise.resolve(), initialLoad: Promise.resolve(),
      busy: 0,
      lastUsedAt: Date.now(), lastUsedSeq: ++this.#useSeq,
    }
    this.#views.set(tabId, entry)
    const owner = this.#window()
    if (owner !== undefined && owner !== null) owner.contentView.addChildView(view)
    // Without a window the view waits for the next one.
    else this.#waiting.add(tabId)
    view.setBounds(rectOf(null))
    view.setVisible(false)
    const contents = view.webContents
    contents.setAudioMuted?.(true)
    const clients = this.#clients.get(botId) ?? []
    for (const client of clients) {
      if (client.discover) this.#send(client.socket, { method: 'Target.targetCreated', params: { targetInfo: this.#targetInfo(entry) } })
      if (client.autoAttach) client.attach(entry)
    }
    contents.on('did-navigate', () => {
      if (contents.getURL()) entry.fallbackTitle = ''
      this.#publish(entry)
    })
    contents.on('did-navigate-in-page', () => this.#publish(entry))
    contents.on('page-title-updated', () => this.#publish(entry))
    contents.on('page-favicon-updated', (_event, favicons) => { entry.favicon = favicons?.[0] ?? null; this.#publish(entry) })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { entry.initialLoading = false; entry.error = description; this.#publish(entry) }
    })
    contents.on('did-start-loading', () => this.#publish(entry))
    contents.on('did-stop-loading', () => { entry.initialLoading = false; this.#publish(entry) })
    contents.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument) {
        entry.error = null
        this.#publish(entry)
      }
    })
    contents.on('will-navigate', (event, target) => { if (!allowedNavigation(target, this.#origin())) event.preventDefault() })
    contents.on('will-redirect', (event, target) => { if (!allowedNavigation(target, this.#origin())) event.preventDefault() })
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame && !allowedNavigation(event.url, this.#origin())) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url: target, postBody }) => {
      if (this.#views.get(tabId) === entry && postBody === undefined && allowedNavigation(target, this.#origin()) && this.#botTabCount(botId) < this.#maxTabsPerBot) {
        const popup = this.create(botId, { url: target, createdByBot: entry.sessions.size > 0, openerId: tabId })
        this.#publish(popup)
      }
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      if (this.#onInputShortcut(input) === true) event.preventDefault()
    })
    contents.on('login', (event, _details, _auth, callback) => { event.preventDefault(); callback() })
    this.#guests.setDownloadHandler(`bot:${botId}`, (event, item, source) => {
      const target = [...this.#views.values()].find(value => value.botId === botId && value.view.webContents === source)
      if (!target) { event.preventDefault(); return }
      this.#download(target, event, item)
    })
    if (activate) this.#active.set(botId, tabId)
    entry.initialLoading = wasDormant && url !== 'about:blank'
    let rawLoad
    try { rawLoad = Promise.resolve(contents.loadURL(url)) } catch (error) { rawLoad = Promise.reject(error) }
    entry.rawInitialLoad = rawLoad
    entry.initialLoad = rawLoad.then(
      () => { entry.initialLoading = false },
      () => { entry.initialLoading = false },
    )
    this.#remember(entry)
    this.#onChange({ type: wasDormant ? 'changed' : 'created', ...this.#state(entry) })
    this.#persist()
    this.#evictOverflow(tabId)
    return entry
  }

  #download(entry, event, item) {
    if (entry.downloadPath === undefined || entry.sessions.size === 0) {
      event.preventDefault()
      return
    }
    const downloadPath = this.#allowedDownloadPath(entry.botId, entry.downloadPath)
    if (downloadPath === undefined) {
      event.preventDefault()
      return
    }
    try {
      const guid = randomUUID()
      const savePath = join(downloadPath, guid)
      item.setSavePath(savePath)
      entry.downloads.set(guid, { item, savePath })
      this.#broadcast(entry.botId, { method: 'Browser.downloadWillBegin', params: {
        frameId: entry.tabId, guid, url: item.getURL(), suggestedFilename: item.getFilename(),
      } })
      const progress = state => this.#broadcast(entry.botId, { method: 'Browser.downloadProgress', params: {
        guid, receivedBytes: item.getReceivedBytes(), totalBytes: Math.max(0, item.getTotalBytes()),
        state: state === 'completed' ? 'completed' : state === 'interrupted' || state === 'cancelled' ? 'canceled' : 'inProgress',
      } })
      item.on('updated', (_event, state) => progress(state))
      item.once('done', (_event, state) => {
        progress(state)
        entry.downloads.delete(guid)
        if (state !== 'completed') void rm(savePath, { force: true }).catch(() => {})
      })
    } catch {
      event.preventDefault()
    }
  }

  #allowedDownloadPath(botId, requested) {
    if (typeof requested !== 'string' || !isAbsolute(requested)) return undefined
    const target = resolve(requested)
    const roots = this.#downloadRoots.get(botId) ?? []
    const allowedByRoot = roots.some(root => {
      if (containsPath(root, target)) return true
      try {
        return containsPath(realpathSync(root), target)
      } catch {
        return false
      }
    })
    const temporaryRoot = resolve(tmpdir())
    let temporaryRealRoot
    try {
      temporaryRealRoot = realpathSync(temporaryRoot)
    } catch {}
    const isArtifact = temporaryRealRoot !== undefined && [temporaryRoot, temporaryRealRoot].some(root =>
      isDirectChild(root, target) && basename(target).startsWith(PLAYWRIGHT_ARTIFACT_PREFIX))
    if (!allowedByRoot && !isArtifact) return undefined
    try {
      mkdirSync(target, { recursive: true })
      const realTarget = realpathSync(target)
      const inRoot = roots.some(root => {
        try {
          return containsPath(realpathSync(root), realTarget)
        } catch {
          return false
        }
      })
      const inArtifacts = isArtifact && temporaryRealRoot !== undefined
        && isDirectChild(temporaryRealRoot, realTarget)
        && basename(realTarget).startsWith(PLAYWRIGHT_ARTIFACT_PREFIX)
      return inRoot || inArtifacts ? realTarget : undefined
    } catch {
      return undefined
    }
  }

  place(tabId, rect, visible = rect !== null) {
    let entry = this.#views.get(tabId)
    if (!entry) {
      const dormant = this.#dormant.get(tabId)
      if (!dormant) return false
      if (visible !== true) return true
      const url = allowedNavigation(dormant.url, this.#origin()) ? dormant.url : 'about:blank'
      entry = this.create(dormant.botId, { tabId, url, createdByBot: dormant.createdByBot })
    }
    // The renderer reports CSS pixels; native view bounds are window DIPs.
    if (rect !== null) entry.view.setBounds(rectOf(rect, this.#window()?.webContents.getZoomFactor() ?? 1))
    entry.shown = visible === true
    this.#applyVisibility(entry)
    if (visible === true) {
      this.#touch(entry)
      if (this.#active.get(entry.botId) !== tabId) {
        this.#active.set(entry.botId, tabId)
        this.#remember(entry)
        this.#persist()
      }
    }
    return true
  }

  async operate(botId, action, payload = {}) {
    if (action === 'close') return this.close(botId, payload.tabId)
    let entry = this.#views.get(payload.tabId)
    let resurrected = false
    if (!entry) {
      const dormant = this.#dormant.get(payload.tabId)
      if (dormant && dormant.botId === botId) {
        if (action === 'navigate') {
          const url = String(payload.url)
          if (!allowedNavigation(url, this.#origin())) throw new Error('This address is not allowed')
          entry = this.create(botId, { tabId: dormant.tabId, url, createdByBot: dormant.createdByBot, activate: false })
          this.#touch(entry)
          entry.busy += 1
          try {
            return await entry.rawInitialLoad
          } finally {
            entry.busy = Math.max(0, entry.busy - 1)
          }
        }
        const url = allowedNavigation(dormant.url, this.#origin()) ? dormant.url : 'about:blank'
        entry = this.create(botId, { tabId: dormant.tabId, url, createdByBot: dormant.createdByBot, activate: false })
        resurrected = true
        if (action === 'command' && payload.command === 'reload') return true
      }
    }
    entry = this.#owned(botId, payload.tabId)
    this.#touch(entry)
    entry.busy += 1
    try {
      if (resurrected && action === 'read') await entry.initialLoad
      const contents = entry.view.webContents
      switch (action) {
        case 'navigate': {
          const url = String(payload.url)
          if (!allowedNavigation(url, this.#origin())) throw new Error('This address is not allowed')
          return await contents.loadURL(url)
        }
        case 'command':
          if (payload.command === 'back' && contents.canGoBack()) contents.goBack()
          else if (payload.command === 'forward' && contents.canGoForward()) contents.goForward()
          else if (payload.command === 'reload') contents.reload()
          else if (payload.command === 'stop') contents.stop()
          return true
        case 'focus': contents.focus(); return true
        case 'read': return await contents.executeJavaScript(String(payload.script))
        default: throw new Error('Unknown browser view operation')
      }
    } finally {
      entry.busy = Math.max(0, entry.busy - 1)
    }
  }

  async close(botId, tabId) {
    const dormant = this.#dormant.get(tabId)
    if (!this.#views.has(tabId) && dormant && dormant.botId === botId) {
      this.#dormant.delete(tabId)
      this.#dropSaved(botId, tabId)
      this.#onChange({ type: 'closed', botId, tabId })
      return true
    }
    const entry = this.#owned(botId, tabId)
    for (const [socket, sessionId] of entry.sessions) {
      this.#send(socket, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: tabId } })
      if ([...(this.#clients.get(botId) ?? [])].some(client => client.socket === socket && client.discover)) {
        this.#send(socket, { method: 'Target.targetDestroyed', params: { targetId: tabId } })
      }
    }
    for (const { item } of entry.downloads.values()) { try { item.cancel?.() } catch {} }
    entry.downloads.clear()
    this.#views.delete(tabId)
    this.#waiting.delete(tabId)
    this.#dormant.delete(tabId)
    this.#dropSaved(botId, tabId)
    // The view leaves the window too: only closing its contents would keep the child view.
    this.#window()?.contentView.removeChildView(entry.view)
    entry.sessions.clear()
    entry.sessionMaps.clear()
    this.#releaseDebugger(entry)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false })
    this.#onChange({ type: 'closed', botId, tabId })
    return true
  }

  async forget(botId) {
    for (const entry of [...this.#views.values()]) if (entry.botId === botId) await this.close(botId, entry.tabId)
    for (const [tabId, dormant] of [...this.#dormant]) {
      if (dormant.botId === botId) {
        this.#dormant.delete(tabId)
        this.#onChange({ type: 'closed', botId, tabId })
      }
    }
    const clients = [...(this.#clients.get(botId) ?? [])]
    for (const client of clients) {
      try { client.socket.close() } catch {}
      try { client.socket.terminate?.() } catch {}
    }
    this.#clients.delete(botId)
    for (const [token, id] of this.#tokens) if (id === botId) this.#tokens.delete(token)
    this.#downloadPaths.delete(botId)
    this.#downloadRoots.delete(botId)
    this.#held.delete(botId)
    this.#active.delete(botId)
    delete this.#saved[botId]
    this.#persist()
  }

  async endpoint(botId, { downloadRoots } = {}) {
    if (this.#held.has(botId)) throw new Error('The user has taken over this browser.')
    if (downloadRoots !== undefined) {
      if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
        throw new Error('Invalid browser download roots.')
      }
      this.#downloadRoots.set(botId, [...new Set(downloadRoots.map(root => resolve(root)))])
      this.#downloadPaths.delete(botId)
      for (const entry of this.#views.values()) if (entry.botId === botId) entry.downloadPath = undefined
    }
    if (!this.#address) await new Promise(resolve => this.#server.once('listening', resolve))
    for (const entry of this.#views.values()) if (entry.botId === botId) this.#touch(entry)
    if (this.sync(botId).length === 0) {
      const saved = this.#saved[botId]
      const restored = saved?.tabs?.find(tab => tab.tabId === saved.active) ?? saved?.tabs?.[0]
      const url = restored && allowedNavigation(restored.url, this.#origin()) ? restored.url : 'about:blank'
      this.create(botId, { url, ...(restored?.tabId ? { tabId: restored.tabId } : {}), createdByBot: true })
    }
    for (const [token, id] of this.#tokens) if (id === botId) this.#tokens.delete(token)
    const token = randomBytes(32).toString('hex')
    this.#tokens.set(token, botId)
    return `ws://127.0.0.1:${this.#address.port}/devtools/browser/${token}`
  }

  /**
   * The app's card is up in the window (main.mjs askInWindow). The views are drawn above the
   * page, so they stay hidden until it goes, or they would cover the card.
   * @param {boolean} covered
   */
  cover(covered) {
    this.#covered = covered === true
    this.#syncVisibility()
  }

  /** The host window is hidden to the tray or minimized: hide and mute views without losing card cover state. */
  setWindowHidden(hidden) {
    this.#windowHidden = hidden === true
    this.#syncVisibility()
  }

  /** The machine suspended or locked: hide and mute views without disturbing window or card flags. */
  setSystemPaused(paused) {
    this.#systemPaused = paused === true
    this.#syncVisibility()
  }

  sync(botId) {
    return [...this.#views.values()].filter(entry => entry.botId === botId).map(entry => this.#state(entry))
  }

  /**
   * The window that owned the views is gone. The views that went with it are dropped; the
   * ones that are still alive wait for the window that comes next.
   */
  release() {
    for (const [tabId, entry] of [...this.#views]) {
      if (!entry.view.webContents.isDestroyed()) { this.#waiting.add(tabId); continue }
      for (const { item } of entry.downloads.values()) { try { item.cancel?.() } catch {} }
      entry.downloads.clear()
      entry.sessions.clear()
      entry.sessionMaps.clear()
      this.#views.delete(tabId)
      this.#waiting.delete(tabId)
      if (this.#active.get(entry.botId) === tabId) this.#active.delete(entry.botId)
    }
  }

  /** The views that waited for a window join it, so that the tabs go on. */
  attach(window) {
    if (window === undefined || window === null) return
    for (const [tabId, entry] of [...this.#views]) {
      if (!this.#waiting.has(tabId)) continue
      if (entry.view.webContents.isDestroyed()) {
        this.#views.delete(tabId)
        this.#waiting.delete(tabId)
        if (this.#active.get(entry.botId) === tabId) this.#active.delete(entry.botId)
        continue
      }
      window.contentView.addChildView(entry.view)
      this.#waiting.delete(tabId)
      this.#applyVisibility(entry)
    }
  }

  dispose() {
    this.#disposed = true
    if (this.#idleTimer !== null) { clearInterval(this.#idleTimer); this.#idleTimer = null }
    if (this.#persistTimer !== null) { clearTimeout(this.#persistTimer); this.#persistTimer = null }
    this.#persistSync()
    for (const entry of this.#views.values()) {
      for (const { item } of entry.downloads.values()) { try { item.cancel?.() } catch {} }
      entry.downloads.clear()
      entry.sessions.clear()
      entry.sessionMaps.clear()
      this.#releaseDebugger(entry)
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false })
    }
    for (const clients of this.#clients.values()) {
      for (const client of clients) {
        try { client.socket.close() } catch {}
        try { client.socket.terminate?.() } catch {}
      }
    }
    this.#views.clear()
    this.#dormant.clear()
    this.#waiting.clear()
    this.#tokens.clear()
    this.#clients.clear()
    this.#wss.close()
    this.#server.close()
  }

  async hold(botId, held) {
    if (!held) {
      this.#held.delete(botId)
      return true
    }
    this.#held.add(botId)
    for (const [token, id] of this.#tokens) if (id === botId) this.#tokens.delete(token)
    const clients = [...(this.#clients.get(botId) ?? [])]
    for (const client of clients) {
      for (const route of client.sessions.values()) {
        if (!route.nativeId) continue
        await route.entry.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: route.nativeId }).catch(() => {})
      }
      client.socket.close()
      client.socket.terminate()
    }
    return true
  }

  #touch(entry) {
    entry.lastUsedAt = Date.now()
    entry.lastUsedSeq = ++this.#useSeq
  }

  #botTabCount(botId) {
    let count = 0
    for (const entry of this.#views.values()) if (entry.botId === botId) count += 1
    for (const entry of this.#dormant.values()) if (entry.botId === botId) count += 1
    return count
  }

  #applyVisibility(entry) {
    const contents = entry.view.webContents
    if (contents.isDestroyed()) return
    const visibleNow = entry.shown === true && !this.#covered && !this.#windowHidden && !this.#systemPaused
    entry.view.setVisible(visibleNow)
    contents.setAudioMuted?.(!visibleNow)
  }

  #syncVisibility() {
    for (const entry of this.#views.values()) this.#applyVisibility(entry)
  }

  #evictable(entry) {
    return entry.shown !== true && entry.busy === 0 && entry.sessions.size === 0 && entry.downloads.size === 0
  }

  #evictEntry(entry) {
    if (!this.#views.has(entry.tabId) || !this.#evictable(entry)) return
    const destroyed = entry.view.webContents.isDestroyed()
    const state = destroyed
      ? {
        botId: entry.botId, tabId: entry.tabId, createdByBot: entry.createdByBot,
        url: this.#saved[entry.botId]?.tabs?.find(tab => tab.tabId === entry.tabId)?.url ?? entry.fallbackUrl ?? 'about:blank',
        title: this.#saved[entry.botId]?.tabs?.find(tab => tab.tabId === entry.tabId)?.title ?? entry.fallbackTitle ?? '',
        loading: false, canGoBack: false, canGoForward: false,
        favicon: entry.favicon ?? null, error: entry.error ?? null, live: false, botAttached: false,
      }
      : this.#state(entry)
    if (!destroyed) this.#remember(entry)
    for (const client of this.#clients.get(entry.botId) ?? []) {
      if (client.discover) this.#send(client.socket, { method: 'Target.targetDestroyed', params: { targetId: entry.tabId } })
    }
    this.#dormant.set(entry.tabId, {
      botId: entry.botId, tabId: entry.tabId, url: state.url, title: state.title,
      createdByBot: entry.createdByBot, favicon: state.favicon,
    })
    this.#views.delete(entry.tabId)
    this.#waiting.delete(entry.tabId)
    this.#window()?.contentView.removeChildView(entry.view)
    this.#releaseDebugger(entry)
    if (!destroyed) entry.view.webContents.close({ waitForBeforeUnload: false })
  }

  #evictOverflow(keepTabId) {
    if (!Number.isFinite(this.#maxLiveViews) || this.#maxLiveViews <= 0) return
    while (this.#views.size > this.#maxLiveViews) {
      let oldest = null
      for (const entry of this.#views.values()) {
        if (entry.tabId === keepTabId || !this.#evictable(entry)) continue
        if (oldest === null || entry.lastUsedAt < oldest.lastUsedAt
          || (entry.lastUsedAt === oldest.lastUsedAt && entry.lastUsedSeq < oldest.lastUsedSeq)) {
          oldest = entry
        }
      }
      if (oldest === null) break
      this.#evictEntry(oldest)
    }
  }

  #evictIdle() {
    if (this.#disposed || !Number.isFinite(this.#idleMs) || this.#idleMs <= 0) return
    const cutoff = Date.now() - this.#idleMs
    for (const entry of [...this.#views.values()]) {
      if (this.#evictable(entry) && entry.lastUsedAt <= cutoff) this.#evictEntry(entry)
    }
  }

  #owned(botId, tabId) {
    const entry = this.#views.get(tabId)
    if (!entry || entry.botId !== botId) throw new Error('Browser tab does not belong to this Bot')
    return entry
  }

  #urlOf(entry) {
    const current = entry.view.webContents.getURL()
    return current || entry.fallbackUrl || 'about:blank'
  }

  #titleOf(entry) {
    const current = entry.view.webContents.getTitle()
    return current || entry.fallbackTitle || ''
  }

  #state(entry) {
    const contents = entry.view.webContents
    return {
      botId: entry.botId, tabId: entry.tabId, createdByBot: entry.createdByBot,
      url: this.#urlOf(entry), title: this.#titleOf(entry), loading: contents.isLoading() || entry.initialLoading === true,
      canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward(),
      favicon: entry.favicon ?? null, error: entry.error ?? null, live: true,
      botAttached: entry.sessions.size > 0,
    }
  }

  #publish(entry) {
    if (this.#views.get(entry.tabId) !== entry || entry.view.webContents.isDestroyed()) return
    this.#remember(entry)
    this.#persist()
    this.#onChange({ type: 'changed', ...this.#state(entry) })
  }

  #remember(entry) {
    const previous = this.#saved[entry.botId] ?? { tabs: [], active: null }
    const tabs = previous.tabs.filter(tab => tab.tabId !== entry.tabId)
    tabs.push({ tabId: entry.tabId, url: this.#urlOf(entry), title: this.#titleOf(entry) })
    this.#saved[entry.botId] = { tabs, active: this.#active.get(entry.botId) ?? previous.active ?? entry.tabId }
  }

  #dropSaved(botId, tabId) {
    const previous = this.#saved[botId]
    if (!previous) return
    const tabs = previous.tabs.filter(tab => tab.tabId !== tabId)
    const wasActive = this.#active.get(botId) === tabId
    const active = wasActive ? tabs.at(-1)?.tabId ?? null : previous.active
    if (tabs.length === 0) {
      delete this.#saved[botId]
      this.#active.delete(botId)
    } else {
      if (wasActive) this.#active.set(botId, active)
      this.#saved[botId] = { tabs, active }
    }
    this.#persist()
  }

  #serializeState() {
    return JSON.stringify({ version: 1, bots: this.#saved })
  }

  #persist() {
    if (this.#statePath === undefined || this.#disposed) return
    if (this.#persistTimer !== null) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null
      this.#enqueuePersist()
    }, this.#persistDebounceMs)
    this.#persistTimer.unref?.()
  }

  #enqueuePersist() {
    if (this.#statePath === undefined || this.#disposed) return
    const snapshot = this.#serializeState()
    if (snapshot === this.#lastPersistedJson) return
    this.#persistChain = this.#persistChain.then(async () => {
      if (this.#disposed || this.#statePath === undefined) return
      const gen = this.#persistGen
      const latest = this.#serializeState()
      if (latest === this.#lastPersistedJson) return
      const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.#statePath), { recursive: true })
        await writeFile(temporary, latest)
        if (this.#disposed || gen !== this.#persistGen) {
          await rm(temporary, { force: true }).catch(() => {})
          return
        }
        await rename(temporary, this.#statePath)
        this.#lastPersistedJson = latest
      } catch {
        await rm(temporary, { force: true }).catch(() => {})
      }
    })
  }

  #persistSync() {
    this.#persistGen += 1
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = null
    }
    if (this.#statePath === undefined) return
    const latest = this.#serializeState()
    if (latest === this.#lastPersistedJson) return
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true })
      writeFileSync(temporary, latest)
      renameSync(temporary, this.#statePath)
      this.#lastPersistedJson = latest
    } catch {
      try { unlinkSync(temporary) } catch {}
    }
  }

  #ensureDebugger(entry) {
    const contents = entry.view.webContents
    if (contents.isDestroyed()) return
    const debuggerApi = contents.debugger
    if (!entry.debuggerWired) {
      entry.debuggerWired = true
      debuggerApi.on('message', (_event, method, params, childSessionId) => {
        if (entry.sessions.size === 0) return
        if (method === 'Target.detachedFromTarget' && params?.sessionId) {
          for (const sessionMap of entry.sessionMaps.values()) sessionMap.delete(params.sessionId)
        }
        this.#sendToSessions(entry, { method, params: this.#framePayload(entry, method, params) }, childSessionId)
      })
      debuggerApi.on('detach', () => {
        entry.debuggerAttached = false
        entry.mainFrameId = undefined
      })
    }
    const attached = typeof debuggerApi.isAttached === 'function' ? debuggerApi.isAttached() : entry.debuggerAttached
    if (!attached) {
      debuggerApi.attach('1.3')
    }
    entry.debuggerAttached = true
  }

  #releaseDebugger(entry) {
    if (entry.sessions.size > 0) return
    const contents = entry.view.webContents
    if (contents.isDestroyed()) {
      entry.debuggerAttached = false
      entry.mainFrameId = undefined
      return
    }
    const debuggerApi = contents.debugger
    if (entry.debuggerAttached || debuggerApi.isAttached?.() === true) {
      try { debuggerApi.detach?.() } catch {}
    }
    entry.debuggerAttached = false
    entry.mainFrameId = undefined
  }

  #frameId(entry, frameId) {
    return frameId === entry.mainFrameId ? entry.tabId : frameId
  }

  #framePayload(entry, method, payload) {
    const value = structuredClone(payload)
    if (method === 'Page.getFrameTree' && value.frameTree?.frame && !value.frameTree.frame.parentId) {
      entry.mainFrameId = value.frameTree.frame.id
    }
    if (method === 'Page.frameNavigated' && value.frame && !value.frame.parentId) entry.mainFrameId = value.frame.id
    if (method === 'Page.frameAttached' && !value.parentFrameId) entry.mainFrameId = value.frameId
    const mapFrame = frame => {
      if (!frame) return
      if (frame.id !== undefined) frame.id = this.#frameId(entry, frame.id)
      if (frame.parentId !== undefined) frame.parentId = this.#frameId(entry, frame.parentId)
      for (const child of frame.childFrames ?? []) mapFrame(child)
    }
    if (method === 'Page.getFrameTree') mapFrame(value.frameTree?.frame)
    if (value.frameId !== undefined) value.frameId = this.#frameId(entry, value.frameId)
    if (value.parentFrameId !== undefined) value.parentFrameId = this.#frameId(entry, value.parentFrameId)
    if (value.frame) mapFrame(value.frame)
    if (value.context?.auxData?.frameId !== undefined) value.context.auxData.frameId = this.#frameId(entry, value.context.auxData.frameId)
    return value
  }

  #sendToSessions(entry, message, childSessionId) {
    for (const [socket, rootSessionId] of entry.sessions) {
      if (childSessionId) entry.sessionMaps.get(socket)?.set(childSessionId, { entry, nativeId: childSessionId })
      this.#send(socket, { ...message, sessionId: childSessionId || rootSessionId })
    }
  }

  #broadcast(botId, message) {
    for (const client of this.#clients.get(botId) ?? []) this.#send(client.socket, message)
  }

  #send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message))
  }

  #connect(socket, botId) {
    const sessions = new Map()
    const clientState = { socket, botId, autoAttach: false, discover: false, attach: undefined, sessions }
    const clients = this.#clients.get(botId) ?? new Set()
    clients.add(clientState)
    this.#clients.set(botId, clients)
    const targets = () => [...this.#views.values()].filter(entry => entry.botId === botId)
    const info = entry => this.#targetInfo(entry)
    const attach = entry => {
      const existing = entry.sessions.get(socket)
      if (existing) return existing
      this.#touch(entry)
      this.#ensureDebugger(entry)
      const sessionId = randomUUID()
      sessions.set(sessionId, { entry, nativeId: undefined })
      entry.sessions.set(socket, sessionId)
      entry.sessionMaps.set(socket, sessions)
      this.#send(socket, { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: info(entry), waitingForDebugger: false } })
      this.#onChange({ type: 'changed', ...this.#state(entry) })
      return sessionId
    }
    clientState.attach = attach
    let commandQueue = Promise.resolve()
    socket.on('message', raw => {
      commandQueue = commandQueue.then(async () => {
        let request
        try { request = JSON.parse(raw.toString()) } catch { return }
        const { id, method, params = {}, sessionId } = request
        const reply = result => {
          this.#send(socket, { id, result, ...(sessionId ? { sessionId } : {}) })
        }
        const fail = error => {
          this.#send(socket, { id, error: { code: -32000, message: String(error?.message ?? error) }, ...(sessionId ? { sessionId } : {}) })
        }
        try {
        if (method === 'Browser.getVersion') { reply({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, userAgent: `Electron/${process.versions.electron} Chrome/${process.versions.chrome}`, jsVersion: process.versions.v8 }); return }
        if (method === 'Browser.setDownloadBehavior') {
          const allowsDownloads = params.behavior === 'allow' || params.behavior === 'allowAndName'
          const downloadPath = allowsDownloads ? this.#allowedDownloadPath(botId, params.downloadPath) : undefined
          this.#downloadPaths.set(botId, downloadPath)
          for (const entry of targets()) entry.downloadPath = downloadPath
          reply({}); return
        }
        if (method === 'Browser.cancelDownload') {
          const download = targets().flatMap(entry => [...entry.downloads.entries()]).find(([guid]) => guid === params.guid)?.[1]
          if (download) await download.item.cancel()
          reply({}); return
        }
        if (method === 'Target.getBrowserContexts') { reply({ browserContextIds: [`bot:${botId}`] }); return }
        if (method === 'Target.getTargets') { reply({ targetInfos: targets().map(info) }); return }
        if (method === 'Target.setDiscoverTargets') {
          clientState.discover = params.discover === true
          if (clientState.discover) for (const entry of targets()) this.#send(socket, { method: 'Target.targetCreated', params: { targetInfo: info(entry) } })
          reply({}); return
        }
        if (method === 'Target.setAutoAttach') {
          clientState.autoAttach = params.autoAttach === true
          if (clientState.autoAttach) for (const entry of targets()) if (!entry.sessions.has(socket)) attach(entry)
          reply({}); return
        }
        if (method === 'Target.attachToTarget') {
          const entry = this.#owned(botId, params.targetId)
          const attached = attach(entry)
          this.#send(socket, { id, result: { sessionId: attached } })
          return
        }
        if (method === 'Target.createTarget') {
          const entry = this.create(botId, { url: params.url ?? 'about:blank', createdByBot: true })
          if (entry && params.background !== true) entry.view.webContents.focus()
          reply({ targetId: entry.tabId }); return
        }
        if (method === 'Target.closeTarget') { await this.close(botId, params.targetId); reply({ success: true }); return }
        if (method === 'Target.activateTarget') {
          const entry = this.#owned(botId, params.targetId)
          this.#touch(entry)
          entry.view.webContents.focus()
          reply({}); return
        }
        if (method === 'Target.detachFromTarget') {
          const route = sessions.get(params.sessionId)
          if (route) {
            if (route.nativeId) {
              await route.entry.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: route.nativeId }).catch(() => {})
              sessions.delete(params.sessionId)
            } else {
              route.entry.sessions.delete(socket)
              route.entry.sessionMaps.delete(socket)
              for (const [sid, candidate] of [...sessions]) {
                if (candidate.entry === route.entry) sessions.delete(sid)
              }
              this.#releaseDebugger(route.entry)
              if (!route.entry.view.webContents.isDestroyed()) this.#onChange({ type: 'changed', ...this.#state(route.entry) })
            }
          }
          reply({}); return
        }
        if (method === 'Target.getTargetInfo') {
          const entry = params.targetId
            ? this.#owned(botId, params.targetId)
            : sessions.get(sessionId)?.entry ?? targets()[0]
          if (!entry || entry.botId !== botId) throw new Error('Unknown target')
          reply({ targetInfo: info(entry) }); return
        }
        if (method === 'Browser.close') { socket.close(); return }
        if (sessionId) {
          const route = sessions.get(sessionId)
          if (!route) throw new Error('Unknown target session')
          this.#touch(route.entry)
          this.#ensureDebugger(route.entry)
          const nativeParams = { ...params }
          if (nativeParams.frameId === route.entry.tabId) nativeParams.frameId = route.entry.mainFrameId
          const result = await route.entry.view.webContents.debugger.sendCommand(method, nativeParams, route.nativeId)
          reply(this.#framePayload(route.entry, method, result))
          return
        }
        if (['Browser.getBrowserCommandLine', 'Browser.getWindowForTarget', 'Target.setDiscoverTargets'].includes(method)) { reply({}); return }
        throw new Error(`Unsupported CDP method: ${method}`)
        } catch (error) { fail(error) }
      })
    })
    socket.on('close', () => {
      for (const entry of targets()) {
        const had = entry.sessions.delete(socket)
        entry.sessionMaps.delete(socket)
        if (had) {
          this.#releaseDebugger(entry)
          if (!entry.view.webContents.isDestroyed()) this.#onChange({ type: 'changed', ...this.#state(entry) })
        }
      }
      sessions.clear()
      clients.delete(clientState)
      if (clients.size === 0) this.#clients.delete(botId)
    })
  }

  #targetInfo(entry) {
    return {
      targetId: entry.tabId, type: 'page', title: entry.view.webContents.getTitle(),
      url: entry.view.webContents.getURL(), attached: entry.sessions.size > 0, canAccessOpener: true,
      browserContextId: `bot:${entry.botId}`, ...(entry.openerId ? { openerId: entry.openerId } : {}),
    }
  }
}
