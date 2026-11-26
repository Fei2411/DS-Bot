// Slack: Socket Mode over a WebSocket for inbound (xapp- token opens a
// connection URL with apps.connections.open, every envelope must be ACKed,
// disconnect frames mean reconnect), the Web API (xoxb- token) for sends and
// edits. A message in an `im` channel is direct; `app_mention` is the group
// trigger. Buttons are Block Kit actions; block_actions come back as
// interactive envelopes. Wire details ported from dsh-im (MIT, see NOTICE).
import { chunkMarkdown } from '../format.js'
import { discardBody, FILE_LIMIT, IMAGE_LIMIT, mediaSignal, readCappedBytes } from './media.js'
import { retryDelay } from './retry.js'

const API = 'https://slack.com/api/'
const TEXT_LIMIT = 4000

const apiBase = env => `${String(env.config?.api ?? API).replace(/\/+$/, '')}/`

const parseRetryAfter = (headers) => {
  const raw = headers?.get?.('retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

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
    // Italic first: Slack spells bold *text* and italic _text_, so converting bold
    // first would hand the italic rule a "*bold*" that it then rewrites to _bold_.
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1_$2_')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*'))
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
    const stopping = new AbortController()
    let socket
    let generation = 0
    let reconnectTimer
    let reconnectAttempt = 0
    let selfId = ''

    const api = (method, params) => call(env, { botToken }, method, params)
    const openUrl = async () => {
      const response = await env.fetch(`${apiBase(env)}apps.connections.open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${appToken}` },
        signal: stopping.signal,
      })
      const body = await response.json().catch(() => ({}))
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers)
        throw Object.assign(new Error('Slack rate limited the connection'), retryAfter !== undefined ? { retryAfter } : {})
      }
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
        if (stopped) return
        const mediaType = String(file.mimetype ?? '')
        const asImage = mediaType.startsWith('image/')
        const bytes = await download(file.url_private, botToken, env, asImage ? IMAGE_LIMIT : FILE_LIMIT, stopping.signal).catch(() => undefined)
        if (bytes === undefined || bytes.length === 0) continue
        if (asImage) images.push({ mediaType, data: Buffer.from(bytes).toString('base64') })
        else files.push({ name: String(file.name ?? 'file'), data: bytes })
      }
      if (stopped) return
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
      if (stopped) return
      const gen = ++generation
      const previous = socket
      socket = undefined
      try { previous?.close(1000, 'replaced') } catch { /* not open */ }
      let url
      try { url = await openUrl() } catch (error) {
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'error', error: error.message })
        if (error.retryAfter === undefined && error.permanent) return
        clearTimeout(reconnectTimer)
        const wait = Number.isFinite(error.retryAfter) && error.retryAfter > 0
          ? error.retryAfter * 1000
          : retryDelay(reconnectAttempt++)
        reconnectTimer = setTimeout(() => { if (!stopped && generation === gen) void open() }, wait)
        reconnectTimer.unref?.()
        return
      }
      if (stopped || generation !== gen) return
      let next
      try {
        next = new env.WebSocket(url)
        socket = next
      } catch (error) {
        handlers.onStatus({ state: 'error', error: `Slack could not open a socket: ${error?.message ?? error}` })
        return
      }
      next.addEventListener('message', (event) => {
        if (stopped || generation !== gen) return
        let packet
        try { packet = JSON.parse(String(event.data)) } catch { return }
        if (packet.type === 'hello') {
          reconnectAttempt = 0
          handlers.onStatus({ state: 'ready' })
          return
        }
        // Every envelope is ACKed by echoing its id.
        if (packet.envelope_id !== undefined && next.readyState === 1) {
          try { next.send(JSON.stringify({ envelope_id: packet.envelope_id })) } catch { /* closing */ }
        }
        if (packet.type === 'disconnect') { next.close(4000); return }
        if (packet.type === 'events_api' && packet.payload?.type === 'event_callback') {
          void onEvent(packet.payload.event ?? {}).catch(error => env.log?.warn?.('ds-bot im: slack event failed: %s', error?.message ?? error))
        } else if (packet.type === 'interactive') {
          void onInteractive(packet.payload ?? {}).catch(error => env.log?.warn?.('ds-bot im: slack action failed: %s', error?.message ?? error))
        }
      })
      next.addEventListener('close', () => {
        if (stopped || generation !== gen) return
        handlers.onStatus({ state: 'connecting' })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!stopped && generation === gen) void open() }, retryDelay(reconnectAttempt++))
        reconnectTimer.unref?.()
      })
      next.addEventListener('error', () => {})
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
      sendImage: async (chat, image) => {
        const bytes = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data ?? [])
        if (bytes.byteLength === 0) throw Object.assign(new Error('Empty image'), { permanent: true })
        const name = image.name || 'image.png'
        const metaResp = await env.fetch(`${apiBase(env)}files.getUploadURLExternal`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${botToken}`,
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body: new URLSearchParams({ filename: name, length: String(bytes.byteLength) }),
          signal: AbortSignal.timeout(30_000),
        })
        const meta = await metaResp.json().catch(() => ({}))
        if (metaResp.status === 429) {
          const retryAfter = parseRetryAfter(metaResp.headers)
          throw Object.assign(new Error('Slack rate limited the send'), retryAfter !== undefined ? { retryAfter } : {})
        }
        let uploadUrl
        try { uploadUrl = meta?.upload_url ? new URL(String(meta.upload_url)) : undefined } catch { uploadUrl = undefined }
        const customApiHost = (() => { try { return env.config?.api ? new URL(String(env.config.api)).host : '' } catch { return '' } })()
        const trustedSlackHost = uploadUrl !== undefined && uploadUrl.username === '' && uploadUrl.password === ''
          && ((customApiHost !== '' && uploadUrl.host === customApiHost && (uploadUrl.protocol === 'http:' || uploadUrl.protocol === 'https:'))
            || (uploadUrl.protocol === 'https:' && (uploadUrl.port === '' || uploadUrl.port === '443')
              && /(^|\.)(slack\.com|slack-edge\.com|slack-files\.com)$/i.test(uploadUrl.hostname)))
        if (!meta?.ok || !meta.file_id || !trustedSlackHost) {
          const error = fail(meta?.error ?? (!trustedSlackHost && meta?.ok ? 'untrusted_upload_url' : `HTTP ${metaResp.status}`))
          error.status = metaResp.status
          if (meta?.error === undefined && !(!trustedSlackHost && meta?.ok)) {
            error.permanent = metaResp.status >= 400 && metaResp.status < 500 && metaResp.status !== 429
          }
          throw error
        }
        const upResp = await env.fetch(uploadUrl, {
          method: 'POST',
          headers: { 'content-type': image.mediaType || 'application/octet-stream' },
          body: bytes,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
        try {
          if (!upResp.ok) {
            const error = new Error(`Slack image upload answered ${upResp.status}`)
            error.status = upResp.status
            if (upResp.status === 429) {
              const retryAfter = parseRetryAfter(upResp.headers)
              if (retryAfter !== undefined) error.retryAfter = retryAfter
            }
            error.permanent = upResp.status >= 400 && upResp.status < 500 && upResp.status !== 429
            throw error
          }
        } finally {
          await discardBody(upResp)
        }
        let doneResp
        try {
          doneResp = await env.fetch(`${apiBase(env)}files.completeUploadExternal`, {
            method: 'POST',
            headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ files: [{ id: meta.file_id, title: image.alt || name }], channel_id: chat.key }),
            signal: AbortSignal.timeout(30_000),
          })
        } catch (error) {
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw Object.assign(new Error('Slack did not answer the image send in time'), { unknown: true })
          }
          throw error
        }
        const done = await doneResp.json().catch(() => ({}))
        if (doneResp.status === 429) {
          const retryAfter = parseRetryAfter(doneResp.headers)
          throw Object.assign(new Error('Slack rate limited the send'), retryAfter !== undefined ? { retryAfter } : {})
        }
        if (!doneResp.ok || !done?.ok) {
          const error = fail(done?.error ?? `HTTP ${doneResp.status}`)
          error.status = doneResp.status
          if (done?.error === undefined) error.permanent = doneResp.status >= 400 && doneResp.status < 500 && doneResp.status !== 429
          throw error
        }
        return { messageId: String(meta.file_id) }
      },
      edit: async (chat, messageId, { text, buttons }) => {
        await api('chat.update', { channel: chat.key, ts: messageId, text: toMrkdwn(text).slice(0, TEXT_LIMIT), blocks: blocksFor(toMrkdwn(text).slice(0, TEXT_LIMIT), buttons) })
      },
      stop: () => {
        stopped = true
        stopping.abort()
        generation += 1
        clearTimeout(reconnectTimer)
        const previous = socket
        socket = undefined
        try { previous?.close(1000) } catch { /* not open */ }
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
  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers)
    throw Object.assign(new Error('Slack rate limited the send'), retryAfter !== undefined ? { retryAfter } : {})
  }
  if (!body.ok) throw fail(body.error ?? `HTTP ${response.status}`)
  return body
}

async function download(url, token, env, limit, signal) {
  const response = await env.fetch(String(url ?? ''), {
    headers: { authorization: `Bearer ${token}` },
    signal: mediaSignal(signal),
  })
  if (!response.ok) {
    await discardBody(response)
    return undefined
  }
  const got = await readCappedBytes(response, limit)
  if (got.overLimit || got.bytes === undefined) return undefined
  return got.bytes
}
