// WeCom intelligent robot: one long-lived WebSocket, a { cmd, headers: {
// req_id }, body } protocol — aibot_subscribe authenticates, ping heartbeats,
// aibot_msg_callback carries inbound messages answered through
// aibot_respond_msg with the callback's req_id, later messages use
// aibot_send_msg. Template-card buttons come back as aibot_event_callback.
// Encrypted images download with their per-link AES-256 key. Markdown.
// Wire details ported from @wecom/aibot-node-sdk (MIT, see NOTICE).
import { createDecipheriv } from 'node:crypto'
import { chunkMarkdown } from '../format.js'

const WSS = 'wss://openws.work.weixin.qq.com'
const TEXT_LIMIT = 4000

const wsBase = env => String(env.config?.gateway ?? env.config?.api ?? WSS).replace(/\/+$/, '')

export default {
  id: 'wecom',

  // The subscription itself is the credential check: a bad bot id or secret
  // fails the aibot_subscribe response.
  async check(fields, env) {
    const botId = String(fields.botId ?? '').trim()
    const secret = String(fields.secret ?? '').trim()
    if (env.WebSocket === undefined) throw new Error('This dsh runs on a Node without WebSocket')
    return await new Promise((resolve, reject) => {
      let socket
      const finish = (error, account) => {
        clearTimeout(timer)
        try { socket?.close(1000, 'check') } catch { /* not open */ }
        if (error === undefined) resolve({ account })
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error('WeCom did not answer the subscription')), 10_000)
      try { socket = new env.WebSocket(`${wsBase(env)}/wss`) } catch (error) {
        finish(new Error(`WeCom could not open a socket: ${error?.message ?? error}`))
        return
      }
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'check-1' }, body: { secret, bot_id: botId } }))
      })
      socket.addEventListener('message', (event) => {
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        if (packet.errcode === undefined) return
        if (packet.errcode === 0) finish(undefined, { id: botId, name: botId })
        else finish(new Error(String(packet.errmsg ?? `WeCom answered ${packet.errcode}`)))
      })
      socket.addEventListener('error', () => finish(new Error('WeCom refused the socket')))
      socket.addEventListener('close', () => {})
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
      if (body.msgtype === 'image' && body.image?.url !== undefined) {
        const bytes = await downloadImage(body.image, env).catch(() => undefined)
        if (bytes !== undefined) images.push({ mediaType: 'image/jpeg', data: Buffer.from(bytes).toString('base64') })
      }
      // Reply frames go out with the callback's req_id; a failed reply is
      // logged but the message itself still lands in the core.
      await handlers.onMessage({
        chat: { key, kind: direct ? 'direct' : 'group', title: '' },
        sender: { id: String(body.from?.userid ?? ''), name: String(body.from?.name ?? body.from?.userid ?? '') },
        text, images, files: [],
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
      try { socket = new env.WebSocket(`${wsBase(env)}/wss`) } catch (error) {
        handlers.onStatus({ state: 'error', error: `WeCom could not open a socket: ${error?.message ?? error}` })
        return
      }
      socket.addEventListener('open', () => {
        sendFrame({ cmd: 'aibot_subscribe', headers: { req_id: nextReqId() }, body: { secret, bot_id: botId } })
      })
      socket.addEventListener('message', (event) => {
        if (stopped || generation !== gen) return
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        if (packet.errcode !== undefined) {
          if (packet.errcode !== 0) {
            handlers.onStatus({ state: 'error', error: String(packet.errmsg ?? `WeCom answered ${packet.errcode}`) })
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
          handlers.onStatus({ state: 'ready', account: { id: botId, name: botId } })
          return
        }
        if (packet.cmd === 'aibot_msg_callback') {
          void onCallback(packet.headers, packet.body ?? {}).catch(error => env.log?.warn?.('ds-bot im: wecom message failed: %s', error?.message ?? error))
        } else if (packet.cmd === 'aibot_event_callback') {
          void onEvent(packet.headers, packet.body ?? {}).catch(error => env.log?.warn?.('ds-bot im: wecom event failed: %s', error?.message ?? error))
        }
      })
      socket.addEventListener('close', () => {
        clearTimeout(pingTimer)
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'connecting' })
        reconnectTimer = setTimeout(() => { if (!stopped) open() }, 2000)
        reconnectTimer.unref?.()
      })
      socket.addEventListener('error', () => {})
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

// Images download from their CDN URL and decrypt with the per-link AES-256
// key (base64).
async function downloadImage(image, env) {
  const response = await env.fetch(String(image.url))
  if (!response.ok) return undefined
  const encrypted = Buffer.from(await response.arrayBuffer())
  const key = Buffer.from(String(image.aeskey ?? ''), 'base64')
  if (key.length !== 32) return undefined
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
