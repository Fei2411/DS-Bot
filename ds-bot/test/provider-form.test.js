import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerFormMissing } from '../src/client/provider-form.js'

// #1077: the Add button stays disabled until the custom provider has an id, an endpoint
// and at least one model. The form names those instead of only greying the button out.
test('a custom provider needs a provider id, an endpoint and at least one model', () => {
  assert.deepEqual(providerFormMissing({}, []), ['provider', 'endpoint', 'model'])
  assert.deepEqual(providerFormMissing({ provider: 'my-gw', baseURL: 'http://127.0.0.1:9/v1' }, []), ['model'])
  assert.deepEqual(providerFormMissing({ provider: 'my-gw', baseURL: 'http://127.0.0.1:9/v1' }, [{ id: 'm1' }]), [])
})

test('blank and padded values count as missing', () => {
  assert.deepEqual(providerFormMissing({ provider: '   ', baseURL: ' ' }, []), ['provider', 'endpoint', 'model'])
  assert.deepEqual(providerFormMissing({ provider: ' my-gw ', baseURL: ' http://x/v1 ' }, []), ['model'])
})

test('a model typed by id counts, not only one picked from the fetched list', () => {
  const draft = { provider: 'my-gw', baseURL: 'http://x/v1', typed: 'm1' }
  // The form computes the model list from the fetched picks and the typed ids.
  const models = draft.typed.split(/[\s,]+/).map(id => ({ id }))
  assert.deepEqual(providerFormMissing(draft, models), [])
})
