import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { install } from '../src/host/local-agents/index.js'
import { refreshSearchDirs } from '../src/host/local-agents/discover.js'

test('disposing during initial CLI discovery drains the scan without touching an inactive context', async () => {
  const root = new Context()
  let live = 0
  root.provide('llm', {
    registerAdapter() {
      live++
      return Object.assign(() => { live-- }, { replace() {} })
    },
  })
  await root.plugin(Object.assign(ctx => {
    install({ ctx, state: {}, teamTools: [], load: async () => {} })
  }, { inject: ['llm'] }))
  await root.fiber.dispose()
  await refreshSearchDirs()
  assert.equal(live, 0)
})
