// Slack: Socket Mode over a WebSocket for inbound (xapp- token opens a
// connection URL with apps.connections.open, every envelope must be ACKed,
// disconnect frames mean reconnect), the Web API (xoxb- token) for sends and
// edits. A message in an `im` channel is direct; `app_mention` is the group
// trigger. Buttons are Block Kit actions; block_actions come back as
// interactive envelopes. Wire details ported from dsh-im (MIT, see NOTICE).
import { chunkMarkdown } from '../format.js'

const API = 'https://slack.com/api/'
const TEXT_LIMIT = 4000

const apiBase = env => `${String(env.config?.api ?? API).replace(/\/+$/, '')}/`

const fail = (reason) => {
  const error = new Error(`Slack answered ${String(reason).replaceAll('_', ' ')}`)
  error.permanent = !['rate_limited', 'fatal_error', 'internal_error'].includes(String(reason))
  return error
}

const toMrkdwn = (markdown) => String(markdown ?? '')
  // fenced code keeps its contents verbatim
  .split(/(```[\s\S]*?```)/g)
  .map((part, index) => index % 2 === 1 ? part : part
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1_$2_'))
  .join('')

export default {
  id: 'slack',

  async check(fields, env) {
    const me = await call(env, fields, 'auth.test', {})
    if (me?.user_id === undefined) throw new Error('These credentials do not belong to a Slack bot')
    return { account: { id: String(me.user_id), name: me.user ? `@${me.user}` : String(me.user_id) } }
  },

  connect(fields, env, handlers) {
    const appToken = String(fields.appToken ?? '').trim()
    const botToken = String(fields.botToken ?? '').trim()
    let stopped = false
    let socket
    let generation = 0
    let reconnectTimer
    let selfId = ''

    const api = (method, params) => call(env, { botToken }, method, params)
    const openUrl = async () => {
      const response = await env.fetch(`${apiBase(env)}apps.connections.open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${appToken}` },
      })
      const body = await response.json().catch(() => ({}))
      if (response.status === 429) throw Object.assign(new Error('Slack rate limited the connection'), { retryAfter: Number(response.headers.get('retry-after')) })
      if (!body.ok) throw fail(body.error ?? `HTTP ${response.status}`)
      return body.url
    }

    const onEvent = async (event) => {
      // Bots and message subtypes (joins, edits) are not user messages.
      if (event.bot_id !== undefined || (event.subtype !== undefined && event.subtype !== 'file_share')) return
      const direct = event.type === 'message' && event.channel_type === 'im'
      const mentioned = event.type === 'app_mention'
      if (!direct && !mentioned) return
      const images = []
      const files = []
      for (const file of event.files ?? []) {
        const mediaType = String(file.mimetype ?? '')
        const bytes = await download(file.url_private, botToken, env).catch(() => undefined)
        if (bytes === undefined) continue
        if (mediaType.startsWith('image/')) images.push({ mediaType, data: Buffer.from(bytes).toString('base64') })
        else files.push({ name: String(file.name ?? 'file'), data: bytes })
      }
      const text = String(event.text ?? '').replaceAll(`<@${selfId}>`, '').trim()
      await handlers.onMessage({
        chat: { key: String(event.channel ?? ''), kind: direct ? 'direct' : 'group', title: '' },
        sender: { id: String(event.user ?? ''), name: String(event.user ?? '') },
        text, images, files, mentioned,
        messageId: String(event.ts ?? ''),
      })
    }

    const onInteractive = async (payload) => {
      if (payload.type !== 'block_actions') return
      const action = payload.actions?.[0]
      if (action === undefined) return
      await handlers.onAction({
        chat: { key: String(payload.channel?.id ?? ''), kind: 'direct', title: '' },
        sender: { id: String(payload.user?.id ?? ''), name: String(payload.user?.name ?? payload.user?.id ?? '') },
        data: String(action.value ?? action.action_id ?? ''),
        messageId: String(payload.message?.ts ?? ''),
      })
    }

    const open = async () => {
      const gen = generation
      let url
      try { url = await openUrl() } catch (error) {
        if (!stopped) {
          handlers.onStatus({ state: 'error', error: error.message })
          if (error.retryAfter === undefined && error.permanent) return
          reconnectTimer = setTimeout(() => { if (!stopped) void open() }, (error.retryAfter ?? 5) * 1000)
          reconnectTimer.unref?.()
        }
        return
      }
      try { socket = new env.WebSocket(url) } catch (error) {
        handlers.onStatus({ state: 'error', error: `Slack could not open a socket: ${error?.message ?? error}` })
        return
      }
      socket.addEventListener('message', (event) => {
        if (stopped || generation !== gen) return
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        if (packet.type === 'hello') {
          handlers.onStatus({ state: 'ready' })
          return
        }
        // Every envelope is ACKed by echoing its id.
        if (packet.envelope_id !== undefined && socket?.readyState === 1) {
          try { socket.send(JSON.stringify({ envelope_id: packet.envelope_id })) } catch { /* closing */ }
        }
        if (packet.type === 'disconnect') { socket.close(4000); return }
        if (packet.type === 'events_api' && packet.payload?.type === 'event_callback') {
          void onEvent(packet.payload.event ?? {}).catch(error => env.log?.warn?.('ds-bot im: slack event failed: %s', error?.message ?? error))
        } else if (packet.type === 'interactive') {
          void onInteractive(packet.payload ?? {}).catch(error => env.log?.warn?.('ds-bot im: slack action failed: %s', error?.message ?? error))
        }
      })
      socket.addEventListener('close', () => {
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'connecting' })
        reconnectTimer = setTimeout(() => { if (!stopped) void open() }, 2000)
        reconnectTimer.unref?.()
      })
      socket.addEventListener('error', () => {})
    }

    handlers.onStatus({ state: 'connecting' })
    void (async () => {
      try {
        const me = await api('auth.test', {})
        selfId = String(me?.user_id ?? '')
      } catch { /* the socket still tells us what it is */ }
      if (!stopped) await open()
    })()

    const blocksFor = (text, buttons) => {
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }]
      if (buttons?.length > 0) {
        blocks.push({
          type: 'actions',
          elements: buttons.slice(0, 5).map((button, index) => ({
            type: 'button',
            action_id: `b${index}`,
            text: { type: 'plain_text', text: button.label.slice(0, 75) },
            value: button.data,
          })),
        })
      }
      return blocks
    }

    return {
      send: async (chat, { text, buttons }) => {
        const chunks = chunkMarkdown(text, TEXT_LIMIT)
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const result = await api('chat.postMessage', {
            channel: chat.key,
            text: chunk,
            blocks: blocksFor(toMrkdwn(chunk), index === chunks.length - 1 ? buttons : undefined),
          })
          messageId = String(result?.ts ?? messageId ?? '')
        }
        return { messageId }
      },
      edit: async (chat, messageId, { text, buttons }) => {
        await api('chat.update', { channel: chat.key, ts: messageId, text: toMrkdwn(text).slice(0, TEXT_LIMIT), blocks: blocksFor(toMrkdwn(text).slice(0, TEXT_LIMIT), buttons) })
      },
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(reconnectTimer)
        try { socket?.close(1000) } catch { /* not open */ }
      },
    }
  },
}

async function call(env, fields, method, params) {
  const response = await env.fetch(`${apiBase(env)}${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(fields.botToken ?? fields.appToken ?? '').trim()}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params),
  })
  const body = await response.json().catch(() => ({}))
  if (response.status === 429) throw Object.assign(new Error('Slack rate limited the send'), { retryAfter: Number(response.headers.get('retry-after')) })
  if (!body.ok) throw fail(body.error ?? `HTTP ${response.status}`)
  return body
}

async function download(url, token, env) {
  const response = await env.fetch(String(url ?? ''), { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) return undefined
  return new Uint8Array(await response.arrayBuffer())
}
