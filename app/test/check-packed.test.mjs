import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../scripts/check-packed.mjs', import.meta.url), 'utf8')
const chatSource = source.slice(source.indexOf('async function chat(cdp)'), source.indexOf('async function checkComputerHelper('))

// delivery says what the page does with the Enter press:
//   sent      the press sends the message
//   second    the first press is dropped, the second sends
//   unfocused the window starts without focus until the mouse click lands on the composer
//   dropped   the press never reaches the page
//   composing an IME owns the key, so the press sends nothing
//   busy      the first press disables the send button while sending
// mode: 'contenteditable' (DSH legacy) or 'textarea' (DS Bot own-frontend composer).
async function runChat(delivery, mode = 'textarea') {
  let now = 0
  let reply = ''
  let presses = 0
  let clicks = 0
  let focused = delivery !== 'unfocused'
  const keys = []
  const timers = []
  const listeners = new Map()
  const button = { disabled: true, getAttribute: () => 'Send message' }
  const field = mode === 'textarea'
    ? {
      tagName: 'TEXTAREA', isContentEditable: false, value: '', innerText: '',
      hasAttribute: () => false, querySelector: () => null,
      contains: node => node === field,
      getBoundingClientRect: () => ({ x: 100, y: 500, width: 400, height: 40, toJSON: () => ({ x: 100, y: 500, width: 400, height: 40 }) }),
      parentElement: { querySelector: () => button },
    }
    : {
      tagName: 'DIV', isContentEditable: true, innerText: '',
      hasAttribute: () => false, querySelector: () => null,
      contains: node => node === field,
      getBoundingClientRect: () => ({ x: 100, y: 500, width: 400, height: 40, toJSON: () => ({ x: 100, y: 500, width: 400, height: 40 }) }),
      parentElement: { querySelector: () => button },
    }
  const control = { click() {} }
  const document = {
    activeElement: field, visibilityState: 'visible', hasFocus: () => focused,
    elementFromPoint: () => field,
    body: { get innerText() { return '先让团队帮你做哪块 ' + (mode === 'textarea' ? '' : field.innerText) + ' ' + reply } },
    querySelector: selector => selector === '[role=listbox]' ? null : control,
    querySelectorAll: selector => selector === '[role=dialog] button' ? [] : [field],
  }
  const page = createContext({
    document, performance: { now: () => now }, setTimeout: callback => timers.push(callback),
    fetch: async () => ({ json: async () => ({ value: { mainBotId: 'chief' } }) }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800,
    screen: { width: 1280, height: 800 }, devicePixelRatio: 1,
  })
  page.window = page
  const chat = runInNewContext(chatSource + '\nchat', {
    Date: { now: () => now }, sleep: async ms => { now += ms },
    frameSheets: [], process: { platform: 'linux' }, console: { log() {} },
  })
  const error = await chat({ call: async (method, params = {}) => {
    if (method === 'Runtime.enable' || method === 'Log.enable' || method === 'Page.bringToFront') return {}
    if (method === 'Runtime.evaluate') return { result: { value: await runInContext(params.expression, page) } }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mouseReleased') { clicks += 1; focused = true }
      return {}
    }
    if (method === 'Input.insertText') {
      assert.equal(focused, true, 'must not insert text before the window holds focus')
      assert.ok(clicks >= 1, 'must click through the input pipeline before typing even if bare focus() held')
      if (mode === 'textarea') field.value = params.text
      else field.innerText = params.text
      button.disabled = false
      return {}
    }
    assert.equal(method, 'Input.dispatchKeyEvent', 'the check must send through the keyboard')
    keys.push(params)
    const type = params.type === 'keyDown' ? 'keydown' : 'keyup'
    if (type === 'keydown') presses += 1
    if (delivery === 'dropped' || (delivery === 'second' && presses < 2)) return {}
    const event = {
      type, key: params.key, code: params.code, keyCode: params.windowsVirtualKeyCode,
      target: field, isComposing: delivery === 'composing', repeat: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false,
    }
    listeners.get(type)?.(event)
    if (type === 'keydown') {
      event.defaultPrevented = true
      if (delivery === 'sent' || delivery === 'unfocused' || (delivery === 'second' && presses >= 2)) {
        if (mode === 'textarea') field.value = ''
        else field.innerText = ''
        reply = '收到：packaged app check'
      }
      if (delivery === 'busy') button.disabled = true
    }
    for (const callback of timers.splice(0)) callback()
    return {}
  } }).then(() => undefined, error => error)
  return { error, keys, presses, clicks, trace: page.__packedEnter }
}

test('even when bare JS focus already reports true, chat clicks the composer once through the input pipeline and sends on Enter', async () => {
  const { error, keys, presses, clicks } = await runChat('sent')
  assert.equal(error, undefined)
  assert.equal(clicks, 1)
  assert.deepEqual(keys.map(key => key.type), ['keyDown', 'keyUp'])
  assert.equal(presses, 1)
})

test('an unfocused window is clicked through the input pipeline until document.hasFocus() holds before typing', async () => {
  const { error, presses, clicks } = await runChat('unfocused')
  assert.equal(error, undefined)
  assert.equal(clicks, 1)
  assert.equal(presses, 1)
})

test('a dropped Enter under Xvfb re-focuses and sends on the second press, without re-pressing an in-flight send', async () => {
  const second = await runChat('second')
  assert.equal(second.error, undefined)
  assert.equal(second.presses, 2)
  assert.equal(second.clicks, 2)
  const busy = await runChat('busy')
  assert.equal(busy.presses, 1)
})

test('every press being dropped stops after three tries and reports the empty key trace', async () => {
  const { error, keys, presses, trace } = await runChat('dropped')
  assert.match(error.message, /timed out waiting for Enter to send the message/)
  assert.equal(presses, 3)
  assert.equal(keys.length, 6)
  assert.equal(trace.events.length, 0)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.focused, true)
  assert.equal(state.draft, 'packaged app check')
  assert.equal(state.send.disabled, false)
  assert.deepEqual(state.enter.events, [])
})

test('an IME holding the key stops after three tries and reports composing and prevented state', async () => {
  const { error, keys, presses, trace } = await runChat('composing')
  assert.match(error.message, /timed out waiting for Enter to send the message/)
  assert.equal(presses, 3)
  assert.equal(keys.length, 6)
  assert.equal(trace.events.length, 6)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.deepEqual([...state.enter.events].map(event => event.type), ['keydown', 'keyup', 'keydown', 'keyup', 'keydown', 'keyup'])
  assert.equal(state.enter.events[0].target, 'TEXTAREA')
  assert.equal(state.enter.events[0].composing, true)
  assert.equal(state.enter.events[0].prevented, true)
  const legacy = await runChat('sent', 'contenteditable')
  assert.equal(legacy.error, undefined)
})

test('the script waits for the start window to close and leave one visible window before running chat', () => {
  const revealIdx = source.indexOf('BrowserWindow.getAllWindows().length === 1')
  const chatCallIdx = source.indexOf('const chatError = await chat(cdp)')
  assert.ok(revealIdx > 0 && revealIdx < chatCallIdx)
})

test('macOS check and dev Electron scripts pass mockKeychainArgs and verify runtime isolation', () => {
  for (const rel of [
    '../scripts/check-packed.mjs',
    '../scripts/check-update.mjs',
    '../scripts/check-lifecycle.mjs',
    '../scripts/shot.mjs',
    '../scripts/icon.mjs',
  ]) {
    const script = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.match(script, /import\s+\{[^}]*\bmockKeychainArgs\b[^}]*\}\s+from\s+'\.\.\/src\/legacy\.mjs'/u, rel)
    assert.match(script, /\.\.\.(?:macArgs|mockKeychainArgs\(\))/u, rel)
  }
  const spawns = [...source.matchAll(/spawn\(packedApp,\s*\[([^\]]+)\]/gu)]
  assert.equal(spawns.length, 2)
  for (const [, args] of spawns) assert.match(args, /\.\.\.macArgs/u)
  assert.match(source, /app\.commandLine\.hasSwitch\('use-mock-keychain'\)/u)
  const lifecycleMain = readFileSync(new URL('./electron/lifecycle-main.mjs', import.meta.url), 'utf8')
  assert.match(lifecycleMain, /appendSwitch\('use-mock-keychain'\)/u)
  assert.match(lifecycleMain, /hasSwitch\('use-mock-keychain'\)/u)
})
