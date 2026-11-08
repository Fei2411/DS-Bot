// An added MCP server that signs in with OAuth. The catalog path is covered in
// connectors-engine.test.js; this file is only about the flag a user sets when
// adding a server, and about the rows that have no flag.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { createRuntime } = await import('../index.js')
const { fakeContext } = await import('./fake-ctx.js')
const oauth = await import('../src/host/connectors/oauth.js')

const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}
const teamHome = (extra = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-custom-oauth-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, ...extra }))
  return home
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const AS = {
  issuer: 'https://as.test',
  authorization_endpoint: 'https://as.test/auth',
  token_endpoint: 'https://as.test/token',
  registration_endpoint: 'https://as.test/register',
  client_id_metadata_document_supported: true,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
}

test('an added server signs in with OAuth, and the ones added before do not change', async (t) => {
  const home = teamHome({ connectors: { legacy: { custom: { name: 'Legacy', url: 'https://legacy.test/mcp', headers: { 'X-Team': 'one' } } } } })
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const rowOf = async (id) => (await rt.connectorsView()).connectors.find(entry => entry.id === id)

  // A row added before the flag keeps its fixed header, mounts, and never signs in.
  await rt.connectorEndpoint('connector-add', { name: 'Fixed', url: 'https://fixed.test/mcp', headers: { Authorization: 'Bearer K' } })
  for (const id of ['legacy', 'fixed']) {
    assert.equal((await rowOf(id)).auth.kind, 'custom', `${id} stays a fixed-header server`)
    assert.deepEqual(rt.connectorsInternals.upstreamOf(id).headers, id === 'legacy' ? { 'X-Team': 'one' } : { Authorization: 'Bearer K' })
  }
  assert.equal((await rt.connectorEndpoint('connector-set', { id: 'fixed', readOnly: true })).connectors.find(entry => entry.id === 'fixed').readOnly, true)

  // With the flag the row is an OAuth connector carrying the address, and Connect
  // reaches discovery instead of refusing with "does not sign in".
  const view = await rt.connectorEndpoint('connector-add', { name: 'Simular Box', url: 'https://mcp.box.simular.ai/mcp', oauth: true })
  const id = view.connectors.find(row => row.name === 'Simular Box').id
  assert.equal(view.connectors.find(row => row.id === id).auth.kind, 'oauth')
  assert.equal(rt.state.connectors[id].custom.oauth, true)
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    url = String(url?.url ?? url)
    seen.push(url)
    if (url.includes('oauth-authorization-server')) return json(AS)
    return new Response('', { status: 401 })
  }
  t.after(() => { globalThis.fetch = real })
  await rt.connectorEndpoint('connector-connect', { id })
  const status = rt.connectorsInternals.statuses.get(id)
  assert.equal(status?.state, 'connecting', JSON.stringify(status))
  assert.ok(seen.includes('https://mcp.box.simular.ai/mcp'), 'discovery probes the address the user typed')
  const pending = rt.connectorsInternals.pendings.get(id)
  assert.equal(pending.kind, 'browser')
  assert.equal(new URL(pending.row.url).searchParams.get('client_id'), oauth.CIMD_CLIENT_ID)
  // The saved metadata is what a later refresh rediscovers the authorization server from.
  assert.equal(rt.state.connectors[id].oauth.resource, 'https://mcp.box.simular.ai/mcp')
  assert.equal((await rowOf(id)).readOnly, undefined, 'no read-only switch before the first token')
  await rt.connectorEndpoint('connector-cancel', { id })

  // Where there is no address to sign in to, the user sets a fixed header instead.
  await assert.rejects(rt.connectorEndpoint('connector-add', { name: 'Spawn', command: 'npx -y mcp', oauth: true }), /OAuth sign-in needs an address/)
  assert.equal(rt.state.connectors.spawn, undefined)
})
