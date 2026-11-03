// Gives the page that the app's Host serves the app's own bridge, and the app's start page its
// own, smaller one; each window's arguments name the one page that gets it. On Windows it also
// marks the Host's page for the frameless window the way DSH Desktop's preload does
// (apps/desktop/src/preload-windows.ts, preload-platform.ts and preload-theme.ts; see NOTICE),
// but without data-platform: that puts DSH's shortcuts on native menu input, which this
// window does not have.
const { contextBridge, ipcRenderer } = require('electron')

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const startPage = argument('ds-bot-start')
const host = argument('ds-bot-origin')
if (startPage !== undefined) {
  if (location.href.split(/[?#]/u)[0] === startPage) {
    contextBridge.exposeInMainWorld('dsBotStart', startBridge())
    // The start page's folder pickers (换个位置…, a data move) are the app's own too.
    ipcRenderer.on('ds-bot:app-picker', (_event, request) => { showPicker(request) })
  }
} else if (host !== undefined && location.origin === host) {
  let ready = false
  contextBridge.exposeInMainWorld('dsBotApp', {
    // The team view has mounted: the start window hands over to this one. With it, where the
    // Main Bot's avatar is drawn, for the start window's whale to land on (start-window §8).
    ready: (place) => {
      if (ready) return
      ready = true
      ipcRenderer.send('ds-bot:ready', placeOf(place))
    },
    // The start window hands its whale over at the top of its jump (start-window.mjs): `run`
    // draws it where it is on this page, and once that is painted the main process cross-fades
    // the two windows.
    onHandoff: (run) => {
      if (typeof run !== 'function') return
      ipcRenderer.removeAllListeners('ds-bot:handoff')
      ipcRenderer.on('ds-bot:handoff', (_event, value) => {
        const from = handoffOf(value)
        if (from === undefined) return
        try { run(from) } finally { requestAnimationFrame(() => { requestAnimationFrame(() => { ipcRenderer.send('ds-bot:handoff-ready') }) }) }
      })
    },
    // DS Bot's settings show and move the app's data location through this.
    dataLocation: () => ipcRenderer.invoke('ds-bot:data-location'),
    moveData: (workspace) => ipcRenderer.invoke('ds-bot:move-data', typeof workspace === 'string' ? workspace : undefined),
    teamWorkspaceChanged: (path) => { ipcRenderer.send('ds-bot:team-workspace', String(path)) },
    // The Bot browsers, in the shape of DSH Desktop's browser bridge so that ds-bot drives both
    // alike; `forget` clears a key's storage, which here outlives the app.
    browser: browserBridge(),
    // The app's own updater, for the About row's state and buttons.
    updates: updatesBridge(),
  })
  // Only plain numbers cross; the main process checks that they make a box inside the page.
  const placeOf = (value) => {
    if (value === null || typeof value !== 'object') return undefined
    const place = {}
    for (const key of ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight']) {
      const number = Number(value[key])
      if (!Number.isFinite(number)) return undefined
      place[key] = number
    }
    return place
  }
  const handoffOf = (value) => {
    if (value === null || typeof value !== 'object') return undefined
    const from = {}
    for (const key of ['x', 'y', 'size', 'hold']) {
      const number = Number(value[key])
      if (!Number.isFinite(number)) return undefined
      from[key] = number
    }
    return from
  }
  // A preload runs before the document root exists.
  const loaded = (run) => {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run, { once: true })
    else run()
  }
  loaded(reportLook)
  // The app's own questions (the tray notice, an update, a data move), on a card over the page.
  ipcRenderer.on('ds-bot:app-card', (_event, card) => { loaded(() => { showCard(card) }) })
  ipcRenderer.on('ds-bot:app-picker', (_event, request) => { loaded(() => { showPicker(request) }) })
  const caption = process.argv.find(value => value.startsWith('--ds-bot-caption='))
  if (caption !== undefined) {
    ipcRenderer.on('ds-bot:fullscreen', (_event, fullscreen) => {
      const root = document.documentElement
      if (root === null) return
      if (fullscreen) root.dataset.fullscreen = 'true'
      else delete root.dataset.fullscreen
    })
    loaded(() => { frameless(caption.slice('--ds-bot-caption='.length), process.argv.includes('--ds-bot-mica')) })
  }
}

// The card that the team window shows in place of a message box (main.mjs askInWindow): a line,
// an optional detail and the buttons, styled by page-card.css, which the main process inserts.
// The answer is the index of the button; -1 when a newer card takes its place. Enter is the
// focused button; Escape is `cancel`, when the card has one; Tab stays on the card's buttons.
let openCard
function showCard(card) {
  if (card === null || typeof card !== 'object' || !Number.isInteger(card.id) || !Array.isArray(card.buttons)) return
  openCard?.close(-1)
  const make = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text === undefined ? {} : { textContent: String(text) }) })
  const layer = make('div', 'dsb-card-layer')
  const box = make('section', 'dsb-card')
  box.setAttribute('role', 'alertdialog')
  box.setAttribute('aria-modal', 'true')
  const title = make('h2', 'dsb-card-title', card.message ?? '')
  title.id = `dsb-card-title-${String(card.id)}`
  box.setAttribute('aria-labelledby', title.id)
  box.append(title)
  if (typeof card.detail === 'string' && card.detail !== '') {
    const detail = make('p', 'dsb-card-detail', card.detail)
    detail.id = `dsb-card-detail-${String(card.id)}`
    box.setAttribute('aria-describedby', detail.id)
    box.append(detail)
  }
  const actions = make('div', 'dsb-card-actions')
  const buttons = card.buttons.map((entry, index) => {
    const button = make('button', 'dsb-card-btn', entry?.label ?? '')
    button.type = 'button'
    button.dataset.look = entry?.primary ? 'primary' : 'soft'
    button.addEventListener('click', () => { close(index) })
    return button
  })
  actions.append(...buttons)
  box.append(actions)
  layer.append(box)
  const before = document.activeElement
  let done = false
  const keys = (event) => {
    if (event.key === 'Escape' && Number.isInteger(card.cancel) && card.cancel >= 0) {
      event.preventDefault()
      close(card.cancel)
    } else if (event.key === 'Tab' && buttons.length > 0) {
      const at = buttons.indexOf(document.activeElement)
      event.preventDefault()
      buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus()
    }
    // The page's own shortcuts wait while the card is up.
    event.stopPropagation()
  }
  // Focus that leaves for the page comes back to the card.
  const keep = (event) => { if (!layer.contains(event.target)) (buttons.find(button => button.dataset.look === 'primary') ?? buttons[0])?.focus() }
  function close(index) {
    if (done) return
    done = true
    if (openCard?.close === close) openCard = undefined
    document.removeEventListener('keydown', keys, true)
    document.removeEventListener('focusin', keep, true)
    ipcRenderer.send('ds-bot:app-card-answer', card.id, index)
    delete layer.dataset.open
    layer.dataset.leaving = ''
    layer.inert = true
    setTimeout(() => { layer.remove() }, 220)
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
  }
  document.addEventListener('keydown', keys, true)
  document.addEventListener('focusin', keep, true)
  ;(document.body ?? document.documentElement).append(layer)
  // The layer is laid out once before it opens, so that the opening transitions run.
  void layer.offsetWidth
  layer.dataset.open = ''
  ;(buttons.find(button => button.dataset.look === 'primary') ?? buttons[0])?.focus({ preventScroll: true })
  openCard = { close }
  ipcRenderer.send('ds-bot:app-card-shown', card.id)
}

// The app's own folder and file picker, in place of the system's (main.mjs askPicker,
// picker-host.mjs): the same card layer with a side column of places and drives, a breadcrumb, a
// path field, the folder's entries (folders first) and, to save, a file name. The page only
// draws: the main process lists, makes folders and checks the answer. What goes wrong (a folder
// without permission, a drive that is gone, a name that cannot be used) is said in place.
let openPicker
function showPicker(request) {
  if (request === null || typeof request !== 'object' || !Number.isInteger(request.id)) return
  openPicker?.close()
  const { id, mode } = request
  const label = key => String(request.labels?.[key] ?? key)
  const say = (key, vars) => label(key).replace(/\{(\w+)\}/gu, (all, name) => (name in vars ? String(vars[name]) : all))
  const call = (channel, ...args) => ipcRenderer.invoke(`ds-bot:app-picker-${channel}`, id, ...args)
  const make = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text === undefined ? {} : { textContent: String(text) }) })
  const button = (className, text, look) => {
    const element = make('button', className, text)
    element.type = 'button'
    if (look !== undefined) element.dataset.look = look
    return element
  }
  const field = (className) => {
    const input = make('input', className)
    input.type = 'text'
    input.spellcheck = false
    input.autocomplete = 'off'
    return input
  }
  // A folder, a file or a drive, drawn in the page's ink.
  const glyph = (kind) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    svg.classList.add('dsb-picker-glyph')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', {
      dir: 'M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z',
      file: 'M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm6 0v3h3',
      drive: 'M2.5 4.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM11.5 8h.01',
    }[kind])
    svg.append(path)
    return svg
  }

  const layer = make('div', 'dsb-card-layer')
  layer.dataset.kind = 'picker'
  const box = make('section', 'dsb-card dsb-picker')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const title = make('h2', 'dsb-card-title', request.title ?? '')
  title.id = `dsb-picker-title-${String(id)}`
  box.setAttribute('aria-labelledby', title.id)

  const bar = make('div', 'dsb-picker-bar')
  const up = button('dsb-picker-up')
  up.setAttribute('aria-label', label('up'))
  up.title = label('up')
  const trail = make('nav', 'dsb-picker-crumbs')
  trail.setAttribute('aria-label', label('path'))
  bar.append(up, trail)

  const pathRow = make('form', 'dsb-picker-row-form')
  const pathField = field('dsb-picker-input')
  pathField.setAttribute('aria-label', label('path'))
  const go = button('dsb-card-btn dsb-picker-small', label('go'), 'soft')
  go.type = 'submit'
  pathRow.append(pathField, go)

  const main = make('div', 'dsb-picker-main')
  const side = make('nav', 'dsb-picker-side')
  side.setAttribute('aria-label', label('places'))
  const pane = make('div', 'dsb-picker-pane')
  const note = make('p', 'dsb-picker-note')
  note.hidden = true
  const rows = make('div', 'dsb-picker-list')
  rows.setAttribute('role', 'listbox')
  rows.setAttribute('aria-labelledby', title.id)
  rows.tabIndex = 0
  pane.append(note, rows)
  main.append(side, pane)

  const fresh = make('form', 'dsb-picker-row-form')
  fresh.hidden = true
  const freshName = field('dsb-picker-input')
  freshName.setAttribute('aria-label', label('newFolder'))
  const freshMake = button('dsb-card-btn dsb-picker-small', label('create'), 'soft')
  freshMake.type = 'submit'
  fresh.append(freshName, freshMake)

  const nameRow = make('label', 'dsb-picker-name')
  const nameField = field('dsb-picker-input')
  nameField.value = String(request.name ?? '')
  nameRow.append(make('span', 'dsb-picker-name-label', label('name')), nameField)

  const ask = make('div', 'dsb-picker-ask')
  ask.setAttribute('role', 'alert')
  ask.hidden = true

  const actions = make('div', 'dsb-card-actions dsb-picker-actions')
  const newFolder = button('dsb-card-btn dsb-picker-newbtn', label('newFolder'), 'soft')
  const cancel = button('dsb-card-btn', label('cancel'), 'soft')
  const primary = button('dsb-card-btn', label(mode === 'save' ? 'save' : mode === 'file' ? 'open' : 'chooseFolder'), 'primary')
  actions.append(newFolder, cancel, primary)

  box.append(title, bar, pathRow, main, fresh)
  if (mode === 'save') box.append(nameRow)
  box.append(ask, actions)
  layer.append(box)

  let here
  let entries = []
  let picked = -1
  let asked = 0
  let done = false

  const tell = (text, tone) => {
    note.textContent = text ?? ''
    note.hidden = !text
    if (tone === undefined) delete note.dataset.tone
    else note.dataset.tone = tone
    note.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  }
  const hideAsk = () => {
    ask.hidden = true
    ask.replaceChildren()
  }
  const choice = () => entries[picked]
  const refresh = () => {
    const entry = choice()
    primary.disabled = here === undefined || (mode === 'file' && (entry === undefined || entry.dir))
    for (const [index, row] of [...rows.children].entries()) row.setAttribute('aria-selected', String(index === picked))
    if (entry === undefined) { rows.removeAttribute('aria-activedescendant'); return }
    rows.setAttribute('aria-activedescendant', rows.children[picked].id)
    rows.children[picked].scrollIntoView({ block: 'nearest' })
  }
  const select = (index) => {
    picked = Math.max(-1, Math.min(index, entries.length - 1))
    const entry = choice()
    if (mode === 'save' && entry !== undefined && !entry.dir) nameField.value = entry.name
    hideAsk()
    refresh()
  }
  const draw = (listing) => {
    here = listing.path
    pathField.value = listing.path
    up.disabled = listing.parent === undefined
    trail.replaceChildren(...listing.crumbs.map((step, index) => {
      const crumb = button('dsb-picker-crumb', step.name)
      crumb.title = step.path
      if (index === listing.crumbs.length - 1) crumb.setAttribute('aria-current', 'location')
      crumb.addEventListener('click', () => { void open(step.path) })
      return crumb
    }))
    trail.scrollLeft = trail.scrollWidth
    entries = listing.entries
    picked = -1
    rows.replaceChildren(...entries.map((entry, index) => {
      const row = make('div', 'dsb-picker-row')
      row.id = `dsb-picker-row-${String(id)}-${String(index)}`
      row.setAttribute('role', 'option')
      row.dataset.dir = String(entry.dir)
      row.title = entry.name
      row.append(glyph(entry.dir ? 'dir' : 'file'), make('span', 'dsb-picker-row-name', entry.name))
      row.addEventListener('click', () => { select(index) })
      row.addEventListener('dblclick', () => { void enter(index) })
      return row
    }))
    if (listing.more !== undefined) tell(say('more', { count: entries.length }))
    else if (entries.length === 0) tell(label(mode === 'folder' ? 'noFolders' : 'empty'))
    else tell()
    for (const root of side.querySelectorAll('.dsb-picker-root')) {
      if (root.dataset.path === here) root.setAttribute('aria-current', 'location')
      else root.removeAttribute('aria-current')
    }
    refresh()
  }
  // A listing that comes back after a newer one was asked for is dropped. A failed one keeps
  // the folder that was shown and says why next to it.
  const open = async (path) => {
    const turn = (asked += 1)
    rows.setAttribute('aria-busy', 'true')
    const listing = await call('list', String(path), here).catch(() => undefined)
    if (done || turn !== asked) return false
    rows.removeAttribute('aria-busy')
    if (listing === undefined || listing === null) return false
    if (listing.error !== undefined) {
      tell(label(`error.${listing.error}`), 'error')
      return false
    }
    hideAsk()
    draw(listing)
    return true
  }
  const enter = async (index) => {
    const entry = entries[index]
    if (entry === undefined) return
    if (entry.dir) await open(entry.path)
    else if (mode === 'file') await choose(entry.path)
    else select(index)
  }
  const choose = async (path, replace = false) => {
    if (done || path === undefined) return
    const name = nameField.value.trim()
    const answer = await call('choose', path, mode === 'save' ? { name, replace } : undefined).catch(() => undefined)
    if (done || answer === undefined || answer === null) return
    if (answer.error !== undefined) { tell(label(`error.${answer.error}`), 'error'); return }
    if (answer.exists) {
      const yes = button('dsb-card-btn dsb-picker-small', label('replace'), 'primary')
      yes.addEventListener('click', () => { void choose(path, true) })
      ask.replaceChildren(make('span', 'dsb-picker-ask-text', say('error.replace', { name })), yes)
      ask.hidden = false
      yes.focus()
      return
    }
    close(false)
  }
  const commit = () => {
    if (mode === 'save') { void choose(here); return }
    const entry = choice()
    if (mode === 'file') { if (entry !== undefined && !entry.dir) void choose(entry.path); return }
    void choose(entry?.dir ? entry.path : here)
  }

  up.addEventListener('click', () => { const steps = trail.children; if (steps.length > 1) steps[steps.length - 2].click() })
  pathRow.addEventListener('submit', (event) => { event.preventDefault(); void open(pathField.value) })
  newFolder.addEventListener('click', () => {
    fresh.hidden = false
    freshName.value = label('newName')
    freshName.focus()
    freshName.select()
  })
  fresh.addEventListener('submit', (event) => {
    event.preventDefault()
    void call('folder', here, freshName.value.trim()).catch(() => undefined).then(async (made) => {
      if (done || made === undefined || made === null) return
      if (made.error !== undefined) { tell(label(`error.${made.error}`), 'error'); freshName.focus(); return }
      fresh.hidden = true
      if (await open(here)) {
        select(entries.findIndex(entry => entry.path === made.path))
        rows.focus()
      }
    })
  })
  nameField.addEventListener('input', hideAsk)
  nameField.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } })
  cancel.addEventListener('click', () => { close(true) })
  primary.addEventListener('click', commit)
  rows.addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[event.key]
    if (step !== undefined && !event.altKey) { event.preventDefault(); select(picked < 0 ? 0 : picked + step) }
    else if (event.key === 'Home') { event.preventDefault(); select(0) }
    else if (event.key === 'End') { event.preventDefault(); select(entries.length - 1) }
    else if (event.key === 'Enter') { event.preventDefault(); if (choice()?.dir) void enter(picked); else commit() }
    else if (event.key === 'Backspace' || (event.key === 'ArrowUp' && event.altKey)) { event.preventDefault(); up.click() }
  })

  const focusables = () => [...box.querySelectorAll('button, input, [tabindex="0"]')].filter(element => !element.disabled && element.offsetParent !== null)
  const keys = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!ask.hidden) hideAsk()
      else if (!fresh.hidden) { fresh.hidden = true; rows.focus() } else close(true)
    } else if (event.key === 'Tab') {
      const list = focusables()
      const at = list.indexOf(document.activeElement)
      event.preventDefault()
      list[(at + (event.shiftKey ? -1 : 1) + list.length) % list.length]?.focus()
    }
    // The page's own shortcuts wait while the picker is up.
    event.stopPropagation()
  }
  const keep = (event) => { if (!layer.contains(event.target)) rows.focus() }
  const before = document.activeElement
  function close(cancelled) {
    if (done) return
    done = true
    if (openPicker?.close === quit) openPicker = undefined
    document.removeEventListener('keydown', keys, true)
    document.removeEventListener('focusin', keep, true)
    if (cancelled) ipcRenderer.send('ds-bot:app-picker-cancel', id)
    delete layer.dataset.open
    layer.dataset.leaving = ''
    layer.inert = true
    setTimeout(() => { layer.remove() }, 220)
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
  }
  const quit = () => { close(true) }
  document.addEventListener('keydown', keys, true)
  document.addEventListener('focusin', keep, true)
  ;(document.body ?? document.documentElement).append(layer)
  // The layer is laid out once before it opens, so that the opening transitions run.
  void layer.offsetWidth
  layer.dataset.open = ''
  openPicker = { close: quit }
  ipcRenderer.send('ds-bot:app-picker-shown', id)
  refresh()
  if (mode === 'save') {
    nameField.focus({ preventScroll: true })
    const dot = nameField.value.lastIndexOf('.')
    nameField.setSelectionRange(0, dot > 0 ? dot : nameField.value.length)
  } else rows.focus({ preventScroll: true })

  void open(request.start ?? '').then((ok) => { if (!ok && !done && here === undefined && note.hidden) tell(label('error.unreadable'), 'error') })
  void call('roots').then((found) => {
    if (done || found === undefined || found === null) return
    const group = (heading, items, kind) => {
      if (items.length === 0) return []
      return [make('h3', 'dsb-picker-head', heading), ...items.map((item) => {
        // The name has a box of its own: as bare text beside the glyph it would be an anonymous
        // flex item, which no ellipsis reaches.
        const root = button('dsb-picker-root')
        root.append(make('span', 'dsb-picker-root-name', item.label))
        root.dataset.path = item.path
        root.title = item.path
        root.prepend(glyph(kind))
        if (item.path === here) root.setAttribute('aria-current', 'location')
        root.addEventListener('click', () => { void open(item.path) })
        return root
      })]
    }
    side.replaceChildren(
      ...group(label('places'), found.places.map(place => ({ path: place.path, label: label(place.key) })), 'dir'),
      ...group(label('drives'), found.drives, 'drive'),
    )
  }, () => {})
}

// The app's theme (DSH's) and the Bot animation tier (ds-bot's), which the start window takes
// at the next start.
function reportLook() {
  const root = document.documentElement
  const sent = {}
  const send = (channel, value) => {
    if (value === null || value === sent[channel]) return
    sent[channel] = value
    ipcRenderer.send(channel, value)
  }
  const report = () => {
    send('ds-bot:native-theme', root.getAttribute('data-ds-theme-source'))
    send('ds-bot:motion', document.body?.getAttribute('data-bt-motion') ?? null)
  }
  const observer = new MutationObserver(report)
  observer.observe(root, { attributeFilter: ['data-ds-theme-source'] })
  if (document.body !== null) observer.observe(document.body, { attributeFilter: ['data-bt-motion'] })
  report()
}

// The main process sends the whole state on every change; a page that subscribes late, or again,
// gets the last one first.
function startBridge() {
  const listeners = new Set()
  let last
  const tell = (listener, state) => {
    try { listener(state) } catch (error) { console.error('DS Bot: a start state listener failed', error) }
  }
  ipcRenderer.on('ds-bot:start-state', (_event, state) => {
    last = state
    for (const listener of [...listeners]) tell(listener, state)
  })
  return {
    onState(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      if (last !== undefined) tell(listener, last)
      return () => { listeners.delete(listener) }
    },
    act: (name, payload) => ipcRenderer.invoke('ds-bot:start-act', String(name), payload),
  }
}

function browserBridge() {
  const listeners = new Map()
  const viewListeners = new Set()
  ipcRenderer.on('ds-bot:browser-view-changed', (_event, change) => {
    for (const listener of [...viewListeners]) {
      try { listener(change) } catch (error) { console.error('DS Bot: a browser view listener failed', error) }
    }
  })
  ipcRenderer.on('ds-bot:browser-open-requested', (_event, request) => {
    if (typeof request?.lease !== 'string' || typeof request.url !== 'string') return
    for (const listener of [...(listeners.get(request.lease) ?? [])]) {
      try { listener(request.url) } catch (error) { console.error('DS Bot: a browser link handler failed', error) }
    }
  })
  return {
    acquire: key => ipcRenderer.invoke('ds-bot:browser-acquire', String(key)),
    release: lease => ipcRenderer.invoke('ds-bot:browser-release', String(lease)),
    forget: key => ipcRenderer.invoke('ds-bot:browser-forget', String(key)),
    views: {
      create: (botId, tabId, url) => ipcRenderer.invoke('ds-bot:browser-view-create', String(botId), String(tabId), typeof url === 'string' ? url : undefined),
      sync: botId => ipcRenderer.invoke('ds-bot:browser-view-sync', String(botId)),
      place: (tabId, rect, visible) => ipcRenderer.invoke('ds-bot:browser-view-place', String(tabId), rect, visible === true),
      navigate: (botId, tabId, url) => ipcRenderer.invoke('ds-bot:browser-view-navigate', String(botId), String(tabId), String(url)),
      command: (botId, tabId, command) => ipcRenderer.invoke('ds-bot:browser-view-command', String(botId), String(tabId), String(command)),
      focus: (botId, tabId) => ipcRenderer.invoke('ds-bot:browser-view-focus', String(botId), String(tabId)),
      read: (botId, tabId, script) => ipcRenderer.invoke('ds-bot:browser-view-read', String(botId), String(tabId), String(script)),
      close: (botId, tabId) => ipcRenderer.invoke('ds-bot:browser-view-close', String(botId), String(tabId)),
      hold: (botId, held) => ipcRenderer.invoke('ds-bot:browser-view-hold', String(botId), held === true),
      subscribe(listener) { viewListeners.add(listener); return () => viewListeners.delete(listener) },
    },
    // Cookie imports, only in the app: sources and a two-step pick/harvest → preview → apply.
    importSources: () => ipcRenderer.invoke('ds-bot:browser-import-sources'),
    importPick: () => ipcRenderer.invoke('ds-bot:browser-import-pick'),
    importLive: (source, close) => ipcRenderer.invoke('ds-bot:browser-import-live', String(source), close === true),
    importApply: (key, pending) => ipcRenderer.invoke('ds-bot:browser-import-apply', String(key), String(pending)),
    importCancel: (pending) => ipcRenderer.invoke('ds-bot:browser-import-cancel', String(pending)),
    onOpenRequested(lease, listener) {
      const id = String(lease)
      let set = listeners.get(id)
      if (set === undefined) { set = new Set(); listeners.set(id, set) }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0 && listeners.get(id) === set) listeners.delete(id)
      }
    },
  }
}

function updatesBridge() {
  const listeners = new Set()
  ipcRenderer.on('ds-bot:app-update-changed', (_event, state) => {
    for (const listener of [...listeners]) {
      try { listener(state) } catch (error) { console.error('DS Bot: an update state handler failed', error) }
    }
  })
  return {
    state: () => ipcRenderer.invoke('ds-bot:app-update-state'),
    check: () => ipcRenderer.invoke('ds-bot:app-update-check'),
    install: () => ipcRenderer.invoke('ds-bot:app-update-install'),
    open: () => ipcRenderer.invoke('ds-bot:app-update-open'),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function frameless(height, mica) {
  const root = document.documentElement
  root.dataset.windowsTitlebar = ''
  root.style.setProperty('--dsh-windows-titlebar-height', `${height}px`)
  // DSH keeps the dialog mask off the caption band, which then stays bright above a dimmed
  // page; here the band is part of the page, so the mask covers it too.
  root.style.setProperty('--dsh-frame-chrome-top', '0px')
  captionColors(mica)
}

// The caption buttons stand on the rightmost open column with Mica (the right sidebar or the
// conversation) and on the sidebar-colored band without it. Theme variables can resolve apart
// from what is painted, so the color comes from the element itself: the first one up from it
// that is not transparent.
function captionColors(mica) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return
  const opaque = (color) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    return alpha === 0 ? undefined : `rgb(${red}, ${green}, ${blue})`
  }
  // The surface's color with the layers above the caption buttons (a dialog's mask) painted over it.
  const covered = (base, frame) => {
    const layers = []
    for (const element of document.elementsFromPoint(innerWidth - 1, 1)) {
      if (frame !== null && (element === frame || element.contains(frame) || frame.contains(element))) break
      for (const pseudo of ['::after', null, '::before']) layers.push(getComputedStyle(element, pseudo).backgroundColor)
    }
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = base
    context.fillRect(0, 0, 1, 1)
    for (const color of layers.reverse()) {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
    }
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    return `rgb(${red}, ${green}, ${blue})`
  }
  const column = () => {
    if (!mica) return document.querySelector('div[class*="_sidebarCol"]')
    const right = document.querySelector('div[class*="_rightbarCol"]')
    return right !== null && right.getBoundingClientRect().width > 0 ? right : document.querySelector('div[class*="_centerCol"]')
  }
  let frame
  const surface = () => {
    const start = column()
    // Opening or closing the right sidebar changes the frame's columns.
    if (start !== null && frame === undefined) {
      frame = start.parentElement
      observer.observe(frame, { attributes: true, attributeFilter: ['style'] })
    }
    for (let element = start; element !== null; element = element.parentElement) {
      const color = opaque(getComputedStyle(element).backgroundColor)
      if (color !== undefined) return [covered(color, frame ?? null), opaque(getComputedStyle(element).color)]
    }
    return undefined
  }
  let sent = ''
  let tries = 0
  const send = () => {
    const colors = surface()
    // The frame appears once DSH has booted; until then the main process's colors hold.
    if (colors === undefined || colors[1] === undefined) {
      if (tries++ < 120) setTimeout(send, 250)
      return
    }
    const current = colors.join()
    if (current === sent) return
    sent = current
    ipcRenderer.send('ds-bot:caption-colors', ...colors)
  }
  // A dialog mounts anywhere in the page, which changes all the time; one look per frame.
  let queued = false
  const queue = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; send() })
  }
  const observer = new MutationObserver(queue)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'], childList: true, subtree: true })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style'] })
  // A stylesheet link is added before it loads; its rules apply without another mutation.
  document.head.addEventListener('load', send, true)
  send()
}
