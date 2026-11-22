import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { discoverEndpoint } from '../bin/ds-bot-cli.mjs'

test('endpoint discovery refuses non-loopback URLs before credentials are sent', t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-discovery-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  for (const baseUrl of ['http://127.attacker.example', 'http://127.0.0.1.evil.com', 'http://localhost.evil', 'https://localhost', 'http://127.1', 'http://user@localhost', 'invalid']) {
    writeFileSync(join(home, 'api-endpoint.json'), JSON.stringify({ baseUrl }))
    assert.throws(() => discoverEndpoint({ home }), /endpoint/i)
    assert.throws(() => discoverEndpoint({ endpoint: baseUrl }), /endpoint/i)
  }
  for (const baseUrl of ['http://127.0.0.1:17830', 'http://localhost:17830', 'http://[::1]:17830']) {
    writeFileSync(join(home, 'api-endpoint.json'), JSON.stringify({ baseUrl }))
    assert.equal(discoverEndpoint({ home }).baseUrl, baseUrl)
  }
  writeFileSync(join(home, 'api-endpoint.json'), JSON.stringify({ baseUrl: 'http://localhost', mcpUrl: 'http://evil.example/mcp' }))
  assert.throws(() => discoverEndpoint({ home }), /endpoint/i)
})

const CLI_PATH = fileURLToPath(new URL('../bin/ds-bot-cli.mjs', import.meta.url))

function startApiServer() {
  const home = mkdtempSync(join(tmpdir(), 'dsb-apicli-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    bots: { b1: { id: 'b1', name: 'Chief', role: 'Chief of Staff', createdAt: 1 } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    revision: 1,
  }))
  const ctx = fakeContext()
  ctx.workspaceRegistry = { get: () => undefined, list: () => [] }
  ctx.sessions = { flush: async () => {}, rename: async () => {} }
  let seq = 1
  ctx.sessionController = {
    resolveAgent: async sid => ({ agent: { id: sid, session: { id: sid, header: { cwd: home }, snapshotEvents: () => [] }, followup() {}, cancel() {} } }),
    page: async () => ({ records: [], hasMore: false }),
    prompt: async ({ requestId, sessionId, content }) => {
      const text = (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      for (const listener of ctx.listeners.get('session/event') ?? []) {
        listener({ id: sessionId }, { type: 'user/message', seq: ++seq, time: Date.now(), data: { content, source: { kind: 'user', rpcId: requestId } } })
      }
      setTimeout(() => {
        for (const listener of ctx.listeners.get('session/event') ?? []) {
          listener({ id: sessionId }, { type: 'turn/start', seq: ++seq, time: Date.now(), data: { turn: 1 } })
          listener({ id: sessionId }, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'text', text: `CLI Reply: ${text}` }] } } })
          listener({ id: sessionId }, { type: 'turn/end', seq: ++seq, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
        }
      }, 10)
    },
  }
  const rt = createRuntime(ctx, { home })
  return {
    home,
    ctx,
    rt,
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('ds-bot CLI subcommands (health, bots, send, event, mcp stdio bridge) work end to end', async (t) => {
  const h = startApiServer()
  t.after(h.stop)
  await h.rt.load()
  await h.rt.apiEndpoint('api-set', { enabled: true, port: 0 })
  const { token } = await h.rt.apiEndpoint('api-token-create', {
    name: 'CLI User',
    scopes: ['read', 'message', 'event:ingest'],
    targetScope: 'all_public',
  })

  const env = { ...process.env, DS_BOT_HOME: h.home, DS_BOT_API_TOKEN: token }
  const runCli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })

  // 1. health
  const health = await runCli(['health', '--json'])
  assert.equal(health.code, 0, health.stderr)
  assert.equal(JSON.parse(health.stdout).ok, true)

  // 2. bots
  const bots = await runCli(['bots', '--json'])
  assert.equal(bots.code, 0, bots.stderr)
  assert.equal(JSON.parse(bots.stdout).bots[0].name, 'Chief')

  // 3. send --wait
  const sent = await runCli(['send', '--bot', 'Chief', '--text', 'ping cli', '--wait', '5', '--json'])
  assert.equal(sent.code, 0, sent.stderr)
  const run = JSON.parse(sent.stdout)
  assert.equal(run.status, 'completed')
  assert.equal(run.output.text, 'CLI Reply: ping cli')

  // 4. event
  const ev = await runCli(['event', '--source', 'ci', '--type', 'deploy', '--summary', 'v1 deployed', '--dry-run', '--json'])
  assert.equal(ev.code, 0, ev.stderr)
  assert.equal(JSON.parse(ev.stdout).status, 'dry_run')

  // 5. ds-bot mcp stdio bridge: real JSON-RPC handshake + tools/list + tools/call over stdin/stdout
  const mcpResponses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, 'mcp'], { env })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`mcp exited ${code}: ${err}`))
      else resolve(out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'stdio-test', version: '1.0' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsbot_list_bots', arguments: {} } })}\n`)
    child.stdin.end()
  })

  const byId = Object.fromEntries(mcpResponses.map(msg => [msg.id, msg]))
  assert.equal(byId[1].result.serverInfo.name, 'ds-bot')
  assert.ok(byId[2].result.tools.some(tool => tool.name === 'dsbot_send_to_bot'))
  assert.equal(byId[2].result.tools.some(tool => tool.name === 'dsbot_write_memory'), false, 'scope without memory:write hides dsbot_write_memory')
  assert.equal(byId[3].result.structuredContent.bots[0].name, 'Chief')

  // 6. ds-bot-mcp compatibility shim honors DSBOT_MCP_TOKEN and --url
  const mcpShimPath = fileURLToPath(new URL('../bin/ds-bot-mcp.mjs', import.meta.url))
  const shimResponses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpShimPath, '--url', h.rt.apiView().mcpUrl], {
      env: { ...process.env, DSBOT_MCP_TOKEN: token },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ds-bot-mcp exited ${code}: ${err}`))
      else resolve(out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'dsbot_list_bots', arguments: {} } })}\n`)
    child.stdin.end()
  })
  assert.equal(shimResponses[0].result.structuredContent.bots[0].name, 'Chief')

  // 7. doctor subcommand delegation still works
  const doc = spawnSync(process.execPath, [CLI_PATH, 'doctor', '--home', h.home, '--dsh-version', '0.2.2-rc.1'], { encoding: 'utf8' })
  assert.equal(doc.status, 0, doc.stderr)
  assert.ok(doc.stdout.includes('ds-bot doctor:'))
})
