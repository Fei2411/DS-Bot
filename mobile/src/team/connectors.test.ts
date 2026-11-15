import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectorRows } from './connectors.ts'

// Recorded from a running computer: `state.connectors` of a `state` answer, cut to three of
// its rows (one per auth kind) and with the mailbox as it comes. The rest of the answer is
// 35 more rows of the same shape. Every row of a fresh team is `off` with a null account.
const answered = {
  connectors: [
    { id: 'github', name: 'GitHub', category: 'dev', about: 'Repositories, issues, and pull requests', auth: { kind: 'oauth', scopes: ['repo', 'read:org'], client: { id: 'Ov23liin4waZGLSJJgn5', deviceFlow: true }, token: true }, state: 'off', account: null, offFor: [], tools: 0 },
    { id: 'huggingface', name: 'Hugging Face', category: 'data', about: 'Models, datasets, and Spaces', auth: { kind: 'none' }, state: 'off', account: null, offFor: [], tools: 0 },
    { id: 'amap', name: 'Amap', category: 'search', about: 'Maps, places, and routes in China', auth: { kind: 'key', query: 'key', keyUrl: 'https://lbs.amap.com/api/mcp-server/create' }, state: 'off', account: null, offFor: [], tools: 0 },
  ],
  mail: { accounts: [], google: false, allowedRecipients: [], noDraftFor: [] },
}

test('the Connectors screen would call .map on the object the computer sends (#1514, #1495)', () => {
  // What the screen did before: take `state.connectors` as the list. On the app that
  // TypeError is "undefined is not a function", and it closes the app.
  assert.equal(Array.isArray(answered), false)
  assert.throws(() => (answered as unknown as unknown[]).map(row => row), TypeError)
})

test('connectorRows reads the rows out of the answer the computer sends', () => {
  const rows = connectorRows(answered)
  assert.deepEqual(rows.map(row => row.id), ['github', 'huggingface', 'amap'])
  assert.equal(rows[0].name, 'GitHub')
  assert.equal(rows[0].state, 'off')
  assert.equal(rows[0].account, null)
  // The screen maps over what comes back.
  assert.deepEqual(rows.map(row => row.name), ['GitHub', 'Hugging Face', 'Amap'])
})

test('a connector that failed or is connecting keeps its error and account', () => {
  // `rowFor` adds `error` only after a failure and fills `account` once signed in.
  const view = { connectors: [
    { ...answered.connectors[0], state: 'error', error: 'upstream POST HTTP 400' },
    { ...answered.connectors[1], state: 'ready', account: 'octocat' },
    { ...answered.connectors[2], state: 'connecting' },
  ], mail: answered.mail }
  const rows = connectorRows(view)
  assert.deepEqual(rows.map(row => row.state), ['error', 'ready', 'connecting'])
  assert.equal(rows[0].error, 'upstream POST HTTP 400')
  assert.equal(rows[1].account, 'octocat')
})

test('a bare list of rows is read too', () => {
  const rows = connectorRows(answered.connectors)
  assert.deepEqual(rows.map(row => row.id), ['github', 'huggingface', 'amap'])
})

test('no connectors, or something else in their place, gives an empty list and never throws', () => {
  for (const view of [undefined, null, {}, { connectors: null }, { connectors: {} }, { mail: answered.mail }, 'github', 7, true]) {
    assert.deepEqual(connectorRows(view), [], JSON.stringify(view))
  }
  assert.deepEqual(connectorRows({ connectors: [] }), [])
  // A row that is not an object would throw in the screen's `item.state`.
  assert.deepEqual(connectorRows({ connectors: [null, 'github', answered.connectors[1], undefined] }).map(row => row.id), ['huggingface'])
})
