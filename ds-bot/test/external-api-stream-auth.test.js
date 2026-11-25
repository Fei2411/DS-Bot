import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createApiAuth } from '../src/host/api/auth.js'
import { createApiRoutes } from '../src/host/api/routes.js'
import { createOpenAiHandler } from '../src/host/api/openai.js'

for (const transport of ['events', 'run', 'openai']) {
  for (const change of ['paused', 'revoked', 'scopes']) {
    test(`${transport} streams close after token ${change}, even without events`, async t => {
      const home = mkdtempSync(join(tmpdir(), 'dsb-stream-auth-'))
      const rt = { home, ctx: {}, state: {}, botOf: id => ({ id }) }
      const auth = createApiAuth(rt)
      auth.updateConfig({ openaiCompat: true })
      const created = auth.createToken({ name: 'Streaming', scopes: ['read', 'message'], targetScope: 'all_public' })
      const checked = await auth.authenticate({
        headers: { host: 'localhost', authorization: `Bearer ${created.token}` },
        socket: { remoteAddress: 'local' },
      })
      assert.equal(checked.ok, true)
      const principal = checked.token
      t.mock.timers.enable({ apis: ['setInterval'] })
      let listener
      const run = { runId: 'run_test', target: { kind: 'bot', id: 'b1' }, status: 'running', output: { text: '' } }
      const runs = {
        getRunForPrincipal: () => ({ ok: true, run }),
        subscribeRun: (_id, cb) => { listener = cb; return () => { listener = undefined } },
      }
      const clients = new Set()
      const routes = createApiRoutes(rt, { auth, runs, sseClients: clients })
      const req = transport === 'openai'
        ? new Readable({ autoDestroy: false, read() { this.push(JSON.stringify({ model: 'dsbot/bot/b1', stream: true, messages: [{ role: 'user', content: 'Go' }] })); this.push(null) } })
        : new EventEmitter()
      req.method = transport === 'openai' ? 'POST' : 'GET'
      req.headers = {}
      let output = ''
      const res = { writableEnded: false, writeHead() {}, write(value) { output += value }, end() { this.writableEnded = true } }
      t.after(() => { req.emit('close'); routes.dispose(); rmSync(home, { recursive: true, force: true }) })
      if (transport === 'openai') {
        const handler = createOpenAiHandler({ auth, runs, sseClients: clients, service: { sendToBot: async () => ({ run }) } })
        await handler.handleOpenAi(req, res, new URL('http://localhost/compat/openai/v1/chat/completions'), principal, {})
      } else {
        await routes.handleV1(req, res, new URL(transport === 'events' ? 'http://localhost/v1/events/stream' : 'http://localhost/v1/runs/run_test/events'), principal, {})
      }
      assert.equal(res.writableEnded, false)
      if (change === 'revoked') auth.revokeToken(created.meta.keyId)
      else auth.updateToken(created.meta.keyId, change === 'paused' ? { paused: true } : { scopes: ['read'] })
      assert.equal(principal.isCurrent(), false)
      t.mock.timers.tick(1_001)
      assert.equal(res.writableEnded, true)
      assert.equal(clients.size, 0)
      listener?.({ event: 'delta', data: { text: 'MUST_NOT_LEAK' } })
      rt.apiEmitGlobal('notice', { text: 'MUST_NOT_LEAK' })
      assert.equal(output.includes('MUST_NOT_LEAK'), false)
    })
  }
}
