import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { enterKeyProps, enterMode, sendsOnEnter } from './enter-key.ts'

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

test('sending on Enter names both props so Android drops IME_FLAG_NO_ENTER_ACTION', () => {
  assert.deepEqual(enterKeyProps(true), { returnKeyType: 'send', submitBehavior: 'submit' })
  assert.deepEqual(enterKeyProps(false), {})
})

test('the composer takes its Enter behavior from the stored mode and the computer', () => {
  const composer = readFileSync(new URL('./composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /enterKeyProps\(sends\)/)
  assert.match(composer, /onSubmitEditing=\{send\}/)
  const chat = readFileSync(new URL('../Chat.tsx', import.meta.url), 'utf8')
  assert.match(chat, /enterMode\(prefs, team\?\.prefs\)/)
  assert.match(chat, /sendsOnEnter\(mode, team\?\.prefs\)/)
  assert.match(chat, /onPrefsChange\(read\)/)
  const settings = readFileSync(new URL('../Settings.tsx', import.meta.url), 'utf8')
  assert.match(settings, /enterMode\(prefs, team\?\.prefs\)/)
})
