import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(plugin, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const { outputFiles } = await build({
  entryPoints: [join(plugin, 'src/client/sidebar-resize.js')], bundle: true,
  format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

function fixture({ mode = 'open', width = 280, viewport = 1280, reduced = false, collapsedWidth = 56 } = {}) {
  const { window } = new JSDOM('<div class="test_centerCol" style="transition:opacity 1s"></div><div class="bt-leftcol"><div class="bt-side"></div><div class="bt-leftcol-grip"></div></div>')
  window.innerWidth = viewport
  window.matchMedia = () => ({ matches: reduced })
  const frames = new Map()
  let frame = 0
  const requestAnimationFrame = fn => { frames.set(++frame, fn); return frame }
  const cancelAnimationFrame = id => frames.delete(id)
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: () => ({}), window, document: window.document,
    CSS: { escape: s => s }, requestAnimationFrame, cancelAnimationFrame,
  })
  const column = window.document.querySelector('.bt-leftcol')
  const grip = column.lastElementChild
  const chat = window.document.querySelector('.test_centerCol')
  column.style.width = `${width}px`
  column.getBoundingClientRect = () => ({ width: parseFloat(column.style.width) })
  column.firstElementChild.getBoundingClientRect = () => ({ width: parseFloat(column.style.width) })
  grip.setPointerCapture = () => {}
  grip.hasPointerCapture = () => true
  grip.releasePointerCapture = () => {}
  const animations = []
  column.animate = (keys, options) => {
    let finish
    const animation = { finished: new Promise(resolve => { finish = resolve }), cancel() { this.cancelled = true }, finish, keys, options }
    animation.finish = finish
    animations.push(animation)
    return animation
  }
  const previews = [], commits = [], done = []
  const dispose = module.exports.startSidebarResize({ button: 0, pointerId: 1, currentTarget: grip, preventDefault() {} }, {
    mode, width, collapsedWidth,
    onPreview: next => previews.push({ ...next }), onCommit: next => commits.push({ ...next }), onDone: () => done.push(true),
  })
  const event = (type, x, pointerId = 1) => {
    const event = new window.Event(type)
    Object.assign(event, { clientX: x, pointerId })
    grip.dispatchEvent(event)
  }
  return { window, column, grip, chat, animations, previews, commits, done, dispose, event, frames }
}

test('ordinary resize writes the columns directly without rendering each width', () => {
  const f = fixture()
  for (const x of [290, 310, 340]) f.event('pointermove', x)
  assert.equal(f.column.style.width, '340px')
  assert.equal(f.chat.style.marginLeft, '284px')
  assert.equal(f.previews.length, 0)
  assert.equal(f.animations.length, 0)
  f.event('pointerup', 355)
  assert.deepEqual(f.commits, [{ left: 'open', width: 355 }])
  assert.equal(f.chat.style.marginLeft, '')
  assert.equal(f.chat.style.transition, 'opacity 1s')
  assert.equal(f.done.length, 1)
  f.event('pointermove', 400)
  assert.equal(f.column.style.width, '355px')
})

test('fold animates the surface, holds content and chat until it lands, including release mid-snap', async () => {
  const f = fixture()
  f.event('pointermove', 300)
  f.event('pointermove', 175)
  assert.deepEqual(f.previews, [{ left: 'rail', width: 88 }])
  assert.equal(f.animations.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(f.animations[0].keys)), [{ width: '300px' }, { width: '88px' }])
  assert.equal(f.chat.style.marginLeft, '244px')
  assert.equal(f.column.style.getPropertyValue('--bt-resize-content'), '88px')
  f.event('pointermove', 100)
  f.event('pointerup', 100)
  assert.equal(f.done.length, 0)
  f.animations[0].finish()
  await Promise.resolve()
  assert.equal(f.done.length, 1)
  assert.equal(f.column.style.getPropertyValue('--bt-resize-content'), '')
  assert.equal(f.chat.style.marginLeft, '')
  assert.equal(f.chat.style.transition, 'opacity 1s')
  assert.deepEqual(f.commits, [{ left: 'rail', width: 88 }])
})

test('expansion reserves chat space first and reversal cancels stale animations', async () => {
  const f = fixture({ mode: 'rail', width: 88 })
  f.event('pointermove', 190)
  assert.equal(f.chat.style.marginLeft, '208px')
  f.event('pointermove', 175)
  assert.equal(f.animations[0].cancelled, true)
  f.animations[0].finish()
  await Promise.resolve()
  assert.equal(f.column.style.getPropertyValue('--bt-resize-content'), '88px')
  f.event('pointerup', 170)
  f.animations.at(-1).finish()
  await Promise.resolve()
  assert.deepEqual(f.commits, [{ left: 'rail', width: 88 }])
  assert.equal(f.done.length, 1)
})

test('reduced motion snaps immediately and a narrow drawer leaves the chat in place', () => {
  const f = fixture({ viewport: 600, reduced: true })
  f.event('pointermove', 175)
  f.event('pointermove', 300)
  assert.equal(f.animations.length, 0)
  assert.equal(f.chat.style.marginLeft, '32px')
  f.event('pointerup', 300)
  assert.deepEqual(f.commits, [{ left: 'drawer', width: 300 }])
  assert.equal(f.done.length, 1)
})

for (const end of ['pointercancel', 'lostpointercapture']) {
  test(`${end} commits the last valid position only once and ignores other pointers`, () => {
    const f = fixture()
    f.event('pointermove', 400, 2)
    f.event(end, 400, 2)
    f.event('pointermove', 320)
    f.event(end, 0)
    f.event('pointerup', 400)
    assert.deepEqual(f.commits, [{ left: 'open', width: 320 }])
    assert.equal(f.done.length, 1)
  })
}

test('dispose removes capture/listeners and inline overrides without committing on unmount', async () => {
  const f = fixture()
  f.event('pointermove', 170)
  f.dispose()
  f.animations[0].finish()
  await Promise.resolve()
  f.event('pointerup', 350)
  assert.equal(f.commits.length, 0)
  assert.equal(f.done.length, 0)
  assert.equal(f.chat.style.marginLeft, '')
  assert.equal(f.chat.style.transition, 'opacity 1s')
  assert.equal(f.column.style.width, '280px')
})

test('a click without movement and a cancelled untouched drag do not change preferences', () => {
  const f = fixture()
  f.event('pointercancel', 0)
  assert.equal(f.commits.length, 0)
  assert.equal(f.done.length, 1)
})

test('moving beyond the expansion snap resumes direct tracking and ignores its stale finish', async () => {
  const f = fixture({ mode: 'rail', width: 88 })
  f.event('pointermove', 200)
  f.event('pointermove', 360)
  assert.equal(f.animations[0].cancelled, true)
  assert.equal(f.column.style.width, '360px')
  assert.equal(f.chat.style.marginLeft, '304px')
  f.animations[0].finish()
  await Promise.resolve()
  assert.equal(f.chat.style.marginLeft, '304px')
  assert.deepEqual(f.previews, [{ left: 'open', width: 264 }])
  f.event('pointerup', 380)
  assert.deepEqual(f.commits, [{ left: 'open', width: 380 }])
})

test('pointerup uses its final coordinate even without a preceding move', async () => {
  const f = fixture()
  f.event('pointerup', 150)
  assert.deepEqual(f.commits, [{ left: 'rail', width: 88 }])
  assert.equal(f.done.length, 0)
  f.animations[0].finish()
  await Promise.resolve()
  assert.equal(f.done.length, 1)
})

test('unmount after release discards the pending snap completion', async () => {
  const f = fixture()
  f.event('pointerup', 150)
  f.dispose()
  f.animations[0].finish()
  await Promise.resolve()
  assert.equal(f.commits.length, 1)
  assert.equal(f.done.length, 0)
  assert.equal(f.chat.style.transition, 'opacity 1s')
  assert.equal(f.column.style.getPropertyValue('--bt-resize-content'), '')
})

test('ordinary movement does not rewrite the chat stylesheet until release', () => {
  const f = fixture()
  const rule = () => [...f.window.document.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule => rule.selectorText === '.test_centerCol')
  for (const x of [300, 320, 330]) {
    f.event('pointermove', x)
    assert.equal(rule().style.getPropertyValue('margin-left'), '')
  }
  f.event('pointerup', 350)
  assert.equal(rule().style.getPropertyValue('margin-left'), '294px')
})
