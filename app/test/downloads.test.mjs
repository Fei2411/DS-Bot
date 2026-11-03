// The main window's will-download handler: the download starts into a staging folder at once,
// the app's own picker says where it goes, and the file moves there when both are in. A
// cancelled picker cancels it; other contents' downloads pass through. Temp folders only.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { downloadSaver, freePath } from '../src/downloads.mjs'

const top = mkdtempSync(join(tmpdir(), 'ds-bot-downloads-'))
after(() => { rmSync(top, { recursive: true, force: true }) })
let runs = 0
const place = () => {
  runs += 1
  const at = join(top, String(runs))
  const downloads = join(at, 'downloads')
  mkdirSync(downloads, { recursive: true })
  return { staging: join(at, 'staging'), downloads, home: join(at, 'home') }
}

// A download item: it writes its bytes to the save path when it is done.
function item(name = 'chart.png') {
  const download = Object.assign(new EventEmitter(), {
    path: undefined, cancelled: false,
    getFilename: () => name,
    setSavePath(path) { this.path = path },
    cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled') },
    finish(text = 'bytes') {
      if (this.cancelled) return
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, text)
      this.emit('done', {}, 'completed')
    },
  })
  return download
}
const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
const settle = () => new Promise(resolve => setImmediate(resolve))
const until = async (check) => { for (let turn = 0; turn < 50 && !check(); turn += 1) await settle() }

function saver(at, ask, extra = {}) {
  const contents = {}
  const save = downloadSaver({ window: { webContents: contents }, ask, staging: () => at.staging, getPath: name => ({ downloads: at.downloads, home: at.home })[name], log: { warn: () => {} }, ...extra })
  return { contents, save }
}

test('a download starts at once, asks where it goes, and lands there when both are in', async () => {
  const at = place()
  const asked = []
  let answer
  const { contents, save } = saver(at, (name, folder) => { asked.push({ name, folder }); return new Promise((resolve) => { answer = resolve }) })
  const ev = event()
  const download = item()
  save(ev, download, contents)
  assert.equal(ev.prevented, false)
  assert.ok(download.path.startsWith(at.staging), 'it saves into the staging folder first')
  assert.deepEqual(asked, [{ name: 'chart.png', folder: at.downloads }], 'the picker starts in the downloads folder')
  // The download is done before the user has answered.
  download.finish('png')
  const target = join(at.downloads, 'picked.png')
  answer(target)
  await until(() => existsSync(target))
  assert.equal(readFileSync(target, 'utf8'), 'png')
  await until(() => readdirSync(at.staging).length === 0)
  assert.deepEqual(readdirSync(at.staging), [], 'the staging folder is cleared')
})

test('an answer before the download is done waits for it', async () => {
  const at = place()
  const target = join(at.downloads, 'early.png')
  const { contents, save } = saver(at, async () => target)
  const download = item()
  save(event(), download, contents)
  await settle()
  assert.equal(existsSync(target), false)
  download.finish('late')
  await until(() => existsSync(target))
  assert.equal(readFileSync(target, 'utf8'), 'late')
})

test('a cancelled picker cancels the download and leaves nothing behind', async () => {
  const at = place()
  const { contents, save } = saver(at, async () => null)
  const download = item()
  save(event(), download, contents)
  await until(() => download.cancelled)
  assert.equal(download.cancelled, true)
  await until(() => readdirSync(at.staging).length === 0)
  assert.deepEqual(readdirSync(at.downloads), [])
  assert.deepEqual(readdirSync(at.staging), [])
})

test('a picker that cannot be shown saves into the downloads folder under a free name', async () => {
  const at = place()
  writeFileSync(join(at.downloads, 'chart.png'), 'old')
  const { contents, save } = saver(at, async () => undefined)
  const download = item()
  save(event(), download, contents)
  download.finish('new')
  const target = join(at.downloads, 'chart (2).png')
  await until(() => existsSync(target))
  assert.equal(readFileSync(target, 'utf8'), 'new')
  assert.equal(readFileSync(join(at.downloads, 'chart.png'), 'utf8'), 'old', 'the old file stays')
})

test('a replace that the picker allowed overwrites the old file', async () => {
  const at = place()
  const target = join(at.downloads, 'chart.png')
  writeFileSync(target, 'old')
  const { contents, save } = saver(at, async () => target)
  const download = item()
  save(event(), download, contents)
  download.finish('new')
  await until(() => readFileSync(target, 'utf8') === 'new')
  assert.equal(readFileSync(target, 'utf8'), 'new')
})

test('a server name cannot reach outside the staging folder', () => {
  const at = place()
  const { contents, save } = saver(at, () => new Promise(() => {}))
  const download = item('../../evil.txt')
  save(event(), download, contents)
  assert.equal(dirname(dirname(download.path)), at.staging)
})

test('a free name counts up past the taken ones', () => {
  const at = place()
  writeFileSync(join(at.downloads, 'a.txt'), '')
  writeFileSync(join(at.downloads, 'a (2).txt'), '')
  assert.equal(freePath(at.downloads, 'a.txt'), join(at.downloads, 'a (3).txt'))
  assert.equal(freePath(at.downloads, 'b'), join(at.downloads, 'b'))
})

test('the downloads folder is looked up for each download; a missing one falls back to home', () => {
  const at = place()
  const asked = []
  const folders = []
  const contents = {}
  const save = downloadSaver({
    window: { webContents: contents }, ask: (_name, folder) => { folders.push(folder); return new Promise(() => {}) },
    staging: () => at.staging, homedir: () => '/os-home', log: { warn: () => {} },
    getPath: (name) => { asked.push(name); if (name === 'downloads') throw new Error('no downloads'); return at.home },
  })
  assert.deepEqual(asked, [])
  save(event(), item(), contents)
  save(event(), item(), contents)
  assert.deepEqual(asked, ['downloads', 'home', 'downloads', 'home'])
  assert.deepEqual(folders, [at.home, at.home])
})

test('a download from another contents, or without a window, passes through', () => {
  const at = place()
  let asked = false
  const ask = () => { asked = true; return Promise.resolve(null) }
  const other = saver(at, ask)
  const ev = event()
  const download = item()
  other.save(ev, download, { other: true })
  const none = downloadSaver({ window: () => undefined, ask, staging: () => at.staging, getPath: () => at.home })
  none(ev, download, {})
  assert.equal(asked, false)
  assert.equal(download.path, undefined)
  assert.equal(ev.prevented, false)
})

test('the window is asked for at the moment of the download, because the app may build a new one', () => {
  const at = place()
  const contents = {}
  let asked = 0
  let window = { webContents: {} }
  const save = downloadSaver({ window: () => window, ask: () => { asked += 1; return new Promise(() => {}) }, staging: () => at.staging, getPath: () => at.downloads })
  window = { webContents: contents }
  save(event(), item(), contents)
  assert.equal(asked, 1)
})
