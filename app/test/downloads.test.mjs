// The main window's will-download handler: the download starts into a staging folder at once,
// the app's own picker says where it goes, and the file moves there when both are in. A
// cancelled picker cancels it; other contents' downloads pass through. Temp folders only.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { downloadSaver, freePath, move } from '../src/downloads.mjs'

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

test('a download whose chosen path cannot be written lands in the downloads folder instead', async () => {
  const at = place()
  const target = join(at.home, 'missing', 'picked.png')
  const warnings = []
  const { contents, save } = saver(at, async () => target, { log: { warn: line => warnings.push(line) } })
  const download = item()
  save(event(), download, contents)
  download.finish('png')
  const fallback = join(at.downloads, 'chart.png')
  await until(() => existsSync(fallback))
  assert.equal(readFileSync(fallback, 'utf8'), 'png')
  assert.ok(warnings.some(line => line.includes(target) && line.includes(fallback)), 'the warning names both paths')
  await until(() => readdirSync(at.staging).length === 0)
  assert.deepEqual(readdirSync(at.staging), [], 'the staging folder is cleared once the file is placed')
})

test('a download that can go nowhere keeps its staged file', async () => {
  const at = place()
  rmSync(at.downloads, { recursive: true })
  writeFileSync(at.downloads, 'not a folder')
  const warnings = []
  const { contents, save } = saver(at, async () => join(at.home, 'missing', 'picked.png'), { log: { warn: line => warnings.push(line) } })
  const download = item()
  save(event(), download, contents)
  download.finish('png')
  await until(() => warnings.length > 0)
  assert.ok(warnings.some(line => line.includes(download.path)), 'the warning names the staged file')
  assert.equal(readFileSync(download.path, 'utf8'), 'png', 'the staged file stays whole')
})

test('a cross-drive move copies next to the target, then takes its name', () => {
  const at = place()
  const staged = join(at.staging, 'held', 'chart.png')
  mkdirSync(dirname(staged), { recursive: true })
  writeFileSync(staged, 'new')
  const target = join(at.downloads, 'chart.png')
  writeFileSync(target, 'old')
  const fs = {
    renameSync(from, to) {
      if (from === staged) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
      renameSync(from, to)
    },
    copyFileSync,
    rmSync,
  }
  move(staged, target, fs)
  assert.equal(readFileSync(target, 'utf8'), 'new')
  assert.deepEqual(readdirSync(at.downloads), ['chart.png'], 'no temp file is left next to the target')
})

test('a cross-drive move whose copy fails leaves the old file and the staged file alone', () => {
  const at = place()
  const staged = join(at.staging, 'held', 'chart.png')
  mkdirSync(dirname(staged), { recursive: true })
  writeFileSync(staged, 'new')
  const target = join(at.downloads, 'chart.png')
  writeFileSync(target, 'old')
  const fs = {
    renameSync() { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }) },
    copyFileSync(_from, to) { writeFileSync(to, 'partial'); throw new Error('no space left on device') },
    rmSync,
  }
  assert.throws(() => move(staged, target, fs), /no space left/)
  assert.equal(readFileSync(target, 'utf8'), 'old', 'the old file is not truncated')
  assert.deepEqual(readdirSync(at.downloads), ['chart.png'], 'the failed temp file is removed')
  assert.equal(readFileSync(staged, 'utf8'), 'new', 'the staged copy stays')
})

test('two downloads of one name without a picker each keep their own file', async () => {
  const at = place()
  const { contents, save } = saver(at, async () => undefined)
  const first = item('chart.png')
  const second = item('chart.png')
  save(event(), first, contents)
  save(event(), second, contents)
  first.finish('one')
  second.finish('two')
  const names = [join(at.downloads, 'chart.png'), join(at.downloads, 'chart (2).png')]
  await until(() => names.every(existsSync))
  const texts = names.map(name => readFileSync(name, 'utf8')).sort()
  assert.deepEqual(texts, ['one', 'two'], 'each download kept its own bytes')
})
