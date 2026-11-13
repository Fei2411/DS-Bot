import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainToolSchema } from '../src/host/tool-schema.js'

// The schema public#1508 reported from an MCP connector: a union with no type of its
// own, and an enum that lists null. Moonshot/KIMI refused the whole request for it.
const REPORTED = {
  type: 'object',
  properties: {
    sort_order: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      enum: ['ASC', 'DESC', null],
      description: 'Sort Order: The sort order (ASC or DESC). Defaults to DESC.',
      title: 'Sort Order',
    },
  },
  required: ['sort_order'],
}

test('the reported union property is collapsed to its first non-null branch, without the null enum entry', () => {
  const plain = plainToolSchema(REPORTED)
  assert.deepEqual(plain.properties.sort_order, {
    type: 'string',
    enum: ['ASC', 'DESC'],
    description: 'Sort Order: The sort order (ASC or DESC). Defaults to DESC.',
    title: 'Sort Order',
  })
  assert.equal(plain.type, 'object')
  assert.deepEqual(plain.required, ['sort_order'])
  // The schema given in is never changed: another provider may still be using it.
  assert.ok(Array.isArray(REPORTED.properties.sort_order.oneOf))
  assert.deepEqual(REPORTED.properties.sort_order.enum, ['ASC', 'DESC', null])
})

test('a schema without a type gets the one its shape or enum names', () => {
  const plain = plainToolSchema({
    type: 'object',
    properties: {
      filter: { type: 'object', properties: { status: { enum: ['open', 'closed'] } } },
      ids: { type: 'array', items: { type: 'integer' } },
      mode: { enum: ['fast', 'slow'] },
      flags: { enum: [true, false] },
      count: { enum: [1, 2, 3] },
      bare: {},
    },
  })
  assert.equal(plain.properties.filter.type, 'object')
  assert.equal(plain.properties.filter.properties.status.type, 'string')
  assert.deepEqual(plain.properties.filter.properties.status.enum, ['open', 'closed'])
  assert.equal(plain.properties.ids.items.type, 'integer')
  assert.equal(plain.properties.mode.type, 'string')
  assert.equal(plain.properties.flags.type, 'boolean')
  assert.equal(plain.properties.count.type, 'integer')
  // Nothing names a type for an empty schema, and nothing is invented for it.
  assert.deepEqual(plain.properties.bare, {})
})

test('nested arrays of objects are typed at every level', () => {
  const plain = plainToolSchema({
    type: 'object',
    properties: {
      rows: { type: 'array', items: { properties: { id: { type: 'string' } } } },
    },
  })
  assert.equal(plain.properties.rows.items.type, 'object')
  assert.deepEqual(plain.properties.rows.items.properties.id, { type: 'string' })
})

test('a nullable union keeps the type of its non-null branch and loses the null enum entry', () => {
  const plain = plainToolSchema({ type: 'object', properties: { tag: { anyOf: [{ type: 'null' }, { type: 'integer' }], enum: [1, null] } } })
  assert.deepEqual(plain.properties.tag, { type: 'integer', enum: [1] })
})

test('refs and const are removed, as the local agent bridge already did', () => {
  const plain = plainToolSchema({
    type: 'object',
    $defs: { name: { type: 'string' } },
    properties: {
      name: { $ref: '#/$defs/name' },
      kind: { const: 'row' },
    },
  })
  assert.equal(plain.$defs, undefined)
  assert.deepEqual(plain.properties.name, {})
  assert.deepEqual(plain.properties.kind, {})
})

test('a schema already plain comes out equal, so the tool list is left as it was', () => {
  const plain = { type: 'object', properties: { text: { type: 'string', description: 'x' } }, required: ['text'] }
  assert.deepEqual(plainToolSchema(plain), plain)
  assert.deepEqual(plainToolSchema({}), {})
  assert.deepEqual(plainToolSchema(undefined), {})
})
