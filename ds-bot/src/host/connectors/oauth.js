// OAuth sign-in for connectors, on the official MCP SDK auth helpers. Discovery:
// an unauthenticated request → 401 WWW-Authenticate → protected-resource
// metadata (well-known fallback; AS metadata on the MCP origin for older
// servers) → AS metadata. Client: catalog → CIMD → DCR → needs-client.
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractWWWAuthenticateParams,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  IssuerMismatchError,
} from '@modelcontextprotocol/client'

const TIMEOUT_MS = 20_000
// The loopback port the client-metadata document at this address may name.
export const FIXED_CALLBACK_PORT = 38517
export const CIMD_CLIENT_ID = 'https://dsbot.app/oauth/client.json'

const timed = (request = fetch) => (url, init) => request(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) })

const https = (url, what) => {
  if (!/^https:\/\//i.test(String(url))) throw new Error(`${what} addresses must start with https://`)
}

// Probes the MCP server and resolves the authorization server and its metadata.
export async function discover(serverUrl, { fetch: request = fetch, originFallback = true } = {}) {
  const send = timed(request)
  https(serverUrl, 'Connector')
  let challenge = {}
  try {
    const probe = await send(serverUrl, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: '{}' })
    if (probe.status === 401 || probe.status === 403) challenge = extractWWWAuthenticateParams(probe)
  } catch { /* discovery below still tries the well-known paths */ }
  let resourceMetadata
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: challenge.resourceMetadataUrl }, send)
  } catch { resourceMetadata = undefined }
  // Older servers publish AS metadata on the MCP origin with no protected-resource doc.
  const asUrl = resourceMetadata?.authorization_servers?.[0] ?? (originFallback ? new URL(serverUrl).origin : serverUrl)
  let metadata
  try {
    metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn: send })
  } catch (error) {
    if (error instanceof IssuerMismatchError) metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn: send, skipIssuerValidation: true }).catch(() => undefined)
  }
  const scope = challenge.scope ?? resourceMetadata?.scopes_supported?.join(' ')
  return {
    authorizationServerUrl: String(asUrl),
    metadata,
    resourceMetadata,
    scope,
    // RFC 8707: the resource parameter always goes out; the PRM's own id wins.
    resource: resourceMetadata?.resource ?? String(serverUrl),
  }
}

// Picks how this attempt identifies itself to the AS. Returns {clientInformation,
// via, store} or null when nothing works — the row then shows the client form.
// `stored` is the client state saved last time; `persist` writes DCR results.
export async function resolveClient(entry, discovery, redirectUri, fixedPort, stored, { fetch: request = fetch, persist } = {}) {
  const catalogClient = entry.auth?.client?.id
  if (catalogClient) return { via: 'catalog', clientInformation: { client_id: catalogClient } }
  if (stored?.clientId) {
    const expired = Number.isFinite(stored.secretExpiresAt) && stored.secretExpiresAt * 1000 <= Date.now()
    const uriMissing = Array.isArray(stored.redirectUris) && !stored.redirectUris.includes(redirectUri)
    // A stored CIMD client still needs the fixed port its document names.
    if (!expired && !uriMissing && stored.via === 'cimd' && fixedPort) return { via: 'cimd', clientInformation: { client_id: stored.clientId } }
    if (!expired && !uriMissing && stored.via !== 'dcr' && stored.via !== 'cimd') return { via: stored.via, clientInformation: { client_id: stored.clientId } }
    if (!expired && !uriMissing && stored.via === 'dcr') return { via: 'dcr', clientInformation: { client_id: stored.clientId, ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}) } }
  }
  const metadata = discovery.metadata
  if (metadata?.client_id_metadata_document_supported === true && fixedPort) {
    return { via: 'cimd', clientInformation: { client_id: CIMD_CLIENT_ID } }
  }
  if (typeof metadata?.registration_endpoint === 'string') {
    const clientMetadata = {
      client_name: 'DS Bot',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
    const full = await registerClient(discovery.authorizationServerUrl, { metadata, clientMetadata, scope: discovery.scope, fetchFn: timed(request) })
    const info = {
      via: 'dcr',
      clientId: full.client_id,
      clientSecret: full.client_secret,
      redirectUris: full.redirect_uris ?? [redirectUri],
      secretExpiresAt: full.client_secret_expires_at,
    }
    await persist?.(info)
    return { via: 'dcr', clientInformation: { client_id: full.client_id, ...(full.client_secret ? { client_secret: full.client_secret } : {}) } }
  }
  return null
}

// Browser PKCE: the SDK makes the S256 verifier and the URL.
export async function beginBrowser(discovery, clientInformation, redirectUri, { state, scope } = {}) {
  const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.metadata,
    clientInformation,
    redirectUrl: redirectUri,
    scope: scope ?? discovery.scope,
    state,
    resource: discovery.resource,
  })
  return { url: String(authorizationUrl), codeVerifier }
}

export async function exchange(discovery, clientInformation, { code, codeVerifier, redirectUri, iss }, { fetch: request = fetch } = {}) {
  return exchangeAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.metadata,
    clientInformation,
    authorizationCode: code,
    iss,
    codeVerifier,
    redirectUri,
    resource: discovery.resource,
    fetchFn: timed(request),
  })
}

const invalidGrant = (error) => {
  for (const field of [error?.error, error?.code, error?.name]) {
    if (typeof field === 'string' && /invalid_grant/i.test(field)) return true
  }
  return /invalid_grant/i.test(String(error?.message ?? error))
}
export { invalidGrant }

export async function refreshTokens(discovery, clientInformation, refreshToken, { scope, fetch: request = fetch } = {}) {
  return refreshAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.metadata,
    clientInformation,
    refreshToken,
    scope: scope ?? discovery.scope,
    resource: discovery.resource,
    fetchFn: timed(request),
  })
}

// Re-discovers AS metadata for a stored authorization server (after a restart).
export async function rediscover(stored, { fetch: request = fetch } = {}) {
  const send = timed(request)
  const metadata = await discoverAuthorizationServerMetadata(stored.authorizationServerUrl, { fetchFn: send }).catch(() => undefined)
  return { authorizationServerUrl: stored.authorizationServerUrl, metadata, resource: stored.resource, scope: stored.scope }
}

// --- GitHub device flow -------------------------------------------------

const post = async (send, url, params) => {
  const response = await send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

export async function deviceBegin(clientId, scope, { fetch: request = fetch, endpoints } = {}) {
  const send = timed(request)
  const codeUrl = endpoints?.deviceCode ?? 'https://github.com/login/device/code'
  const { status, body } = await post(send, codeUrl, { client_id: clientId, ...(scope ? { scope } : {}) })
  if (status !== 200 || typeof body.device_code !== 'string') throw new Error(body.error_description ?? `Device sign-in was refused (${status})`)
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? 'https://github.com/login/device',
    interval: Number(body.interval) || 5,
    expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
  }
}

// One poll step. Returns {state:'pending'|'slow_down'|'done'|'error', ...}.
export async function devicePoll(clientId, device, { fetch: request = fetch, endpoints } = {}) {
  const send = timed(request)
  const tokenUrl = endpoints?.accessToken ?? 'https://github.com/login/oauth/access_token'
  const { status, body } = await post(send, tokenUrl, {
    client_id: clientId,
    device_code: device.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  if (status === 200 && typeof body.access_token === 'string') return { state: 'done', token: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in }
  const error = body.error
  if (error === 'authorization_pending') return { state: 'pending' }
  if (error === 'slow_down') return { state: 'slow_down' }
  return { state: 'error', error: body.error_description ?? error ?? `Sign-in failed (${status})` }
}
