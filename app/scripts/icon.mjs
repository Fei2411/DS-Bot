// Draws the app icon from the Main Bot's whale in ../ds-bot and writes assets/icon.svg,
// assets/icon.png (1024 px), assets/icon.ico (Windows, 16 to 256 px) and the tray marks:
// assets/tray.ico (Windows), assets/tray.png (Linux) and assets/trayTemplate.png with its
// @2x (macOS).
// Usage: npm run icon. It runs itself again inside Electron, which turns the SVG into PNGs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { characterMarkup, MASK_ID } from '../../ds-bot/src/client/characters.js'

const here = fileURLToPath(import.meta.url)
const assets = join(dirname(here), '..', 'assets')
const ICO_SIZES = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]
// The tray icon is small: the sizes a notification area shows, and one plain png for Linux.
const TRAY_ICO_SIZES = [16, 20, 24, 32]
const TRAY_PNG_SIZE = 24
// macOS draws a template image itself, in the colour of the menu bar: a black mark with the
// shape of the whale.
const TRAY_TEMPLATE_SIZES = [16, 32]
const WHALE_INK = '#4D6BFE'

// The whale's body spans x 4..95.9 and y 20.9..79 of its 100 box.
const WHALE = { cx: 49.95, cy: 49.95, width: 91.9 }

// A superellipse close to the system's rounded-square app tile.
function tile(size, inset) {
  const radius = (size - 2 * inset) / 2
  const center = size / 2
  const points = []
  for (let i = 0; i < 128; i += 1) {
    const angle = (i / 128) * Math.PI * 2
    const at = value => Math.sign(value) * Math.abs(value) ** 0.4
    points.push(`${(center + radius * at(Math.cos(angle))).toFixed(2)} ${(center + radius * at(Math.sin(angle))).toFixed(2)}`)
  }
  return `M${points.join('L')}Z`
}

// `plate`: the tile's share of the canvas. macOS wants a margin around the tile; Windows
// draws its icons nearly edge to edge, so its sizes use a fuller tile.
function iconSvg(plate, size = 1024) {
  const inset = (size * (1 - plate)) / 2
  const whaleWidth = (size - 2 * inset) * 0.85
  const scale = whaleWidth / WHALE.width
  // The head carries the weight, so the whale sits a little left of and above center.
  const x = size / 2 - WHALE.cx * scale - whaleWidth * 0.015
  const y = size / 2 - WHALE.cy * scale - whaleWidth * 0.018
  const path = tile(size, inset)
  const whale = characterMarkup('whale', 'deepseek').replaceAll(MASK_ID, 'eyes').replaceAll('var(--bt-ink-deepseek)', WHALE_INK)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef1f7"/></linearGradient>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${size * 0.012}" stdDeviation="${size * 0.012}" flood-color="#000" flood-opacity=".22"/></filter>
</defs>
<path d="${path}" fill="url(#plate)" filter="url(#shadow)"/>
<path d="${path}" fill="none" stroke="rgba(20,20,40,.1)" stroke-width="${size * 0.004}"/>
<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})">${whale}</g>
</svg>
`
}

// The tray mark: the whale alone, so that it still reads at the size of a tray icon. The
// macOS template is the same shape in black, because macOS paints it in the colour of the
// menu bar itself.
function traySvg(size, ink) {
  const whaleWidth = size * 0.94
  const scale = whaleWidth / WHALE.width
  const x = size / 2 - WHALE.cx * scale - whaleWidth * 0.015
  const y = size / 2 - WHALE.cy * scale - whaleWidth * 0.018
  const whale = characterMarkup('whale', 'deepseek').replaceAll(MASK_ID, 'eyes').replaceAll('var(--bt-ink-deepseek)', ink)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})">${whale}</g>
</svg>
`
}

// PNG entries in an .ico file, which Windows reads since Vista.
function icoFile(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(image => image.png)])
}

// Inside Electron: a page draws each SVG on a canvas of its exact size, so every size is
// drawn from the vectors rather than scaled down from a large bitmap.
async function renderInElectron(jobs) {
  const { BrowserWindow } = await import('electron')
  const page = new BrowserWindow({ show: false })
  await page.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const draw = async (list) => Promise.all(list.map(async ({ svg, size }) => {
    const image = new Image()
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d').drawImage(image, 0, 0, size, size)
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }))
  const pngs = await page.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(jobs)})`)
  page.destroy()
  return pngs.map(data => Buffer.from(data, 'base64'))
}

if (process.versions.electron) {
  const jobs = [
    { svg: iconSvg(0.805), size: 1024 },
    ...ICO_SIZES.map(size => ({ svg: iconSvg(0.92, size), size })),
    ...TRAY_ICO_SIZES.map(size => ({ svg: traySvg(size, WHALE_INK), size })),
    { svg: traySvg(TRAY_PNG_SIZE, WHALE_INK), size: TRAY_PNG_SIZE },
    ...TRAY_TEMPLATE_SIZES.map(size => ({ svg: traySvg(size, '#000000'), size })),
  ]
  // Not awaited at the top: Electron is ready only after the main module has run.
  const { app } = await import('electron')
  app.whenReady().then(() => renderInElectron(jobs)).then(([large, ...rest]) => {
    const small = rest.slice(0, ICO_SIZES.length)
    const tray = rest.slice(ICO_SIZES.length)
    writeFileSync(join(assets, 'icon.png'), large)
    writeFileSync(join(assets, 'icon.ico'), icoFile(ICO_SIZES.map((size, index) => ({ size, png: small[index] }))))
    writeFileSync(join(assets, 'tray.ico'), icoFile(TRAY_ICO_SIZES.map((size, index) => ({ size, png: tray[index] }))))
    writeFileSync(join(assets, 'tray.png'), tray[TRAY_ICO_SIZES.length])
    writeFileSync(join(assets, 'trayTemplate.png'), tray[TRAY_ICO_SIZES.length + 1])
    writeFileSync(join(assets, 'trayTemplate@2x.png'), tray[TRAY_ICO_SIZES.length + 2])
    app.exit(0)
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'icon.svg'), iconSvg(0.805))
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which would keep Electron plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const electron = createRequire(import.meta.url)('electron')
  const run = spawnSync(electron, [here], { stdio: 'inherit', env })
  if (run.status !== 0) process.exit(run.status ?? 1)
  console.log('icon: wrote assets/icon.svg, assets/icon.png, assets/icon.ico and the tray marks')
}
