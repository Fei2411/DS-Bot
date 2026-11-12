import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../scripts/check-packed.mjs', import.meta.url), 'utf8')
const chatSource = source.slice(source.indexOf('async function chat(cdp)'), source.indexOf('async function checkComputerHelper('))

// delivery says what the page does with the Enter press:
//   sent      the press sends the message
//   unfocused the window starts without focus until the mouse click lands on the composer
//   dropped   the press never reaches the page
//   composing an IME owns the key, so the press sends nothing
async function runChat(delivery) {
  let now = 0
  let reply = ''
  let presses = 0
  let clicks = 0
  let focused = delivery !== 'unfocused'
  const keys = []
  const timers = []
  const listeners = new Map()
  const button = { disabled: true, getAttribute: () => 'Send message' }
  const field = {
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
    body: { get innerText() { return '先让团队帮你做哪块 ' + field.innerText + ' ' + reply } },
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
    if (method === 'Runtime.enable' || method === 'Log.enable') return {}
    if (method === 'Runtime.evaluate') return { result: { value: await runInContext(params.expression, page) } }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mouseReleased') { clicks += 1; focused = true }
      return {}
    }
    if (method === 'Input.insertText') {
      assert.equal(focused, true, 'must not insert text before the window holds focus')
      field.innerText = params.text
      button.disabled = false
      return {}
    }
    assert.equal(method, 'Input.dispatchKeyEvent', 'the check must send through the keyboard')
    keys.push(params)
    const type = params.type === 'keyDown' ? 'keydown' : 'keyup'
    if (type === 'keydown') presses += 1
    if (delivery === 'dropped') return {}
    const event = {
      type, key: params.key, code: params.code, keyCode: params.windowsVirtualKeyCode,
      target: field, isComposing: delivery === 'composing', repeat: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false,
    }
    listeners.get(type)?.(event)
    if (type === 'keydown') {
      event.defaultPrevented = true
      if (delivery === 'sent' || delivery === 'unfocused') {
        field.innerText = ''
        reply = '收到：packaged app check'
      }
    }
    for (const callback of timers.splice(0)) callback()
    return {}
  } }).then(() => undefined, error => error)
  return { error, keys, presses, clicks, trace: page.__packedEnter }
}

test('a focused composer sends on a single Enter press', async () => {
  const { error, keys, presses, clicks } = await runChat('sent')
  assert.equal(error, undefined)
  assert.equal(clicks, 0)
  assert.deepEqual(keys.map(key => key.type), ['keyDown', 'keyUp'])
  assert.equal(presses, 1)
})

test('an unfocused window is clicked through the input pipeline until document.hasFocus() holds before typing', async () => {
  const { error, presses, clicks } = await runChat('unfocused')
  assert.equal(error, undefined)
  assert.equal(clicks, 1)
  assert.equal(presses, 1)
})

test('a dropped press fails without re-pressing Enter and reports the empty key trace', async () => {
  const { error, keys, presses, trace } = await runChat('dropped')
  assert.match(error.message, /timed out waiting for Enter to send the message/)
  assert.equal(presses, 1)
  assert.equal(keys.length, 2)
  assert.equal(trace.events.length, 0)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.focused, true)
  assert.equal(state.draft, 'packaged app check')
  assert.equal(state.send.disabled, false)
  assert.deepEqual(state.enter.events, [])
})

test('an IME holding the key fails on the first press and reports composing and prevented state', async () => {
  const { error, keys, presses, trace } = await runChat('composing')
  assert.match(error.message, /timed out waiting for Enter to send the message/)
  assert.equal(presses, 1)
  assert.equal(keys.length, 2)
  assert.equal(trace.events.length, 2)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.deepEqual([...state.enter.events].map(event => event.type), ['keydown', 'keyup'])
  assert.equal(state.enter.events[0].target, 'DIV')
  assert.equal(state.enter.events[0].composing, true)
  assert.equal(state.enter.events[0].prevented, true)
})

test('the script waits for the start window to close and leave one visible window before running chat', () => {
  const revealIdx = source.indexOf('BrowserWindow.getAllWindows().length === 1')
  const chatCallIdx = source.indexOf('const chatError = await chat(cdp)')
  assert.ok(revealIdx > 0 && revealIdx < chatCallIdx)
})
