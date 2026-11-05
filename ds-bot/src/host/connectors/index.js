// Connectors: outside services every Bot can use. One engine mounts each
// connected service's MCP server on the plugin context through the local
// gateway (gateway.js), so every Bot gets mcp__<id>__* tools while credentials
// stay DS Bot secrets that never reach the mcp-client config. OAuth sign-in is
// in oauth.js, the service list in catalog.js, mail in mail/.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CATALOG, entryOf, customId, tokenSecretOf, refreshSecretOf, clientSecretOf, keySecretOf, envSecretOf } from './catalog.js'
import * as oauth from './oauth.js'
import { createGateway } from './gateway.js'
import { install as installMail } from './mail/index.js'
import { CONNECTOR_IDS } from '../capabilities.js'
import { output } from '../tools.js'

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const CHECK_TIMEOUT_MS = 15_000
const SIGN_IN_TIMEOUT_MS = 10 * 60_000
const SECRET_REF = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const MAX_REQUESTS = 20

// Asks GitHub who the token belongs to. Any token GitHub accepts passes.
export async function signIn(token, { api = 'https://api.github.com', fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${api.replace(/\/$/, '')}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach GitHub')
  }
  if (response.status === 401) throw new Error('GitHub did not accept this token')
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const user = await response.json().catch(() => ({}))
  if (typeof user?.login !== 'string') throw new Error('GitHub did not say who this token belongs to')
  return { login: user.login }
}

export function install(rt) {
  const { ctx, state } = rt
  for (const entry of CATALOG) CONNECTOR_IDS.add(entry.id)
  const options = rt.config.github === false ? null : { api: 'https://api.github.com', ...rt.config.github }
  const insecure = (url) => !/^https:\/\//i.test(String(url))
  let stopped = false
  let queue = Promise.resolve()
  const mounts = new Map()
  const statuses = new Map()
  const pendings = new Map()
  const refreshes = new Map()
  const gateways = { gw: null }
  const pluginP = { p: null }

  const entries = () => {
    const list = [...CATALOG.filter(entry => entry.id !== 'github' || options !== null)]
    for (const [id, saved] of Object.entries(state.connectors ?? {})) {
      if (saved?.custom) list.push({ id, name: saved.custom.name, category: 'custom', about: saved.custom.url ?? saved.custom.command ?? '', auth: { kind: 'custom' }, custom: saved.custom })
    }
    return list
  }
  const entryFor = (id) => {
    const catalog = entryOf(id)
    // rt.config.github keeps its url/api overrides from the old single connector.
    if (catalog !== undefined && id === 'github' && options?.url !== undefined) {
      return { ...catalog, remote: { url: options.url } }
    }
    if (catalog !== undefined) return catalog
    const custom = state.connectors?.[id]?.custom
    if (custom !== undefined) return { id, name: custom.name, category: 'custom', about: custom.url ?? custom.command ?? '', auth: { kind: 'custom' }, custom }
    return undefined
  }
  const known = (id) => {
    const entry = entryFor(String(id ?? ''))
    if (entry === undefined || entry.id === 'github' && options === null) throw new Error('No such connector')
    return entry
  }
  const reason = (error) => rt.redactSecrets([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'error').slice(0, 300)

  // --- credentials ------------------------------------------------------

  const credentialOf = (id) => {
    const entry = entryFor(id)
    if (entry === undefined) return undefined
    if (entry.auth.kind === 'none' || entry.auth.kind === 'custom') return {}
    if (entry.auth.kind === 'oauth') {
      const token = rt.secretValue(tokenSecretOf(id))
      return token === undefined ? undefined : { Authorization: `Bearer ${token}` }
    }
    if (entry.auth.kind === 'key') {
      const key = rt.secretValue(keySecretOf(id))
      return key === undefined ? undefined : { key }
    }
    return {}
  }
  const hasCredential = (id) => {
    const entry = entryFor(id)
    if (entry === undefined) return false
    if (entry.custom !== undefined) return true
    if (entry.auth.kind === 'none') return state.connectors?.[id] !== undefined
    return credentialOf(id) !== undefined
  }

  // What the gateway sends upstream for a connector.
  const upstreamOf = (id) => {
    const entry = entryFor(id)
    if (entry === undefined || !hasCredential(id)) return undefined
    let url = entry.custom?.url ?? entry.remote?.url
    if (url === undefined) return undefined
    const headers = { ...(entry.headers ?? {}) }
    const cred = credentialOf(id)
    if (entry.auth.kind === 'oauth' && cred !== undefined) Object.assign(headers, cred)
    if (entry.auth.kind === 'key' && cred !== undefined) {
      if (entry.auth.header) headers[entry.auth.header] = `${entry.auth.prefix ?? ''}${cred.key}`
      else if (entry.auth.query) {
        const parsed = new URL(url)
        parsed.searchParams.set(entry.auth.query, cred.key)
        url = String(parsed)
      }
    }
    if (entry.custom !== undefined) {
      for (const [name, raw] of Object.entries(entry.custom.headers ?? {})) {
        headers[name] = String(raw).replace(SECRET_REF, (_m, n) => rt.secretValue(n) ?? '')
      }
    }
    return { url, headers }
  }

  const gateway = async () => {
    gateways.gw ??= createGateway({
      credential: upstreamOf,
      readOnly: id => state.connectors?.[id]?.readOnly === true,
      onUnauthorized: id => refreshConnector(id),
      log: (...args) => rt.warn(...args),
    })
    await gateways.gw.listen()
    return gateways.gw
  }

  const loadMcpPlugin = async () => {
    pluginP.p ??= (async () => {
      const loader = ctx.get?.('loader')
      if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load connectors')
      const mod = await loader.import(MCP_CLIENT)
      return loader.unwrapExports?.(mod) ?? mod?.default ?? mod
    })()
    return pluginP.p
  }

  const resolveRefs = (value) => String(value).replace(SECRET_REF, (_m, name) => rt.secretValue(name) ?? '')

  async function configFor(id) {
    const entry = entryFor(id)
    if (entry?.custom !== undefined && entry.custom.command !== undefined) {
      const env = {}
      for (const [key, raw] of Object.entries(entry.custom.env ?? {})) env[key] = resolveRefs(raw)
      return { transport: 'stdio', serverName: id, command: entry.custom.command, args: entry.custom.args ?? [], env }
    }
    const gw = await gateway()
    return { transport: 'streamable-http', serverName: id, url: gw.urlFor(id), headers: gw.headers() }
  }

  // A mount fingerprint covers the config a change must re-mount for; access and
  // refresh tokens live in the gateway, so changing one never re-mounts.
  async function fingerprint(id) {
    const config = await configFor(id)
    return JSON.stringify(config)
  }

  const unmount = async (id) => {
    const mount = mounts.get(id)
    mounts.delete(id)
    if (mount?.fiber !== undefined) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }

  async function mountOne(id) {
    const fp = await fingerprint(id)
    if (mounts.get(id)?.fp === fp) return
    await unmount(id)
    statuses.set(id, { state: 'connecting' })
    try {
      const plugin = await loadMcpPlugin()
      if (stopped) return
      const config = { ...(await configFor(id)), failOnStartupError: true }
      const fiber = ctx.plugin(plugin, config)
      const mount = { fp, fiber }
      mounts.set(id, mount)
      await fiber.await()
      if (stopped || mounts.get(id) !== mount) return
      statuses.delete(id)
      settleRequests(id)
    } catch (error) {
      await unmount(id)
      mounts.set(id, { fp })
      statuses.set(id, { state: 'error', error: reason(error) })
      rt.warn('ds-bot: connector %s failed: %s', id, statuses.get(id).error)
    }
  }

  async function reconcile() {
    for (const id of mounts.keys()) {
      if (!hasCredential(id)) await unmount(id)
    }
    for (const entry of entries()) {
      if (entry.id === 'mail' || !hasCredential(entry.id)) continue
      await mountOne(entry.id)
    }
  }
  const sync = (force = false) => {
    queue = queue.then(async () => {
      if (force) { for (const id of mounts.keys()) await unmount(id) }
      await reconcile()
    }).catch(error => rt.warn('ds-bot: connectors: %s', reason(error)))
    return queue
  }

  // --- secrets ----------------------------------------------------------

  const keptSecret = async (name) => { await rt.loadSecrets(); return rt.secretValue(name) !== undefined }
  const writeSecret = async (name, value, purpose) => {
    const kept = await keptSecret(name)
    await rt.secretEndpoint('secret-set', { name, value, purpose, ...(kept ? {} : { scope: [] }) })
  }
  const dropSecrets = async (id) => {
    await rt.loadSecrets()
    for (const name of [tokenSecretOf(id), refreshSecretOf(id), clientSecretOf(id), keySecretOf(id)]) {
      if (id !== 'github' || name === GITHUB_SECRET || name !== tokenSecretOf(id)) {
        if (rt.secretValue(name) !== undefined) await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
    }
  }
  const saveState = async (id, patch) => {
    state.connectors = { ...(state.connectors ?? {}), [id]: { ...state.connectors?.[id], ...patch } }
    await rt.save()
  }

  // --- OAuth sign-in ----------------------------------------------------

  const finishTokens = async (id, entry, tokens) => {
    await writeSecret(tokenSecretOf(id), tokens.access_token, `${entry.name} connector`)
    if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== '') {
      await writeSecret(refreshSecretOf(id), tokens.refresh_token, `${entry.name} connector`).catch(() => {})
    }
    const account = await readAccount(id, entry, tokens.access_token).catch(() => undefined)
    await saveState(id, { account, connectedAt: Date.now(), tokenExpiresAt: Number.isFinite(tokens.expires_in) ? Date.now() + tokens.expires_in * 1000 : undefined })
  }

  async function readAccount(id, entry, token) {
    if (entry.whoami === undefined) return undefined
    if (id === 'github') return (await signIn(token, { api: options.api })).login
    const response = await fetch(entry.whoami.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const body = await response.json().catch(() => ({}))
    return typeof body?.[entry.whoami.field] === 'string' ? body[entry.whoami.field] : undefined
  }

  async function endPending(id, status) {
    const pending = pendings.get(id)
    pendings.delete(id)
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    if (pending?.listener !== undefined) await new Promise(resolve => pending.listener.close(resolve)).catch(() => {})
    if (status !== undefined) statuses.set(id, status)
    else statuses.delete(id)
  }

  // The loopback server for the browser flow: fixed port first, else a random one.
  async function loopback(ready) {
    const listener = createServer((req, res) => {
      req.on('error', () => res.destroy())
      res.on('error', () => req.destroy())
      let url
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { res.writeHead(400); res.end(); return }
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Signed in</title><p style="font-family:sans-serif;margin:3em;text-align:center">Signed in — you can close this tab and go back to DS Bot.</p>')
      void ready({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), iss: url.searchParams.get('iss'), error: url.searchParams.get('error'), errorDescription: url.searchParams.get('error_description') }).catch(error => rt.warn('ds-bot: connector sign-in callback failed: %s', reason(error)))
    })
    listener.on('error', error => {
      if (listener.listening) rt.warn('ds-bot: connector sign-in listener failed: %s', error?.code ?? 'error')
    })
    const listen = port => new Promise((resolve, reject) => {
      const onError = error => { listener.off('listening', onOk); reject(error) }
      const onOk = () => { listener.off('error', onError); resolve() }
      listener.once('error', onError)
      listener.once('listening', onOk)
      listener.listen(port, '127.0.0.1')
    })
    try {
      await listen(oauth.FIXED_CALLBACK_PORT)
      return { listener, fixed: true, redirectUri: `http://127.0.0.1:${oauth.FIXED_CALLBACK_PORT}/callback` }
    } catch {
      await listen(0)
      const port = listener.address().port
      return { listener, fixed: false, redirectUri: `http://127.0.0.1:${port}/callback` }
    }
  }

  async function startBrowserFlow(id, entry, pending) {
    const { listener, fixed, redirectUri } = await loopback(({ code, state, iss, error, errorDescription }) => completeBrowser(id, { code, state, iss, error, errorDescription }))
    const saved = state.connectors?.[id]
    const persist = async (client) => {
      const { clientSecret, ...rest } = client
      if (clientSecret !== undefined) await writeSecret(clientSecretOf(id), clientSecret, `${entry.name} connector`)
      await saveState(id, { client: rest })
    }
    const resolved = await oauth.resolveClient(entry, pending.discovery, redirectUri, fixed, saved?.client ? { ...saved.client, clientSecret: rt.secretValue(clientSecretOf(id)) } : undefined, { persist })
    if (resolved === null) {
      pendings.set(id, { ...pending, listener, redirectUri })
      statuses.set(id, { state: 'needs-client' })
      return
    }
    // Refresh needs to know which client signed in; DCR already persisted its result.
    if (resolved.via !== 'dcr') await saveState(id, { client: { via: resolved.via, clientId: resolved.clientInformation.client_id } })
    const stateParam = randomBytes(16).toString('base64url')
    const { url, codeVerifier } = await oauth.beginBrowser(pending.discovery, resolved.clientInformation, redirectUri, { state: stateParam })
    pendings.set(id, {
      ...pending, kind: 'browser', listener, redirectUri, codeVerifier, expectedState: stateParam,
      clientInformation: resolved.clientInformation,
      row: { kind: 'browser', url },
      timer: setTimeout(() => void expire(id), SIGN_IN_TIMEOUT_MS),
    })
    statuses.set(id, { state: 'connecting' })
  }

  async function expire(id) {
    await endPending(id, { state: 'off', error: 'Sign-in timed out' })
  }

  async function completeBrowser(id, result) {
    const pending = pendings.get(id)
    if (pending === undefined || pending.kind !== 'browser') return
    try {
      if (result.error !== null && result.error !== undefined) throw new Error(result.errorDescription ?? result.error)
      if (result.state !== pending.expectedState) throw new Error('The sign-in answer did not match this attempt (state mismatch). Try again.')
      const entry = entryFor(id)
      const tokens = await oauth.exchange(pending.discovery, pending.clientInformation, { code: result.code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, iss: result.iss ?? undefined })
      await endPending(id)
      await finishTokens(id, entry, tokens)
      await sync(true)
    } catch (error) {
      await endPending(id, { state: 'error', error: reason(error) })
    }
  }

  async function startDeviceFlow(id, entry, pending) {
    const clientId = entry.auth.client.id
    const device = await oauth.deviceBegin(clientId, (entry.auth.scopes ?? []).join(' '), { endpoints: rt.config.github?.endpoints })
    const poll = async () => {
      const current = pendings.get(id)
      if (current === undefined || current.kind !== 'device' || stopped) return
      if (Date.now() >= current.device.expiresAt) { await expire(id); return }
      try {
        const step = await oauth.devicePoll(clientId, current.device, { endpoints: rt.config.github?.endpoints })
        if (step.state === 'done') {
          await endPending(id)
          await writeSecret(GITHUB_SECRET, step.token, 'GitHub connector')
          const account = await readAccount(id, entry, step.token).catch(() => undefined)
          await saveState(id, { account, connectedAt: Date.now() })
          await sync(true)
          return
        }
        if (step.state === 'error') { await endPending(id, { state: 'error', error: reason(step.error) }); return }
        if (step.state === 'slow_down') current.interval += 5
      } catch (error) {
        await endPending(id, { state: 'error', error: reason(error) })
        return
      }
      current.timer = setTimeout(() => void poll(), current.interval * 1000)
    }
    pendings.set(id, {
      ...pending, kind: 'device', device, interval: device.interval,
      row: { kind: 'device', userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt },
      timer: setTimeout(() => void poll(), device.interval * 1000),
    })
  }

  async function beginSignIn(id) {
    const entry = known(id)
    if (entry.auth.kind !== 'oauth') throw new Error('This connector does not sign in')
    if (rt.readOnly() !== undefined) throw new Error(rt.readOnly())
    await rt.loadSecrets()
    if (pendings.has(id)) await endPending(id)
    statuses.set(id, { state: 'connecting' })
    try {
      // GitHub's own flow: device code through github.com, no discovery.
      if (entry.auth.client?.deviceFlow === true) {
        await startDeviceFlow(id, entry, {})
        return
      }
      const remote = entry.remote?.url
      if (remote === undefined) throw new Error('This connector has no server address')
      if (insecure(remote)) throw new Error('Connector addresses must start with https://')
      const discovery = await oauth.discover(remote)
      if (discovery.metadata === undefined) throw new Error('This service does not publish OAuth sign-in metadata')
      state.connectors = { ...(state.connectors ?? {}), [id]: { ...state.connectors?.[id], oauth: { authorizationServerUrl: discovery.authorizationServerUrl, resource: discovery.resource, scope: discovery.scope } } }
      await rt.save()
      await startBrowserFlow(id, entry, { discovery })
    } catch (error) {
      await endPending(id)
      statuses.set(id, { state: 'error', error: reason(error) })
    }
  }

  // One refresh per connector at a time; read-only windows never write.
  function refreshConnector(id) {
    if (refreshes.has(id)) return refreshes.get(id)
    const job = (async () => {
      const saved = state.connectors?.[id]
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) {
        await rt.loadSecrets()
        return false
      }
      const refresh = rt.secretValue(refreshSecretOf(id))
      let path = saved?.client?.via ?? 'inferred'
      if (refresh === undefined || saved?.oauth === undefined) {
        statuses.set(id, { state: 'needs-sign-in' })
        rt.warn('ds-bot: connector %s token refresh failed (client: %s; missing refresh token or OAuth metadata)', id, path)
        return false
      }
      try {
        const discovery = await oauth.rediscover(saved.oauth)
        // Refresh with the client that signed in: catalog → the current catalog id,
        // CIMD → the published document id, DCR/manual → the stored id (+ secret).
        // Rows signed in before clients were persisted have no `client`: fall back to
        // CIMD when the AS supports it, otherwise ask the user to sign in again.
        const via = saved.client?.via
        const clientId = via === 'catalog' ? entryFor(id)?.auth?.client?.id
          : via === 'cimd' ? oauth.CIMD_CLIENT_ID
          : saved.client?.clientId ?? (discovery.metadata?.client_id_metadata_document_supported === true ? oauth.CIMD_CLIENT_ID : undefined)
        const clientVia = via ?? (saved.client?.clientId ? 'manual' : 'cimd')
        if (via === undefined && clientId !== undefined) path = `inferred/${clientVia}`
        if (clientId === undefined) {
          statuses.set(id, { state: 'needs-sign-in' })
          rt.warn('ds-bot: connector %s token refresh failed (client: %s; no OAuth client)', id, path)
          return false
        }
        const secret = rt.secretValue(clientSecretOf(id))
        const client = { client_id: clientId, ...(secret !== undefined ? { client_secret: secret } : {}) }
        const tokens = await oauth.refreshTokens(discovery, client, refresh, { scope: saved.oauth.scope })
        const purpose = `${entryFor(id)?.name ?? id} connector`
        await writeSecret(tokenSecretOf(id), tokens.access_token, purpose)
        if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== '' && tokens.refresh_token !== refresh) {
          // Rotation: the old refresh token stays if this write fails.
          await writeSecret(refreshSecretOf(id), tokens.refresh_token, purpose).catch(() => {})
        }
        await saveState(id, {
          client: { ...saved.client, via: clientVia, clientId },
          tokenExpiresAt: Number.isFinite(tokens.expires_in) ? Date.now() + tokens.expires_in * 1000 : undefined,
        })
        statuses.delete(id)
        rt.warn('ds-bot: connector %s token refresh succeeded (client: %s)', id, path)
        return true
      } catch (error) {
        if (oauth.invalidGrant(error)) statuses.set(id, { state: 'needs-sign-in', error: 'Sign in again' })
        else statuses.set(id, { state: 'error', error: reason(error) })
        rt.warn('ds-bot: connector %s token refresh failed (client: %s; %s)', id, path, oauth.invalidGrant(error) ? 'invalid_grant' : 'refresh error')
        return false
      }
    })().finally(() => refreshes.delete(id))
    refreshes.set(id, job)
    return job
  }

  // --- request cards (request_connector) ---------------------------------

  const requestsOf = (botId) => {
    const requests = (state.connectorRequests ??= {})
    if (!Object.hasOwn(requests, botId) && rt.botOf(botId) === undefined) return []
    return (requests[botId] ??= [])
  }
  const settleRequests = async (id) => {
    const notes = []
    for (const [botId, list] of Object.entries(state.connectorRequests ?? {})) {
      for (const request of list) {
        if (request.status !== 'pending' || request.connectorId !== id) continue
        request.status = 'connected'
        request.settledAt = Date.now()
        const entry = entryFor(id)
        notes.push([botId, `The user connected ${entry?.name ?? id}. Its tools are available as mcp__${id}__* now. Carry on with what you needed it for.`])
      }
    }
    if (notes.length === 0) return
    await rt.save()
    for (const [botId, text] of notes) {
      await rt.deliver({ toId: botId, role: 'connector', text }).catch(error => rt.warn('ds-bot: connector note to %s failed: %s', botId, error))
    }
  }

  rt.teamTools.push(defineTool({
    name: 'list_connectors',
    description: 'List the connectors the team can use: name, what it offers, whether it is connected, and whether you may use it. Connect one for yourself with request_connector.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(self)
      if (!bot) return 'Only Bots on the team can use list_connectors.'
      const rows = entries().filter(entry => entry.id !== 'mail' || mailHasAccounts())
      if (rows.length === 0) return 'No connectors are set up.'
      const lines = rows.map((entry) => {
        const connected = entry.id === 'mail' ? mailHasAccounts() : (statuses.get(entry.id)?.state === undefined && mounts.has(entry.id)) || hasCredential(entry.id)
        const usable = !offFor(entry.id).includes(bot.id)
        return `- ${entry.name} (${entry.id}) — ${entry.about} — ${connected ? 'connected' : 'not connected'}${usable ? '' : '; turned off for you'}`
      })
      return ['Connectors:', ...lines].join('\n')
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'request_connector',
    description: 'Ask the user to connect an outside service through a card in your own chat, when you need a service that is not connected. The card shows a Connect button; your turn ends and a note arrives when the user connects or dismisses it. If the connector is already connected, this just tells you its tool prefix.',
    parameters: {
      id: { type: 'string', required: true, description: 'Connector id from list_connectors' },
      purpose: { type: 'string', required: true, description: 'One short line for the user: what you need it for' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = String(args.id ?? '').trim()
      const entry = id === 'mail' ? entryOf('mail') : entryFor(id)
      if (entry === undefined) return `No connector named ${id}.`
      const agentId = exec.agent?.id
      const bot = rt.botOf(rt.selfOf(agentId))
      if (bot === undefined) return 'Only Bots on the team can use request_connector.'
      const connected = id === 'mail' ? mailHasAccounts() : hasCredential(id)
      const signIn = statuses.get(id)?.state === 'needs-sign-in'
      if (connected && !signIn && !offFor(id).includes(bot.id)) return `${entry.name} is already connected; use its tools (mcp__${id}__*).`
      if (offFor(id).includes(bot.id)) return `${entry.name} is turned off for you. The user can turn it on in your details.`
      if (rt.groupOwners.has(agentId)) return 'Connector cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_connector there.'
      if (!rt.chatOwners.has(agentId)) return 'Connector cards only work in your current own chat.'
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`
      const list = requestsOf(bot.id)
      const now = Date.now()
      for (const request of list) if (request.status === 'pending' && request.connectorId === id) { request.status = 'canceled'; request.settledAt = now }
      list.push({
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        sessionId: agentId,
        connectorId: id,
        name: entry.name,
        purpose: String(args.purpose ?? '').trim().slice(0, 300),
        status: 'pending',
        askedAt: now,
      })
      while (list.length > MAX_REQUESTS) { const at = list.findIndex(entry => entry.status !== 'pending'); list.splice(at === -1 ? 0 : at, 1) }
      await rt.save()
      exec.concludeTurn?.()
      return `The card asking the user to connect ${entry.name} is on screen. A note arrives when the user connects or dismisses it.`
    },
  }))

  const offFor = id => state.connectors?.[id]?.offFor ?? []

  // --- import -------------------------------------------------------------

  const importFiles = () => {
    const home = homedir()
    const appData = platform() === 'win32' ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming')) : null
    const files = [
      { source: 'claude', key: 'mcpServers', path: platform() === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : platform() === 'win32' ? join(appData, 'Claude', 'claude_desktop_config.json') : join(home, '.config', 'Claude', 'claude_desktop_config.json') },
      { source: 'cursor', key: 'mcpServers', path: join(home, '.cursor', 'mcp.json') },
      { source: 'vscode', key: 'servers', path: platform() === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json') : platform() === 'win32' ? join(appData, 'Code', 'User', 'mcp.json') : join(home, '.config', 'Code', 'User', 'mcp.json') },
    ]
    return files
  }
  const importScan = async () => {
    const found = []
    for (const file of importFiles()) {
      let parsed
      try { parsed = JSON.parse(await readFile(file.path, 'utf8')) } catch { continue }
      const servers = parsed?.[file.key]
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) continue
      for (const [name, spec] of Object.entries(servers)) {
        if (spec === null || typeof spec !== 'object') continue
        const url = typeof spec.url === 'string' ? spec.url : typeof spec.serverUrl === 'string' ? spec.serverUrl : undefined
        const command = typeof spec.command === 'string' ? spec.command : undefined
        if (url === undefined && command === undefined) continue
        found.push({
          source: file.source,
          name,
          ...(url !== undefined ? { url } : { command, args: Array.isArray(spec.args) ? spec.args.filter(arg => typeof arg === 'string') : [] }),
          envNames: Object.keys(spec.env ?? {}),
          headersNames: Object.keys(spec.headers ?? {}),
        })
      }
    }
    return found
  }
  const importPick = async (items) => {
    const scanned = await importScan()
    const wanted = new Set((Array.isArray(items) ? items : []).map(item => `${item?.source ?? ''}:${item?.name ?? ''}`))
    const picked = []
    for (const file of importFiles()) {
      let parsed
      try { parsed = JSON.parse(await readFile(file.path, 'utf8')) } catch { continue }
      const servers = parsed?.[file.key] ?? {}
      for (const [name, spec] of Object.entries(servers)) {
        if (!wanted.has(`${file.source}:${name}`) || spec === null || typeof spec !== 'object') continue
        if (scanned.some(entry => entry.source === file.source && entry.name === name)) picked.push({ name, spec })
      }
    }
    return picked
  }

  // --- view & endpoints ---------------------------------------------------

  const rowFor = (entry) => {
    const saved = state.connectors?.[entry.id]
    const status = statuses.get(entry.id)
    const connected = hasCredential(entry.id)
    const remote = entry.custom === undefined || entry.custom.url !== undefined
    const state_ = status?.state ?? (connected && mounts.has(entry.id) ? 'ready' : connected ? 'connecting' : 'off')
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      about: entry.about,
      auth: entry.auth,
      state: state_,
      ...(status?.error !== undefined ? { error: status.error } : {}),
      account: saved?.account ?? (id => id === 'github' ? saved?.login : undefined)(entry.id) ?? null,
      ...(remote && connected && entry.auth.kind !== 'none' ? { readOnly: saved?.readOnly === true } : {}),
      ...(remote && connected && (entry.auth.kind === 'oauth' || entry.auth.kind === 'key') ? { readOnly: saved?.readOnly === true } : {}),
      offFor: saved?.offFor ?? [],
      tools: gateways.gw?.toolCount?.(entry.id) ?? 0,
      ...(entry.custom !== undefined ? { custom: true } : {}),
      ...(pendings.has(entry.id) ? { pending: pendings.get(entry.id).row } : {}),
    }
  }

  const connectorsView = () => ({
    connectors: entries().filter(entry => entry.id !== 'mail').map(rowFor),
    mail: rt.mailView?.() ?? { accounts: [], google: false },
  })

  const endpoints = {
    async 'connector-connect'(body) {
      const entry = known(body.id)
      if (entry.id === 'github' && options === null) throw new Error('No such connector')
      if (entry.auth.kind === 'none') {
        await saveState(entry.id, { connectedAt: Date.now() })
        await sync()
        return connectorsView()
      }
      if (entry.auth.kind === 'key') {
        const key = typeof body.key === 'string' ? body.key.trim() : ''
        if (key === '') throw new Error('Paste a key first')
        const remote = entry.remote?.url
        if (remote !== undefined && insecure(remote)) throw new Error('Connector addresses must start with https://')
        await writeSecret(keySecretOf(entry.id), key, `${entry.name} connector`)
        await saveState(entry.id, { connectedAt: Date.now() })
        await sync()
        return connectorsView()
      }
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token !== '') {
        const remote = entry.remote?.url
        if (remote !== undefined && insecure(remote)) throw new Error('Connector addresses must start with https://')
        if (entry.id === 'github' && options?.api !== undefined && insecure(options.api)) throw new Error('GitHub addresses must start with https://')
        await rt.loadSecrets()
        let account
        if (entry.id === 'github') account = (await signIn(token, { api: options.api })).login
        else if (entry.whoami !== undefined) account = await readAccount(entry.id, entry, token)
        await writeSecret(tokenSecretOf(entry.id), token, `${entry.name} connector`)
        await saveState(entry.id, { account, ...(entry.id === 'github' ? { login: account } : {}), connectedAt: Date.now() })
        await sync()
        return connectorsView()
      }
      if (entry.id === 'github' && (entry.auth.client?.id ?? '') === '') throw new Error('Paste a token first')
      await beginSignIn(entry.id)
      return connectorsView()
    },
    async 'connector-disconnect'(body) {
      const entry = known(body.id)
      await endPending(entry.id)
      await dropSecrets(entry.id)
      if (state.connectors?.[entry.id] !== undefined) {
        delete state.connectors[entry.id]
        await rt.save()
      }
      gateways.gw?.forget(entry.id)
      await sync()
      return connectorsView()
    },
    async 'connector-retry'(body) {
      const entry = known(body.id)
      statuses.delete(entry.id)
      await rt.loadSecrets()
      await sync(true)
      return connectorsView()
    },
    async 'connector-cancel'(body) {
      const entry = known(body.id)
      await endPending(entry.id, { state: hasCredential(entry.id) ? 'ready' : 'off' })
      return connectorsView()
    },
    async 'connector-sign-in-code'(body) {
      const entry = known(body.id)
      const pending = pendings.get(entry.id)
      if (pending === undefined || pending.kind !== 'browser') throw new Error('No sign-in is waiting')
      const input = String(body.input ?? body.code ?? '').trim()
      if (input === '') throw new Error('Paste the address or the code')
      let code = input, stateParam, iss
      if (/^https?:\/\//i.test(input)) {
        const url = new URL(input)
        code = url.searchParams.get('code') ?? ''
        stateParam = url.searchParams.get('state')
        iss = url.searchParams.get('iss') ?? undefined
        if (stateParam !== pending.expectedState) throw new Error('This address is not from this sign-in attempt (state mismatch). Copy the whole address again.')
      }
      if (code === '') throw new Error('The address has no code')
      await completeBrowser(entry.id, { code, state: pending.expectedState, iss })
      return connectorsView()
    },
    async 'connector-client'(body) {
      const entry = known(body.id)
      const clientId = String(body.clientId ?? '').trim()
      if (clientId === '') throw new Error('Enter the client ID')
      const clientSecret = typeof body.clientSecret === 'string' && body.clientSecret.trim() !== '' ? body.clientSecret.trim() : undefined
      if (clientSecret !== undefined) await writeSecret(clientSecretOf(entry.id), clientSecret, `${entry.name} connector`)
      await saveState(entry.id, { client: { via: 'manual', clientId } })
      const pending = pendings.get(entry.id)
      if (pending !== undefined && pending.discovery !== undefined) {
        await startBrowserFlow(entry.id, entry, pending)
      }
      return connectorsView()
    },
    async 'connector-set'(body) {
      const entry = known(body.id)
      const patch = {}
      if (body.readOnly !== undefined) patch.readOnly = body.readOnly === true
      if (Array.isArray(body.offFor)) patch.offFor = [...new Set(body.offFor.filter(id => rt.botOf(id) !== undefined))]
      await saveState(entry.id, patch)
      rt.reapplyToolMasks?.()
      return connectorsView()
    },
    async 'connector-add'(body) {
      const name = String(body.name ?? '').trim()
      if (name === '') throw new Error('Name the connector')
      const url = typeof body.url === 'string' ? body.url.trim() : undefined
      const command = typeof body.command === 'string' ? body.command.trim() : undefined
      if (url !== undefined && insecure(url) && !/^http:\/\/(localhost|127\.)/i.test(url)) throw new Error('Connector addresses must start with https://')
      if (url === undefined && command === undefined) throw new Error('Enter an address or a command')
      const taken = new Set(Object.keys(state.connectors ?? {}))
      const id = customId(name, taken)
      CONNECTOR_IDS.add(id)
      const custom = url !== undefined
        ? { name, url, headers: body.headers && typeof body.headers === 'object' ? body.headers : {} }
        : { name, command, args: Array.isArray(body.args) ? body.args.map(String) : [], env: body.env && typeof body.env === 'object' ? body.env : {} }
      await saveState(id, { custom, connectedAt: Date.now() })
      await sync(true)
      return connectorsView()
    },
    async 'connector-remove'(body) {
      const entry = known(body.id)
      if (entry.custom === undefined) throw new Error('Only added connectors can be removed')
      await endpoints['connector-disconnect']({ id: entry.id })
      return connectorsView()
    },
    async 'connector-import-scan'() {
      return importScan()
    },
    async 'connector-import'(body) {
      const picked = await importPick(body.items)
      const created = []
      for (const { name, spec } of picked) {
        const taken = new Set(Object.keys(state.connectors ?? {}))
        const id = customId(name, taken)
        const custom = { name }
        if (typeof spec.url === 'string' || typeof spec.serverUrl === 'string') {
          custom.url = spec.url ?? spec.serverUrl
          custom.headers = {}
          for (const [header, raw] of Object.entries(spec.headers ?? {})) {
            const secretName = envSecretOf(id, `HEAD_${header}`)
            await writeSecret(secretName, String(raw), `${name} connector`)
            custom.headers[header] = `$DSH_SECRET_${secretName}`
          }
        } else if (typeof spec.command === 'string') {
          custom.command = spec.command
          custom.args = Array.isArray(spec.args) ? spec.args.map(String) : []
          custom.env = {}
          for (const [envName, raw] of Object.entries(spec.env ?? {})) {
            const secretName = envSecretOf(id, envName)
            await writeSecret(secretName, String(raw), `${name} connector`)
            custom.env[envName] = `$DSH_SECRET_${secretName}`
          }
        } else continue
        await saveState(id, { custom, connectedAt: Date.now() })
        created.push(id)
      }
      await sync(true)
      return { view: connectorsView(), created }
    },
    async 'connector-request-cancel'(body) {
      const found = (() => {
        for (const [botId, list] of Object.entries(state.connectorRequests ?? {})) {
          const request = list.find(entry => entry.id === String(body.requestId ?? ''))
          if (request !== undefined) return { botId, request }
        }
        return undefined
      })()
      if (found === undefined) throw new Error('This request is gone')
      if (found.request.status !== 'pending') throw new Error('This request was already answered')
      found.request.status = 'canceled'
      found.request.settledAt = Date.now()
      await rt.save()
      await rt.deliver({ toId: found.botId, role: 'connector', text: `The user dismissed your request to connect ${entryFor(found.request.connectorId)?.name ?? found.request.connectorId}. Carry on without it, or tell the user what you cannot do without it.` }).catch(() => {})
      return true
    },
  }

  const mailApi = installMail(rt, { entries: () => entries().find(e => e.id === 'mail'), offFor, secrets: { writeSecret, value: name => rt.secretValue(name) }, reason })
  const mailHasAccounts = () => mailApi.hasAccounts()
  rt.mailView = mailApi.mailView

  const connectorEndpoint = async (endpoint, body) => {
    await rt.loadSecrets()
    if (endpoint.startsWith('mail-')) return mailApi.endpoint(endpoint, body)
    return endpoints[endpoint](body ?? {})
  }

  ctx.on('tools/change', () => { rt.reapplyToolMasks?.() })

  ctx.effect(() => {
    stopped = false
    void rt.load().then(() => rt.loadSecrets()).then(() => sync())
    return () => {
      stopped = true
      for (const pending of pendings.values()) if (pending.timer !== undefined) clearTimeout(pending.timer)
      for (const pending of pendings.values()) pending.listener?.close()
      pendings.clear()
      const closing = [...mounts.values()].map(mount => Promise.resolve().then(() => mount.fiber?.dispose()).catch(() => {}))
      mounts.clear()
      const gw = gateways.gw
      gateways.gw = null
      return Promise.all([...closing, gw?.close(), mailApi.dispose()])
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, {
    connectorsView,
    connectorEndpoint,
    connectorOffFor: (botId) => {
      const prefixes = []
      for (const entry of entries()) {
        if (!offFor(entry.id).includes(botId)) continue
        if (entry.id === 'mail') prefixes.push('mail_')
        else prefixes.push(`mcp__${entry.id}__`)
      }
      return prefixes
    },
    connectorSettleRequests: settleRequests,
    secretsChanged: () => { void sync() },
    connectorsInternals: { mounts, statuses, pendings, gateways, refreshConnector, upstreamOf },
  })
}
