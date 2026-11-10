import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../scripts/check-packed.mjs', import.meta.url), 'utf8')
const chatSource = source.slice(source.indexOf('async function chat(cdp)'), source.indexOf('async function checkComputerHelper('))

async function runChat(delivery) {
  let now = 0
  let reply = ''
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
    if (delivery === 'dropped') return {}
    const type = params.type === 'keyDown' ? 'keydown' : 'keyup'
    const event = { type, key: params.key, code: params.code, keyCode: params.windowsVirtualKeyCode,
      target: field, isComposing: delivery === 'composing', repeat: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false }
    listeners.get(type)?.(event)
    listeners.delete(type)
    if (type === 'keydown') {
      event.defaultPrevented = true
      if (delivery === 'sent') { field.innerText = ''; reply = '收到：packaged app check' }
    }
    for (const callback of timers.splice(0)) callback()
    return {}
  } }).then(() => undefined, error => error)
  return { error, keys, trace: page.__packedEnter }
}

test('the packed check still sends exactly one Enter and waits for the reply', async () => {
  const { error, keys } = await runChat('sent')
  assert.equal(error, undefined)
  assert.deepEqual(keys.map(key => key.type), ['keyDown', 'keyUp'])
})

test('a dropped Enter reports readiness and no received keyboard events, without retrying', async () => {
  const { error, keys } = await runChat('dropped')
  assert.match(error.message, /timed out waiting for Enter to send the message/)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.enter.before.draft, 'packaged app check')
  assert.equal(state.enter.before.send.disabled, false)
  assert.equal(state.enter.before.focused, true)
  assert.deepEqual(state.enter.events, [])
  assert.equal(keys.length, 2)
})

test('an intercepted Enter reports its event state and final preventDefault result', async () => {
  const { error, keys } = await runChat('composing')
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.deepEqual(state.enter.events.map(event => event.type), ['keydown', 'keyup'])
  assert.equal(state.enter.events[0].target, 'DIV')
  assert.equal(state.enter.events[0].composing, true)
  assert.equal(state.enter.events[0].prevented, true)
  assert.equal(state.draft, 'packaged app check')
  assert.equal(keys.length, 2)
})
