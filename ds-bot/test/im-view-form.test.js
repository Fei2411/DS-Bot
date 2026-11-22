import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imViewFormText, isLegacyImViewFormAnswer, parseImViewForm } from '../src/host/im/view-form.js'

const calculator = { type: 'stack', children: [
  { type: 'number', id: 'count', label: 'Count', min: 1, max: 10, value: 2 },
  { type: 'slider', id: 'size', label: 'Size', min: 0, max: 100, value: 50 },
  { type: 'toggle', id: 'enabled', label: 'Enabled', value: false },
  { type: 'choice', id: 'route', label: 'Route', options: [{ label: 'Fast', value: 'f' }, { label: 'Safe', value: 's' }] },
  { type: 'submit', id: 'send' },
] }

test('token forms render types, defaults, bounds and an answer example', () => {
  const text = imViewFormText(calculator, 'V3')
  for (const part of ['Card V3', 'Submit', 'number', 'slider', 'min 1', 'max 10', 'default 2', '1=Fast; 2=Safe', 'Reply example: !card V3\\n1: 2', 'mention the Bot before !card']) assert.ok(text.includes(part), part)
  assert.ok(!text.includes('1. Submit'))
})

test('legacy reply shapes include defaults, options, fields and cancellation but not prose', () => {
  for (const text of ['', '\n', '1 3', '1,3', '\n1: Alice\n  continued\tvalue', '2\r\n1: Alice', 'cancel', '2 CANCEL', '1: value']) {
    assert.equal(isLegacyImViewFormAnswer(text), true, text)
  }
  for (const text of ['is our release', '2 is our release', '1. value', '!card V1 1', 'cancel prose', '1\nnot a field']) {
    assert.equal(isLegacyImViewFormAnswer(text), false, text)
  }
})

test('token forms parse all input values and default omitted inputs', () => {
  assert.deepEqual(parseImViewForm(calculator, '').values.inputs, { count: 2, size: 50, enabled: false, route: 'f' })
  for (const [word, enabled] of [['yes', true], ['TRUE', true], ['on', true], ['no', false], ['false', false], ['OFF', false]]) {
    const answer = parseImViewForm(calculator, `\n1: 4\n2: 75\n3: ${word}\n4: Safe`)
    assert.deepEqual(answer.values.inputs, { count: 4, size: 75, enabled, route: 's' })
  }
  assert.equal(parseImViewForm(calculator, '\n4: 2').values.inputs.route, 's')
  for (const value of ['11', 'Infinity', '', '2oops']) assert.ok(parseImViewForm(calculator, `\n1: ${value}`).error)
  for (const text of ['\n9: value', '\n3: maybe', '\n4: missing', '\n1: 2\n1: 3', '\nnot a field']) assert.ok(parseImViewForm(calculator, text).error)
})

test('forms preserve multiline text, apply defaults and only cancel when allowed', () => {
  const view = { type: 'form', id: 'details', cancelLabel: 'Cancel', fields: [
    { id: 'name', label: 'Name', value: 'Default' },
    { id: 'notes', label: 'Notes', multiline: true },
    { id: 'fixed', label: 'Fixed', value: 'Keep', readOnly: true },
  ] }
  assert.deepEqual(parseImViewForm(view, '\n2: first\nsecond\n3: changed').values, { fields: { name: 'Default', notes: 'first\nsecond', fixed: 'Keep' } })
  assert.deepEqual(parseImViewForm(view, 'cancel').values, { canceled: true })
  assert.ok(parseImViewForm({ ...view, cancelLabel: undefined }, 'cancel').error)
  assert.ok(parseImViewForm(view, `\n1: ${'x'.repeat(2001)}`).error)
  assert.deepEqual(parseImViewForm(view, '\n1: ').values.fields.name, '')
})

test('multi-select accepts comma and whitespace indices, rejects empty and unknown picks', () => {
  const view = { type: 'options', id: 'pick', multi: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }
  for (const text of ['1 3', '1,3', '1, 3', '1 1 3']) assert.deepEqual(parseImViewForm(view, text).values.selected, ['A', 'C'])
  for (const text of ['', '0', '4', '1,', 'A']) assert.ok(parseImViewForm(view, text).error)
})

test('several actions require an explicit action and disallow fields from another form', () => {
  const view = { type: 'stack', children: [
    { type: 'form', id: 'first', fields: [{ id: 'a', label: 'A' }], cancelLabel: 'Cancel' },
    { type: 'form', id: 'second', fields: [{ id: 'b', label: 'B' }], cancelLabel: 'Cancel' },
  ] }
  assert.match(imViewFormText(view, 'V4'), /1\. Submit\n2\. Submit/)
  assert.equal(parseImViewForm(view, '2\n2: hi').action, 'second')
  assert.ok(parseImViewForm(view, '').error)
  assert.ok(parseImViewForm(view, 'cancel').error)
  assert.ok(parseImViewForm(view, '1\n2: wrong').error)
  assert.deepEqual(parseImViewForm(view, '2 cancel').values, { canceled: true })
})
