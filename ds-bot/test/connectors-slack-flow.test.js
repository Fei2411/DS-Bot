// The Slack-shaped OAuth flow end to end, as a user meets it: the service only
// takes a hand-typed client (no CIMD, no DCR), the browser answers on the
// loopback address, and the token request must sign with the client secret.
// The steps a user retries -- reopen the form, sign in again -- must keep one
// callback address, or Slack refuses the redirect the app has configured.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const AS_ORIGIN = 'https://mcp.slack.test'
const TOKEN_URL = `${AS_ORIGIN}/api/oauth.v2.access`
const CLIENT_ID = '126049596329.1234567890'
const CLIENT_SECRET = 'slack-client-secret'
const CODE = 'slack-auth-code'
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const portOf = uri => new URL(uri).port
const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-slack-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

// A Slack-shaped AS: pre-registered clients only, and ok:false errors so a
// missing secret reads exactly as Slack reports it.
const slackServer = () => {
  const tokens = []
  const metadata = {
    issuer: AS_ORIGIN,
    authorization_endpoint: `${AS_ORIGIN}/oauth/v2/authorize`,
    token_endpoint: TOKEN_URL,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }
  const answer = async request => {
    const form = new URLSearchParams(await request.text())
    const basic = request.headers.get('authorization') ?? ''
    let clientId = form.get('client_id')
    let secret = form.get('client_secret')
    if (basic.toLowerCase().startsWith('basic ')) {
      const [id, pass] = Buffer.from(basic.slice(6), 'base64').toString().split(':')
      clientId = clientId ?? id
      secret = secret ?? (pass === '' ? undefined : pass)
    }
    tokens.push({ clientId, secret, redirectUri: form.get('redirect_uri'), grant: form.get('grant_type') })
    if (secret === undefined) return json({ ok: false, error: 'bad_client_secret' })
    if (clientId !== CLIENT_ID || secret !== CLIENT_SECRET) return json({ ok: false, error: 'bad_client_secret' })
    if (form.get('grant_type') === 'refresh_token') return json({ ok: true, access_token: 'xoxp-TEST-REFRESHED', token_type: 'Bearer', expires_in: 3600 })
    if (form.get('code') !== CODE) return json({ ok: false, error: 'invalid_code' })
    return json({ ok: true, access_token: 'xoxp-TEST-OK', token_type: 'Bearer', scope: 'channels:read', expires_in: 3600, refresh_token: 'xoxe-1-TEST' })
  }
  const fetch = async (url, init = {}) => {
    url = String(url?.url ?? url)
    if (url === `${AS_ORIGIN}/mcp`) return new Response('', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${AS_ORIGIN}/.well-known/oauth-protected-resource"` } })
    if (url.includes('oauth-protected-resource')) return json({ resource: AS_ORIGIN, authorization_servers: [AS_ORIGIN], scopes_supported: ['channels:read'] })
    if (url.includes('oauth-authorization-server')) return json(metadata)
    if (url === TOKEN_URL) return answer(new Request(url, init))
    return new Response('not found', { status: 404 })
  }
  return { fetch, tokens }
}

const within = async (check, timeout = 5000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

const setup = async (t) => {
  const server = slackServer()
  const real = globalThis.fetch
  // 127.0.0.1 is the loopback the browser actually answers on: leave it alone.
  const local = url => String(url?.url ?? url).startsWith('http://127.0.0.1:')
  globalThis.fetch = (url, init) => local(url) ? real(url, init) : server.fetch(url, init)
  t.after(() => { globalThis.fetch = real })
  const home = teamHome()
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors?.slack ?? {}
  return { rt, internals: rt.connectorsInternals, tokens: server.tokens, saved }
}

test('a hand-typed Slack client signs the token request and the flow connects', async (t) => {
  const { rt, internals, tokens, saved } = await setup(t)

  // Slack publishes no registration and no client-metadata support: the row asks
  // for the client the Slack app already has.
  await rt.connectorEndpoint('connector-connect', { id: 'slack' })
  assert.equal(internals.statuses.get('slack').state, 'needs-client')
  const form = internals.pendings.get('slack')
  assert.equal(form.kind, undefined)
  assert.match(form.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  await rt.connectorEndpoint('connector-client', { id: 'slack', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  const pending = internals.pendings.get('slack')
  assert.equal(pending.kind, 'browser')
  assert.deepEqual(pending.clientInformation, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET })

  // The browser comes back on the loopback address the authorize URL named.
  const back = new URL(pending.redirectUri)
  back.searchParams.set('code', CODE)
  back.searchParams.set('state', pending.expectedState)
  const page = await fetch(back)
  assert.equal(page.status, 200)

  // Mounting the real server cannot run here, so that failure is expected: only
  // an attempt that stored nothing counts as finished.
  const done = () => Number.isFinite(saved().connectedAt)
    || (internals.statuses.get('slack')?.state === 'error' && rt.secretValue('CONNECTOR_SLACK_TOKEN') === undefined)
  assert.ok(await within(done))
  assert.doesNotMatch(String(internals.statuses.get('slack')?.error ?? ''), /bad_client_secret|invalid_client/)
  // The root cause of bad_client_secret: the secret never reached the token request.
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].secret, CLIENT_SECRET)
  assert.equal(tokens[0].clientId, CLIENT_ID)
  assert.equal(tokens[0].redirectUri, pending.redirectUri)
  assert.equal(rt.secretValue('CONNECTOR_SLACK_TOKEN'), 'xoxp-TEST-OK')
  assert.equal(rt.secretValue('CONNECTOR_SLACK_REFRESH'), 'xoxe-1-TEST')
  // A later refresh needs the same client and its secret.
  assert.equal(saved().client?.via, 'manual')
  assert.equal(saved().client?.clientId, CLIENT_ID)
  assert.equal(saved().oauth?.authorizationServerUrl, AS_ORIGIN)
  assert.equal(rt.secretValue('CONNECTOR_SLACK_CLIENT_SECRET'), CLIENT_SECRET)
})

test('reopening the form replaces the listener instead of squatting the callback port', async (t) => {
  const { rt, internals } = await setup(t)
  await rt.connectorEndpoint('connector-connect', { id: 'slack' })
  const first = internals.pendings.get('slack')
  // A leak shows up here: the replaced attempt keeps the port, so the next one
  // cannot have the same address.
  await rt.connectorEndpoint('connector-client', { id: 'slack', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(first.listener.listening, false)
  assert.equal(first.listener.address(), null)
  const second = internals.pendings.get('slack')
  assert.equal(second.kind, 'browser')
  // A second retry replaces a browser attempt, whose timeout must not survive to
  // end the attempt that took its place.
  await rt.connectorEndpoint('connector-client', { id: 'slack', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(second.listener.listening, false)
  assert.equal(second.timer._destroyed, true)
  const third = internals.pendings.get('slack')
  if (portOf(first.redirectUri) !== String(oauth.FIXED_CALLBACK_PORT)) {
    // Something else on this host holds the documented port: the flow keeps one
    // fallback address (see the engine test), which is not this test's subject.
    t.skip('the fixed callback port is in use on this host')
    return
  }
  assert.equal(portOf(second.redirectUri), String(oauth.FIXED_CALLBACK_PORT))
  assert.equal(portOf(third.redirectUri), String(oauth.FIXED_CALLBACK_PORT))
  // And the sign-in still finishes from that address.
  const back = new URL(third.redirectUri)
  back.searchParams.set('code', CODE)
  back.searchParams.set('state', third.expectedState)
  await fetch(back)
  assert.ok(await within(() => rt.secretValue('CONNECTOR_SLACK_TOKEN') !== undefined))
})
