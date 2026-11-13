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
import WebSocket from 'ws'
import { chunkMarkdown } from '../format.js'

const WSS = 'wss://openws.work.weixin.qq.com'
const TEXT_LIMIT = 4000
// A long-connection download reads the whole body into memory, so an oversized
// attachment is surfaced in the log instead of buffered.
const FILE_LIMIT = 100 * 1024 * 1024

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
    let socket
    let generation = 0
    let reconnectTimer
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
    const pending = new Map() // req_id → {resolve, reject}

    const nextReqId = () => `r${++reqCounter}`
    const sendFrame = (packet) => { if (socket?.readyState === 1) socket.send(JSON.stringify(packet)) }
    const request = (cmd, body, reqId) => {
      const req_id = reqId ?? nextReqId()
      sendFrame({ cmd, headers: { req_id }, body })
      if (cmd === 'aibot_send_msg') {
        return new Promise((resolve, reject) => {
          pending.set(req_id, { resolve, reject })
          setTimeout(() => {
            if (pending.delete(req_id)) reject(new Error('WeCom did not answer the send'))
          }, 15_000).unref?.()
        })
      }
    }

    const onCallback = async (headers, body) => {
      const key = String(body.chattype === 'single' ? body.from?.userid ?? '' : body.chatid ?? '')
      lastReqId.set(key, String(headers?.req_id ?? ''))
      const direct = body.chattype === 'single'
      // Groups only count when the bot was @-ed: the text keeps the mention.
      const text = String(body.text?.content ?? '').trim()
      const images = []
      const files = []
      if (body.msgtype === 'image' && body.image?.url !== undefined) {
        const bytes = await downloadImage(body.image, env).catch(() => undefined)
        if (bytes !== undefined) images.push({ mediaType: 'image/jpeg', data: Buffer.from(bytes).toString('base64') })
      }
      if (body.msgtype === 'file' || body.msgtype === 'video') {
        const media = body[body.msgtype]
        if (media?.url !== undefined) {
          const got = await downloadMedium(media, env).catch(() => undefined)
          if (got !== undefined) {
            if (got.bytes.length <= FILE_LIMIT) files.push({ name: got.name || `wecom-${body.msgid ?? 'file'}`, data: got.bytes })
            else env.log?.warn?.('ds-bot im: wecom %s is %d bytes, over the %d cap', body.msgtype, got.bytes.length, FILE_LIMIT)
          }
        }
      }
      // 图文混排: the image items ride the same encrypted-link path as a plain image.
      if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
        for (const item of body.mixed.msg_item) {
          if (item?.msgtype !== 'image' || item.image?.url === undefined) continue
          const got = await downloadMedium(item.image, env).catch(() => undefined)
          if (got === undefined) continue
          images.push({ mediaType: imageTypeOf(got.name), data: got.bytes.toString('base64') })
        }
      }
      // Reply frames go out with the callback's req_id; a failed reply is
      // logged but the message itself still lands in the core.
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group', title: '' },
        sender: { id: String(body.from?.userid ?? ''), name: String(body.from?.name ?? body.from?.userid ?? '') },
        text, images, files,
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

    const open = () => {
      const gen = generation
      try { socket = new WebSocket(socketUrl(env)) } catch (error) {
        fail(`WeCom could not open a socket: ${socketError(error)}`)
        return
      }
      socket.on('open', () => {
        sendFrame({ cmd: 'aibot_subscribe', headers: { req_id: nextReqId() }, body: { secret, bot_id: botId } })
      })
      socket.on('message', (data) => {
        if (stopped || generation !== gen) return
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
            return
          }
          if (packet.headers?.req_id !== undefined && pending.has(packet.headers.req_id)) {
            const held = pending.get(packet.headers.req_id)
            pending.delete(packet.headers.req_id)
            held.resolve(packet.body)
          }
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
      socket.on('close', () => {
        clearTimeout(pingTimer)
        if (stopped || generation !== gen) return
        // A refusal stays on screen until a socket subscribes again.
        if (lastError === undefined) handlers.onStatus({ state: 'connecting' })
        reconnectTimer = setTimeout(() => { if (!stopped) open() }, 2000)
        reconnectTimer.unref?.()
      })
      socket.on('error', (error) => {
        if (stopped || generation !== gen) return
        fail(`WeCom socket failed: ${socketError(error)}`)
      })
      pingTimer = setInterval(() => { if (!stopped && socket?.readyState === 1) sendFrame({ cmd: 'ping', headers: { req_id: nextReqId() } }) }, 30_000)
      pingTimer.unref?.()
    }

    handlers.onStatus({ state: 'connecting' })
    open()

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
        generation += 1
        clearTimeout(reconnectTimer)
        clearTimeout(pingTimer)
        for (const held of pending.values()) held.reject(new Error('stopped'))
        pending.clear()
        try { socket?.close(1000, 'stop') } catch { /* not open */ }
      },
    }
  },
}

// Inbound media (images, files, video, mixed items) downloads from its CDN URL and
// decrypts with the per-link AES-256 key (base64). The name comes from
// Content-Disposition: the callback body carries none for a file.
async function downloadMedium(medium, env) {
  const response = await env.fetch(String(medium.url))
  if (!response.ok) return undefined
  const encrypted = Buffer.from(await response.arrayBuffer())
  const key = Buffer.from(String(medium.aeskey ?? ''), 'base64')
  if (key.length !== 32) return undefined
  return { bytes: decryptMedia(encrypted, key), name: filenameOf(response.headers?.get?.('content-disposition')) }
}

async function downloadImage(image, env) {
  return (await downloadMedium(image, env))?.bytes
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
  const plain = header.match(/filename="?([^";]+)"?/i)
  if (plain === null) return ''
  try { return decodeURIComponent(plain[1].trim()) } catch { return plain[1].trim() }
}

// A mixed image arrives without a media type; the extension is the only clue.
function imageTypeOf(name) {
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}
