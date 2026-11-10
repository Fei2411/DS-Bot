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
  assert.equal(keys[0].text, '\r')
  assert.equal(keys[0].unmodifiedText, '\r')
  assert.equal(keys[1].text, undefined)
})

test('a dropped Enter reports readiness and no received keyboard events, without retrying', async () => {
  const { error, keys } = await runChat('dropped')
  assert.match(error.message, /timed out waiting for Enter to send the message/)
  const state = JSON.parse(error.message.split('; composer: ')[1])
  assert.equal(state.enter.before.draft, 'packaged app check')
  assert.equal(state.enter.before.send.disabled, false)
  assert.equal(state.enter.before.focused, true)
  assert.deepEqual(state.enter.events, [])
  assert.deepEqual(state.dispatch.map(entry => entry.type), ['keyDown', 'keyUp'])
  assert.ok(state.dispatch.every(entry => typeof entry.sent === 'number' && entry.acknowledged >= entry.sent))
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

const diagnosticsSource = source.slice(source.indexOf('async function startInputTrace('), source.indexOf('// material.css and macos.css'))
function diagnostics(options = {}) {
  return runInNewContext(diagnosticsSource + '\n({ startInputTrace, checkChat })', {
    setTimeout, clearTimeout, console: { log() {} }, chat: async () => {}, ...options,
  })
}
function traceClient(call) {
  const listeners = new Set()
  return {
    call,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emit(method, params) { for (const listener of listeners) listener(method, params) },
    get listening() { return listeners.size },
  }
}

test('input tracing bounds and sanitizes events, and waits for both completion and the end reply', async () => {
  let acknowledge
  const client = traceClient(async (method, params, timeout) => {
    assert.equal(timeout, 5000)
    if (method === 'Tracing.start') {
      assert.equal(params.categories, 'input,content,latencyInfo')
      assert.equal(params.transferMode, 'ReportEvents')
    } else return new Promise(done => { acknowledge = done })
  })
  const stop = await diagnostics().startInputTrace(client)
  client.emit('Tracing.dataCollected', { value: [
    { name: 'request', args: { url: 'secret-url' } },
    { name: 'WebFrameWidgetImpl::HandleInputEvent', args: { type: 'MouseDown' } },
    ...Array.from({ length: 123 }, (_, index) => ({
      name: 'InputRouterImpl::KeyboardEventHandled', ts: index, pid: 2, tid: 3, ph: 'X',
      args: { type: 'KeyDown', ack: 'CONSUMED', url: 'secret-url', text: 'private-draft' },
    })),
  ] })
  let settled = false
  const result = stop().then(value => { settled = true; return value })
  client.emit('Tracing.tracingComplete', { dataLossOccurred: false, stream: 'private-stream' })
  await Promise.resolve()
  assert.equal(settled, false, 'completion alone is not the end command reply')
  acknowledge({})
  const trace = await result
  assert.equal(trace.status, 'complete')
  assert.equal(trace.total, 123)
  assert.equal(trace.events.length, 120)
  assert.equal(trace.truncated, true)
  assert.equal(trace.dataLossOccurred, false)
  assert.deepEqual(Object.keys(trace.events[0]), ['name', 'ts', 'pid', 'tid', 'ph', 'type', 'ack'])
  assert.doesNotMatch(JSON.stringify(trace), /secret-url|private-draft|private-stream/)
  assert.equal(client.listening, 0)
})

test('input tracing waits for tracingComplete after the end command acknowledges', async () => {
  const client = traceClient(async () => ({}))
  const stop = await diagnostics().startInputTrace(client)
  let settled = false
  const result = stop().then(value => { settled = true; return value })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
  client.emit('Tracing.tracingComplete', { dataLossOccurred: true })
  const trace = await result
  assert.equal(trace.status, 'complete')
  assert.equal(trace.dataLossOccurred, true)
  assert.equal(client.listening, 0)
})

test('unavailable tracing and a failed end command return bounded diagnostics', async () => {
  for (const failed of ['Tracing.start', 'Tracing.end']) {
    const calls = []
    const client = traceClient(async (method) => {
      calls.push(method)
      if (method === failed) throw new Error('private-url?token=secret')
      return {}
    })
    const stop = await diagnostics().startInputTrace(client)
    const trace = await stop()
    assert.equal(trace.status, failed === 'Tracing.start' ? 'start-failed' : 'end-failed')
    assert.doesNotMatch(JSON.stringify(trace), /private-url|token|secret/)
    assert.equal(client.listening, 0)
    assert.equal(calls.length, failed === 'Tracing.start' ? 1 : 2)
  }
})

test('missing trace completion or a missing end reply times out and removes the listener', async () => {
  for (const missing of ['completion', 'reply']) {
    let expire
    let cleared = false
    const client = traceClient(async method => method === 'Tracing.end' && missing === 'reply' ? new Promise(() => {}) : {})
    const { startInputTrace } = diagnostics({
      setTimeout(callback, ms) { assert.equal(ms, 5000); expire = callback; return 1 },
      clearTimeout(timer) { assert.equal(timer, 1); cleared = true },
    })
    const stop = await startInputTrace(client)
    const result = stop()
    if (missing === 'reply') client.emit('Tracing.tracingComplete', {})
    expire()
    assert.equal((await result).status, 'end-timeout')
    assert.equal(client.listening, 0)
    assert.equal(cleared, true)
  }
})

test('chat diagnostics keep the original failure and query only safe target and window state afterwards', async () => {
  for (const failDiagnostics of [false, true]) {
    const calls = []
    const logs = []
    const original = new Error('original chat error')
    const client = traceClient(async (method, _params, timeout) => {
      calls.push(method)
      assert.equal(timeout, 5000)
      if (method === 'Tracing.end') {
        if (failDiagnostics) throw new Error('trace diagnostic error')
        client.emit('Tracing.tracingComplete', {})
      }
      if (method === 'Page.getFrameTree') {
        if (failDiagnostics) throw new Error('private query token')
        return { frameTree: { frame: { id: 'frame-id', url: 'private-url?token=secret' } } }
      }
      return {}
    })
    const { checkChat } = diagnostics({
      chat: async () => { calls.push('chat'); throw original },
      console: { log: value => logs.push(value) },
    })
    const result = await checkChat(client, { id: 'target-id', type: 'page', url: 'private-url' }, async (expression, timeout) => {
      calls.push('windows')
      assert.equal(timeout, 5000)
      if (failDiagnostics) throw new Error('window diagnostic error')
      const window = { id: 7, isEnabled: () => true, isFocused: () => false, isVisible: () => true,
        webContents: { id: 8, isFocused: () => false, getOSProcessId: () => 123, getURL: () => 'private-url' } }
      return runInNewContext(expression, { BrowserWindow: { getAllWindows: () => [window] } })
    })
    assert.equal(result, original)
    assert.deepEqual(calls, ['Tracing.start', 'chat', 'Tracing.end', 'Page.getFrameTree', 'windows'])
    assert.doesNotMatch(logs.join('\n'), /private-url|token|secret|diagnostic error/)
    const state = JSON.parse(logs[1].slice('check-packed: input target '.length))
    assert.deepEqual(state.target, { id: 'target-id', type: 'page' })
    assert.equal(state.frame, failDiagnostics ? 'unavailable' : 'frame-id')
    if (failDiagnostics) assert.equal(state.windows, 'unavailable')
    else assert.deepEqual(state.windows, [{ id: 7, enabled: true, focused: false, visible: true,
      webContents: { id: 8, focused: false, rendererPID: 123 } }])
  }
})

test('successful chat reports tracing without querying failure state', async () => {
  const calls = []
  const client = traceClient(async method => {
    calls.push(method)
    if (method === 'Tracing.end') client.emit('Tracing.tracingComplete', {})
    return {}
  })
  const { checkChat } = diagnostics({ chat: async () => { calls.push('chat') } })
  const result = await checkChat(client, {}, () => { assert.fail('success must not query native state') })
  assert.equal(result, undefined)
  assert.deepEqual(calls, ['Tracing.start', 'chat', 'Tracing.end'])
})
