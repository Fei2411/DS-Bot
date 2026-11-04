// Discord: the Gateway over a WebSocket and the REST API for sends. DMs have no
// guild_id; a group message counts as a mention when the bot user is in
// `mentions`. Buttons are components; interactions come back as
// INTERACTION_CREATE and are answered with a deferred update (type 6).
// Wire details ported from dsh-im (MIT, see NOTICE).
import { chunkMarkdown, toPlain } from '../format.js'

const API = 'https://discord.com/api/v10'
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
// guilds | guild messages | direct messages | message content
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
const TEXT_LIMIT = 2000

const apiBase = env => String(env.config?.api ?? API).replace(/\/+$/, '')
const wsBase = env => String(env.config?.gateway ?? GATEWAY)

const errorOf = (body, status) => {
  const error = new Error(String(body?.message ?? `Discord answered ${status}`))
  error.status = status
  if (body?.errors?.retry_after !== undefined || body?.retry_after !== undefined) error.retryAfter = Number(body.errors?.retry_after ?? body.retry_after) * 1000 / 1000
  // Discord's retry_after is in seconds, and may be fractional.
  if (body?.retry_after !== undefined) error.retryAfter = Number(body.retry_after)
  error.permanent = status >= 400 && status < 500 && status !== 429
  return error
}

export default {
  id: 'discord',

  async check(fields, env) {
    const me = await request(env, fields, '/users/@me')
    if (me?.id === undefined || me.bot !== true) throw new Error('This token does not belong to a Discord bot')
    return { account: { id: String(me.id), name: me.username ? `@${me.username}` : String(me.id) } }
  },

  connect(fields, env, handlers) {
    const token = String(fields.token ?? '').trim()
    let stopped = false
    let socket
    let heartbeatTimer
    let heartbeatAcked = true
    let sequence
    let sessionId
    let resumeUrl
    let generation = 0
    let reconnectTimer
    const self = { id: undefined, name: '' }

    const rest = async (path, options = {}) => {
      const response = await env.fetch(`${apiBase(env)}${path}`, {
        method: options.method ?? 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bot ${token}` },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw errorOf(body, response.status)
      return body
    }

    const send = (packet) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify(packet))
    }
    const heartbeat = () => send({ op: 1, d: sequence ?? null })
    const scheduleHeartbeat = (interval) => {
      clearTimeout(heartbeatTimer)
      heartbeatAcked = true
      const beat = () => {
        if (!heartbeatAcked) { socket?.close(4000, 'Heartbeat lost'); return }
        heartbeatAcked = false
        heartbeat()
        heartbeatTimer = setTimeout(beat, interval)
      }
      heartbeatTimer = setTimeout(beat, interval * Math.random())
      heartbeatTimer.unref?.()
    }

    const onMessageEvent = async (data) => {
      if (data.author?.bot === true) return
      const direct = data.guild_id === undefined
      const mentioned = direct ? false : (data.mentions ?? []).some(user => String(user.id) === self.id)
      const chat = {
        key: String(data.channel_id),
        kind: direct ? 'direct' : 'group',
        title: data.channel?.name ?? direct ? String(data.author?.username ?? '') : '',
      }
      const images = []
      const files = []
      for (const item of data.attachments ?? []) {
        try {
          const response = await env.fetch(item.url)
          const bytes = new Uint8Array(await response.arrayBuffer())
          const mediaType = String(item.content_type ?? '')
          if (mediaType.startsWith('image/')) images.push({ mediaType, data: Buffer.from(bytes).toString('base64') })
          else files.push({ name: String(item.filename ?? 'file'), data: bytes })
        } catch { /* an attachment that cannot be fetched just does not arrive */ }
      }
      const text = String(data.content ?? '')
      await handlers.onMessage({
        chat,
        sender: { id: String(data.author?.id ?? ''), name: String(data.author?.username ?? '') },
        text: mentioned && self.name ? text.replaceAll(`<@${self.id}>`, '').replaceAll(`<@!${self.id}>`, '').trim() : text,
        images, files, mentioned, messageId: String(data.id ?? ''),
      })
    }

    const onInteraction = async (data) => {
      // Type 3 is a component press: answer it with a deferred update and hand
      // the action to the core.
      if (data.type !== 3) return
      await rest(`/interactions/${data.id}/${data.token}/callback`, { body: { type: 6 } }).catch(() => {})
      const from = data.user ?? data.member?.user ?? {}
      const chat = { key: String(data.channel_id ?? data.channel?.id ?? ''), kind: data.guild_id === undefined ? 'direct' : 'group', title: '' }
      await handlers.onAction({
        chat,
        sender: { id: String(from.id ?? ''), name: String(from.username ?? '') },
        data: String(data.data?.custom_id ?? ''),
        messageId: String(data.message?.id ?? ''),
      })
    }

    let gatewayUrl
    const open = (resume) => {
      const gen = generation
      const url = resume && resumeUrl ? resumeUrl : gatewayUrl
      try {
        socket = new env.WebSocket(url)
      } catch (error) {
        handlers.onStatus({ state: 'error', error: `Discord could not open a socket: ${error?.message ?? error}` })
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
            ? { op: 6, d: { token, session_id: sessionId, seq: sequence ?? null } }
            : { op: 2, d: { token, intents: INTENTS, properties: { os: process.platform, browser: 'ds-bot', device: 'ds-bot' } } })
          return
        }
        if (packet.op === 11) { heartbeatAcked = true; return }
        if (packet.op === 1) { heartbeat(); return }
        if (packet.op === 7) { socket.close(4000, 'Reconnect requested'); return }
        if (packet.op === 9) {
          if (packet.d !== true) { sessionId = undefined; resumeUrl = undefined; sequence = undefined }
          socket.close(4000, 'Invalid session')
          return
        }
        if (packet.op !== 0) return
        if (packet.t === 'READY') {
          sessionId = packet.d?.session_id
          resumeUrl = packet.d?.resume_gateway_url
          self.id = String(packet.d?.user?.id ?? '')
          self.name = String(packet.d?.user?.username ?? '')
          handlers.onStatus({ state: 'ready', account: { id: self.id, name: self.name ? `@${self.name}` : self.id } })
        } else if (packet.t === 'RESUMED') {
          handlers.onStatus({ state: 'ready' })
        } else if (packet.t === 'MESSAGE_CREATE') {
          void onMessageEvent(packet.d).catch(error => env.log?.warn?.('ds-bot im: discord message failed: %s', error?.message ?? error))
        } else if (packet.t === 'INTERACTION_CREATE') {
          void onInteraction(packet.d).catch(error => env.log?.warn?.('ds-bot im: discord action failed: %s', error?.message ?? error))
        }
      })
      socket.addEventListener('close', () => {
        clearTimeout(heartbeatTimer)
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'connecting' })
        // Resume keeps session_id when the close code allows it; a 4004 or an
        // invalid session forces a fresh identify.
        reconnectTimer = setTimeout(() => { if (!stopped) open(sessionId !== undefined) }, 2000)
        reconnectTimer.unref?.()
      })
      socket.addEventListener('error', () => {})
    }

    handlers.onStatus({ state: 'connecting' })
    const gatewaySocket = (base) => {
      try {
        const url = new URL(base)
        url.searchParams.set('v', '10')
        url.searchParams.set('encoding', 'json')
        return url.href
      } catch { return undefined }
    }
    void (async () => {
      try {
        const gateway = await rest('/gateway/bot', { method: 'GET' })
        gatewayUrl = gatewaySocket(gateway?.url) ?? gatewaySocket(wsBase(env))
      } catch {
        gatewayUrl = gatewaySocket(wsBase(env))
      }
      if (gatewayUrl === undefined) handlers.onStatus({ state: 'error', error: 'Discord gave no usable gateway URL' })
      else if (!stopped) open(false)
    })()

    return {
      send: async (chat, { text, buttons }) => {
        const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const components = index === chunks.length - 1 && buttons?.length > 0
            ? [{ type: 1, components: buttons.slice(0, 5).map(button => ({ type: 2, style: 1, label: button.label.slice(0, 80), custom_id: button.data })) }]
            : []
          const sent = await rest(`/channels/${chat.key}/messages`, { body: { content: chunk, components } })
          messageId = String(sent?.id ?? messageId ?? '')
        }
        return { messageId }
      },
      edit: async (chat, messageId, { text, buttons }) => {
        const components = buttons?.length > 0
          ? [{ type: 1, components: buttons.slice(0, 5).map(button => ({ type: 2, style: 1, label: button.label.slice(0, 80), custom_id: button.data })) }]
          : []
        await rest(`/channels/${chat.key}/messages/${messageId}`, { method: 'PATCH', body: { content: toPlain(text).slice(0, TEXT_LIMIT), components } })
      },
      typing: async (chat) => rest(`/channels/${chat.key}/typing`).then(() => {}, () => {}),
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(heartbeatTimer)
        clearTimeout(reconnectTimer)
        try { socket?.close(1000, 'stop') } catch { /* socket may not be open */ }
      },
    }
  },
}

async function request(env, fields, path) {
  const response = await env.fetch(`${apiBase(env)}${path}`, { headers: { authorization: `Bot ${String(fields.token ?? '').trim()}` } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw errorOf(body, response.status)
  return body
}
