import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { createChatGPTStore } from './chatgpt-store.mjs'

const RESOURCE = 'https://api.openai.com/v1'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
const random = () => randomBytes(32).toString('base64url')
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class ChatGPTSignInError extends Error {
  constructor(state, code = 'request-failed') {
    super('ChatGPT sign-in could not complete. Please check the connection status.')
    this.name = 'ChatGPTSignInError'
    this.state = state
    this.code = code
  }
}

export async function createChatGPTSignIn({ userData, safeStorage, fs, platform,
  fetch: fetcher = globalThis.fetch, discoveryUrl = 'https://auth.openai.com/.well-known/openid-configuration',
  endpoints = {}, now = Date.now, timeoutMs = 5 * 60_000, onChange = () => {},
}) {
  const store = createChatGPTStore({ userData, safeStorage, fs, platform })
  let record
  let state = 'signed-out'
  let publish = () => {}
  const setState = next => { state = next; publish() }
  let refreshInFlight
  let activeSignIn
  let signingOut = false
  let credentialWriteFailed = false
  let queue = Promise.resolve()
  const exclusive = work => {
    const result = queue.then(work)
    queue = result.catch(() => {})
    return result
  }
  const fail = (next, code) => { setState(next); return new ChatGPTSignInError(next, code) }
  const supported = () => {
    if (!store.supported()) throw fail('unsupported', 'secure-storage-unavailable')
  }
  try {
    if (!store.supported()) state = 'unsupported'
    else record = await store.read()
  } catch { state = 'temporarily-unavailable' }
  const connectionState = () => record?.tokens ? (record.tokens.scopes.includes(PLAN_SCOPE) ? 'connected' : 'plan-usage-off')
    : record?.needsSignIn ? 'needs-sign-in' : 'signed-out'
  if (record) state = connectionState()
  const save = async next => {
    supported()
    try { await store.write(next) } catch {
      credentialWriteFailed = true
      throw fail('temporarily-unavailable', 'secure-storage-failed')
    }
    credentialWriteFailed = false
    record = next
  }
  const clearTokens = async needsSignIn => {
    if (!record) return
    const { tokens: _tokens, ...mapping } = record
    await save({ ...mapping, needsSignIn })
  }
  const status = () => ({
    state: store.supported() ? state : 'unsupported',
    ...(record?.account ? { account: {
      ...(typeof record.account.email === 'string' ? { email: record.account.email } : {}),
      ...(typeof record.account.name === 'string' ? { name: record.account.name } : {}),
    } } : {}),
    ...(record?.tokens ? { planUsage: record.tokens.scopes.includes(PLAN_SCOPE), expiresAt: record.tokens.expiresAt } : {}),
  })
  let published
  publish = () => {
    const next = status()
    const key = JSON.stringify(next)
    if (key === published) return
    published = key
    try { onChange(next) } catch {}
  }
  const recoverConnection = () => { if (state === 'temporarily-unavailable') setState(connectionState()) }
  const endpoint = value => {
    try {
      const url = new URL(value)
      const testingLoopback = new URL(discoveryUrl).protocol === 'http:' && new URL(discoveryUrl).hostname === '127.0.0.1'
      if (url.username || url.password || url.hash || (url.protocol !== 'https:'
        && !(testingLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error()
      return url.href
    } catch { throw fail('temporarily-unavailable', 'invalid-endpoint') }
  }
  const request = async (url, options = {}) => {
    try {
      return await fetcher(endpoint(url), { ...options, redirect: 'manual',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    } catch (error) {
      if (error instanceof ChatGPTSignInError) throw error
      throw fail('temporarily-unavailable', 'network-error')
    }
  }
  const json = async response => {
    try { return await response.json() } catch { throw fail('temporarily-unavailable', 'invalid-response') }
  }
  const success = response => {
    if (!response.ok) throw fail('temporarily-unavailable', response.status >= 300 && response.status < 400 ? 'redirect-refused' : 'http-error')
  }
  const discover = async signal => {
    const response = await request(discoveryUrl, { signal })
    success(response)
    const config = { ...await json(response), ...endpoints }
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) endpoint(config[field])
    return config
  }
  const post = (url, fields, signal) => request(url, { method: 'POST', signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  const validateIdentity = async (token, config, clientId, nonce, signal) => {
    try {
      if (typeof token !== 'string') throw new Error()
      const parts = token.split('.')
      if (parts.length !== 3) throw new Error()
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'))
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'))
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw new Error()
      const response = await request(config.jwks_uri, { signal })
      success(response)
      const { keys } = await json(response)
      const matches = keys.filter(key => key.kid === header.kid && key.kty === 'RSA'
        && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'))
      if (matches.length !== 1) throw new Error()
      const key = createPublicKey({ key: matches[0], format: 'jwk' })
      if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error()
      const seconds = now() / 1000
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (claims.iss !== config.issuer || !audience.includes(clientId)
        || (audience.length > 1 && claims.azp !== clientId)
        || !Number.isFinite(claims.exp) || claims.exp <= seconds - 60
        || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.iat >= claims.exp
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60))
        || typeof claims.sub !== 'string' || !claims.sub
        || (nonce !== undefined && !equal(claims.nonce, nonce))) throw new Error()
      if (record?.subject && record.subject !== claims.sub) throw new Error()
      return claims
    } catch (error) {
      if (error instanceof ChatGPTSignInError) throw error
      throw fail('needs-sign-in', 'invalid-identity')
    }
  }
  const tokenSet = (body, previous) => {
    if (!body || typeof body.access_token !== 'string' || !body.access_token
      || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(body.expires_in) || body.expires_in <= 0
      || (body.refresh_token !== undefined && (typeof body.refresh_token !== 'string' || !body.refresh_token))
      || (body.scope !== undefined && typeof body.scope !== 'string')) throw fail('temporarily-unavailable', 'invalid-token-response')
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? previous?.refreshToken,
      idToken: body.id_token ?? previous?.idToken,
      scopes: body.scope === undefined ? previous?.scopes ?? [] : body.scope.split(/\s+/u).filter(Boolean),
      expiresAt: now() + body.expires_in * 1000 }
  }
  const signIn = ({ openExternal, signal, consent = false } = {}) => {
    if (activeSignIn) return Promise.reject(new ChatGPTSignInError('signing-in', 'already-signing-in'))
    const controller = new AbortController()
    activeSignIn = controller
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    return exclusive(async () => {
      supported()
      if (state === 'temporarily-unavailable' && !record) throw fail(state, 'secure-storage-failed')
      setState('signing-in')
      let server
      let removeAbort = () => {}
      try {
        combined.throwIfAborted()
        if (!record) await save({ version: 1, hostId: `urn:uuid:${randomUUID()}` })
        const config = await discover(combined)
        if (record.issuer && record.issuer !== config.issuer) throw fail('needs-sign-in', 'issuer-changed')
        const stateValue = random()
        const nonce = random()
        const verifier = random()
        let settle
        const callback = new Promise(resolve => { settle = resolve })
        let used = false
        server = createServer((req, res) => {
          const respond = statusCode => { res.writeHead(statusCode, { 'content-type': 'text/plain', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer' }); res.end('Return to DS Bot to continue.') }
          if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${server.address()?.port}`
            || !req.url.startsWith('/auth/callback?')) { respond(400); return }
          const url = new URL(req.url, 'http://127.0.0.1')
          if (url.pathname !== '/auth/callback' || used) { respond(400); return }
          used = true
          const params = url.searchParams
          if ([...params.keys()].some(key => params.getAll(key).length !== 1) || !equal(params.get('state'), stateValue)) {
            respond(400); settle({ error: 'invalid-callback' }); return
          }
          respond(200)
          settle(params.has('error') ? { error: 'authorization-declined' } : { code: params.get('code'), clientId: params.get('client_id') })
        })
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
        const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
        const authorization = new URL(config.authorization_endpoint)
        const params = { response_type: 'code', client_id: record.clientId ?? 'dynamic_agent_client', scope: SCOPES,
          resource: RESOURCE, redirect_uri: redirectUri, state: stateValue, nonce,
          code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ext_agent_host_id: record.hostId }
        if (!record.clientId) params.agent_name_hint = 'DS Bot'
        else {
          if (record.tokens?.idToken) params.id_token_hint = record.tokens.idToken
          if (record.account?.email) params.login_hint = record.account.email
        }
        if (consent) params.prompt = 'consent'
        for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value)
        const result = await new Promise((resolve, reject) => {
          const abort = () => reject(new ChatGPTSignInError(connectionState(), 'sign-in-cancelled'))
          combined.addEventListener('abort', abort, { once: true })
          removeAbort = () => combined.removeEventListener('abort', abort)
          if (combined.aborted) abort()
          else Promise.resolve().then(() => openExternal(authorization.href)).then(() => callback).then(resolve, () => reject(new ChatGPTSignInError(connectionState(), 'browser-failed')))
        })
        combined.throwIfAborted()
        if (result.error || !result.code) throw fail(connectionState(), 'invalid-callback')
        const clientId = result.clientId ?? record.clientId
        if (!clientId || clientId === 'dynamic_agent_client' || (record.clientId && clientId !== record.clientId)) throw fail('needs-sign-in', 'invalid-client')
        if (!record.clientId) await save({ ...record, clientId })
        const response = await post(config.token_endpoint, { grant_type: 'authorization_code', client_id: clientId,
          code: result.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, combined)
        success(response)
        const body = await json(response)
        const claims = await validateIdentity(body?.id_token, config, clientId, nonce, combined)
        const tokens = tokenSet(body)
        if (!tokens.refreshToken) throw fail('needs-sign-in', 'missing-refresh-token')
        combined.throwIfAborted()
        await save({ ...record, clientId, issuer: config.issuer, subject: claims.sub,
          account: { ...(typeof claims.email === 'string' ? { email: claims.email } : {}), ...(typeof claims.name === 'string' ? { name: claims.name } : {}) }, tokens, needsSignIn: false })
        setState(connectionState())
        return status()
      } catch (error) {
        if (combined.aborted) throw fail(connectionState(), 'sign-in-cancelled')
        if (error instanceof ChatGPTSignInError) { setState(error.state); throw error }
        throw fail(connectionState(), 'sign-in-failed')
      } finally {
        removeAbort()
        if (server) { server.close(); server.closeAllConnections() }
      }
    }).finally(() => { activeSignIn = undefined })
  }
  const refresh = () => {
    refreshInFlight ??= exclusive(async () => {
      supported()
      if (credentialWriteFailed) throw fail('temporarily-unavailable', 'secure-storage-failed')
      if (!record?.tokens?.refreshToken || state === 'needs-sign-in') throw fail('needs-sign-in', 'sign-in-required')
      const config = await discover()
      if (record.issuer !== config.issuer) throw fail('needs-sign-in', 'issuer-changed')
      const response = await post(config.token_endpoint, { grant_type: 'refresh_token', client_id: record.clientId,
        refresh_token: record.tokens.refreshToken, resource: RESOURCE })
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const body = await json(response)
          if (TERMINAL.has(body?.error)) { await clearTokens(true); throw fail('needs-sign-in', 'refresh-rejected') }
        }
        success(response)
      }
      const body = await json(response)
      if (body?.id_token !== undefined) await validateIdentity(body.id_token, config, record.clientId)
      const tokens = tokenSet(body, record.tokens)
      await save({ ...record, tokens, needsSignIn: false })
      setState(connectionState())
      return status()
    }).finally(() => { refreshInFlight = undefined })
    return refreshInFlight
  }
  const getAccessToken = async () => {
    supported()
    if (credentialWriteFailed) throw fail('temporarily-unavailable', 'secure-storage-failed')
    if (signingOut || !record?.tokens || state === 'needs-sign-in' || state === 'signing-in') throw new ChatGPTSignInError(state, 'sign-in-required')
    if (refreshInFlight) await refreshInFlight
    if (signingOut || !record?.tokens) throw new ChatGPTSignInError(state, 'sign-in-required')
    if (record.tokens.expiresAt - now() < 5 * 60_000) await refresh()
    if (signingOut || !record?.tokens) throw new ChatGPTSignInError(state, 'sign-in-required')
    recoverConnection()
    if (!record.tokens.scopes.includes(PLAN_SCOPE)) throw fail('plan-usage-off', 'plan-usage-required')
    return record.tokens.accessToken
  }
  const signOut = () => {
    signingOut = true
    activeSignIn?.abort()
    return exclusive(async () => {
      supported()
      let revoked = false
      try {
        if (record?.tokens?.refreshToken) {
          const config = await discover()
          if (record.issuer !== config.issuer) throw fail('needs-sign-in', 'issuer-changed')
          const response = await post(config.revocation_endpoint, { token: record.tokens.refreshToken,
            token_type_hint: 'refresh_token', client_id: record.clientId })
          revoked = response.status === 200
        }
      } catch {}
      await clearTokens(false)
      setState('signed-out')
      return { ...status(), remoteRevocationConfirmed: revoked }
    }).finally(() => { signingOut = false })
  }
  const listModels = async () => {
    const token = await getAccessToken()
    const response = await request(endpoints.models_endpoint ?? `${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` } })
    success(response)
    const body = await json(response)
    if (!Array.isArray(body?.models)) throw fail('temporarily-unavailable', 'invalid-models')
    recoverConnection()
    return body.models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && typeof model.display_name === 'string')
      .map(model => ({ id: model.slug, name: model.display_name }))
  }
  return { signIn, refresh, signOut, getAccessToken, listModels, status }
}
