// The app's own picker in place of the system's: what main lists and checks (folder-picker.mjs),
// and the IPC that only the page showing a picker may use (picker-host.mjs). Temp folders only.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { after, test } from 'node:test'
import { crumbs, list, makeFolder, nameOk, roots, saveTarget, startIn, typed } from '../src/folder-picker.mjs'
import { PICKER_IPC, Pickers } from '../src/picker-host.mjs'

const top = mkdtempSync(join(tmpdir(), 'ds-bot-picker-'))
after(() => { rmSync(top, { recursive: true, force: true }) })
const folder = (...parts) => { const path = join(top, ...parts); mkdirSync(path, { recursive: true }); return path }
const file = (path, text = '') => { writeFileSync(path, text); return path }

test('a folder lists its folders first, each sorted as people read numbers, and hides hidden ones', async () => {
  const at = folder('sorted')
  for (const name of ['b', 'a10', 'a2', '.git', '$Recycle.Bin']) folder('sorted', name)
  file(join(at, 'z.txt'))
  file(join(at, 'c.json'))
  file(join(at, '.env'))
  const folders = await list(at)
  assert.deepEqual(folders.entries.map(entry => entry.name), ['a2', 'a10', 'b'], 'folders only, in reading order')
  assert.equal(folders.path, at)
  assert.equal(folders.parent, join(top))
  const all = await list(at, { files: true })
  assert.deepEqual(all.entries.map(entry => `${entry.name}${entry.dir ? '/' : ''}`), ['a2/', 'a10/', 'b/', 'c.json', 'z.txt'])
  const json = await list(at, { files: true, extensions: ['JSON'] })
  assert.deepEqual(json.entries.filter(entry => !entry.dir).map(entry => entry.name), ['c.json'])
})

test('the breadcrumb runs from the root down to the folder', () => {
  const path = join(top, 'one', 'two')
  const steps = crumbs(path)
  assert.equal(steps[0].path, parse(path).root)
  assert.deepEqual(steps.slice(-2).map(step => step.name), ['one', 'two'])
  assert.equal(steps.at(-1).path, path)
})

test('a folder that is gone, a file and a missing drive are answers, not throws', async () => {
  assert.equal((await list(join(top, 'nowhere'))).error, 'missing')
  assert.equal((await list(file(join(folder('plain'), 'note.txt')))).error, 'notFolder')
  if (process.platform === 'win32') {
    // A letter that no machine of the tests has: the drive is gone, not the folder.
    const free = [...'QRSTUVWXYZ'].map(letter => `${letter}:\\`).reverse()
    const { drives } = await roots({ getPath: () => top, platform: 'win32' })
    const missing = free.find(path => !drives.some(drive => drive.path === path))
    assert.equal((await list(join(missing, 'data'))).error, 'drive')
  }
})

test('a Windows long path lists like any other', { skip: process.platform !== 'win32' }, async () => {
  const deep = join(top, ...Array.from({ length: 14 }, (_value, index) => `a-rather-long-folder-name-${String(index)}`))
  mkdirSync(deep, { recursive: true })
  assert.ok(deep.length > 260)
  file(join(deep, 'inside.txt'))
  const listing = await list(deep, { files: true })
  assert.equal(listing.error, undefined)
  assert.deepEqual(listing.entries.map(entry => entry.name), ['inside.txt'])
})

test('a new folder is made once, and a bad or taken name says why', async () => {
  const at = folder('fresh')
  const made = await makeFolder(at, 'Reports')
  assert.equal(made.path, join(at, 'Reports'))
  assert.deepEqual(await makeFolder(at, 'Reports'), { error: 'exists' })
  assert.deepEqual(await makeFolder(at, '   '), { error: 'name' })
  assert.deepEqual(await makeFolder(at, 'a/b'), { error: 'name' })
  assert.deepEqual(await makeFolder(join(at, 'gone', 'deeper'), 'x'), { error: 'missing' })
})

test('Windows names keep to what Windows allows', () => {
  for (const bad of ['con', 'NUL.txt', 'a:b', 'what?', 'ends.', 'ends ', 'a\\b']) assert.equal(nameOk(bad, 'win32'), false, bad)
  for (const good of ['Reports', 'chart (2).png', '数据']) assert.equal(nameOk(good, 'win32'), true, good)
  assert.equal(nameOk('con', 'linux'), true)
})

test('a save into a taken name asks first; a folder of that name is no file', async () => {
  const at = folder('save')
  assert.deepEqual(await saveTarget(at, 'chart.png'), { path: join(at, 'chart.png') })
  file(join(at, 'chart.png'), 'old')
  assert.deepEqual(await saveTarget(at, 'chart.png'), { path: join(at, 'chart.png'), exists: true })
  folder('save', 'report')
  assert.deepEqual(await saveTarget(at, 'report'), { error: 'isFolder' })
  assert.deepEqual(await saveTarget(join(at, 'gone'), 'chart.png'), { error: 'missing' })
})

test('a typed path: ~ is home, a relative one starts where the picker is', () => {
  assert.equal(typed('~', top, '/home/me'), join('/home/me'))
  assert.equal(typed(' "sub" ', top, '/home/me'), join(top, 'sub'))
  assert.equal(typed(top, '/elsewhere', '/home/me'), top)
})

test('a picker opens in the nearest folder that exists', async () => {
  const at = folder('start')
  assert.equal(await startIn(join(at, 'not', 'yet')), at)
  assert.equal(await startIn(undefined, at), at)
})

// The IPC: the page that shows the picker lists, makes folders and answers; nobody else.
function host() {
  const handlers = new Map()
  const ipcMain = { handle: (channel, run) => { handlers.set(channel, run) }, on: (channel, run) => { handlers.set(channel, run) } }
  const pickers = new Pickers({ ipcMain, getPath: () => top, shownMs: 50 })
  const page = Object.assign(new EventEmitter(), { sent: [], isDestroyed: () => false, isLoading: () => false })
  page.send = (...args) => { page.sent.push(args) }
  const as = sender => ({ sender })
  const call = (channel, sender, ...args) => handlers.get(channel)(as(sender), ...args)
  return { pickers, page, call, request: () => page.sent.at(-1)[1] }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const opened = async (page) => { while (page.sent.length === 0) await tick() }

test('the page that shows a folder picker lists, makes a folder and chooses it', async () => {
  const { pickers, page, call, request } = host()
  const at = folder('ipc')
  const answer = pickers.ask(page, { mode: 'folder', title: 'Pick', start: join(at, 'missing'), labels: {} })
  await opened(page)
  const { id, start } = request()
  assert.equal(start, at, 'it opens where the folder would be')
  call(PICKER_IPC.shown, page, id)
  const made = await call(PICKER_IPC.folder, page, id, at, 'New')
  assert.equal(made.path, join(at, 'New'))
  const listing = await call(PICKER_IPC.list, page, id, 'New', at)
  assert.equal(listing.path, join(at, 'New'), 'a relative path starts at the folder shown')
  const roots = await call(PICKER_IPC.roots, page, id)
  assert.ok(Array.isArray(roots.drives) && roots.drives.length > 0)
  assert.deepEqual(await call(PICKER_IPC.choose, page, id, file(join(at, 'f.txt'))), { error: 'notFolder' })
  assert.deepEqual(await call(PICKER_IPC.choose, page, id, made.path), { path: made.path })
  assert.equal(await answer, made.path)
  assert.equal(await call(PICKER_IPC.list, page, id, at), undefined, 'a closed picker lists nothing')
})

test('another page gets nothing from a picker it does not show', async () => {
  const { pickers, page, call, request } = host()
  const answer = pickers.ask(page, { mode: 'folder', title: 'Pick', start: top, labels: {} })
  await opened(page)
  const { id } = request()
  call(PICKER_IPC.shown, page, id)
  const other = new EventEmitter()
  assert.equal(await call(PICKER_IPC.list, other, id, top), undefined)
  assert.equal(await call(PICKER_IPC.folder, other, id, top, 'x'), undefined)
  assert.equal(await call(PICKER_IPC.choose, other, id, top), undefined)
  call(PICKER_IPC.cancel, page, id)
  assert.equal(await answer, null, 'a cancel is null')
})

test('a save picker asks before it replaces, and answers once replace is said', async () => {
  const { pickers, page, call, request } = host()
  const at = folder('clash')
  file(join(at, 'chart.png'), 'old')
  const answer = pickers.ask(page, { mode: 'save', title: 'Save', start: at, name: 'chart.png', labels: {} })
  await opened(page)
  const { id, name } = request()
  assert.equal(name, 'chart.png')
  call(PICKER_IPC.shown, page, id)
  assert.deepEqual(await call(PICKER_IPC.choose, page, id, at, { name: 'chart.png' }), { path: join(at, 'chart.png'), exists: true })
  assert.deepEqual(await call(PICKER_IPC.choose, page, id, at, { name: 'bad:name' }), process.platform === 'win32' ? { error: 'name' } : { path: join(at, 'bad:name') })
  if (process.platform === 'win32') assert.deepEqual(await call(PICKER_IPC.choose, page, id, at, { name: 'chart.png', replace: true }), { path: join(at, 'chart.png') })
  assert.equal(await answer, join(at, process.platform === 'win32' ? 'chart.png' : 'bad:name'))
})

test('a page that does not show the picker in time gets no answer to wait for', async () => {
  const { pickers, page } = host()
  assert.equal(await pickers.ask(page, { mode: 'folder', title: 'Pick', start: top, labels: {} }), undefined)
  const loading = Object.assign(new EventEmitter(), { isDestroyed: () => false, isLoading: () => true, send() {} })
  assert.equal(await pickers.ask(loading, { mode: 'folder', title: 'Pick', labels: {} }), undefined)
})

// A long drive or folder name in the side column ends in an ellipsis: the name is its own box,
// for an ellipsis does not reach bare text beside the glyph in the button's flex row.
test('a place or drive with a long name is cut with an ellipsis, and its title keeps the whole path', () => {
  const src = new URL('../src/', import.meta.url)
  const preload = readFileSync(new URL('preload.cjs', src), 'utf8')
  const side = preload.slice(preload.indexOf("button('dsb-picker-root"), preload.indexOf("root.addEventListener('click'"))
  assert.match(side, /button\('dsb-picker-root'\)/u, 'no bare label in the button')
  assert.match(side, /root\.append\(make\('span', 'dsb-picker-root-name', item\.label\)\)/u, 'the name in a span of its own')
  assert.match(side, /root\.title = item\.path/u, 'the whole path on hover')
  const css = readFileSync(new URL('page-card.css', src), 'utf8')
  const rule = css.match(/\.dsb-picker-root-name\{([^}]*)\}/u)?.[1].split(';') ?? []
  for (const declaration of ['min-width:0', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) assert.ok(rule.includes(declaration), declaration)
})
