// QQ open platform: an app access token from appId+secret, then a Discord-like
// gateway (hello, heartbeat, identify, resume, reconnect, invalid session) for
// C2C and group @ messages. Sends are passive replies carrying the inbound
// msg_id with an incrementing msg_seq; outside the reply window the platform
// refuses and the reason is permanent. No buttons — the core numbers choices.
// Wire details ported from @tencent-connect/qqbot-nodejs (MIT, see NOTICE).
import { chunkMarkdown, toPlain } from '../format.js'
import { toQqMarkdown } from '../qq-markdown.js'
import {
  createChatQueue, detectImageMediaType, discardBody, fileExtension,
  FILE_LIMIT, IMAGE_LIMIT, isHttpUrl, mediaSignal, readCappedBytes,
} from './media.js'
import { retryDelay, retryWait } from './retry.js'

const API = 'https://api.sgroup.qq.com'
const TOKEN_API = 'https://bots.qq.com'
const TEXT_LIMIT = 2000
const DIRECT_UPLOAD_LIMIT = 5 * 1024 * 1024
// GROUP_AND_C2C covers C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE.
const INTENTS = 1 << 25

// Chunks QQ already took, by reply job: a retry of the same job (after a backoff
// or from Try again) resumes after them instead of posting them a second time.
const delivered = new WeakMap()

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

const attachmentUrl = (raw) => {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  const normalized = value.startsWith('//') ? `https:${value}` : value
  return isHttpUrl(normalized) ? normalized : ''
}

const isImageAttachment = (item) => {
  const ct = String(item?.content_type ?? '').split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/')) return true
  return IMAGE_EXTS.has(fileExtension(item?.filename))
}

const downloadAttachments = async (d, env, signal) => {
  const images = []
  const files = []
  const attachments = Array.isArray(d.attachments) ? d.attachments : []
  for (const item of attachments) {
    if (signal?.aborted) return { images, files }
    if (!item || typeof item !== 'object') continue
    const ct = String(item.content_type ?? '').toLowerCase()
    if (ct === 'voice') continue
    const url = attachmentUrl(item.url)
    if (url === '') continue
    const asImage = isImageAttachment(item)
    const limit = asImage ? IMAGE_LIMIT : FILE_LIMIT
    try {
      const response = await env.fetch(url, { signal: mediaSignal(signal) })
      if (!response.ok) {
        await discardBody(response)
        env.log?.warn?.('ds-bot im: qq attachment download answered %s', response.status)
        continue
      }
      const got = await readCappedBytes(response, limit)
      if (got.overLimit) {
        env.log?.warn?.('ds-bot im: qq attachment over %d byte cap, skipped', limit)
        continue
      }
      if (got.bytes === undefined || got.bytes.length === 0) continue
      const mediaType = detectImageMediaType(got.bytes)
      if (mediaType !== undefined && got.bytes.length <= IMAGE_LIMIT) {
        images.push({ mediaType, data: got.bytes.toString('base64') })
      } else {
        files.push({ name: String(item.filename || 'file'), data: got.bytes })
      }
    } catch (error) {
      if (!signal?.aborted) env.log?.warn?.('ds-bot im: qq attachment download failed: %s', error?.message ?? error)
    }
  }
  return { images, files }
}
const apiBase = env => String(env.config?.api ?? API).replace(/\/+$/, '')
const tokenBase = env => String(env.config?.token ?? TOKEN_API)

// A voice message carries no `content`: the transcript rides on the attachment
// as `asr_refer_text`, which the platform produced itself. Without this the
// message normalises to an empty text and the common IM entry drops it (#1824).
// A caption the sender typed alongside the voice wins over the transcript.
const textOf = d => {
  const content = String(d.content ?? '').trim()
  if (content !== '') return content
  const attachments = Array.isArray(d.attachments) ? d.attachments : []
  return attachments
    .filter(item => item?.content_type === 'voice')
    .map(item => String(item?.asr_refer_text ?? '').trim())
    .filter(Boolean)
    .join('\n')
}

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
  // Checked before the reply text drops the image tag, so an oversized image leaves a notice.
  imageMaxBytes: DIRECT_UPLOAD_LIMIT,

  async check(fields, env) {
    const { token } = await getToken(fields, env)
    const me = await api(env, token, '/users/@me', { method: 'GET' }).catch(() => ({}))
    return { account: { id: String(fields.appId).trim(), name: me?.username ? `@${me.username}` : String(fields.appId).trim() } }
  },

  connect(fields, env, handlers) {
    const MSG_SEQ_MAX = 2000
    const LAST_MSG_ID_MAX = 500
    const FATAL_CLOSE_CODES = new Set([4010, 4011, 4012, 4013, 4014])
    let stopped = false
    const stopping = new AbortController()
    let socket
    let token
    let expiresAt = 0
    let refreshTimer
    let refreshAttempt = 0
    let heartbeatTimer
    let heartbeatAcked = true
    let reconnectTimer
    let reconnectAttempt = 0
    let generation = 0
    let sequence
    let sessionId
    // Passive replies reuse the inbound msg_id with a msg_seq that climbs
    // per id — outside the window the platform refuses (permanent).
    const msgSeq = new Map()
    const lastMsgId = new Map()
    const inOrder = createChatQueue()

    const nextReply = (msgId) => {
      if (!msgId) return {}
      const seq = (msgSeq.get(msgId) ?? 0) + 1
      msgSeq.delete(msgId)
      msgSeq.set(msgId, seq)
      if (msgSeq.size > MSG_SEQ_MAX) msgSeq.delete(msgSeq.keys().next().value)
      return { msg_id: msgId, msg_seq: seq }
    }

    let terminal = false
    const stopPermanently = (errorMessage) => {
      terminal = true
      clearTimeout(heartbeatTimer)
      heartbeatTimer = undefined
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      clearTimeout(refreshTimer)
      refreshTimer = undefined
      sessionId = undefined
      sequence = undefined
      handlers.onStatus({ state: 'error', error: errorMessage })
    }

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
      if (stopped || terminal) return
      clearTimeout(refreshTimer)
      const wait = refreshAttempt > 0 ? retryDelay(refreshAttempt) : Math.max(5_000, expiresAt - Date.now() - 60_000)
      refreshTimer = setTimeout(async () => {
        if (stopped || terminal) return
        try {
          const next = await getToken(fields, env)
          if (stopped || terminal) return
          token = next.token
          expiresAt = next.expiresAt
          refreshAttempt = 0
        } catch (error) {
          if (stopped || terminal) return
          env.log?.warn?.('ds-bot im: qq token refresh failed: %s', error?.message ?? error)
          if (error?.permanent === true) {
            terminal = true
            clearTimeout(refreshTimer)
            refreshTimer = undefined
            handlers.onStatus({ state: 'error', error: error.message })
            return
          }
          refreshAttempt += 1
        }
        if (!stopped && !terminal) refresh()
      }, wait)
      refreshTimer.unref?.()
    }

    const onDispatch = async (packet) => {
      if (packet.t === 'READY') {
        reconnectAttempt = 0
        openFailures = 0
        sessionId = packet.d?.session_id
        handlers.onStatus({ state: 'ready', account: { id: String(fields.appId).trim(), name: packet.d?.user?.username ? `@${packet.d.user.username}` : String(fields.appId).trim() } })
        return
      }
      if (packet.t === 'RESUMED') {
        reconnectAttempt = 0
        openFailures = 0
        handlers.onStatus({ state: 'ready' })
        return
      }
      const c2c = packet.t === 'C2C_MESSAGE_CREATE'
      const group = packet.t === 'GROUP_AT_MESSAGE_CREATE'
      if (!c2c && !group) return
      const d = packet.d ?? {}
      const key = String(c2c ? d.author?.user_openid ?? d.channel_id ?? '' : d.group_openid ?? d.channel_id ?? '')
      lastMsgId.delete(key)
      lastMsgId.set(key, String(d.id ?? ''))
      if (lastMsgId.size > LAST_MSG_ID_MAX) lastMsgId.delete(lastMsgId.keys().next().value)
      const sender = c2c ? d.author?.user_openid : d.author?.member_openid ?? d.author?.id
      await inOrder(key, async () => {
        if (stopped) return
        const { images, files } = await downloadAttachments(d, env, stopping.signal)
        if (stopped) return
        await handlers.onMessage({
          chat: { key, kind: c2c ? 'direct' : 'group', title: '' },
          sender: { id: String(sender ?? ''), name: String(sender ?? '') },
          text: textOf(d),
          images, files,
          mentioned: group, messageId: String(d.id ?? ''),
        })
      })
    }

    const reconnect = async (gen, { resume, forceRefresh = false } = {}) => {
      if (stopped || generation !== gen) return
      const needsRefresh = forceRefresh || Date.now() >= expiresAt
      if (needsRefresh) {
        try {
          const next = await getToken(fields, env)
          if (stopped || generation !== gen) return
          token = next.token
          expiresAt = next.expiresAt
          refreshAttempt = 0
          refresh()
        } catch (error) {
          if (stopped || generation !== gen) return
          if (error?.permanent === true) {
            stopPermanently(error.message)
            return
          }
          handlers.onStatus({ state: 'retrying', error: error.message })
          clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => {
            if (!stopped && generation === gen) void reconnect(gen, { resume, forceRefresh: true })
          }, retryDelay(reconnectAttempt++))
          reconnectTimer.unref?.()
          return
        }
      }
      if (stopped || generation !== gen) return
      open(resume && sessionId !== undefined, { refreshed: needsRefresh })
    }

    let openFailures = 0
    const open = (resume, { refreshed = false } = {}) => {
      if (stopped) return
      const gen = ++generation
      let authenticated = false
      clearTimeout(heartbeatTimer)
      const previous = socket
      socket = undefined
      try { previous?.close(1000, 'replaced') } catch { /* already gone */ }
      let next
      try {
        next = new env.WebSocket(gatewayUrl)
        socket = next
        openFailures = 0
      } catch (error) {
        // A socket that cannot be built yet is retried like a dropped one; the
        // connection is not over (#1119).
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'retrying', error: `QQ could not open a socket: ${error?.message ?? error}` })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped && generation === gen) void reconnect(gen, { resume }) }, retryDelay(openFailures))
        reconnectTimer.unref?.()
        openFailures += 1
        return
      }
      next.addEventListener('message', (event) => {
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
        if (packet.op === 7) { next.close(4000, 'Reconnect requested'); return }
        if (packet.op === 9) {
          if (packet.d !== true) { sessionId = undefined; sequence = undefined }
          next.close(4000, 'Invalid session')
          return
        }
        if (packet.op === 0) {
          if (packet.t === 'READY' || packet.t === 'RESUMED') authenticated = true
          void onDispatch(packet).catch(error => env.log?.warn?.('ds-bot im: qq event failed: %s', error?.message ?? error))
        }
      })
      next.addEventListener('close', (event) => {
        clearTimeout(heartbeatTimer)
        if (stopped || generation !== gen) return
        const code = event?.code
        if (FATAL_CLOSE_CODES.has(code)) {
          stopPermanently(`QQ closed the gateway (${code}${event?.reason ? `: ${event.reason}` : ''})`)
          return
        }
        if (code === 4004) {
          sessionId = undefined
          sequence = undefined
          if (refreshed && !authenticated) {
            stopPermanently(`QQ closed the gateway (${code}${event?.reason ? `: ${event.reason}` : ''})`)
            return
          }
          handlers.onStatus({ state: 'connecting' })
          clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => { if (!stopped && generation === gen) void reconnect(gen, { resume: false, forceRefresh: true }) }, retryDelay(reconnectAttempt++))
          reconnectTimer.unref?.()
          return
        }
        handlers.onStatus({ state: 'connecting' })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped && generation === gen) void reconnect(gen, { resume: sessionId !== undefined }) }, retryDelay(reconnectAttempt++))
        reconnectTimer.unref?.()
      })
      next.addEventListener('error', () => {})
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
          if (stopped) return
          token = got.token
          expiresAt = got.expiresAt
          const gateway = await api(env, token, '/gateway', { method: 'GET' })
          if (stopped) return
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
            stopPermanently(error.message)
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
      send: async (chat, message) => {
        const text = String(message.text ?? '')
        const chunks = chunkMarkdown(toQqMarkdown(text), TEXT_LIMIT)
        const msgId = lastMsgId.get(chat.key)
        const base = chat.kind === 'direct' ? `/v2/users/${chat.key}/messages` : `/v2/groups/${chat.key}/messages`
        const done = delivered.get(message)?.text === text ? delivered.get(message) : undefined
        let count = done?.count ?? 0
        let messageId = done?.messageId
        for (const chunk of chunks.slice(count)) {
          const reply = nextReply(msgId)
          let sent
          try {
            sent = await api(env, token, base, {
              method: 'POST',
              body: { markdown: { content: chunk }, msg_type: 2, ...reply },
            })
          } catch (error) {
            // 40034090 is the platform refusing the markdown itself (no permission
            // for it). Any other refusal is about this reply and is not retried.
            if (Number(error?.bizCode) !== 40034090) throw error
            sent = await api(env, token, base, {
              method: 'POST',
              body: { content: toPlain(chunk), msg_type: 0, ...reply },
            })
          }
          messageId = String(sent?.id ?? messageId ?? '')
          count += 1
          delivered.set(message, { text, count, messageId })
        }
        delivered.delete(message)
        return { messageId }
      },
      sendImage: async (chat, image) => {
        const bytes = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data ?? [])
        if (bytes.length === 0 || bytes.length > DIRECT_UPLOAD_LIMIT) {
          throw Object.assign(new Error('QQ image must be non-empty and at most 5 MiB'), { permanent: true })
        }
        const msgId = lastMsgId.get(chat.key)
        const base = chat.kind === 'direct' ? `/v2/users/${chat.key}` : `/v2/groups/${chat.key}`
        const { file_info: fileInfo } = await api(env, token, `${base}/files`, {
          method: 'POST',
          body: { file_type: 1, file_name: image.name || 'image.png', file_data: bytes.toString('base64'), srv_send_msg: false },
        })
        if (typeof fileInfo !== 'string' || fileInfo === '') throw new Error('QQ image upload returned no file_info')
        const sent = await api(env, token, `${base}/messages`, {
          method: 'POST',
          body: { msg_type: 7, media: { file_info: fileInfo }, ...nextReply(msgId) },
        })
        return { messageId: String(sent?.id ?? '') }
      },
      stop: () => {
        stopped = true
        stopping.abort()
        generation += 1
        clearTimeout(heartbeatTimer)
        heartbeatTimer = undefined
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        clearTimeout(refreshTimer)
        refreshTimer = undefined
        msgSeq.clear()
        lastMsgId.clear()
        const previous = socket
        socket = undefined
        try { previous?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

const parseRetryAfter = (headers) => {
  const raw = headers?.get?.('retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

async function api(env, token, path, { method = 'GET', body } = {}) {
  const response = await env.fetch(`${apiBase(env)}${path}`, {
    method,
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  const bizCode = [json.err_code, json.code].find(code => code !== undefined && Number(code) !== 0)
  // Awaiting audit is accepted, not a refusal; retrying could duplicate delivery.
  if ([304023, 304024].includes(Number(bizCode))) return json
  if (!response.ok || bizCode !== undefined) {
    const reason = json.message ?? json.error ?? `QQ answered ${response.status}`
    const traceId = json.trace_id ?? response.headers.get('X-Tps-trace-ID')
    const error = new Error(`${reason}${traceId ? ` (trace_id: ${traceId})` : ''}`)
    error.status = response.status
    error.bizCode = bizCode
    // A refusal outside the reply window or over quota is permanent; 4xx other
    // than auth problems too. 5xx and timeouts retry.
    error.permanent = response.ok && bizCode !== undefined
      || response.status >= 400 && response.status < 500 && response.status !== 429
      || /reply.*window|quota|frequency|超过|过期/i.test(String(reason))
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers)
      if (retryAfter !== undefined) error.retryAfter = retryAfter
    }
    throw error
  }
  return json
}
