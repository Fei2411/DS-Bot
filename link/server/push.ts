import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PushNotifyPayload } from '../src/frames.ts'

export interface PushForwardResult {
  ok: boolean
  gone?: boolean
  code?: string
}

export type PushForwarder = (request: PushNotifyPayload) => Promise<PushForwardResult>

export interface FcmServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

export function loadFcmServiceAccount(rawOrPath: string, projectOverride?: string): FcmServiceAccount {
  const text = rawOrPath.trim().startsWith('{') ? rawOrPath : readFileSync(rawOrPath, 'utf8')
  const parsed = JSON.parse(text) as Partial<FcmServiceAccount>
  const projectId = (projectOverride || parsed.project_id || '').trim()
  if (!projectId || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new Error('Invalid FCM service account configuration.')
  }
  return {
    project_id: projectId,
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: typeof parsed.token_uri === 'string' && parsed.token_uri ? parsed.token_uri : DEFAULT_TOKEN_URI,
  }
}

/**
 * Zero-dependency FCM HTTP v1 forwarder. Sends only data-only opaque encrypted
 * envelopes (`v`, `h`, `p`); FCM never receives plaintext message content.
 */
export function createFcmForwarder(
  account: FcmServiceAccount,
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): PushForwarder {
  const fetchFn = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  let cachedToken: { value: string; expiresAt: number } | undefined

  async function accessToken(): Promise<string> {
    if (cachedToken !== undefined && now() < cachedToken.expiresAt - 60_000) return cachedToken.value
    const iat = Math.floor(now() / 1000)
    const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI
    const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' })
    const claim = base64UrlJson({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })
    const unsigned = `${header}.${claim}`
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')
    const response = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`FCM auth failed (${response.status})`)
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown }
    if (typeof data.access_token !== 'string' || data.access_token === '') throw new Error('FCM auth returned no token')
    const ttlSec = typeof data.expires_in === 'number' && data.expires_in > 60 ? data.expires_in : 3600
    cachedToken = { value: data.access_token, expiresAt: now() + ttlSec * 1000 }
    return cachedToken.value
  }

  return async (request) => {
    try {
      const token = await accessToken()
      const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: request.token,
            data: {
              v: String(request.envelope.v),
              h: request.envelope.h,
              p: request.envelope.p,
            },
            android: {
              priority: request.urgency === 'high' ? 'HIGH' : 'NORMAL',
              ttl: '86400s',
            },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) return { ok: true }
      const body = await response.text().catch(() => '')
      const gone = response.status === 404 || body.includes('UNREGISTERED')
      return { ok: false, gone, code: gone ? 'UNREGISTERED' : `HTTP_${response.status}` }
    } catch {
      return { ok: false, code: 'PUSH_FAILED' }
    }
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}
