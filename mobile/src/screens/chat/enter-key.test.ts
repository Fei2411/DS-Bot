import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { enterMode, sendsOnEnter } from './enter-key.ts'

// Node runs the native copy of a platform file, so the browser one is loaded below
// under its own name to keep both under test.
import { enterHandler as nativeEnter, submitProps as nativeProps } from './composer.enter.ts'
import { enterHandler as webEnter, submitProps as webProps } from './composer.enter.web.ts'

test('a phone with no choice of its own follows the computer', () => {
  assert.equal(enterMode(undefined, undefined), 'follow')
  assert.equal(enterMode({}, undefined), 'follow')
  assert.equal(enterMode({ enterToSend: 'follow' }, undefined), 'follow')
  assert.equal(enterMode({ enterToSend: 'send' }, undefined), 'send')
  assert.equal(enterMode({ enterToSend: 'newline' }, undefined), 'newline')
})

test('following the computer keeps its default of sending, and its off switch', () => {
  assert.equal(sendsOnEnter('follow', undefined), true)
  assert.equal(sendsOnEnter('follow', {}), true)
  assert.equal(sendsOnEnter('follow', { enterToSend: false }), false)
  assert.equal(sendsOnEnter('follow', { enterToSend: true }), true)
})

test('the phone keeps its own answer when it has one', () => {
  assert.equal(sendsOnEnter('send', { enterToSend: false }), true)
  assert.equal(sendsOnEnter('newline', { enterToSend: true }), false)
})

test('the native build names both props so Android drops IME_FLAG_NO_ENTER_ACTION', () => {
  assert.deepEqual(nativeProps(true), { returnKeyType: 'send', submitBehavior: 'submit' })
  assert.deepEqual(nativeProps(false), {})
})

test('the native build leaves Enter to the platform, never to a key handler', () => {
  assert.equal(nativeEnter(true, () => assert.fail('the native handler must not send')), undefined)
})

test('the browser build handles Enter itself, since react-native-web ignores submitBehavior', () => {
  assert.deepEqual(webProps(true), {}, 'no prop the browser would ignore')

  const sent: string[] = []
  const press = (over: Record<string, unknown> = {}, sends = true) => {
    let kept = false
    webEnter(sends, () => sent.push('send'))?.({
      preventDefault: () => { kept = true },
      nativeEvent: { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...over },
    } as never)
    return kept
  }

  assert.equal(press(), true, 'Enter sends and keeps the newline out')
  assert.deepEqual(sent, ['send'])
  assert.equal(press({ shiftKey: true }), false, 'Shift+Enter keeps the newline')
  assert.equal(press({ isComposing: true }), false, 'a composing IME does not send')
  assert.equal(press({ isComposing: false, keyCode: 229 }), false, 'a CJK IME closing Enter does not send')
  assert.deepEqual(sent, ['send'], 'only the plain Enter sent')
  assert.equal(webEnter(false, () => sent.push('no')), undefined, 'newline mode leaves the key alone')
  assert.equal(press({}, false), false)
})

test('the composer takes its Enter behavior from the stored mode and the computer', () => {
  const composer = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /submitProps\(sends\)/)
  assert.match(composer, /enterHandler\(sends, send\)/)
  assert.match(composer, /onSubmitEditing=\{send\}/)
  const chat = readFileSync(new URL('../Chat.tsx', import.meta.url), 'utf8')
  assert.match(chat, /enterMode\(prefs, team\?\.prefs\)/)
  assert.match(chat, /sendsOnEnter\(mode, team\?\.prefs\)/)
  assert.match(chat, /onPrefsChange\(read\)/)
  const settings = readFileSync(new URL('../Settings.tsx', import.meta.url), 'utf8')
  assert.match(settings, /enterMode\(prefs, team\?\.prefs\)/)
})
