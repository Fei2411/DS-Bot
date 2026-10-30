// The window and the tray in a real Electron, with a fake Host: no DSH, no model, no data.
// The check script drives it over stdin and reads the answers on stdout.
import { app, BrowserWindow, Menu, nativeImage, powerMonitor, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createShell } from '../../src/shell.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', '..', 'assets')
// The data of this run is the folder the check script names, so that the check never writes
// into the data of the user. The path is set before the app is ready.
if (process.env.DS_BOT_SHELL_DATA !== undefined) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)
const token = randomBytes(16).toString('hex')
const cookie = `dsh-auth=${token}`
let origin
let requests = 0
let hosts = 0

// The Host of the app, as far as the window is concerned: the launch URL trades its token for
// a cookie, and the plain address is served to whoever carries that cookie.
const host = createServer((request, response) => {
  requests += 1
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.searchParams.get('token') === token) {
    response.writeHead(302, { 'set-cookie': `${cookie}; Path=/`, location: '/' })
    response.end()
    return
  }
  if ((request.headers.cookie ?? '').includes(cookie)) {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>DeepSeek Bot</title><h1 id="ready">ready</h1>')
    return
  }
  response.writeHead(401).end('unauthorized')
})

let mainWindow
const shell = createShell({
  electron: { app, Menu, Tray, powerMonitor },
  platform: process.platform,
  messages: () => ({ tooltip: 'DeepSeek Bot', open: 'Open DeepSeek Bot', quit: 'Quit DeepSeek Bot', notice: 'The app goes on.', noticeConfirm: 'OK' }),
  trayImage: () => {
    const file = join(assets, process.platform === 'win32' ? 'tray.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) throw new Error(`the tray icon ${file} could not be read`)
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  },
  window: () => mainWindow,
  build: () => {
    const win = createWindow()
    // The Host runs already: the plain address is enough, the cookie carries the session.
    void win.loadURL(`${origin}/`).catch(() => {})
    return win
  },
  reveal: (target) => { target.show(); target.focus() },
  quit: () => { app.quit() },
  busy: () => false,
  ready: () => origin !== undefined,
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: async () => ({ response: 0 }) },
})

// The app is on its way out: the window may close for good. The app of the real desktop
// does the same in its before-quit.
app.on('before-quit', () => { shell.beginQuit() })

function createWindow() {
  const win = new BrowserWindow({ width: 900, height: 600, show: false })
  mainWindow = win
  win.once('ready-to-show', () => {
    if (win.isDestroyed() || shell.isQuitting() || shell.isHidden(win)) return
    win.show()
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined })
  shell.watch(win)
  return win
}

const answer = (payload) => { process.stdout.write(`${JSON.stringify(payload)}\n`) }

const state = () => ({
  visible: mainWindow === undefined ? null : mainWindow.isVisible(),
  destroyed: mainWindow === undefined ? null : mainWindow.isDestroyed(),
  url: mainWindow === undefined ? null : mainWindow.webContents.getURL(),
  title: mainWindow === undefined ? null : mainWindow.webContents.getTitle(),
  requests,
  hosts,
  hasTray: shell.hasTray(),
  quitting: shell.isQuitting(),
})

async function handle(command) {
  if (command === 'close') mainWindow?.close()
  if (command === 'destroy') mainWindow?.destroy()
  if (command === 'open') shell.open()
  if (command === 'quit') shell.quit()
  await new Promise(resolve => setTimeout(resolve, 400))
  return state()
}

// The check script talks to the app over this socket: the main process of Electron does not
// read its standard input.
const commands = net.createServer((socket) => {
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      void handle(line).then(result => { socket.write(`${JSON.stringify(result)}\n`) })
    }
  })
})

app.whenReady().then(async () => {
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String(host.address().port)}`
  hosts += 1
  // The one-time notice is answered in advance: the check is about the window and the tray.
  const folder = app.getPath('userData')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'tray-close-acknowledged'), '')
  shell.install()
  await new Promise(resolve => commands.listen(0, '127.0.0.1', resolve))
  const win = createWindow()
  // The launch URL trades its token for the cookie of the Host.
  void win.loadURL(`${origin}/?token=${token}`).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 1200))
  answer({ ready: true, port: commands.address().port, ...state() })
})
