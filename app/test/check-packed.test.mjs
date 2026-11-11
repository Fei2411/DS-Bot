import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../scripts/check-packed.mjs', import.meta.url), 'utf8')
const chatSource = source.slice(source.indexOf('async function chat(cdp)'), source.indexOf('async function checkComputerHelper('))

// delivery says what the page does with a press:
//   sent      the first press sends
//   second    the first press is dropped, the second one sends
//   dropped   no press is ever delivered to the page
//   composing an IME owns the key, so the press sends nothing
//   busy      the press starts a send that never clears the field (the button turns disabled)
//   changed   the press leaves other text behind instead of sending
async function runChat(delivery) {
  let now = 0
  let reply = ''
  let presses = 0
  const keys = []
  const timers = []
  const listeners = new Map()
  const button = { disabled: true, getAttribute: () => 'Send message' }
  const field = {
    tagName: 'DIV', isContentEditable: true, innerText: '',
    hasAttribute: () => false, querySelector: () => null,
    parentElement: { querySelector: () => button },
  }
  const control = { click() {} }
  const document = {
    activeElement: field, visibilityState: 'visible', hasFocus: () => true,
    body: { get innerText() { return '先让团队帮你做哪块 ' + field.innerText + ' ' + reply } },
    querySelector: selector => selector === '[role=listbox]' ? null : control,
    querySelectorAll: selector => selector === '[role=dialog] button' ? [] : [field],
  }
  const page = createContext({
    document, performance: { now: () => now }, setTimeout: callback => timers.push(callback),
    fetch: async () => ({ json: async () => ({ value: { mainBotId: 'chief' } }) }),
    addEventListener: (type, listener) => listeners.set(type, listener),
  })
  page.window = page
  const chat = runInNewContext(chatSource + String.fromCharCode(10) + 'chat', {
    Date: { now: () => now }, sleep: async ms => { now += ms },
    frameSheets: [], process: { platform: 'linux' }, console: { log() {} },
  })
  const error = await chat({ call: async (method, params = {}) => {
    if (method === 'Runtime.enable' || method === 'Log.enable') return {}
    if (method === 'Runtime.evaluate') return { result: { value: await runInContext(params.expression, page) } }
    if (method === 'Input.insertText') { field.innerText = params.text; button.disabled = false; return {} }
    assert.equal(method, 'Input.dispatchKeyEvent', 'the check must send through the keyboard')
    keys.push(params)
    const type = params.type === 'keyDown' ? 'keydown' : 'keyup'
    if (type === 'keydown') presses += 1
    // A dropped press reaches the browser's input pipeline but never the page.
    if (delivery === 'dropped') return {}
    const event = { type, key: params.key, code: params.code, keyCode: params.windowsVirtualKeyCode,
      target: field, isComposing: delivery === 'composing', repeat: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false }
    listeners.get(type)?.(event)
    if (type === 'keydown') {
      const sends = delivery === 'sent' || (delivery === 'second' && presses >= 2)
      event.defaultPrevented = true
      if (sends) { field.innerText = ''; reply = '收到：packaged app check' }
      if (delivery === 'busy') button.disabled = true
      if (delivery === 'changed') field.innerText = 'packaged app check and more'
    }
    for (const callback of timers.splice(0)) callback()
    return {}
  } }).then(() => undefined, error => error)
  return { error, keys, presses, trace: page.__packedEnter }
}

test('a press that sends is the only one', async () => {
  const { error, keys, presses } = await runChat('sent')
  assert.equal(error, undefined)
  assert.deepEqual(keys.map(key => key.type), ['keyDown', 'keyUp'])
  assert.equal(presses, 1)
})

test('a dropped press is pressed again, and the run goes on once the second one sends', async () => {
  const { error, keys, presses, trace } = await runChat('second')
  assert.equal(error, undefined)
  assert.equal(presses, 2)
  assert.deepEqual(keys.map(key => key.type), ['keyDown', 'keyUp', 'keyDown', 'keyUp'])
  assert.deepEqual([...trace.events].map(event => event.type), ['keydown', 'keyup', 'keydown', 'keyup'])
})

test('every press being dropped reports three tries and the composer state, never more', async () => {
  const { error, keys, presses, trace } = await runChat('dropped')
  assert.match(error.message, /stayed in the composer after 3 Enter presses/)
  assert.equal(presses, 3)
  assert.equal(keys.length, 6)
  // Nothing reached the page, so the trace the page keeps stays empty.
  assert.equal(trace.events.length, 0)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.draft, 'packaged app check')
  assert.equal(state.send.disabled, false)
  assert.deepEqual(state.enter.events, [])
})

test('an IME holding the key is reported with its event state, and still stops after three tries', async () => {
  const { error, keys, trace } = await runChat('composing')
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.deepEqual([...state.enter.events].map(event => event.type), ['keydown', 'keyup', 'keydown', 'keyup', 'keydown', 'keyup'])
  assert.equal(state.enter.events[0].target, 'DIV')
  assert.equal(state.enter.events[0].composing, true)
  assert.equal(state.enter.events[0].prevented, true)
  assert.equal(state.draft, 'packaged app check')
  assert.equal(keys.length, 6)
  assert.equal(trace.events.length, 6)
})

test('a send in flight is not pressed a second time, so the message cannot be posted twice', async () => {
  const { error, presses } = await runChat('busy')
  assert.match(error.message, /stayed in the composer after 3 Enter presses/)
  assert.equal(presses, 1)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.send.disabled, true)
  assert.equal(state.draft, 'packaged app check')
})

test('a field whose text changed is not pressed again either', async () => {
  const { error, presses } = await runChat('changed')
  assert.match(error.message, /stayed in the composer after 3 Enter presses/)
  assert.equal(presses, 1)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.draft, 'packaged app check and more')
})
