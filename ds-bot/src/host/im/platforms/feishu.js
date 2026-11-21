// Feishu / Lark: the long connection speaks protobuf pbbp2 frames — control
// pings sent at the server's interval, data frames ACKed by sending the frame back with a
// {"code":200} payload and a biz_rt header; split payloads reassemble by
// sum/seq. p2p messages are direct; a group message counts when the bot's
// open_id is in its mentions. Sends go through the OpenAPI with a tenant
// access token: interactive cards with a markdown element and buttons, edited
// by PATCH. The tiny protobuf codec below implements only this frame shape.
// Protocol ported from @larksuiteoapi/node-sdk (MIT, see NOTICE).
import { chunkMarkdown } from '../format.js'
import { retryDelay, retryWait } from './retry.js'

const TEXT_LIMIT = 4000
const SOCKET_TIMEOUT = 30_000
const pingInterval = seconds => {
  const ms = Number(seconds) * 1000
  return Number.isFinite(ms) && ms >= 1000 && ms <= 2_147_483_647 ? ms : undefined
}

const apiBase = (env, fields) => String(env.config?.api ?? (fields.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn')).replace(/\/+$/, '')

// ---- pbbp2.Frame codec (protobuf wire format, only this message) ----------
// Frame: SeqID u64=1, LogID u64=2, service i32=3, method i32=4,
// headers repeated Header=5, payload_encoding string=6, payload_type
// string=7, payload bytes=8, LogIDNew string=9. Header: key string=1, value
// string=2. Wire types: 0 varint, 2 length-delimited.
const uvarint = (value) => {
  let v = BigInt(value)
  const bytes = []
  while (v > 127n) { bytes.push(Number(v & 127n) | 128); v >>= 7n }
  bytes.push(Number(v))
  return bytes
}
const field = (number, wire, bytes) => {
  const tag = uvarint((number << 3) | wire)
  if (wire === 0) return [...tag, ...uvarint(bytes)]
  const body = typeof bytes === 'string' ? [...Buffer.from(bytes, 'utf8')] : [...bytes]
  return [...tag, ...uvarint(body.length), ...body]
}
const encodeHeader = ({ key, value }) => [...field(1, 2, key), ...field(2, 2, value)]
export const encodeFrame = (frame) => {
  const out = []
  if (frame.SeqID !== undefined) out.push(...field(1, 0, frame.SeqID))
  if (frame.LogID !== undefined) out.push(...field(2, 0, frame.LogID))
  if (frame.service !== undefined) out.push(...field(3, 0, frame.service))
  if (frame.method !== undefined) out.push(...field(4, 0, frame.method))
  for (const header of frame.headers ?? []) out.push(...field(5, 2, encodeHeader(header)))
  if (frame.payloadEncoding !== undefined) out.push(...field(6, 2, frame.payloadEncoding))
  if (frame.payloadType !== undefined) out.push(...field(7, 2, frame.payloadType))
  if (frame.payload !== undefined) out.push(...field(8, 2, frame.payload))
  if (frame.LogIDNew !== undefined) out.push(...field(9, 2, frame.LogIDNew))
  return Buffer.from(out)
}
export const decodeFrame = (buffer) => {
  const frame = { headers: [] }
  let at = 0
  const varint = () => {
    let value = 0n
    let shift = 0n
    while (at < buffer.length) {
      const byte = buffer[at]
      at += 1
      value |= BigInt(byte & 127) << shift
      if ((byte & 128) === 0) break
      shift += 7n
    }
    return value
  }
  const bytes = () => {
    const length = Number(varint())
    const part = buffer.subarray(at, at + length)
    at += length
    return part
  }
  const header = (buf) => {
    let index = 0
    const out = {}
    const v = () => {
      let value = 0n
      let shift = 0n
      while (index < buf.length) {
        const byte = buf[index]
        index += 1
        value |= BigInt(byte & 127) << shift
        if ((byte & 128) === 0) break
        shift += 7n
      }
      return value
    }
    const b = () => {
      const length = Number(v())
      const part = buf.subarray(index, index + length)
      index += length
      return part
    }
    while (index < buf.length) {
      const tag = Number(v())
      if (tag >> 3 === 1) out.key = b().toString('utf8')
      else if (tag >> 3 === 2) out.value = b().toString('utf8')
      else if ((tag & 7) === 2) b()
      else if ((tag & 7) === 0) v()
    }
    return out
  }
  while (at < buffer.length) {
    const tag = Number(varint())
    const number = tag >> 3
    const wire = tag & 7
    if (wire === 0) {
      const value = varint()
      if (number === 1) frame.SeqID = Number(value)
      else if (number === 2) frame.LogID = Number(value)
      else if (number === 3) frame.service = Number(value)
      else if (number === 4) frame.method = Number(value)
    } else if (wire === 2) {
      const value = bytes()
      if (number === 5) frame.headers.push(header(value))
      else if (number === 6) frame.payloadEncoding = value.toString('utf8')
      else if (number === 7) frame.payloadType = value.toString('utf8')
      else if (number === 8) frame.payload = Buffer.from(value)
      else if (number === 9) frame.LogIDNew = value.toString('utf8')
    }
  }
  return frame
}
// ---------------------------------------------------------------------------

export default {
  id: 'feishu',

  async check(fields, env) {
    const { token } = await tenantToken(fields, env)
    const me = await api(env, apiBase(env, fields), token, '/open-apis/bot/v3/info', { method: 'GET' })
    const bot = me?.bot ?? me
    return { account: { id: String(bot?.open_id ?? bot?.app_id ?? fields.appId), name: bot?.app_name ?? String(fields.appId) } }
  },

  connect(fields, env, handlers) {
    const appId = String(fields.appId ?? '').trim()
    const appSecret = String(fields.appSecret ?? '').trim()
    let stopped = false
    let socket
    let generation = 0
    let reconnectTimer
    let connectTimer
    let pingTimer
    let heartbeatTimer
    let token
    let tokenExpiresAt = 0
    let refreshing
    let botOpenId = ''
    // Split data frames reassemble by (sum, seq) until all parts arrive.
    const parts = new Map()

    // Inbound downloads share the expiry check: a socket that only receives
    // still needs a live token. Callers wait on the one in-flight refresh —
    // two images arriving together must not race two tokens.
    const freshToken = async () => {
      if (token === undefined || Date.now() > tokenExpiresAt - 30_000) {
        refreshing ??= tenantToken({ appId, appSecret }, env)
          .then(got => { token = got.token; tokenExpiresAt = got.expiresAt })
          .finally(() => { refreshing = undefined })
        await refreshing
      }
      return token
    }

    const rest = async (path, { method = 'POST', body } = {}) =>
      api(env, apiBase(env, fields), await freshToken(), path, { method, body })

    const sendFrame = (buffer) => { if (socket?.readyState === 1) socket.send(buffer) }
    const pong = (frame) => sendFrame(encodeFrame({ ...frame, headers: frame.headers.map(h => h.key === 'type' ? { key: 'type', value: 'pong' } : h), payload: Buffer.from('pong') }))
    const ack = (frame, ms) => sendFrame(encodeFrame({
      ...frame,
      headers: [...frame.headers.filter(h => h.key !== 'biz_rt'), { key: 'biz_rt', value: String(ms) }],
      payload: Buffer.from(JSON.stringify({ code: 200, headers: {}, data: '' })),
      payloadType: 'json',
    }))

    const downloadResource = (messageId, key, resourceType) => freshToken()
      .then(bearer => resource(env, apiBase(env, fields), bearer, messageId, key, resourceType))
      .catch(() => undefined)

    const dispatch = async (type, body) => {
      const payload = JSON.parse(body.toString('utf8'))
      if (type === 'event' && payload.header?.event_type === 'im.message.receive_v1') {
        const event = payload.event ?? {}
        const message = event.message ?? {}
        if (message.message_type === 'system') return
        const direct = message.chat_type === 'p2p'
        const mentions = message.mentions ?? []
        if (!direct && botOpenId === '' && mentions.length > 0) {
          const me = await rest('/open-apis/bot/v3/info', { method: 'GET' }).catch(() => ({}))
          botOpenId = String(me?.bot?.open_id ?? me?.open_id ?? '')
        }
        const isBotMention = m => botOpenId !== '' && m.id?.open_id === botOpenId
        const mentioned = !direct && mentions.some(isBotMention)
        const mentionNames = new Map(mentions.map(m => [m.key, isBotMention(m) ? '' : (m.name ? `@${m.name}` : '')]))
        const content = safeJson(message.content)
        const post = message.message_type === 'post' ? flattenPost(content, botOpenId, mentionNames) : undefined
        const rawText = post !== undefined ? post.text : String(content.text ?? '')
        const note = messageNote(message.message_type, content)
        const text = [
          rawText.replace(/@_user_\d+/g, key => mentionNames.get(key) ?? '').trim(),
          note,
        ].filter(Boolean).join('\n').trim()
        const images = []
        if (message.message_type === 'image' && content.image_key !== undefined) {
          const bytes = await downloadResource(message.message_id, content.image_key, 'image')
          if (bytes !== undefined) {
            const buffer = Buffer.from(bytes)
            images.push({ mediaType: imageMediaType(buffer), data: buffer.toString('base64') })
          } else env.log?.warn?.('ds-bot im: feishu image download failed for %s', String(message.message_id ?? ''))
        }
        for (const key of post?.imageKeys ?? []) {
          const bytes = await downloadResource(message.message_id, key, 'image')
          if (bytes === undefined) {
            env.log?.warn?.('ds-bot im: feishu post image download failed for %s', String(message.message_id ?? ''))
            continue
          }
          try {
            const buffer = Buffer.from(bytes)
            images.push({ mediaType: imageMediaType(buffer), data: buffer.toString('base64') })
          } catch (error) {
            env.log?.warn?.('ds-bot im: feishu post image skipped for %s: %s', String(message.message_id ?? ''), error?.message ?? error)
          }
        }
        const files = []
        const fileName = fileAttachmentName(message.message_type, content, message.message_id)
        if (fileName !== undefined && content.file_key !== undefined) {
          const bytes = await downloadResource(message.message_id, content.file_key, 'file')
          if (bytes !== undefined) files.push({ name: fileName, data: bytes })
          else env.log?.warn?.('ds-bot im: feishu %s download failed for %s', String(message.message_type), String(message.message_id ?? ''))
        }
        const sender = event.sender?.sender_id?.open_id ?? event.sender?.user_id ?? ''
        await handlers.onMessage({
          chat: { key: String(message.chat_id ?? ''), kind: direct ? 'direct' : 'group', title: String(message.chat_id ?? '') },
          sender: { id: String(sender), name: String(sender) },
          text, images, files,
          mentioned, messageId: String(message.message_id ?? ''),
        })
      }
      if (type === 'card' || payload.header?.event_type === 'card.action.trigger') {
        const event = payload.event ?? {}
        const action = event.action ?? event.actions?.[0] ?? {}
        const data = action.value ?? action.action_data?.value ?? action.action_data ?? {}
        await handlers.onAction({
          chat: { key: String(event.context?.open_chat_id ?? event.message?.chat_id ?? ''), kind: 'direct', title: '' },
          sender: { id: String(event.operator?.open_id ?? event.user_id ?? ''), name: '' },
          data: String(typeof data === 'object' ? (data.v ?? JSON.stringify(data)) : data),
          messageId: String(event.message_id ?? event.context?.open_message_id ?? ''),
        })
      }
    }

    const clearSocketTimers = () => {
      clearTimeout(connectTimer)
      clearTimeout(pingTimer)
      clearTimeout(heartbeatTimer)
      connectTimer = pingTimer = heartbeatTimer = undefined
    }
    let openFailures = 0
    const retry = (gen, error) => {
      if (stopped || generation !== gen) return
      generation += 1
      clearSocketTimers()
      const previous = socket
      socket = undefined
      try { previous?.close(4001, 'reconnect') } catch { /* already gone */ }
      handlers.onStatus({ state: 'retrying', error })
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(openFailures))
      reconnectTimer.unref?.()
      openFailures += 1
    }
    const open = async () => {
      if (stopped) return
      const gen = ++generation
      let url
      let pingEvery = 90_000
      try {
        const answer = await env.fetch(`${apiBase(env, fields)}/callback/ws/endpoint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${await freshToken()}` },
          body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
        })
        const body = await answer.json().catch(() => ({}))
        url = body.data?.URL
        if (url === undefined || (body.code !== undefined && body.code !== 0)) {
          const reason = body.msg ?? `Feishu answered ${answer.status}`
          const error = new Error(body.code === undefined ? reason : `${reason} (code ${body.code})`)
          error.status = answer.status
          // A 200 that carries no WebSocket URL is the platform refusing the app.
          error.permanent = answer.ok || (answer.status >= 400 && answer.status < 500 && answer.status !== 429)
          throw error
        }
        pingEvery = pingInterval(body.data?.ClientConfig?.PingInterval) ?? pingEvery
      } catch (error) {
        if (stopped || generation !== gen) return
        if (error?.permanent === true) {
          handlers.onStatus({ state: 'error', error: error.message })
          return
        }
        // The handshake is retried, also when this is the first one: a connection
        // started before the network is up is not over (#1119).
        retry(gen, error.message)
        return
      }
      if (stopped || generation !== gen) return
      let next
      let service
      try {
        const id = Number(new URL(url).searchParams.get('service_id') ?? 0)
        service = Number.isSafeInteger(id) && id >= 0 ? id : 0
        next = new env.WebSocket(url)
        next.binaryType = 'arraybuffer'
        socket = next
      } catch (error) {
        retry(gen, `Feishu could not open a socket: ${error?.message ?? error}`)
        return
      }
      const current = () => !stopped && generation === gen && socket === next
      const schedulePing = () => {
        clearTimeout(pingTimer)
        pingTimer = setTimeout(ping, pingEvery)
        pingTimer.unref?.()
      }
      const ping = () => {
        if (!current() || next.readyState !== 1) return
        if (heartbeatTimer === undefined) {
          heartbeatTimer = setTimeout(() => retry(gen, 'Feishu heartbeat timed out'), SOCKET_TIMEOUT)
          heartbeatTimer.unref?.()
        }
        try {
          next.send(encodeFrame({ SeqID: 0, LogID: 0, service, method: 0, headers: [{ key: 'type', value: 'ping' }] }))
        } catch {
          retry(gen, 'Feishu could not send a heartbeat')
          return
        }
        schedulePing()
      }
      next.addEventListener('message', (event) => {
        if (!current()) return
        // Any inbound frame answers the liveness probe. The next scheduled
        // ping arms it again; healthy idle time must not start a short timeout.
        clearTimeout(heartbeatTimer)
        heartbeatTimer = undefined
        let frame
        try { frame = decodeFrame(Buffer.from(event.data)) } catch { return }
        const type = frame.headers.find(h => h.key === 'type')?.value
        if (frame.method === 0 && type === 'ping') { pong(frame); return }
        if (frame.method === 0 && type === 'pong') {
          const interval = pingInterval(safeJson(frame.payload?.toString('utf8'))?.PingInterval)
          if (interval !== undefined) { pingEvery = interval; schedulePing() }
          return
        }
        if (frame.method === 1 && type === 'reconnect') { retry(gen, 'Feishu requested a reconnect'); return }
        if (frame.method !== 1 || (type !== 'event' && type !== 'card')) return
        const messageId = frame.headers.find(h => h.key === 'message_id')?.value ?? ''
        const sum = Number(frame.headers.find(h => h.key === 'sum')?.value ?? 1)
        const seq = Number(frame.headers.find(h => h.key === 'seq')?.value ?? 1)
        ack(frame, 0)
        if (sum > 1) {
          const held = parts.get(messageId) ?? { received: new Map(), sum }
          held.received.set(seq, frame.payload)
          parts.set(messageId, held)
          if (held.received.size !== sum) return
          frame.payload = Buffer.concat([...held.received.keys()].sort((a, b) => a - b).map(s => held.received.get(s)))
          parts.delete(messageId)
        }
        void dispatch(type, frame.payload).catch(error => env.log?.warn?.('ds-bot im: feishu event failed: %s', error?.message ?? error))
      })
      next.addEventListener('open', () => {
        if (!current()) return
        clearTimeout(connectTimer)
        openFailures = 0
        handlers.onStatus({ state: 'ready' })
        ping()
      })
      next.addEventListener('close', () => retry(gen, 'Feishu socket closed'))
      next.addEventListener('error', () => retry(gen, 'Feishu socket error'))
      connectTimer = setTimeout(() => retry(gen, 'Feishu socket opening timed out'), SOCKET_TIMEOUT)
      connectTimer.unref?.()
    }

    handlers.onStatus({ state: 'connecting' })
    // The tenant token is fetched until it arrives: a connection started before the
    // network is up must connect once it is (#1119). The bot identity is fetched
    // again per handshake below; here it only fills the mention check.
    void (async () => {
      let attempt = 0
      while (!stopped) {
        try {
          const got = await tenantToken({ appId, appSecret }, env)
          token = got.token
          tokenExpiresAt = got.expiresAt
          const me = await api(env, apiBase(env, fields), token, '/open-apis/bot/v3/info', { method: 'GET' }).catch(() => ({}))
          botOpenId = String(me?.bot?.open_id ?? me?.open_id ?? '')
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

    const card = (text, buttons) => JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
          ...(buttons?.length > 0 ? [{
            // Schema 2.0 removed the `action` container; buttons live in column_set with callback behaviors.
            tag: 'column_set',
            flex_mode: 'flow',
            horizontal_spacing: '8px',
            columns: buttons.slice(0, 5).map(button => ({
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                type: 'primary',
                text: { tag: 'plain_text', content: button.label.slice(0, 20) },
                behaviors: [{ type: 'callback', value: { v: button.data } }],
              }],
            })),
          }] : []),
        ],
      },
    })

    return {
      send: async (chat, { text, buttons }) => {
        const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const interactive = buttons !== undefined && index === chunks.length - 1
          const sent = await rest('/open-apis/im/v1/messages?receive_id_type=chat_id', {
            body: {
              receive_id: chat.key,
              msg_type: interactive ? 'interactive' : 'text',
              content: interactive ? card(chunk, buttons) : JSON.stringify({ text: chunk }),
            },
          })
          messageId = String(sent?.data?.message_id ?? messageId ?? '')
        }
        return { messageId }
      },
      sendImage: async (chat, image) => {
        const bytes = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data ?? [])
        if (bytes.byteLength === 0) throw Object.assign(new Error('Empty image'), { permanent: true })
        const form = new FormData()
        form.append('image_type', 'message')
        form.append('image', new Blob([bytes], { type: image.mediaType || 'image/png' }), image.name || 'image.png')
        const upload = await env.fetch(`${apiBase(env, fields)}/open-apis/im/v1/images`, {
          method: 'POST',
          headers: { authorization: `Bearer ${await freshToken()}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        })
        const json = await upload.json().catch(() => ({}))
        const imageKey = String(json?.data?.image_key ?? '')
        if (!upload.ok || (json.code !== undefined && json.code !== 0) || imageKey === '') {
          const error = new Error(String(json.msg ?? `Feishu image upload answered ${upload.status}`))
          error.status = upload.status
          error.permanent = upload.status >= 400 && upload.status < 500 && upload.status !== 429
          if (upload.status === 429) error.retryAfter = Number(upload.headers.get('retry-after'))
          throw error
        }
        const sent = await rest('/open-apis/im/v1/messages?receive_id_type=chat_id', {
          body: {
            receive_id: chat.key,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        })
        return { messageId: String(sent?.data?.message_id ?? '') }
      },
      edit: async (chat, messageId, { text, buttons }) => {
        await rest(`/open-apis/im/v1/messages/${messageId}`, {
          method: 'PATCH',
          body: { msg_type: 'interactive', content: card(toMarkdown(text).slice(0, TEXT_LIMIT), buttons) },
        })
      },
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(reconnectTimer)
        clearSocketTimers()
        parts.clear()
        const previous = socket
        socket = undefined
        try { previous?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

const safeJson = (text) => { try { return JSON.parse(text ?? '{}') } catch { return {} } }
const toMarkdown = text => String(text ?? '')

const TYPE_NOTES = {
  sticker: '[Feishu sticker]',
  merge_forward: '[Feishu merged-and-forwarded chat history: cannot be expanded, ask the user to paste the key content]',
  share_chat: '[Feishu shared group card]',
  share_user: '[Feishu shared contact card]',
  location: '[Feishu shared location]',
  todo: '[Feishu shared task]',
  share_calendar_event: '[Feishu shared calendar event]',
}
const HANDLED_MESSAGE_TYPES = new Set(['text', 'post', 'image', 'file', 'audio', 'media', 'system'])

function messageNote(messageType, content) {
  if (!messageType || HANDLED_MESSAGE_TYPES.has(messageType)) return ''
  if (messageType === 'location' && content.name) return `[Feishu shared location: ${content.name}]`
  return TYPE_NOTES[messageType] ?? `[Feishu ${messageType} message]`
}

function fileAttachmentName(messageType, content, messageId) {
  const id = String(messageId ?? '')
  if (messageType === 'file') return String(content.file_name || (id ? `file-${id}` : 'file'))
  if (messageType === 'audio') return String(content.file_name || (id ? `voice-${id}.opus` : 'voice.opus'))
  if (messageType === 'media') return String(content.file_name || (id ? `video-${id}.mp4` : 'video.mp4'))
  return undefined
}

function flattenPost(content, botOpenId, mentionNames) {
  const body = Array.isArray(content.content) ? content : (Object.values(content).find(v => Array.isArray(v?.content)) ?? {})
  const imageKeys = []
  const formatAt = (el) => {
    const id = String(el.user_id ?? '')
    if (mentionNames.has(id)) return mentionNames.get(id)
    if (botOpenId !== '' && id === botOpenId) return ''
    return el.user_name ? `@${el.user_name}` : String(el.text ?? '')
  }
  const formatElement = (el) => {
    if (el?.tag === 'img' && el.image_key !== undefined && el.image_key !== '') {
      imageKeys.push(el.image_key)
      return ''
    }
    if (el?.tag === 'a') {
      if (!el.href) return String(el.text ?? '')
      return el.text && el.text !== el.href ? `${el.text} (${el.href})` : String(el.href)
    }
    if (el?.tag === 'at') return formatAt(el)
    if (el?.tag === 'emotion') return el.emoji_type ? `[${el.emoji_type}]` : ''
    if (el?.tag === 'code_block') return `\n\`\`\`${el.language ?? ''}\n${el.text ?? ''}\n\`\`\`\n`
    if (el?.tag === 'hr') return '---'
    return String(el?.text ?? '')
  }
  const lines = (body.content ?? []).map(row => (Array.isArray(row) ? row : []).map(formatElement).join(''))
  const text = [body.title, ...lines].filter(line => line !== undefined && line !== '').join('\n')
  return { text, imageKeys }
}

function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const header = bytes.toString('latin1', 0, 6)
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('Feishu returned an unsupported image format')
}

async function tenantToken(fields, env) {
  const response = await env.fetch(`${apiBase(env, fields)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: String(fields.appId ?? '').trim(), app_secret: String(fields.appSecret ?? '').trim() }),
  })
  const body = await response.json().catch(() => ({}))
  if (body.tenant_access_token === undefined) {
    const error = new Error(body.msg ?? 'Feishu refused these credentials')
    error.status = response.status
    // A 5xx or a 429 is the service, not the credentials: retry those.
    error.permanent = !(response.status >= 500 || response.status === 429)
    throw error
  }
  return { token: body.tenant_access_token, expiresAt: Date.now() + Math.max(60, Number(body.expire ?? 7200) - 300) * 1000 }
}

async function api(env, base, token, path, { method = 'GET', body } = {}) {
  const response = await env.fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    const error = new Error(String(json.msg ?? `Feishu answered ${response.status}`))
    error.status = response.status
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
    throw error
  }
  return json
}

async function resource(env, base, token, messageId, key, type) {
  const response = await env.fetch(`${base}/open-apis/im/v1/messages/${messageId}/resources/${key}?type=${type}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) return undefined
  return new Uint8Array(await response.arrayBuffer())
}
