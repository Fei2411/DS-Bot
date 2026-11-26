// WeCom intelligent robot: one long-lived WebSocket, a { cmd, headers: {
// req_id }, body } protocol — aibot_subscribe authenticates, ping heartbeats,
// aibot_msg_callback carries inbound messages answered through
// aibot_respond_msg with the callback's req_id, later messages use
// aibot_send_msg. Template-card buttons come back as aibot_event_callback.
// Encrypted images download with their per-link AES-256 key. Markdown.
// Wire details ported from @wecom/aibot-node-sdk (MIT, see NOTICE).
// The gateway takes a WebSocket on its root path only (/wss answers 403) and
// matches Connection / Upgrade case-sensitively, so the socket comes from `ws`:
// Node's built-in WebSocket sends those header names in lowercase.
import { createDecipheriv } from 'node:crypto'
import { chunkMarkdown } from '../format.js'
import { discardBody, FILE_LIMIT, IMAGE_LIMIT, mediaSignal, readCappedBytes } from './media.js'
import { retryDelay } from './retry.js'

// Loaded on first WeCom check or connect so plugin startup skips `ws` when unused.
let wsModule
const loadWs = () => (wsModule ??= import('ws').then(mod => mod.default))

const WSS = 'wss://openws.work.weixin.qq.com'
const TEXT_LIMIT = 4000
const LAST_REQ_ID_MAX = 1000
// Known permanent WeCom credential/config errcodes (invalid secret/corpid/token/agentid/bot or disabled API).
// Transient errors (-1, 45009/45011 rate limits, session conflicts, unknown codes) retry with backoff.
const FATAL_SUBSCRIBE_ERRCODES = new Set([40001, 40013, 40014, 40056, 41002, 41004, 48002, 60111])

const socketUrl = env => String(env.config?.gateway ?? env.config?.api ?? WSS).replace(/\/+$/, '')
// Keep the cause on screen: a refused handshake reports its HTTP status here.
const socketError = (error) => {
  const code = error?.code ?? error?.cause?.code
  const message = String(error?.message ?? error)
  return code !== undefined && !message.includes(code) ? `${message} (${code})` : message
}

export default {
  id: 'wecom',

  // The subscription itself is the credential check: a bad bot id or secret
  // fails the aibot_subscribe response.
  async check(fields, env) {
    const WebSocket = await loadWs()
    const botId = String(fields.botId ?? '').trim()
    const secret = String(fields.secret ?? '').trim()
    return await new Promise((resolve, reject) => {
      let socket
      let settled = false
      const finish = (error, account) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { socket?.terminate() } catch { /* not open */ }
        if (error === undefined) resolve({ account })
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error('WeCom did not answer the subscription')), 10_000)
      timer.unref?.()
      try { socket = new WebSocket(socketUrl(env)) } catch (error) {
        finish(new Error(`WeCom could not open a socket: ${socketError(error)}`))
        return
      }
      socket.on('open', () => {
        socket.send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'check-1' }, body: { secret, bot_id: botId } }))
      })
      socket.on('message', (data) => {
        let packet
        try { packet = JSON.parse(String(data)) } catch { return }
        if (packet.errcode === undefined) return
        if (packet.errcode === 0) finish(undefined, { id: botId, name: botId })
        else finish(new Error(String(packet.errmsg ?? `WeCom answered ${packet.errcode}`)))
      })
      socket.on('error', error => finish(new Error(`WeCom could not connect: ${socketError(error)}`)))
      socket.on('close', () => {})
    })
  },

  connect(fields, env, handlers) {
    const botId = String(fields.botId ?? '').trim()
    const secret = String(fields.secret ?? '').trim()
    let stopped = false
    const stopping = new AbortController()
    let socket
    let generation = 0
    let reconnectTimer
    let reconnectAttempt = 0
    let fatalAuth = false
    let pingTimer
    let reqCounter = 0
    // A refusal is kept on the status while the adapter retries.
    let lastError
    const fail = (message) => {
      lastError = message
      handlers.onStatus({ state: 'error', error: message })
    }
    // Passive replies reuse the last callback req_id per chat.
    const lastReqId = new Map()
    const rememberReqId = (key, reqId) => {
      lastReqId.delete(key)
      lastReqId.set(key, reqId)
      while (lastReqId.size > LAST_REQ_ID_MAX) lastReqId.delete(lastReqId.keys().next().value)
    }
    const pending = new Map() // req_id → {resolve, reject, timer}

    const nextReqId = () => `r${++reqCounter}`
    const sendFrame = (packet) => { if (socket?.readyState === 1) socket.send(JSON.stringify(packet)) }
    const request = (cmd, body, reqId) => {
      const req_id = reqId ?? nextReqId()
      sendFrame({ cmd, headers: { req_id }, body })
      if (cmd === 'aibot_send_msg') {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (pending.delete(req_id)) reject(new Error('WeCom did not answer the send'))
          }, 15_000)
          timer.unref?.()
          pending.set(req_id, {
            timer,
            resolve: (value) => { clearTimeout(timer); resolve(value) },
            reject: (error) => { clearTimeout(timer); reject(error) },
          })
        })
      }
    }

    const onCallback = async (headers, body) => {
      const key = String(body.chattype === 'single' ? body.from?.userid ?? '' : body.chatid ?? '')
      rememberReqId(key, String(headers?.req_id ?? ''))
      const direct = body.chattype === 'single'
      // Groups only count when the bot was @-ed: the text keeps the mention.
      // A voice message carries its own transcription, which is all of the text
      // there is to send on. A mixed message carries its words as items, so those
      // are gathered here rather than dropped: a caption is the whole instruction.
      const text = String(body.text?.content ?? body.voice?.content ?? '').trim()
      const images = []
      const files = []
      if (body.msgtype === 'image' && body.image?.url !== undefined) {
        const got = await downloadMedium(body.image, env, IMAGE_LIMIT, stopping.signal).catch(() => undefined)
        if (got !== undefined) images.push({ mediaType: imageTypeOf(got.bytes, got.name), data: got.bytes.toString('base64') })
      }
      if (body.msgtype === 'file' || body.msgtype === 'video') {
        const media = body[body.msgtype]
        if (media?.url !== undefined) {
          const got = await downloadMedium(media, env, FILE_LIMIT, stopping.signal).catch(error => error)
          if (got?.overLimit === true) env.log?.warn?.('ds-bot im: wecom %s is over the %d byte cap, skipped', body.msgtype, FILE_LIMIT)
          else if (got?.bytes !== undefined) files.push({ name: got.name || `wecom-${body.msgid ?? 'file'}`, data: got.bytes })
        }
      }
      // 图文混排: the words and the pictures of one message. Both matter — a picture
      // without its caption loses the instruction, and a text-only one would otherwise
      // arrive empty and be dropped.
      const mixedText = []
      if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
        for (const item of body.mixed.msg_item) {
          if (item?.msgtype === 'text') {
            const itemText = String(item.text?.content ?? '').trim()
            if (itemText !== '') mixedText.push(itemText)
            continue
          }
          if (item?.msgtype !== 'image' || item.image?.url === undefined) continue
          const got = await downloadMedium(item.image, env, IMAGE_LIMIT, stopping.signal).catch(error => error)
          if (got?.overLimit === true) env.log?.warn?.('ds-bot im: wecom mixed image is over the %d byte cap, skipped', IMAGE_LIMIT)
          else if (got?.bytes !== undefined) images.push({ mediaType: imageTypeOf(got.bytes, got.name), data: got.bytes.toString('base64') })
        }
      }
      // The core places one text part before every image, so splitting a mixed
      // message into its parts loses which caption sat beside which picture. The
      // words are joined rather than dropped: a caption is the whole instruction.
      const words = mixedText.length === 0 ? text : [text, ...mixedText].filter(part => part !== '').join('\n')
      // Reply frames go out with the callback's req_id; a failed reply is
      // logged but the message itself still lands in the core.
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group', title: '' },
        sender: { id: String(body.from?.userid ?? ''), name: String(body.from?.name ?? body.from?.userid ?? '') },
        text: words, images, files,
        mentioned: body.chattype !== 'single' && body.mention_robot === true,
        messageId: String(body.msgid ?? ''),
      })
    }

    const onEvent = async (headers, body) => {
      if (body.event?.event_type !== 'template_card_event' && body.event_type !== 'template_card_event') return
      const card = body.event?.template_card_event ?? body.template_card_event ?? {}
      const key = String(body.chattype === 'single' ? body.from?.userid ?? '' : body.chatid ?? card.chatid ?? '')
      await handlers.onAction({
        chat: { key, kind: body.chattype === 'single' ? 'direct' : 'group', title: '' },
        sender: { id: String(body.from?.userid ?? card.userid ?? ''), name: '' },
        data: String(card.event_key ?? card.key ?? ''),
        messageId: String(body.msgid ?? ''),
      })
    }

    const open = async () => {
      if (stopped || fatalAuth) return
      const gen = ++generation
      clearInterval(pingTimer)
      pingTimer = undefined
      const previous = socket
      socket = undefined
      try { previous?.close(4001, 'reconnect') } catch { /* not open */ }
      let next
      try {
        const WebSocket = await loadWs()
        if (stopped || generation !== gen) return
        next = new WebSocket(socketUrl(env))
        socket = next
      } catch (error) {
        if (stopped || generation !== gen) return
        fail(`WeCom could not open a socket: ${socketError(error)}`)
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(reconnectAttempt++))
        reconnectTimer.unref?.()
        return
      }
      let subscribeReqId
      next.on('open', () => {
        if (stopped || generation !== gen || socket !== next) return
        subscribeReqId = nextReqId()
        sendFrame({ cmd: 'aibot_subscribe', headers: { req_id: subscribeReqId }, body: { secret, bot_id: botId } })
      })
      next.on('message', (data) => {
        if (stopped || generation !== gen || socket !== next) return
        let packet
        try { packet = JSON.parse(String(data)) } catch { return }
        if (packet.errcode !== undefined) {
          if (packet.errcode !== 0) {
            fail(String(packet.errmsg ?? `WeCom answered ${packet.errcode}`))
            const held = pending.get(packet.headers?.req_id)
            if (held !== undefined) {
              pending.delete(packet.headers?.req_id)
              held.reject(Object.assign(new Error(String(packet.errmsg ?? 'WeCom refused')), { permanent: true }))
            }
            if (subscribeReqId !== undefined && packet.headers?.req_id === subscribeReqId) {
              if (FATAL_SUBSCRIBE_ERRCODES.has(Number(packet.errcode))) fatalAuth = true
              clearInterval(pingTimer)
              pingTimer = undefined
              try { next.close(1000, fatalAuth ? 'auth refused' : 'subscribe failed') } catch { /* not open */ }
            }
            return
          }
          if (packet.headers?.req_id !== undefined && pending.has(packet.headers.req_id)) {
            const held = pending.get(packet.headers.req_id)
            pending.delete(packet.headers.req_id)
            held.resolve(packet.body)
          }
          reconnectAttempt = 0
          lastError = undefined
          handlers.onStatus({ state: 'ready', account: { id: botId, name: botId } })
          return
        }
        if (packet.cmd === 'aibot_msg_callback') {
          void onCallback(packet.headers, packet.body ?? {}).catch(error => env.log?.warn?.('ds-bot im: wecom message failed: %s', error?.message ?? error))
        } else if (packet.cmd === 'aibot_event_callback') {
          void onEvent(packet.headers, packet.body ?? {}).catch(error => env.log?.warn?.('ds-bot im: wecom event failed: %s', error?.message ?? error))
        }
      })
      next.on('close', () => {
        if (socket === next) {
          clearInterval(pingTimer)
          pingTimer = undefined
        }
        if (stopped || generation !== gen || fatalAuth) return
        // A refusal stays on screen until a socket subscribes again.
        if (lastError === undefined) handlers.onStatus({ state: 'connecting' })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, retryDelay(reconnectAttempt++))
        reconnectTimer.unref?.()
      })
      next.on('error', (error) => {
        if (stopped || generation !== gen || socket !== next) return
        fail(`WeCom socket failed: ${socketError(error)}`)
      })
      pingTimer = setInterval(() => { if (!stopped && generation === gen && socket === next && next.readyState === 1) sendFrame({ cmd: 'ping', headers: { req_id: nextReqId() } }) }, 30_000)
      pingTimer.unref?.()
    }

    handlers.onStatus({ state: 'connecting' })
    void open()

    return {
      send: async (chat, { text, buttons }) => {
        const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const body = { msgtype: 'markdown', markdown: { content: chunk } }
          // Buttons ride a template card on the last chunk.
          if (index === chunks.length - 1 && buttons?.length > 0) {
            body.msgtype = 'template_card'
            body.template_card = {
              card_type: 'text_notice',
              main_title: { title: chunk.slice(0, 100) },
              card_action: { type: 2, url: 'https://work.weixin.qq.com' },
              button_selection: { question_key: 'choice', option_list: buttons.slice(0, 10).map(b => ({ id: b.data, text: b.label.slice(0, 30) })) },
            }
          }
          const reqId = lastReqId.get(chat.key)
          if (reqId !== undefined) {
            sendFrame({ cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body })
            messageId = undefined
          } else {
            const result = await request('aibot_send_msg', { ...body, chatid: chat.kind === 'group' ? chat.key : undefined, userid: chat.kind === 'direct' ? chat.key : undefined })
            messageId = String(result?.msgid ?? messageId ?? '')
          }
        }
        return { messageId }
      },
      stop: () => {
        stopped = true
        stopping.abort()
        generation += 1
        clearTimeout(reconnectTimer)
        clearInterval(pingTimer)
        pingTimer = undefined
        lastReqId.clear()
        for (const held of pending.values()) held.reject(new Error('stopped'))
        pending.clear()
        const previous = socket
        socket = undefined
        try { previous?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

// Inbound media (images, files, video, mixed items) downloads from its CDN URL and
// decrypts with the per-link AES-256 key (base64). The name comes from
// Content-Disposition: the callback body carries none for a file.
//
// The body is read in chunks and abandoned the moment it passes `limit`, so an
// oversized attachment costs neither the buffer nor the decrypt. Checking the size
// after buffering would have guarded nothing: the memory is already spent by then.
async function downloadMedium(medium, env, limit, signal) {
  const response = await env.fetch(String(medium.url), { signal: mediaSignal(signal) })
  if (!response.ok) {
    await discardBody(response)
    return undefined
  }
  const got = await readCappedBytes(response, limit)
  if (got.overLimit) throw Object.assign(new Error('over the media cap'), { overLimit: true })
  if (got.bytes === undefined) return undefined
  const key = Buffer.from(String(medium.aeskey ?? ''), 'base64')
  if (key.length !== 32) return undefined
  return { bytes: decryptMedia(got.bytes, key), name: filenameOf(response.headers?.get?.('content-disposition')) }
}

// WeCom pads to a 32-byte block, not the 16 that `setAutoPadding` assumes, so the
// padding is removed here: leaving it on makes `final()` throw on a bad decrypt.
function decryptMedia(encrypted, key) {
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const pad = plain[plain.length - 1]
  if (pad < 1 || pad > 32 || pad > plain.length) return plain
  for (let i = plain.length - pad; i < plain.length; i += 1) if (plain[i] !== pad) return plain
  return plain.subarray(0, plain.length - pad)
}

function filenameOf(contentDisposition) {
  const header = String(contentDisposition ?? '')
  if (header === '') return ''
  const utf8 = header.match(/filename\*=UTF-8''([^;\s]+)/i)
  if (utf8 !== null) {
    try { return decodeURIComponent(utf8[1]) } catch { /* a malformed escape keeps the plain name */ }
  }
  // A quoted filename may itself contain a semicolon, so it runs to its closing
  // quote; an unquoted one ends at the first semicolon, as the header grammar says.
  const plain = header.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i)
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim()
  if (name === '') return ''
  try { return decodeURIComponent(name) } catch { return name }
}

// WeCom does not say what an image is: declare what the bytes actually are, since a
// decrypted PNG labelled image/jpeg fails admission later on. The name is only a
// fallback for a format the signatures do not cover.
function imageTypeOf(bytes, name) {
  const at = (offset, ...signature) => signature.every((byte, index) => bytes[offset + index] === byte)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x42, 0x4d)) return 'image/bmp'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}
