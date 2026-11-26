import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

function createHarness(initialState, { onPrompt } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-extapi-'))
  const workDir = join(home, 'work')
  const state = initialState ?? {
    version: 1,
    mainBotIds: ['b1'],
    bots: {
      b1: { id: 'b1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
      b2: { id: 'b2', name: 'Analyst', role: 'Research', instructions: '', createdAt: 2 },
    },
    rooms: {
      r1: { id: 'r1', name: 'Core Team', named: true, members: ['b1', 'b2'], admin: 'b1', mode: 'everyone', sessions: { b1: 'g_b1', b2: 'g_b2' }, log: [], seq: 0, createdAt: 3 },
    },
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))

  const attachments = fakeAttachments(home)
  const sessions = new Map()
  const agents = new Map()
  const prompted = []
  let seqCounter = 10

  const ensureSession = (sid) => {
    let s = sessions.get(sid)
    if (!s) {
      const events = []
      s = {
        id: sid,
        seq: 1,
        events,
        snapshotEvents: () => [...events],
        requestHeader: () => ({ config: { provider: 'mock' } }),
        header: { cwd: workDir },
      }
      sessions.set(sid, s)
      const agent = {
        id: sid,
        session: s,
        status: 'idle',
        cancelled: false,
        followups: [],
        followup(msg) {
          this.followups.push(msg)
          emitSessionEvent(sid, {
            type: 'user/message',
            seq: ++seqCounter,
            time: Date.now(),
            data: { content: msg.content, source: msg.source },
          })
          // Automatically complete a follow-up turn unless customized
          setTimeout(() => {
            emitSessionEvent(sid, { type: 'turn/start', seq: ++seqCounter, time: Date.now(), data: { turn: 2 } })
            emitSessionEvent(sid, {
              type: 'assistant/message',
              seq: ++seqCounter,
              time: Date.now(),
              data: { message: { content: [{ type: 'text', text: 'Continued after human input.' }] }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } },
            })
            emitSessionEvent(sid, { type: 'turn/end', seq: ++seqCounter, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } })
          }, 10)
        },
        steer(msg) { this.followup(msg) },
        cancel() {
          this.cancelled = true
          emitSessionEvent(sid, { type: 'turn/end', seq: ++seqCounter, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
        },
      }
      agents.set(sid, agent)
    }
    return s
  }

  let ctx
  const emitSessionEvent = (sid, event) => {
    const s = ensureSession(sid)
    s.events.push(event)
    s.seq = Math.max(s.seq, (event.seq ?? 0) + 1)
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      listener(s, event)
    }
  }
  const emitStream = (sid, text) => {
    const agent = agents.get(sid) ?? (ensureSession(sid), agents.get(sid))
    for (const listener of ctx.listeners.get('agent/assistant-stream') ?? []) {
      listener({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } })
    }
  }
  const triggerApproval = (request) => {
    const chain = [...(ctx.listeners.get('approval/request') ?? [])]
    let idx = 0
    const next = () => {
      const fn = chain[idx++]
      if (!fn) {
        // Simulates DSH's own UI card waiting until answered or withdrawn via request.signal.
        return new Promise((resolve) => {
          if (request.signal?.aborted) resolve('cancelled')
          else request.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      }
      return fn(request, next)
    }
    return next()
  }

  ctx = fakeContext({
    services: {
      attachments,
      agents,
    },
  })
  ctx.workspaceRegistry = { get: () => undefined, list: () => [] }
  ctx.sessions = { flush: async () => {}, rename: async () => {} }
  ctx.sessionController = {
    resolveAgent: async (sid) => {
      ensureSession(sid)
      return { agent: agents.get(sid) }
    },
    page: async ({ address }) => {
      const s = ensureSession(address.sessionId)
      return { records: s.events.map(event => ({ event })), hasMore: false }
    },
    prompt: async ({ requestId, sessionId, content }) => {
      prompted.push({ requestId, sessionId, content })
      const text = (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      emitSessionEvent(sessionId, {
        type: 'user/message',
        seq: ++seqCounter,
        time: Date.now(),
        data: { content, source: { kind: 'user', rpcId: requestId } },
      })
      if (onPrompt) {
        await onPrompt({ requestId, sessionId, content, text, emitSessionEvent, emitStream, triggerApproval, rt, agents, ensureSession, nextSeq: () => ++seqCounter })
        return
      }
      // Default realistic turn completion with streaming + usage
      setTimeout(() => {
        emitSessionEvent(sessionId, { type: 'turn/start', seq: ++seqCounter, time: Date.now(), data: { turn: 1 } })
        emitStream(sessionId, 'Hello ')
        emitStream(sessionId, 'world!')
        emitSessionEvent(sessionId, { type: 'tool/call', seq: ++seqCounter, time: Date.now(), data: { callId: 'c1', name: 'read' } })
        emitSessionEvent(sessionId, { type: 'tool/result', seq: ++seqCounter, time: Date.now(), data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } })
        emitSessionEvent(sessionId, {
          type: 'assistant/message',
          seq: ++seqCounter,
          time: Date.now(),
          data: {
            message: { content: [{ type: 'text', text: `Echo: ${text}` }] },
            usage: { inputTokens: 120, cacheReadTokens: 30, outputTokens: 45 },
          },
        })
        emitSessionEvent(sessionId, { type: 'turn/end', seq: ++seqCounter, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
      }, 10)
    },
  }

  const rt = createRuntime(ctx, { home })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }

  return { home, ctx, rt, prompted, emitSessionEvent, emitStream, triggerApproval, agents, ensureSession, stop }
}

test('REST avatar mutations return validation errors as 400 and retain internal failures as 500', async t => {
  const h = createHarness()
  t.after(h.stop)
  const workspace = { id: 'avatar-workspace', path: join(h.home, 'work') }
  Object.assign(h.ctx.workspaceRegistry, {
    get: () => workspace,
    resolveByPath: async () => workspace,
    create: async () => workspace,
    archiveSession: async () => {},
  })
  let seq = 0
  h.ctx.sessionController.create = async () => {
    const sessionId = `avatar-session-${++seq}`
    h.ensureSession(sessionId)
    return { sessionId }
  }
  h.ctx.sessionController.selectModel = async () => {}
  h.ctx.sessionTitle = { rename: async () => {} }
  h.ctx.llm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
  await h.rt.load()
  const view = await h.rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await h.rt.apiEndpoint('api-token-create', {
    name: 'Avatar manager', scopes: ['team:manage'], confirmHighRisk: true, targetScope: 'all_public',
  })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const mutations = [
    { method: 'POST', path: '/v1/bots', roster: 'createBot', body: { name: 'Avatar Bot' }, state: 'bots' },
    { method: 'PATCH', path: '/v1/bots/b2', roster: 'updateBot', body: {}, state: 'bots', id: 'b2' },
    { method: 'POST', path: '/v1/groups', roster: 'createRoom', body: { name: 'Avatar Group', members: ['b1', 'b2'] }, state: 'rooms' },
    { method: 'PATCH', path: '/v1/groups/r1', roster: 'updateRoom', body: {}, state: 'rooms', id: 'r1' },
  ]
  const request = async (mutation, avatar) => {
    const response = await fetch(`${view.baseUrl}${mutation.path}`, {
      method: mutation.method, headers, body: JSON.stringify({ ...mutation.body, avatar }),
    })
    return { status: response.status, data: await response.json() }
  }
  const invalidImages = [
    'data:image/svg+xml;base64,PHN2Zy8+',
    'not an image URL',
    'data:image/png;base64',
    'data:image/png,AAAA',
    'data:image/png;base64,???',
    'data:image/png;base64,bm90IGFuIGltYWdl',
    'data:image/png;base64,' + 'A'.repeat(200_000),
    42,
  ]
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0KsAAAAASUVORK5CYII='
  for (const mutation of mutations) {
    for (const invalid of invalidImages) {
      const result = await request(mutation, { image: invalid })
      assert.equal(result.status, 400, `${mutation.method} ${mutation.path}: ${JSON.stringify(result.data)}`)
      assert.equal(result.data.error.code, 'api/invalid-avatar')
      assert.match(result.data.error.message, /avatar|image/i)
    }
    const valid = await request(mutation, { image })
    assert.equal(valid.status, mutation.method === 'POST' ? 201 : 200, JSON.stringify(valid.data))
    assert.equal(h.rt.state[mutation.state][valid.data.id].avatar.image, image)
    if (mutation.method === 'POST') mutation.body.name += ' empty'
    const empty = await request(mutation, null)
    assert.equal(empty.status, mutation.method === 'POST' ? 201 : 200, JSON.stringify(empty.data))
    assert.equal(h.rt.state[mutation.state][empty.data.id].avatar, undefined)
    const mock = t.mock.method(h.rt, mutation.roster, async () => { throw new Error('Internal fixture failure') })
    const internal = await request(mutation, { image })
    assert.equal(internal.status, 500)
    assert.equal(internal.data.error.code, 'api/internal-error')
    assert.equal(internal.data.error.message, 'Internal fixture failure')
    mock.mock.restore()
  }
})

test('full REST + SSE + Idempotency + Upload + Memory + Events + MCP + OpenAI compat lifecycle', async (t) => {
  const h = createHarness()
  t.after(h.stop)
  await h.rt.load()

  // Enable on ephemeral port 0 so parallel tests never collide
  const view = await h.rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  assert.equal(view.status, 'running')
  assert.ok(view.baseUrl.startsWith('http://127.0.0.1:'))

  // Endpoint discovery file exists with 0600 permissions and contains no secrets
  const endpointRaw = readFileSync(view.endpointPath, 'utf8')
  const endpoint = JSON.parse(endpointRaw)
  assert.equal(endpoint.baseUrl, view.baseUrl)
  assert.equal(endpoint.mcpUrl, `${view.baseUrl}/mcp`)
  assert.equal(endpoint.token, undefined)
  if (process.platform !== 'win32') {
    assert.equal(statSync(view.endpointPath).mode & 0o777, 0o600)
  }

  // Create a full-scope token (all public targets)
  await h.rt.apiEndpoint('api-set', { openaiCompat: true })
  const { token } = await h.rt.apiEndpoint('api-token-create', {
    name: 'Test Runner',
    scopes: ['read', 'message', 'event:ingest', 'memory:write', 'approval', 'team:manage'],
    confirmHighRisk: true,
    targetScope: 'all_public',
  })
  assert.ok(token.startsWith('dsb_live_'))
  const authHeader = { Authorization: `Bearer ${token}` }

  // 1. Health & capabilities & roster
  const health = await fetch(`${view.baseUrl}/v1/health`, { headers: authHeader }).then(r => r.json())
  assert.equal(health.ok, true)
  assert.equal(health.holdsLock, true)

  const caps = await fetch(`${view.baseUrl}/v1/capabilities`, { headers: authHeader }).then(r => r.json())
  assert.ok(caps.capabilities.includes('mcp.streamable_http'))
  assert.ok(caps.capabilities.includes('compat.openai'))

  const botsRes = await fetch(`${view.baseUrl}/v1/bots`, { headers: authHeader }).then(r => r.json())
  assert.equal(botsRes.bots.length, 2)
  assert.equal(botsRes.bots[0].name, 'Chief')

  const groupsRes = await fetch(`${view.baseUrl}/v1/groups`, { headers: authHeader }).then(r => r.json())
  assert.equal(groupsRes.groups.length, 1)
  assert.equal(groupsRes.groups[0].name, 'Core Team')

  // 2. Synchronous wait message + Idempotency-Key replay + conflict 409
  const sendRes = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ text: 'Check report', wait: 5 }),
  })
  assert.equal(sendRes.status, 200)
  const run1 = await sendRes.json()
  assert.equal(run1.status, 'completed')
  assert.equal(run1.output.text, 'Echo: Check report')
  assert.equal(run1.usage.inputTokens, 120)
  assert.equal(run1.usage.outputTokens, 45)
  assert.equal(run1.usage.calls, 1)

  // Replay with same Idempotency-Key + same payload returns original run without re-prompting
  const beforePrompts = h.prompted.length
  const replayRes = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ text: 'Check report', wait: 5 }),
  })
  assert.equal(replayRes.status, 200)
  const replayed = await replayRes.json()
  assert.equal(replayed.runId, run1.runId)
  assert.equal(h.prompted.length, beforePrompts)

  // Same key with different payload returns 409 Conflict
  const conflictRes = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ text: 'Different body', wait: 5 }),
  })
  assert.equal(conflictRes.status, 409)
  const conflictBody = await conflictRes.json()
  assert.equal(conflictBody.error.code, 'api/idempotency-conflict')

  // 3. Direct SSE streaming on POST /v1/bots/b1/messages
  const sseRes = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text: 'Stream me', stream: true }),
  })
  assert.equal(sseRes.status, 200)
  assert.ok(sseRes.headers.get('content-type').includes('text/event-stream'))
  const sseText = await sseRes.text()
  assert.ok(sseText.includes('event: run.started'))
  assert.ok(sseText.includes('event: delta'))
  assert.ok(sseText.includes('event: tool.call'))
  assert.ok(sseText.includes('event: run.completed'))

  // 4. Upload attachment + send message referencing uploadId
  const uploadRes = await fetch(`${view.baseUrl}/v1/uploads`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'note.txt', mime: 'text/plain', data: Buffer.from('hello file').toString('base64') }),
  })
  assert.equal(uploadRes.status, 201)
  const uploaded = await uploadRes.json()
  assert.ok(uploaded.uploadId.startsWith('upl_'))
  const attachSend = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Read attached', attachments: [{ uploadId: uploaded.uploadId }], wait: 5 }),
  })
  assert.equal(attachSend.status, 200)

  // 5. External event ingest + deduplication + dryRun
  const evRes1 = await fetch(`${view.baseUrl}/v1/events`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': 'nvda-q3' },
    body: JSON.stringify({
      source: 'stock-watcher',
      type: 'earnings.released',
      threadKey: 'NVDA',
      title: 'NVDA Q3',
      summary: 'Revenue +94%',
      payload: { symbol: 'NVDA', eps: 0.81 },
      target: { kind: 'group', id: 'r1' },
    }),
  })
  assert.equal(evRes1.status, 202)
  const ev1 = await evRes1.json()
  assert.equal(ev1.status, 'accepted')
  assert.ok(ev1.ledgerEventId.startsWith('ev_'))

  // Duplicate submission returns 200 duplicate with same ledgerEventId
  const evRes2 = await fetch(`${view.baseUrl}/v1/events`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': 'nvda-q3' },
    body: JSON.stringify({ source: 'stock-watcher', type: 'earnings.released', summary: 'Revenue +94%' }),
  })
  assert.equal(evRes2.status, 200)
  const ev2 = await evRes2.json()
  assert.equal(ev2.status, 'duplicate')
  assert.equal(ev2.ledgerEventId, ev1.ledgerEventId)

  // Dry run event
  const evDry = await fetch(`${view.baseUrl}/v1/events`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'ci', type: 'build', summary: 'dry test', dryRun: true }),
  }).then(r => r.json())
  assert.equal(evDry.status, 'dry_run')

  // 6. Memory CRUD (Bot memory)
  const memAddRes = await fetch(`${view.baseUrl}/v1/bots/b1/memory`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Prefers concise bullet summaries' }),
  })
  assert.equal(memAddRes.status, 201)
  const memAdded = await memAddRes.json()
  assert.ok(memAdded.entry?.id)

  const memRead = await fetch(`${view.baseUrl}/v1/bots/b1/memory?q=bullet`, { headers: authHeader }).then(r => r.json())
  assert.equal(memRead.entries.length, 1)

  const memPatch = await fetch(`${view.baseUrl}/v1/bots/b1/memory/${memAdded.entry.id}`, {
    method: 'PATCH',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Prefers concise bullet summaries with citations' }),
  }).then(r => r.json())
  assert.ok(memPatch.entry.text.includes('citations'))

  const memDel = await fetch(`${view.baseUrl}/v1/bots/b1/memory/${memPatch.entry.id}`, {
    method: 'DELETE',
    headers: authHeader,
  }).then(r => r.json())
  assert.equal(memDel.deleted, true)

  // 7. MCP Streamable HTTP (/mcp): initialize, tools/list, tools/call, resources/list, resources/read
  const mcpInit = await fetch(view.mcpUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0' } } }),
  }).then(r => r.json())
  assert.equal(mcpInit.result.serverInfo.name, 'ds-bot')

  const mcpTools = await fetch(view.mcpUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  }).then(r => r.json())
  const toolNames = mcpTools.result.tools.map(tool => tool.name)
  assert.ok(toolNames.includes('dsbot_list_bots'))
  assert.ok(toolNames.includes('dsbot_send_to_bot'))
  assert.ok(toolNames.includes('dsbot_emit_event'))

  const mcpCall = await fetch(view.mcpUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsbot_send_to_bot', arguments: { bot: 'Chief', text: 'Via MCP', waitSeconds: 5 } } }),
  }).then(r => r.json())
  assert.equal(mcpCall.result.isError, undefined)
  assert.equal(mcpCall.result.structuredContent.status, 'completed')
  assert.equal(mcpCall.result.structuredContent.output.text, 'Echo: Via MCP')

  const mcpRes = await fetch(view.mcpUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'dsbot://team/bots' } }),
  }).then(r => r.json())
  assert.ok(mcpRes.result.contents[0].text.includes('Chief'))

  // 8. OpenAI compatibility layer (/compat/openai/v1/*)
  const oaiModels = await fetch(`${view.baseUrl}/compat/openai/v1/models`, { headers: authHeader }).then(r => r.json())
  assert.ok(oaiModels.data.some(m => m.id === 'dsbot/bot/b1'))
  assert.ok(oaiModels.data.some(m => m.id === 'dsbot/group/r1'))

  const oaiChat = await fetch(`${view.baseUrl}/compat/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'dsbot/bot/b1', messages: [{ role: 'user', content: 'Hello OpenAI compat' }] }),
  })
  assert.equal(oaiChat.status, 200)
  assert.ok(oaiChat.headers.get('x-dsbot-run-id').startsWith('run_'))
  assert.equal(oaiChat.headers.get('x-dsbot-status'), 'completed')
  const oaiBody = await oaiChat.json()
  assert.equal(oaiBody.choices[0].message.content, 'Echo: Hello OpenAI compat')

  // OpenAI streaming SSE
  const oaiStream = await fetch(`${view.baseUrl}/compat/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'dsbot/bot/b1', stream: true, messages: [{ role: 'user', content: 'Stream OAI' }] }),
  })
  assert.equal(oaiStream.status, 200)
  const oaiSseText = await oaiStream.text()
  assert.ok(oaiSseText.includes('chat.completion.chunk'))
  assert.ok(oaiSseText.includes('data: [DONE]'))

  // Disabling OpenAI compat switch returns 404
  await h.rt.apiEndpoint('api-set', { openaiCompat: false })
  const oaiOff = await fetch(`${view.baseUrl}/compat/openai/v1/models`, { headers: authHeader })
  assert.equal(oaiOff.status, 404)

  // 9. Forbidden zone: DELETE /v1/bots/:id is 405, creating private Bot is 400
  const delBot = await fetch(`${view.baseUrl}/v1/bots/b2`, { method: 'DELETE', headers: authHeader })
  assert.equal(delBot.status, 405)
  const privCreate = await fetch(`${view.baseUrl}/v1/bots`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SecretBot', private: true }),
  })
  assert.equal(privCreate.status, 400)
})

test('waiting_human loop: approval scope enforcement, question response, and secret refusal', async (t) => {
  let approvalPromise
  const h = createHarness(undefined, {
    async onPrompt({ sessionId, text, emitSessionEvent, triggerApproval, rt, agents, nextSeq }) {
      emitSessionEvent(sessionId, { type: 'turn/start', seq: nextSeq(), time: Date.now(), data: { turn: 1 } })
      if (text === 'need-approval' || text === 'privacy-outbound' || text === 'privacy-reworded') {
        approvalPromise = triggerApproval({
          agent: agents.get(sessionId),
          toolName: text === 'need-approval' ? 'bash' : 'message_bot',
          privacy: text !== 'need-approval',
          reason: text === 'privacy-outbound' ? 'Let Vault send this to Chief?' : 'Please confirm this operation',
        }).then((outcome) => {
          emitSessionEvent(sessionId, {
            type: 'assistant/message',
            seq: nextSeq(),
            time: Date.now(),
            data: { message: { content: [{ type: 'text', text: `Approval outcome: ${outcome}` }] } },
          })
          emitSessionEvent(sessionId, { type: 'turn/end', seq: nextSeq(), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
        })
      } else if (text === 'need-view') {
        rt.state.views[sessionId] = { id: 'v_1', title: 'Confirm' }
        emitSessionEvent(sessionId, { type: 'turn/end', seq: nextSeq(), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
      } else if (text === 'need-question') {
        rt.state.questions[sessionId] = { id: 'q_1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }
        emitSessionEvent(sessionId, { type: 'turn/end', seq: nextSeq(), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
      } else if (text === 'need-secret') {
        rt.state.secretRequests = { [sessionId]: { id: 'sec_1', name: 'STRIPE_KEY' } }
        emitSessionEvent(sessionId, { type: 'turn/end', seq: nextSeq(), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
      }
    },
  })
  t.after(h.stop)
  await h.rt.load()
  const view = await h.rt.apiEndpoint('api-set', { enabled: true, port: 0 })

  const { token: msgOnlyToken } = await h.rt.apiEndpoint('api-token-create', {
    name: 'MsgOnly',
    scopes: ['read', 'message'],
    targetScope: 'all_public',
  })
  const { token: approveToken } = await h.rt.apiEndpoint('api-token-create', {
    name: 'Approver',
    scopes: ['read', 'message', 'approval'],
    confirmHighRisk: true,
    targetScope: 'all_public',
  })

  // A. Approval card -> waiting_human -> refused without approval scope -> allowed with approval scope
  const r1 = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${msgOnlyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'need-approval', wait: 5 }),
  })
  assert.equal(r1.status, 202)
  const runA = await r1.json()
  assert.equal(runA.status, 'waiting_human')
  assert.equal(runA.pendingAction.kind, 'approval')
  assert.equal(runA.pendingAction.canRespondViaApi, true)

  const respond = (run, body) => fetch(`${view.baseUrl}/v1/runs/${run.runId}/respond`, {
    method: 'POST', headers: { Authorization: `Bearer ${approveToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal((await respond(runA, { choice: 'allow' })).status, 400)
  assert.equal((await respond(runA, { actionId: 'stale', choice: 'allow' })).status, 409)
  const approvalsView = h.rt.approvalsView
  h.rt.approvalsView = () => []
  assert.equal((await respond(runA, { actionId: runA.pendingAction.actionId, choice: 'allow' })).status, 409)
  h.rt.approvalsView = approvalsView

  const denied = await fetch(`${view.baseUrl}/v1/runs/${runA.runId}/respond`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${msgOnlyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: runA.pendingAction.actionId, choice: 'allow' }),
  })
  assert.equal(denied.status, 403)

  const allowed = await fetch(`${view.baseUrl}/v1/runs/${runA.runId}/respond`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${approveToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: runA.pendingAction.actionId, choice: 'allow' }),
  })
  assert.equal(allowed.status, 200)
  await approvalPromise
  const doneA = await fetch(`${view.baseUrl}/v1/runs/${runA.runId}`, { headers: { Authorization: `Bearer ${approveToken}` } }).then(r => r.json())
  assert.equal(doneA.status, 'completed')
  assert.equal(doneA.output.text, 'Approval outcome: allowed-once')

  // B. Question card -> waiting_human -> answered with message scope -> completed
  const r2 = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${msgOnlyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'need-question', wait: 5 }),
  })
  assert.equal(r2.status, 202)
  const runQ = await r2.json()
  assert.equal(runQ.status, 'waiting_human')
  assert.equal(runQ.pendingAction.kind, 'question')

  assert.equal((await respond(runQ, { answer: 'Yes' })).status, 400)
  const question = h.rt.state.questions[runQ.pendingAction.sessionId]
  h.rt.state.questions[runQ.pendingAction.sessionId] = { ...question, id: 'replacement' }
  assert.equal((await respond(runQ, { actionId: runQ.pendingAction.actionId, answer: 'Yes' })).status, 409)
  h.rt.state.questions[runQ.pendingAction.sessionId] = question
  for (const answer of [null, 42, {}, { custom: {} }, { selected: [123] }, { selected: ['Unknown'] }, { selected: ['Yes', 'No'] }, { selected: ['Yes'], extra: true }, 'Unlisted']) {
    assert.equal((await respond(runQ, { actionId: runQ.pendingAction.actionId, answer })).status, 400)
  }

  const ansQ = await fetch(`${view.baseUrl}/v1/runs/${runQ.runId}/respond`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${msgOnlyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: runQ.pendingAction.actionId, answer: 'Yes' }),
  })
  assert.equal(ansQ.status, 200)
  await new Promise(resolve => setTimeout(resolve, 40))
  const doneQ = await fetch(`${view.baseUrl}/v1/runs/${runQ.runId}`, { headers: { Authorization: `Bearer ${msgOnlyToken}` } }).then(r => r.json())
  assert.equal(doneQ.status, 'completed')
  assert.equal(doneQ.output.text, 'Continued after human input.')

  for (const text of ['privacy-outbound', 'privacy-reworded', 'need-view']) {
    const response = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${approveToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, wait: 5 }),
    })
    const run = await response.json()
    assert.equal(response.status, 202)
    assert.equal((await respond(run, {})).status, 400)
    if (text === 'need-view') {
      delete h.rt.state.views[run.pendingAction.sessionId]
      assert.equal((await respond(run, { actionId: run.pendingAction.actionId })).status, 409)
    } else {
      assert.equal(run.pendingAction.canRespondViaApi, false)
      assert.equal((await respond(run, { actionId: run.pendingAction.actionId, choice: 'allow' })).status, 403)
      assert.equal('privacy' in h.rt.approvalsView()[0], false)
      h.rt.answerApproval(run.pendingAction.actionId, 'reject')
      await approvalPromise
    }
  }

  // C. Secret card -> waiting_human with canRespondViaApi: false -> respond refused with 403
  const r3 = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${approveToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'need-secret', wait: 5 }),
  })
  assert.equal(r3.status, 202)
  const runS = await r3.json()
  assert.equal(runS.status, 'waiting_human')
  assert.equal(runS.pendingAction.kind, 'secret')
  assert.equal(runS.pendingAction.canRespondViaApi, false)

  const refuseSecret = await fetch(`${view.baseUrl}/v1/runs/${runS.runId}/respond`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${approveToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: runS.pendingAction.actionId, answer: 'sk-123' }),
  })
  assert.equal(refuseSecret.status, 403)
})

test('group chat multi-member batch settlement collects ordered replies', async (t) => {
  const h = createHarness(undefined, {
    async onPrompt({ sessionId, rt, emitSessionEvent, nextSeq }) {
      const room = rt.roomOf(sessionId)
      if (!room) return
      // Simulate group round active while two members reply in order
      let activeFlag = true
      rt.roomActive = () => activeFlag
      rt.roomWorkView = () => (activeFlag ? { [room.id]: [{ botId: 'b1' }] } : {})
      emitSessionEvent(sessionId, { type: 'tool/call', seq: nextSeq(), time: Date.now(), data: { callId: 'rel_1', name: 'group_relay' } })
      setTimeout(() => {
        room.seq = 1
        room.log.push({ seq: 1, botId: 'b1', who: 'Chief', text: 'Assigning to Analyst', time: Date.now() })
        rt.publishFeed?.('room', { roomId: room.id })
      }, 15)
      setTimeout(() => {
        room.seq = 2
        room.log.push({ seq: 2, botId: 'b2', who: 'Analyst', text: 'Here is the analysis', time: Date.now() })
        activeFlag = false
        emitSessionEvent(sessionId, { type: 'tool/result', seq: nextSeq(), time: Date.now(), data: { message: { toolCallId: 'rel_1', content: [{ type: 'text', text: '{}' }] } } })
        rt.publishFeed?.('room', { roomId: room.id })
      }, 35)
    },
  })
  t.after(h.stop)
  await h.rt.load()
  const view = await h.rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await h.rt.apiEndpoint('api-token-create', {
    name: 'GroupCaller',
    scopes: ['read', 'message'],
    targetScope: 'all_public',
  })

  const res = await fetch(`${view.baseUrl}/v1/groups/r1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Analyze Q3', mentions: ['b2'], wait: 5 }),
  })
  assert.equal(res.status, 200)
  const run = await res.json()
  assert.equal(run.status, 'completed')
  assert.equal(run.output.messages.length, 2)
  assert.equal(run.output.messages[0].name, 'Chief')
  assert.equal(run.output.messages[1].name, 'Analyst')
  assert.ok(run.output.text.includes('Here is the analysis'))
})

test('run cancel, deliverables file download authorization, and global SSE stream filtering', async (t) => {
  const deliverablePath = join(tmpdir(), `dsb-deliv-${Date.now()}.txt`)
  writeFileSync(deliverablePath, 'Quarterly report content')
  t.after(() => rmSync(deliverablePath, { force: true }))

  const h = createHarness({
    version: 1,
    mainBotIds: ['b1'],
    bots: {
      b1: { id: 'b1', name: 'Chief', role: 'Lead', createdAt: 1 },
      b2: { id: 'b2', name: 'Worker', role: 'Dev', createdAt: 2 },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  }, {
    async onPrompt({ sessionId, text, emitSessionEvent, nextSeq }) {
      emitSessionEvent(sessionId, { type: 'turn/start', seq: nextSeq(), time: Date.now(), data: { turn: 1 } })
      if (text === 'slow-cancel') {
        // Stay running until cancelled
        return
      }
      if (text === 'deliver-file') {
        emitSessionEvent(sessionId, {
          type: 'deliverables/presented',
          seq: nextSeq(),
          time: Date.now(),
          data: { files: [{ path: deliverablePath, name: 'report.txt', mime: 'text/plain', size: 24 }] },
        })
        emitSessionEvent(sessionId, {
          type: 'assistant/message',
          seq: nextSeq(),
          time: Date.now(),
          data: { message: { content: [{ type: 'text', text: 'Report ready.' }] } },
        })
        emitSessionEvent(sessionId, { type: 'turn/end', seq: nextSeq(), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
      }
    },
  })
  t.after(h.stop)
  await h.rt.load()
  const view = await h.rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token: b1Token } = await h.rt.apiEndpoint('api-token-create', {
    name: 'B1Only',
    scopes: ['read', 'message'],
    targetScope: 'selected',
    botIds: ['b1'],
  })
  const { token: b2Token } = await h.rt.apiEndpoint('api-token-create', {
    name: 'B2Only',
    scopes: ['read', 'message'],
    targetScope: 'selected',
    botIds: ['b2'],
  })

  // 1. Cancel an in-flight Run
  const slowRes = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${b1Token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'slow-cancel', wait: 0 }),
  })
  assert.equal(slowRes.status, 202)
  const slowRun = await slowRes.json()
  const cancelRes = await fetch(`${view.baseUrl}/v1/runs/${slowRun.runId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${b1Token}` },
  })
  assert.equal(cancelRes.status, 200)
  const cancelled = await cancelRes.json()
  assert.equal(cancelled.status, 'stopped')

  // 2. Deliverables download: authorized token gets bytes, unauthorized token for b1 gets 403
  const delivRes = await fetch(`${view.baseUrl}/v1/bots/b1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${b1Token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'deliver-file', wait: 5 }),
  })
  assert.equal(delivRes.status, 200)
  const delivRun = await delivRes.json()
  assert.equal(delivRun.output.deliverables.length, 1)
  const fileRef = delivRun.output.deliverables[0].fileRef

  const okFile = await fetch(`${view.baseUrl}/v1/files/${fileRef}`, { headers: { Authorization: `Bearer ${b1Token}` } })
  assert.equal(okFile.status, 200)
  assert.equal(await okFile.text(), 'Quarterly report content')

  const forbiddenFile = await fetch(`${view.baseUrl}/v1/files/${fileRef}`, { headers: { Authorization: `Bearer ${b2Token}` } })
  assert.equal(forbiddenFile.status, 403)

  // 3. Global SSE stream: connects, receives hello and filtered events
  const controller = new AbortController()
  const streamRes = await fetch(`${view.baseUrl}/v1/events/stream?botId=b1`, {
    headers: { Authorization: `Bearer ${b1Token}` },
    signal: controller.signal,
  })
  assert.equal(streamRes.status, 200)
  const reader = streamRes.body.getReader()
  const firstChunk = new TextDecoder().decode((await reader.read()).value)
  assert.ok(firstChunk.includes('event: hello'))
  controller.abort()
})
