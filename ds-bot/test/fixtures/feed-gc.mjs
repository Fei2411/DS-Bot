import assert from 'node:assert/strict'
import { install } from '../../src/host/feed.js'
import { fakeContext } from '../fake-ctx.js'

const ctx = fakeContext()
let route
const register = ctx.connection.fetch.register
ctx.connection.fetch.register = value => { route = value; return register(value) }
install({ ctx, state: { revision: 1, exchangeTurns: {} }, chatOwners: new Map(), selfOf: () => undefined, displayItems: () => [] })
try {
  const abort = new AbortController()
  const response = await route.fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const reader = response.body.getReader()
  await reader.read()
  for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise(resolve => setTimeout(resolve, 10)) }
  abort.abort()
  let timer
  try {
    const result = await Promise.race([reader.read(), new Promise(resolve => { timer = setTimeout(() => resolve({ done: false }), 1000) })])
    assert.equal(result.done, true, 'The feed must retain the Request until external cancellation ends the stream')
  } finally { clearTimeout(timer) }
} finally { await ctx.dispose() }
