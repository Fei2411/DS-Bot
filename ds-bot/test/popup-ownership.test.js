import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerPopupOwner, ownedPopups } from '../src/client/popup-ownership.js'

function element(parent = null) {
  return {
    parent, isConnected: true,
    hasAttribute(name) { return name === 'data-leaving' && this.leaving === true },
    contains(child) {
      for (let node = child; node; node = node.parent) if (node === this) return true
      return false
    },
  }
}

test('popup ownership excludes unrelated, missing, disconnected and closing popups', t => {
  const target = element()
  const unrelated = element()
  t.after(registerPopupOwner({ current: unrelated }, { current: element() }))
  t.after(registerPopupOwner({ current: target }, { current: null }))
  t.after(registerPopupOwner({ current: null }, { current: element() }))
  t.after(registerPopupOwner({ current: target }, { current: { ...element(), isConnected: false } }))
  t.after(registerPopupOwner({ current: target }, { current: { ...element(), leaving: true } }))
  assert.deepEqual([...ownedPopups([target])], [])
  assert.deepEqual([...ownedPopups([])], [])
})

test('popup ownership follows refs mounted later and removes unmounted owners', t => {
  const target = element()
  const owner = { current: element(target) }
  const popup = { current: null }
  const cleanup = registerPopupOwner(owner, popup)
  t.after(cleanup)
  assert.deepEqual([...ownedPopups([target])], [])
  popup.current = element()
  assert.deepEqual([...ownedPopups([target])], [popup.current])
  cleanup()
  assert.deepEqual([...ownedPopups([target])], [])
})

test('popup ownership includes nested portals but never duplicates descendant roots', t => {
  const target = element()
  const popup = element()
  const nested = element()
  t.after(registerPopupOwner({ current: element(popup) }, { current: nested }))
  t.after(registerPopupOwner({ current: element(target) }, { current: popup }))
  t.after(registerPopupOwner({ current: element(popup) }, { current: element(popup) }))
  assert.deepEqual([...ownedPopups([target])], [popup, nested])
  assert.deepEqual([...ownedPopups([target, popup])], [nested])
})
