// Feishu / Lark: the long connection speaks protobuf pbbp2 frames — control
// pings answered with pong, data frames ACKed by sending the frame back with a
// {"code":200} payload and a biz_rt header; split payloads reassemble by
// sum/seq. p2p messages are direct; a group message counts when the bot's
// open_id is in its mentions. Sends go through the OpenAPI with a tenant
// access token: interactive cards with a markdown element and buttons, edited
// by PATCH. The tiny protobuf codec below implements only this frame shape.
// Protocol ported from @larksuiteoapi/node-sdk (MIT, see NOTICE).
import { createHash } from 'node:crypto'
import { chunkMarkdown } from '../format.js'
import { retryDelay, retryWait } from './retry.js'
import { OfficialTurnStream, convertMessageContent, LarkClient, bindTerminalTables, setLoggerProvider } from '../vendor/feishu/official-stream.js'
import { officialConfig, officialRuntime, officialSdk } from './feishu-transport.js'

const TEXT_LIMIT = 4000

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
    let token
    let tokenExpiresAt = 0
    let botOpenId = ''
    // Split data frames reassemble by (sum, seq) until all parts arrive.
    const parts = new Map()
    // Feishu can redeliver an ACKed event after a reconnect. Keep only IDs and
    // timestamps in the IM runtime ledger; no message bodies or credentials.
    const claimMessage = (messageId) => {
      const id = String(messageId ?? '')
      if (id === '') return false
      const now = Date.now()
      const seen = { ...(env.runtime?.get?.().messages ?? {}) }
      if (seen[id] !== undefined) return false
      seen[id] = now
      const entries = Object.entries(seen).filter(([, at]) => typeof at === 'number' && now - at < 12 * 60 * 60 * 1000)
      env.runtime?.set?.({ messages: Object.fromEntries(entries.slice(-5000)) })
      return true
    }
    const releaseMessage = (messageId) => {
      const seen = { ...(env.runtime?.get?.().messages ?? {}) }
      delete seen[String(messageId ?? '')]
      env.runtime?.set?.({ messages: seen })
    }

    const rest = async (path, { method = 'POST', body } = {}) => {
      if (token === undefined || Date.now() > tokenExpiresAt - 30_000) {
        const got = await tenantToken({ appId, appSecret }, env)
        token = got.token
        tokenExpiresAt = got.expiresAt
      }
      return api(env, apiBase(env, fields), token, path, { method, body })
    }

    const sendFrame = (buffer) => { if (socket?.readyState === 1) socket.send(buffer) }
    const pong = (frame) => sendFrame(encodeFrame({ ...frame, headers: frame.headers.map(h => h.key === 'type' ? { key: 'type', value: 'pong' } : h), payload: Buffer.from('pong') }))
    const ack = (frame, ms) => sendFrame(encodeFrame({
      ...frame,
      headers: [...frame.headers.filter(h => h.key !== 'biz_rt'), { key: 'biz_rt', value: String(ms) }],
      payload: Buffer.from(JSON.stringify({ code: 200, headers: {}, data: '' })),
      payloadType: 'json',
    }))

    // The official controller still speaks the Lark SDK shape, but every call
    // goes through this adapter's REST/token path. No OpenClaw runtime or
    // session controller is registered. Account IDs include the connection so
    // two Feishu applications never share a cached SDK credential.
    const base = apiBase(env, fields)
    const accountId = String(fields.connectionId ?? 'default')
    const cfg = officialConfig(fields, env, base)
    const restToken = async () => {
      if (token === undefined || Date.now() > tokenExpiresAt - 30_000) {
        const got = await tenantToken({ appId, appSecret }, env)
        token = got.token
        tokenExpiresAt = got.expiresAt
      }
      return token
    }
    const officialRest = Object.assign(async (path, options) => api(env, base, await restToken(), path, options), { token: restToken })
    const client = LarkClient.fromCfg(cfg, accountId)
    client._sdk = officialSdk(officialRest, { base, fetch: env.fetch })
    const runtime = officialRuntime(env.log)
    LarkClient.setRuntime(runtime)
    setLoggerProvider(runtime)

    const resourceFile = async (messageId, fileKey, type, name) => {
      const bytes = await resource(env, base, await restToken(), messageId, fileKey, type === 'image' ? 'image' : 'file')
      if (bytes === undefined) throw new Error(`Feishu resource unavailable: ${type}`)
      const mime = sniffMime(bytes)
      if (type === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('Feishu image has an unsupported format')
      return { name: String(name ?? fileKey), ...(type === 'image' ? { mediaType: mime, data: Buffer.from(bytes).toString('base64') } : { data: Buffer.from(bytes) }) }
    }
    const fetchSubMessages = async (messageId) => (await officialRest(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { method: 'GET' }))?.data?.items ?? []
    const convertMessage = async (message, { download = true } = {}) => {
      const type = message.message_type ?? message.msg_type ?? 'unknown'
      const raw = message.content ?? message.body?.content ?? '{}'
      const mentions = message.mentions ?? []
      const byKey = new Map(mentions.map(item => [item.key, { key: item.key, openId: item.id?.open_id ?? '', name: item.name ?? '', isBot: item.id?.open_id === botOpenId }]))
      const byOpenId = new Map([...byKey.values()].map(item => [item.openId, item]))
      const converted = await convertMessageContent(typeof raw === 'string' ? raw : JSON.stringify(raw), type, {
        mentions: byKey, mentionsByOpenId: byOpenId, messageId: message.message_id,
        botOpenId, cfg, accountId, stripBotMentions: true, fetchSubMessages,
        batchResolveNames: async () => {}, resolveUserName: id => byOpenId.get(id)?.name,
      })
      const images = [], files = []
      // Quoted context is bounded textual metadata: do not upload its files to
      // the model again. Current-message resources retain native attachment flow.
      for (const item of converted.resources ?? []) {
        const isImage = item.type === 'image' || item.type === 'sticker'
        if (!download) { (isImage ? images : files).push({ name: item.fileName ?? item.fileKey, descriptor: true }); continue }
        const file = await resourceFile(message.message_id, item.fileKey, isImage ? 'image' : 'file', item.fileName)
        ;(isImage ? images : files).push(file)
      }
      let text = converted.content
      if (text.trim() === '' && converted.resources?.length) text = converted.resources.map(item => item.type === 'image' ? '[图片]' : `[附件 ${item.fileName ?? item.fileKey}]`).join('\n')
      return { text, images, files }
    }

    const dispatch = async (type, body) => {
      const payload = JSON.parse(body.toString('utf8'))
      if (type === 'event' && payload.header?.event_type === 'im.message.receive_v1') {
        const event = payload.event ?? {}
        const message = event.message ?? {}
        if (event.sender?.sender_type === 'bot' || event.sender?.sender_type === 'app') return
        const createdAt = Number(message.create_time)
        if (Number.isFinite(createdAt) && createdAt > 0 && Date.now() - createdAt > 30 * 60 * 1000) return
        if (!claimMessage(message.message_id)) return
        try {
          const direct = message.chat_type === 'p2p'
          const mentioned = !direct && (message.mentions ?? []).some(m => m.id?.open_id === botOpenId || m.key === `@_user_${1}`)
          const { text, images, files } = await convertMessage(message)
          const sender = event.sender?.sender_id?.open_id ?? event.sender?.user_id ?? ''
          let quoted = ''
          if (message.parent_id) {
            const got = await rest(`/open-apis/im/v1/messages/${encodeURIComponent(message.parent_id)}`, { method: 'GET' }).catch(() => undefined)
            const item = got?.data?.items?.[0]
            if (item !== undefined) {
              const parent = await convertMessage(item, { download: false })
              const value = [parent.text, ...parent.images.map(() => '[图片]'), ...parent.files.map(file => `[附件 ${file.name}]`)].filter(Boolean).join('\n')
              if (value !== '') quoted = `[引用的消息: ${value.slice(0, 4000)}]\n\n`
            }
          }
          await handlers.onMessage({
            chat: { key: String(message.chat_id ?? ''), kind: direct ? 'direct' : 'group', title: String(message.chat_id ?? '') },
            sender: { id: String(sender), name: String(sender) },
            text: `${quoted}${text}`, images, files,
            mentioned, messageId: String(message.message_id ?? ''),
          })
        } catch (error) {
          releaseMessage(message.message_id)
          throw error
        }
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

    let openFailures = 0
    const open = async () => {
      const gen = generation
      let url
      try {
        if (token === undefined || Date.now() > tokenExpiresAt - 30_000) {
          const got = await tenantToken({ appId, appSecret }, env)
          token = got.token
          tokenExpiresAt = got.expiresAt
        }
        const answer = await env.fetch(`${apiBase(env, fields)}/callback/ws/endpoint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
        })
        const body = await answer.json().catch(() => ({}))
        url = body.data?.URL
        if (url === undefined || (body.code !== undefined && body.code !== 0)) {
          const reason = body.msg ?? `Feishu answered ${answer.status}`
          const error = new Error(body.code === undefined ? reason : `${reason} (code ${body.code})`)
          // A 200 that carries no WebSocket URL is the platform refusing the app.
          error.permanent = answer.ok || (answer.status >= 400 && answer.status < 500 && answer.status !== 429)
          throw error
        }
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
      try {
        socket = new env.WebSocket(url)
        socket.binaryType = 'arraybuffer'
      } catch (error) {
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'retrying', error: `Feishu could not open a socket: ${error?.message ?? error}` })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(openFailures))
        reconnectTimer.unref?.()
        openFailures += 1
        return
      }
      socket.addEventListener('message', (event) => {
        if (stopped || generation !== gen) return
        let frame
        try { frame = decodeFrame(Buffer.from(event.data)) } catch { return }
        const type = frame.headers.find(h => h.key === 'type')?.value
        if (frame.method === 0 && type === 'ping') { pong(frame); return }
        if (frame.method === 1 && type === 'reconnect') { socket.close(4000, 'Reconnect requested'); return }
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
            tag: 'action',
            actions: buttons.slice(0, 5).map(button => ({
              tag: 'button', type: 'primary',
              text: { tag: 'plain_text', content: button.label.slice(0, 20) },
              value: { v: button.data },
            })),
          }] : []),
        ],
      },
    })

    // The exact official lifecycle, including tool/text lanes, table budgets,
    // image resolution and terminal cards. DS Bot owns admission/routing only.
    const streams = new Map()
    // The queue retries the same job object. Do not append its durable text a
    // second time when a retry resumes an existing stream.
    const deliveryJobs = new WeakMap()
    const checkpoints = new Map(Object.entries(env.runtime?.get?.().streams ?? {}))
    const streamFactory = bindTerminalTables(cfg.channels.feishu.tableRenderMode === 'native' ? 'native' : 'markdown')
    const keyOf = chat => `${chat.sessionId ?? chat.key}:${chat.turn ?? 0}`
    const validTurn = chat => Number.isSafeInteger(chat.turn) && chat.turn > 0
    const checkpoint = (key, state) => {
      if (state === undefined) { checkpoints.delete(key); streams.delete(key) }
      else checkpoints.set(key, state)
      const persisted = Object.fromEntries([...checkpoints].slice(-100))
      env.runtime?.set?.({ streams: persisted })
    }
    const streamFor = chat => {
      const key = keyOf(chat)
      let held = streams.get(key)
      if (held) return held
      const state = checkpoints.get(key)
      const notification = {
        // Feishu accepts at most 50 characters. Hash the stable Session+turn
        // key instead of truncating away either the session suffix or turn.
        uuid: `dsbot-${createHash('sha256').update(key).digest('base64url').slice(0, 40)}`,
        ...(state ? { state } : {}),
        checkpoint: next => checkpoint(key, next),
      }
      held = {
        stream: new OfficialTurnStream(String(chat.sessionId ?? chat.key), chat.key,
          chat.replyTo, cfg, streamFactory, accountId, notification),
        committed: '', live: '', tools: new Map(), key,
        committedParts: [], liveParts: new Map(), pendingDeliver: false,
      }
      streams.set(key, held)
      return held
    }
    const visibleText = held => [held.committed, held.live].filter(Boolean).join('\n\n')
    const sendMessage = async (chat, msgType, content) => {
      if (chat.replyTo) return rest(`/open-apis/im/v1/messages/${encodeURIComponent(chat.replyTo)}/reply`, {
        body: { msg_type: msgType, content, reply_in_thread: false },
      })
      return rest('/open-apis/im/v1/messages?receive_id_type=chat_id', {
        body: { receive_id: chat.key, msg_type: msgType, content },
      })
    }

    const sendStatic = async (chat, text) => {
      let messageId = ''
      for (const chunk of chunkMarkdown(String(text ?? ''), TEXT_LIMIT)) {
        const sent = await sendMessage(chat, 'text', JSON.stringify({ text: chunk }))
        const id = sent?.data?.message_id
        if (typeof id !== 'string' || id === '') throw new Error('Feishu text reply returned no message_id')
        messageId = id
      }
      return { messageId }
    }

    return {
      send: async (chat, job) => {
        const { text, buttons, system, replyTo } = job
        chat = { ...chat, ...(replyTo ? { replyTo } : {}) }
        if (buttons !== undefined) {
          // Question/approval cards: plain interactive path (buttons + edit settle).
          chat = { ...chat, ...(replyTo ? { replyTo } : {}) }
          const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
          let messageId
          for (const [index, chunk] of chunks.entries()) {
            const interactive = index === chunks.length - 1
            const sent = await sendMessage(chat, interactive ? 'interactive' : 'text',
              interactive ? card(chunk, buttons) : JSON.stringify({ text: chunk }))
            messageId = String(sent?.data?.message_id ?? messageId ?? '')
          }
          return { messageId }
        }
        const body = String(text ?? '')
        if (body.trim() === '') return { messageId: '' }
        if (system === true) {
          chat = { ...chat, ...(replyTo ? { replyTo } : {}) }
          let messageId
          for (const chunk of chunkMarkdown(body, TEXT_LIMIT)) {
            const sent = await sendMessage(chat, 'text', JSON.stringify({ text: chunk }))
            messageId = String(sent?.data?.message_id ?? messageId ?? '')
          }
          return { messageId }
        }
        const held = streamFor(chat)
        held.pendingDeliver = true
        if (deliveryJobs.get(job) !== held.key) {
          held.committedParts.push(body)
          deliveryJobs.set(job, held.key)
        }
        held.committed = held.committedParts.join('\n\n')
        // The durable assistant/message is authoritative. It may arrive before
        // the matching stream end, so the live preview is now the same text,
        // not another paragraph. pendingDeliver also blocks later live deltas.
        held.liveParts.clear()
        held.live = ''
        await held.stream.text(visibleText(held))
        if (held.stream.phase === 'creation_failed') {
          // No CardKit entity exists, so a quoted text reply is safe. Keep its
          // actual id: turnEnd must not deliver the same durable text again.
          const current = visibleText(held)
          const previous = held.fallbackText ?? ''
          if (current === previous && held.fallbackMessageId) return { messageId: held.fallbackMessageId }
          const addition = previous && current.startsWith(previous) ? current.slice(previous.length).trimStart() : current
          const target = held.fallbackMessageId ? { ...chat, replyTo: undefined } : chat
          const sent = await sendStatic(target, addition)
          held.fallbackMessageId = sent.messageId
          held.fallbackText = current
          return sent
        }
        return { messageId: held.stream.messageId ?? '' }
      },
      assistantFrame: async (chat, frame) => {
        if (!validTurn(chat)) return
        const held = streamFor(chat)
        if (frame.type === 'start') {
          held.attempt = frame.attemptId
          held.liveParts.delete(frame.attemptId)
          held.live = [...held.liveParts.values()].join('')
          return
        }
        if (frame.type === 'end') {
          // Only a committed attempt has a durable assistant/message following
          // it. Keep that snapshot for the terminal card, drop an abandoned
          // retry attempt entirely.
          if (frame.outcome?.kind !== 'committed') held.liveParts.delete(frame.attemptId)
          if (held.attempt === frame.attemptId) held.attempt = undefined
          held.live = [...held.liveParts.values()].join('')
          return
        }
        if (!frame.attemptId || held.attempt !== frame.attemptId || held.pendingDeliver) return
        if (frame.chunk?.type === 'text-delta') {
          const text = String(frame.chunk.text ?? '')
          held.liveParts.set(frame.attemptId, (held.liveParts.get(frame.attemptId) ?? '') + text)
          held.live = [...held.liveParts.values()].join('')
          await held.stream.text(visibleText(held))
        }
        return { messageId: held.stream.messageId ?? '' }
      },
      toolEvent: async (chat, step) => {
        if (!validTurn(chat)) return
        const held = streamFor(chat)
        if (step.phase === 'call') {
          held.tools.set(step.callId, { name: step.name, params: step.params, startedAt: Date.now() })
          await held.stream.toolStart({ name: step.name ?? 'tool', callId: step.callId, params: step.params })
        } else {
          const started = held.tools.get(step.callId)
          await held.stream.toolEnd({ name: started?.name ?? step.name ?? 'tool', callId: step.callId,
            params: started?.params, result: step.result, error: step.error,
            durationMs: started ? Date.now() - started.startedAt : undefined })
          held.tools.delete(step.callId)
        }
      },
      turnEnd: async (chat, reason) => {
        if (!validTurn(chat)) return
        const key = keyOf(chat)
        const held = streams.get(key)
        try {
          if (!held) {
            if (reason?.kind === 'error' || reason?.kind === 'aborted') {
              const fallback = streamFor(chat)
              await fallback.stream[reason.kind === 'error' ? 'fail' : 'abort'](reason.error?.message)
              const sent = !fallback.stream.messageId
                ? await sendStatic(chat, reason.kind === 'error' ? '本轮生成失败，请稍后重试。' : '本轮已停止。')
                : undefined
              checkpoint(key, undefined)
              return { messageId: fallback.stream.messageId ?? sent?.messageId ?? '' }
            }
            return { messageId: '' }
          }
          if (reason?.kind === 'error') await held.stream.fail(reason.error?.message ?? 'Turn failed')
          else if (reason?.kind === 'aborted') await held.stream.abort()
          else await held.stream.complete(visibleText(held))
          if (!held.stream.messageId && !held.fallbackMessageId && visibleText(held)) {
            const sent = await sendStatic(chat, visibleText(held))
            held.fallbackMessageId = sent.messageId
          }
          checkpoint(key, undefined)
          return { messageId: held.stream.messageId ?? held.fallbackMessageId ?? '' }
        } catch (error) {
          // Keep the terminal controller and its accumulated text. Its
          // notification checkpoint resumes the same card on the next close.
          throw error
        }
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
        streams.clear()
        try { socket?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

const sniffMime = (bytes) => {
  const data = Buffer.from(bytes ?? [])
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  return 'application/octet-stream'
}
const toMarkdown = text => String(text ?? '')

async function tenantToken(fields, env) {
  const response = await env.fetch(`${apiBase(env, fields)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: String(fields.appId ?? '').trim(), app_secret: String(fields.appSecret ?? '').trim() }),
  })
  const body = await response.json().catch(() => ({}))
  if (body.tenant_access_token === undefined) {
    const error = new Error(body.msg ?? 'Feishu refused these credentials')
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
