import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HEADER_ENTRY, PANEL_OPENER, focusTargetOnClose, openerBeforeOpen } from '../src/client/panel-focus.js'

// A tiny tree: a node contains itself and its descendants.
const node = (name, ...kids) => {
  const self = { name, isConnected: true, kids, contains: other => other === self || kids.some(kid => kid.contains(other)) }
  return self
}
const inside = node('close-button')
const panel = node('panel', inside)
const chatBox = node('chat-box')
const openerButton = node('opener')
const pill = node('header-pill')
const finder = (known = {}) => selector => known[selector] ?? null

test('focus inside the panel goes back to what had it before the panel opened', () => {
  assert.equal(focusTargetOnClose({ panel, active: inside, opener: openerButton, find: finder() }), openerButton)
})

test('focus in the chat box, or anywhere outside the panel, is left alone', () => {
  assert.equal(focusTargetOnClose({ panel, active: chatBox, opener: openerButton, find: finder() }), null)
  assert.equal(focusTargetOnClose({ panel, active: null, opener: openerButton, find: finder() }), null)
  assert.equal(focusTargetOnClose({ panel, active: undefined, opener: openerButton, find: finder() }), null)
  assert.equal(focusTargetOnClose({ panel: null, active: inside, opener: openerButton, find: finder() }), null)
})

test('an opener that is gone falls back to the marked opener, then to the header entry, then to nothing', () => {
  const gone = { ...openerButton, isConnected: false }
  assert.equal(focusTargetOnClose({ panel, active: inside, opener: gone, find: finder({ [PANEL_OPENER]: pill, [HEADER_ENTRY]: chatBox }) }), pill)
  assert.equal(focusTargetOnClose({ panel, active: inside, opener: null, find: finder({ [HEADER_ENTRY]: pill }) }), pill)
  assert.equal(focusTargetOnClose({ panel, active: inside, opener: gone, find: finder() }), null, 'nothing to return to: the browser keeps focus where it falls')
})

test('an opener inside the panel itself is never returned to', () => {
  assert.equal(focusTargetOnClose({ panel, active: inside, opener: inside, find: finder({ [HEADER_ENTRY]: pill }) }), pill)
})

test('the opener is whatever had focus before the panel, and never something inside it', () => {
  assert.equal(openerBeforeOpen({ panel, active: chatBox }), chatBox)
  assert.equal(openerBeforeOpen({ panel, active: inside }), null)
  assert.equal(openerBeforeOpen({ panel, active: null }), null)
  assert.equal(openerBeforeOpen({ panel: null, active: chatBox }), chatBox)
})
