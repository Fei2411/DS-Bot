// DingTalk stream mode: connections/open with the client credentials opens a
// ticketed WebSocket; every frame is ACKed by echoing its messageId with
// code 200, system pings get a pong, and the robot callback carries the
// sessionWebhook for passive replies. Outside that window the OpenAPI
// batchSend/groupMessages path answers instead. No buttons — the core
// numbers choices. Wire details ported from dingtalk-stream (MIT, see
// NOTICE).
import { chunkMarkdown } from '../format.js'
import {
  createChatQueue, detectImageMediaType, discardBody,
  FILE_LIMIT, IMAGE_LIMIT, isHttpUrl, mediaSignal, readCappedBytes,
} from './media.js'
import { retryDelay, retryWait } from './retry.js'

const GATEWAY = 'https://api.dingtalk.com'
const OAPI = 'https://oapi.dingtalk.com'
const TEXT_LIMIT = 5000
const SOCKET_TIMEOUT = 30_000
const IDLE_TIMEOUT = 10 * 60_000

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
    const stopping = new AbortController()
    let socket
    let generation = 0
    let reconnectTimer
    let connectTimer
    let idleTimer
    let token
    let tokenExpiresAt = 0
    let tokenRefresh
    const ensureToken = async (signal) => {
      if (token !== undefined && tokenExpiresAt > Date.now() + 30_000) return token
      tokenRefresh ??= appToken(fields, env, signal)
        .then((answer) => {
          token = answer.accessToken
          tokenExpiresAt = answer.expiresAt
          return token
        })
        .finally(() => { tokenRefresh = undefined })
      return tokenRefresh
    }
    // Passive replies reuse the inbound sessionWebhook while it lives.
    const sessionWebhooks = new Map()
    const inOrder = createChatQueue()

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
            msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: chunk.slice(0, 30), text: chunk }),
          })
          messageId = String(answer?.processQueryKey ?? messageId ?? '')
        } else {
          const answer = await robot(env, await ensureToken(), clientId, '/v1.0/robot/groupMessages/send', {
            robotCode: clientId, openConversationId: chat.key,
            msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: chunk.slice(0, 30), text: chunk }),
          })
          messageId = String(answer?.processQueryKey ?? messageId ?? '')
        }
      }
      return { messageId }
    }

    const downloadCodeBytes = async (downloadCode, limit, robotCode = clientId) => {
      const signal = mediaSignal(stopping.signal)
      const answer = await robot(env, await ensureToken(signal), clientId, '/v1.0/robot/messageFiles/download', {
        downloadCode: String(downloadCode),
        robotCode: String(robotCode || clientId),
      }, signal)
      const url = String(answer?.downloadUrl ?? '').trim()
      if (!isHttpUrl(url)) return undefined
      const response = await env.fetch(url, { signal })
      if (!response.ok) {
        await discardBody(response)
        env.log?.warn?.('ds-bot im: dingtalk attachment download answered %s', response.status)
        return undefined
      }
      const got = await readCappedBytes(response, limit)
      if (got.overLimit) {
        env.log?.warn?.('ds-bot im: dingtalk attachment over %d byte cap, skipped', limit)
        return undefined
      }
      return got.bytes === undefined || got.bytes.length === 0 ? undefined : { bytes: got.bytes }
    }

    const onCallback = async (headers, raw) => {
      let data
      try { data = JSON.parse(raw) } catch { return }
      if (data.text === undefined && !['text', 'richText', 'picture', 'file'].includes(data.msgtype)) { ack(headers, { ok: true }); return }
      const direct = data.conversationType === '1'
      const mentioned = direct ? false : data.isInAtList === true
      const key = String(direct ? data.senderStaffId ?? data.senderId ?? '' : data.conversationId ?? '')
      if (data.sessionWebhook !== undefined) {
        sessionWebhooks.set(key, { url: String(data.sessionWebhook), until: Date.now() + 20 * 60_000 })
      }
      const sender = String(data.senderStaffId ?? data.senderId ?? '')
      const robotCode = String(data.robotCode || clientId)
      // ACK promptly before downloading media so DingTalk does not redeliver the frame.
      ack(headers, { ok: true })
      await inOrder(key, async () => {
        if (stopped) return
        const texts = []
        if (typeof data.text?.content === 'string' && data.text.content.trim() !== '') texts.push(data.text.content.trim())
        const content = typeof data.content === 'string'
          ? (() => { try { return JSON.parse(data.content) } catch { return {} } })()
          : (data.content ?? {})
        const pictureCodes = []
        const fileEntries = []
        if (data.msgtype === 'picture') {
          const code = content?.downloadCode ?? content?.pictureDownloadCode
          if (code) pictureCodes.push(String(code))
        } else if (data.msgtype === 'file') {
          const code = content?.downloadCode
          if (code) fileEntries.push({ code: String(code), name: String(content?.fileName ?? 'file') })
        } else if (data.msgtype === 'richText' && Array.isArray(content?.richText)) {
          for (const part of content.richText) {
            if (!part || typeof part !== 'object') continue
            if (typeof part.text === 'string' && part.text.trim() !== '') texts.push(part.text.trim())
            const code = part.downloadCode ?? part.pictureDownloadCode
            if (code && (part.type === 'picture' || part.pictureDownloadCode !== undefined)) pictureCodes.push(String(code))
            else if (code && part.type === 'file') fileEntries.push({ code: String(code), name: String(part.fileName ?? 'file') })
          }
        }
        const images = []
        const files = []
        for (const code of pictureCodes) {
          if (stopped) return
          try {
            const got = await downloadCodeBytes(code, IMAGE_LIMIT, robotCode)
            if (stopped) return
            if (got !== undefined) {
              const mediaType = detectImageMediaType(got.bytes)
              if (mediaType !== undefined) images.push({ mediaType, data: got.bytes.toString('base64') })
              else files.push({ name: 'image', data: got.bytes })
            }
          } catch (error) {
            if (!stopped) env.log?.warn?.('ds-bot im: dingtalk image download failed: %s', error?.message ?? error)
          }
        }
        for (const item of fileEntries) {
          if (stopped) return
          try {
            const got = await downloadCodeBytes(item.code, FILE_LIMIT, robotCode)
            if (stopped) return
            if (got !== undefined) files.push({ name: item.name, data: got.bytes })
          } catch (error) {
            if (!stopped) env.log?.warn?.('ds-bot im: dingtalk file download failed: %s', error?.message ?? error)
          }
        }
        await handlers.onMessage({
          chat: { key, kind: direct ? 'direct' : 'group', title: '' },
          sender: { id: sender, name: String(data.senderNick ?? sender) },
          text: texts.join('\n').trim(), images, files,
          mentioned, messageId: String(data.msgId ?? ''),
        })
      })
    }

    const clearSocketTimers = () => {
      clearTimeout(connectTimer)
      clearTimeout(idleTimer)
      connectTimer = idleTimer = undefined
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
      try {
        next = new env.WebSocket(url)
        socket = next
      } catch (error) {
        retry(gen, `DingTalk could not open a socket: ${error?.message ?? error}`)
        return
      }
      const current = () => !stopped && generation === gen && socket === next
      const touch = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => retry(gen, 'DingTalk received no frames for 10 minutes'), IDLE_TIMEOUT)
        idleTimer.unref?.()
      }
      next.addEventListener('message', (event) => {
        if (!current()) return
        touch()
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        const headers = packet.headers ?? {}
        if (packet.type === 'SYSTEM') {
          const disconnect = headers.topic === 'disconnect'
          if (disconnect || String(packet.data ?? '').includes('ping') || headers.eventType === 'ping' || headers.topic === 'ping') {
            sendFrame({ code: 200, headers, message: 'OK', data: packet.data })
          }
          if (disconnect) retry(gen, 'DingTalk requested a reconnect')
          return
        }
        if (packet.type === 'CALLBACK' || packet.type === 'EVENT') {
          void onCallback(headers, String(packet.data ?? '{}')).catch(error => env.log?.warn?.('ds-bot im: dingtalk message failed: %s', error?.message ?? error))
        }
      })
      next.addEventListener('open', () => {
        if (!current()) return
        clearTimeout(connectTimer)
        openFailures = 0
        touch()
        handlers.onStatus({ state: 'ready' })
      })
      next.addEventListener('close', () => retry(gen, 'DingTalk socket closed'))
      next.addEventListener('error', () => retry(gen, 'DingTalk socket error'))
      connectTimer = setTimeout(() => retry(gen, 'DingTalk socket opening timed out'), SOCKET_TIMEOUT)
      connectTimer.unref?.()
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
      sendImage: async (chat, image) => {
        const bytes = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data ?? [])
        if (bytes.byteLength === 0) throw Object.assign(new Error('Empty image'), { permanent: true })
        const form = new FormData()
        form.append('media', new Blob([bytes], { type: image.mediaType || 'image/png' }), image.name || 'image.png')
        const upResp = await env.fetch(`${oapiBase(env)}/media/upload?access_token=${encodeURIComponent(await ensureToken())}&type=image`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(30_000),
        })
        const upJson = await upResp.json().catch(() => ({}))
        const mediaId = String(upJson?.media_id ?? '')
        if (!upResp.ok || (upJson.errcode !== undefined && upJson.errcode !== 0) || mediaId === '') {
          // Clear cached token on expired/invalid access_token codes so retry fetches a fresh one.
          if ([40014, 42001].includes(Number(upJson.errcode))) { token = undefined; tokenExpiresAt = 0 }
          const error = new Error(String(upJson.errmsg ?? `DingTalk image upload answered ${upResp.status}`))
          error.status = upResp.status
          if (upResp.status === 429) error.retryAfter = Number(upResp.headers.get('retry-after'))
          error.permanent = upResp.status >= 400 && upResp.status < 500 && upResp.status !== 429
          throw error
        }
        const msgParam = JSON.stringify({ photoURL: mediaId })
        const answer = chat.kind === 'direct'
          ? await robot(env, await ensureToken(), clientId, '/v1.0/robot/oToMessages/batchSend', {
            robotCode: clientId, userIds: [chat.key], msgKey: 'sampleImageMsg', msgParam,
          })
          : await robot(env, await ensureToken(), clientId, '/v1.0/robot/groupMessages/send', {
            robotCode: clientId, openConversationId: chat.key, msgKey: 'sampleImageMsg', msgParam,
          })
        return { messageId: String(answer?.processQueryKey ?? '') }
      },
      stop: () => {
        stopped = true
        stopping.abort()
        generation += 1
        clearTimeout(reconnectTimer)
        clearSocketTimers()
        const previous = socket
        socket = undefined
        try { previous?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

// The app-level access token for OpenAPI sends (oapi gettoken, cached until
// it expires).
async function appToken(fields, env, signal) {
  const url = `${oapiBase(env)}/gettoken?appkey=${encodeURIComponent(String(fields.clientId ?? '').trim())}&appsecret=${encodeURIComponent(String(fields.clientSecret ?? '').trim())}`
  const response = await env.fetch(url, signal !== undefined ? { signal } : undefined)
  const body = await response.json().catch(() => ({}))
  if (body.errcode !== 0 || body.access_token === undefined) {
    const error = new Error(String(body.errmsg ?? 'DingTalk refused these credentials'))
    // A 5xx or a 429 is the service, not the credentials: retry those.
    error.permanent = !(response.status >= 500 || response.status === 429)
    throw error
  }
  return { accessToken: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in ?? 7200) - 300) * 1000 }
}

async function robot(env, token, clientId, path, body, signal) {
  if (token === undefined) throw Object.assign(new Error('DingTalk has no access token yet'), { permanent: false })
  const response = await env.fetch(`${gatewayBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(String(json.message ?? json.errmsg ?? `DingTalk answered ${response.status}`))
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
    throw error
  }
  return json
}
