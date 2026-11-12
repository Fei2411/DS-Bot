import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-frame-'))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { rt, call, stop: () => rmSync(home, { recursive: true, force: true }) }
}

test('browser-frame returns the open frame', async () => {
  const { rt, call, stop } = start()
  rt.browserFrame = async () => ({ mime: 'image/jpeg', data: 'aGk=', url: 'https://example.com', title: 'Example' })
  const response = await call('browser-frame', { botId: 'b-1' })
  assert.equal(response.ok, true)
  assert.equal(response.value.mime, 'image/jpeg')
  assert.equal(response.value.url, 'https://example.com')
  stop()
})

test('browser-frame refuses when no Bot browser is open', async () => {
  const { rt, call, stop } = start()
  rt.browserFrame = async () => undefined
  const response = await call('browser-frame', { botId: 'b-9' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'bot/not-found')
  stop()
})

test('browser-frame refuses when browsers are off', async () => {
  const { call, stop } = start()
  const response = await call('browser-frame', { botId: 'b-1' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'bot/browser-off')
  stop()
})
