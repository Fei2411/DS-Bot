// DingTalk stream mode: connections/open with the client credentials opens a
// ticketed WebSocket; every frame is ACKed by echoing its messageId with
// code 200, system pings get a pong, and the robot callback carries the
// sessionWebhook for passive replies. Outside that window the OpenAPI
// batchSend/groupMessages path answers instead. No buttons — the core
// numbers choices. Wire details ported from dingtalk-stream (MIT, see
// NOTICE).
import { chunkMarkdown } from '../format.js'
import { retryDelay, retryWait } from './retry.js'

const GATEWAY = 'https://api.dingtalk.com'
const OAPI = 'https://oapi.dingtalk.com'
const TEXT_LIMIT = 5000

const gatewayBase = env => String(env.config?.gateway ?? env.config?.api ?? GATEWAY).replace(/\/+$/, '')
const oapiBase = env => String(env.config?.oapi ?? env.config?.api ?? OAPI).replace(/\/+$/, '')

export default {
  id: 'dingtalk',

  async check(fields, env) {
    await appToken(fields, env)
    return { account: { id: String(fields.clientId ?? '').trim(), name: String(fields.clientId ?? '').trim() } }
  },

  connect(fields, env, handlers) {
    const clientId = String(fields.clientId ?? '').trim()
    let stopped = false
    let socket
    let generation = 0
    let reconnectTimer
    let token
    let tokenExpiresAt = 0
    const ensureToken = async () => {
      if (token !== undefined && tokenExpiresAt > Date.now() + 30_000) return token
      const answer = await appToken(fields, env)
      token = answer.accessToken
      tokenExpiresAt = Date.now() + (Number(answer.expiresIn ?? 7200) * 1000)
      return token
    }
    // Passive replies reuse the inbound sessionWebhook while it lives.
    const sessionWebhooks = new Map()

    const sendFrame = packet => { if (socket?.readyState === 1) socket.send(JSON.stringify(packet)) }
    const ack = (headers, data = {}) => sendFrame({
      specVersion: '1.0',
      code: 200,
      headers: { appType: 'STREAM', clientId, messageId: String(headers?.messageId ?? ''), time: String(Date.now()) },
      message: 'OK',
      data: JSON.stringify(data),
    })

    const markdown = async (chat, text) => {
      const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
      let messageId
      for (const chunk of chunks) {
        const hook = sessionWebhooks.get(chat.key)
        if (hook !== undefined && hook.until > Date.now()) {
          const response = await env.fetch(hook.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ msgtype: 'markdown', markdown: { title: chunk.slice(0, 30), text: chunk } }),
          })
          const body = await response.json().catch(() => ({}))
          if (body.errcode !== 0) throw Object.assign(new Error(String(body.errmsg ?? 'DingTalk refused the reply')), { permanent: true })
          messageId = String(body.processQueryKey ?? messageId ?? '')
          continue
        }
        if (chat.kind === 'direct') {
          const answer = await robot(env, await ensureToken(), clientId, '/v1.0/robot/oToMessages/batchSend', {
            robotCode: clientId, userIds: [chat.key],
            msgKey: 'sampleMarkdown', msgParam: { title: chunk.slice(0, 30), text: chunk },
          })
          messageId = String(answer?.processQueryKey ?? messageId ?? '')
        } else {
          const answer = await robot(env, await ensureToken(), clientId, '/v1.0/robot/groupMessages/send', {
            robotCode: clientId, openConversationId: chat.key,
            msgKey: 'sampleMarkdown', msgParam: { title: chunk.slice(0, 30), text: chunk },
          })
          messageId = String(answer?.processQueryKey ?? messageId ?? '')
        }
      }
      return { messageId }
    }

    const onCallback = async (headers, raw) => {
      let data
      try { data = JSON.parse(raw) } catch { return }
      if (data.text === undefined && data.msgtype !== 'text' && data.msgtype !== 'richText' && data.msgtype !== 'picture') { ack(headers, { ok: true }); return }
      const direct = data.conversationType === '1'
      const mentioned = direct ? false : data.isInAtList === true
      const key = String(direct ? data.senderStaffId ?? data.senderId ?? '' : data.conversationId ?? '')
      if (data.sessionWebhook !== undefined) {
        sessionWebhooks.set(key, { url: String(data.sessionWebhook), until: Date.now() + 20 * 60_000 })
      }
      // A picture message's content carries the download code, not text.
      const text = String(data.text?.content ?? '').trim()
      const sender = String(data.senderStaffId ?? data.senderId ?? '')
      ack(headers, { ok: true })
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group', title: '' },
        sender: { id: sender, name: String(data.senderNick ?? sender) },
        text, images: [], files: [],
        mentioned, messageId: String(data.msgId ?? ''),
      })
    }

    let openFailures = 0
    const open = async () => {
      const gen = generation
      let url
      try {
        const response = await env.fetch(`${gatewayBase(env)}/v1.0/gateway/connections/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId, clientSecret: String(fields.clientSecret ?? '').trim(),
            ua: 'ds-bot',
            subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
          }),
        })
        if (!response.ok && !(response.status >= 500 || response.status === 429)) {
          throw Object.assign(new Error(`DingTalk answered ${response.status}`), { permanent: true })
        }
        const body = await response.json().catch(() => ({}))
        if (body.endpoint === undefined) {
          const error = new Error(String(body.message ?? body.error ?? 'DingTalk refused the connection'))
          // A 200 that names no endpoint is the platform refusing the app.
          error.permanent = response.ok
          throw error
        }
        url = `${body.endpoint}?ticket=${body.ticket}`
        openFailures = 0
      } catch (error) {
        if (stopped || generation !== gen) return
        if (error?.permanent === true) {
          handlers.onStatus({ state: 'error', error: error.message })
          return
        }
        // The handshake is retried, also when this is the first one: a connection
        // started before the network is up is not over (#1119).
        handlers.onStatus({ state: 'retrying', error: error.message })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(openFailures))
        reconnectTimer.unref?.()
        openFailures += 1
        return
      }
      try { socket = new env.WebSocket(url) } catch (error) {
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'retrying', error: `DingTalk could not open a socket: ${error?.message ?? error}` })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(openFailures))
        reconnectTimer.unref?.()
        openFailures += 1
        return
      }
      socket.addEventListener('message', (event) => {
        if (stopped || generation !== gen) return
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        const headers = packet.headers ?? {}
        if (packet.type === 'SYSTEM') {
          if (String(packet.data ?? '').includes('ping') || headers.eventType === 'ping' || packet.headers?.topic === 'ping') {
            ack(headers, 'pong')
          }
          return
        }
        if (packet.type === 'CALLBACK' || packet.type === 'EVENT') {
          void onCallback(headers, String(packet.data ?? '{}')).catch(error => env.log?.warn?.('ds-bot im: dingtalk message failed: %s', error?.message ?? error))
        }
      })
      socket.addEventListener('open', () => { openFailures = 0; handlers.onStatus({ state: 'ready' }) })
      socket.addEventListener('close', () => {
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'connecting' })
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, 2000)
        reconnectTimer.unref?.()
      })
      socket.addEventListener('error', () => {})
    }

    handlers.onStatus({ state: 'connecting' })
    // The access token is fetched until it arrives: a connection started before the
    // network is up must connect once it is (#1119).
    void (async () => {
      let attempt = 0
      while (!stopped) {
        try {
          const got = await appToken(fields, env)
          token = got.accessToken
          tokenExpiresAt = got.expiresAt
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
      if (!stopped) await open()
    })()

    return {
      send: async (chat, { text }) => markdown(chat, text),
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(reconnectTimer)
        try { socket?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

// The app-level access token for OpenAPI sends (oapi gettoken, cached until
// it expires).
async function appToken(fields, env) {
  const url = `${oapiBase(env)}/gettoken?appkey=${encodeURIComponent(String(fields.clientId ?? '').trim())}&appsecret=${encodeURIComponent(String(fields.clientSecret ?? '').trim())}`
  const response = await env.fetch(url)
  const body = await response.json().catch(() => ({}))
  if (body.errcode !== 0 || body.access_token === undefined) {
    const error = new Error(String(body.errmsg ?? 'DingTalk refused these credentials'))
    // A 5xx or a 429 is the service, not the credentials: retry those.
    error.permanent = !(response.status >= 500 || response.status === 429)
    throw error
  }
  return { accessToken: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in ?? 7200) - 300) * 1000 }
}

async function robot(env, token, clientId, path, body) {
  if (token === undefined) throw Object.assign(new Error('DingTalk has no access token yet'), { permanent: false })
  const response = await env.fetch(`${gatewayBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(String(json.message ?? json.errmsg ?? `DingTalk answered ${response.status}`))
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
    throw error
  }
  return json
}
