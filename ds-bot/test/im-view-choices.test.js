import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imViewChoices } from '../src/host/im/view-choices.js'

test('IM views map confirms, options and action buttons to validated answers', () => {
  assert.deepEqual(imViewChoices({ type: 'confirm', id: 'ok' }).map(choice => choice.values), [{ confirmed: true }, { confirmed: false }])
  assert.deepEqual(imViewChoices({ type: 'options', id: 'pick', options: [{ label: 'A' }] }), [{ label: 'A', action: 'pick', values: { selected: ['A'] } }])
  assert.deepEqual(imViewChoices({ type: 'submit', id: 'go', label: 'Go' }), [{ label: 'Go', action: 'go', values: {} }])
  assert.deepEqual(imViewChoices({ type: 'submit', id: 'go' }), [{ label: 'Submit', action: 'go', values: {} }])
  assert.deepEqual(imViewChoices({ type: 'stack', children: [
    { type: 'choice', id: 'route', label: 'Route', options: [{ label: 'Short', value: 'a' }, { label: 'Scenic', value: 'b' }] },
    { type: 'submit', id: 'go', label: 'Go' },
  ] }).map(choice => choice.values), [{ inputs: { route: 'a' } }, { inputs: { route: 'b' } }])
})

test('IM views without choices or with typed or multiple inputs have no IM answers', () => {
  assert.deepEqual(imViewChoices({ type: 'text', text: 'Hello' }), [])
  assert.deepEqual(imViewChoices({ type: 'options', id: 'pick', multi: true, options: [{ label: 'A' }, { label: 'B' }] }), [])
  for (const type of ['form', 'number', 'slider', 'toggle']) {
    assert.deepEqual(imViewChoices({ type: 'stack', children: [{ type, id: 'field' }, { type: 'submit', id: 'go', label: 'Go' }] }), [])
  }
  assert.deepEqual(imViewChoices({ type: 'stack', children: [
    { type: 'choice', id: 'a' }, { type: 'choice', id: 'b' }, { type: 'submit', id: 'go', label: 'Go' },
  ] }), [])
})
