// QQ open platform: an app access token from appId+secret, then a Discord-like
// gateway (hello, heartbeat, identify, resume, reconnect, invalid session) for
// C2C and group @ messages. Sends are passive replies carrying the inbound
// msg_id with an incrementing msg_seq; outside the reply window the platform
// refuses and the reason is permanent. No buttons — the core numbers choices.
// Wire details ported from @tencent-connect/qqbot-nodejs (MIT, see NOTICE).
import { chunkMarkdown } from '../format.js'
import { retryDelay, retryWait } from './retry.js'

const API = 'https://api.sgroup.qq.com'
const TOKEN_API = 'https://bots.qq.com'
const TEXT_LIMIT = 2000
// GROUP_AND_C2C covers C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE.
const INTENTS = 1 << 25

const apiBase = env => String(env.config?.api ?? API).replace(/\/+$/, '')
const tokenBase = env => String(env.config?.token ?? TOKEN_API)

const getToken = async (fields, env) => {
  const response = await env.fetch(`${tokenBase(env)}/app/getAppAccessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: String(fields.appId ?? '').trim(), clientSecret: String(fields.appSecret ?? '').trim() }),
  })
  const body = await response.json().catch(() => ({}))
  if (body.access_token === undefined) {
    const error = new Error(body.error_reason ?? body.error ?? 'QQ refused these credentials')
    // A refusal is not fixed by trying again; a server or network failure is.
    error.permanent = response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)
    throw error
  }
  return { token: body.access_token, expiresAt: Date.now() + Math.max(10, Number(body.expires_in ?? 7200) - 300) * 1000 }
}

export default {
  id: 'qq',

  async check(fields, env) {
    const { token } = await getToken(fields, env)
    const me = await api(env, token, '/users/@me', { method: 'GET' }).catch(() => ({}))
    return { account: { id: String(fields.appId).trim(), name: me?.username ? `@${me.username}` : String(fields.appId).trim() } }
  },

  connect(fields, env, handlers) {
    let stopped = false
    let socket
    let token
    let expiresAt = 0
    let refreshTimer
    let heartbeatTimer
    let heartbeatAcked = true
    let reconnectTimer
    let generation = 0
    let sequence
    let sessionId
    // Passive replies reuse the inbound msg_id with a msg_seq that climbs
    // per id — outside the window the platform refuses (permanent).
    const msgSeq = new Map()
    const lastMsgId = new Map()

    const send = packet => { if (socket?.readyState === 1) socket.send(JSON.stringify(packet)) }
    const heartbeat = () => send({ op: 1, d: sequence ?? null })
    const scheduleHeartbeat = (interval) => {
      clearTimeout(heartbeatTimer)
      heartbeatAcked = true
      const beat = () => {
        if (!heartbeatAcked) { socket?.close(4000, 'Heartbeat lost'); return }
        heartbeatAcked = false
        heartbeat()
        heartbeatTimer = setTimeout(beat, interval)
        heartbeatTimer.unref?.()
      }
      heartbeatTimer = setTimeout(beat, interval)
      heartbeatTimer.unref?.()
    }

    const refresh = () => {
      const wait = Math.max(5_000, expiresAt - Date.now() - 60_000)
      refreshTimer = setTimeout(async () => {
        if (stopped) return
        try {
          const next = await getToken(fields, env)
          token = next.token
          expiresAt = next.expiresAt
        } catch (error) {
          env.log?.warn?.('ds-bot im: qq token refresh failed: %s', error?.message ?? error)
        }
        refresh()
      }, wait)
      refreshTimer.unref?.()
    }

    const onDispatch = async (packet) => {
      if (packet.t === 'READY') {
        sessionId = packet.d?.session_id
        handlers.onStatus({ state: 'ready', account: { id: String(fields.appId).trim(), name: packet.d?.user?.username ? `@${packet.d.user.username}` : String(fields.appId).trim() } })
        return
      }
      if (packet.t === 'RESUMED') { handlers.onStatus({ state: 'ready' }); return }
      const c2c = packet.t === 'C2C_MESSAGE_CREATE'
      const group = packet.t === 'GROUP_AT_MESSAGE_CREATE'
      if (!c2c && !group) return
      const d = packet.d ?? {}
      const key = String(c2c ? d.author?.user_openid ?? d.channel_id ?? '' : d.group_openid ?? d.channel_id ?? '')
      lastMsgId.set(key, String(d.id ?? ''))
      const sender = c2c ? d.author?.user_openid : d.author?.member_openid ?? d.author?.id
      await handlers.onMessage({
        chat: { key, kind: c2c ? 'direct' : 'group', title: '' },
        sender: { id: String(sender ?? ''), name: String(sender ?? '') },
        text: String(d.content ?? '').trim(),
        images: [], files: [],
        mentioned: group, messageId: String(d.id ?? ''),
      })
    }

    let openFailures = 0
    const open = (resume) => {
      const gen = generation
      try {
        socket = new env.WebSocket(gatewayUrl)
        openFailures = 0
      } catch (error) {
        // A socket that cannot be built yet is retried like a dropped one; the
        // connection is not over (#1119).
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'retrying', error: `QQ could not open a socket: ${error?.message ?? error}` })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped) open(resume) }, retryDelay(openFailures))
        reconnectTimer.unref?.()
        openFailures += 1
        return
      }
      socket.addEventListener('message', (event) => {
        if (stopped || generation !== gen) return
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        if (Number.isSafeInteger(packet.s)) sequence = packet.s
        if (packet.op === 10) {
          scheduleHeartbeat(Number(packet.d?.heartbeat_interval) || 40_000)
          send(resume && sessionId
            ? { op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: sequence ?? null } }
            : { op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1], properties: { os: process.platform, browser: 'ds-bot', device: 'ds-bot' } } })
          return
        }
        if (packet.op === 11) { heartbeatAcked = true; return }
        if (packet.op === 1) { heartbeat(); return }
        if (packet.op === 7) { socket.close(4000, 'Reconnect requested'); return }
        if (packet.op === 9) {
          if (packet.d !== true) { sessionId = undefined; sequence = undefined }
          socket.close(4000, 'Invalid session')
          return
        }
        if (packet.op === 0) void onDispatch(packet).catch(error => env.log?.warn?.('ds-bot im: qq event failed: %s', error?.message ?? error))
      })
      socket.addEventListener('close', () => {
        clearTimeout(heartbeatTimer)
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'connecting' })
        reconnectTimer = setTimeout(() => { if (!stopped) open(sessionId !== undefined) }, 2000)
        reconnectTimer.unref?.()
      })
      socket.addEventListener('error', () => {})
    }

    let gatewayUrl
    handlers.onStatus({ state: 'connecting' })
    // The token and gateway are fetched until they arrive: a start before the network
    // is up must connect once it is (#1119). A refused credential stops instead.
    void (async () => {
      let attempt = 0
      while (!stopped) {
        try {
          const got = await getToken(fields, env)
          token = got.token
          expiresAt = got.expiresAt
          const gateway = await api(env, token, '/gateway', { method: 'GET' })
          if (!gateway?.url) {
            // A 200 that names no gateway is the platform refusing this app, the
            // same as DingTalk's missing endpoint and Feishu's missing URL;
            // retrying would send the same refusal again.
            const refused = new Error(String(gateway?.message ?? gateway?.error ?? 'QQ refused the gateway'))
            refused.permanent = true
            throw refused
          }
          gatewayUrl = gateway.url
          break
        } catch (error) {
          if (stopped) return
          if (error?.permanent === true) {
            handlers.onStatus({ state: 'error', error: error.message })
            return
          }
          handlers.onStatus({ state: 'retrying', error: error.message })
          await retryWait(retryDelay(attempt))
          attempt += 1
        }
      }
      if (stopped) return
      refresh()
      open(false)
    })()

    return {
      send: async (chat, { text }) => {
        const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
        const msgId = lastMsgId.get(chat.key)
        const base = chat.kind === 'direct' ? `/v2/users/${chat.key}/messages` : `/v2/groups/${chat.key}/messages`
        let messageId
        for (const chunk of chunks) {
          const seq = (msgSeq.get(msgId) ?? 0) + 1
          msgSeq.set(msgId, seq)
          const sent = await api(env, token, base, {
            method: 'POST',
            body: { content: chunk, msg_type: 0, ...(msgId ? { msg_id: msgId, msg_seq: seq } : {}) },
          })
          messageId = String(sent?.id ?? messageId ?? '')
        }
        return { messageId }
      },
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(heartbeatTimer)
        clearTimeout(reconnectTimer)
        clearTimeout(refreshTimer)
        try { socket?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

async function api(env, token, path, { method = 'GET', body } = {}) {
  const response = await env.fetch(`${apiBase(env)}${path}`, {
    method,
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok || json.code !== undefined) {
    const reason = json.message ?? json.error ?? `QQ answered ${response.status}`
    const error = new Error(String(reason))
    error.status = response.status
    // A refusal outside the reply window or over quota is permanent; 4xx other
    // than auth problems too. 5xx and timeouts retry.
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
      || /reply.*window|quota|frequency|超过|过期/i.test(String(reason))
    if (response.status === 429) error.retryAfter = Number(response.headers.get('retry-after'))
    throw error
  }
  return json
}
