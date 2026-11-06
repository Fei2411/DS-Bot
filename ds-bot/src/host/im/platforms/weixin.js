// WeChat iLink: a QR login creates the connection — get_bot_qrcode, then a
// get_qrcode_status long poll until the owner confirms on their phone; the
// reply carries bot_token, ilink_bot_id, ilink_user_id and the base URL.
// From then a getupdates long poll delivers messages (the get_updates_buf
// cursor and the latest context_token per user live in the connection
// runtime so they survive restarts); sends go out through sendmessage with
// that user's context_token, ~1800-char text chunks. Typing uses the
// getconfig ticket. Voice items arrive with a transcript; images download
// from the CDN and decrypt with their AES key. A refused send is permanent
// with the platform's reason. Protocol ported from dsh-im (MIT, see NOTICE).
import { createDecipheriv, randomBytes } from 'node:crypto'

const QR_BASE = 'https://ilinkai.weixin.qq.com/'
const BOT_TYPE = '3'
const TEXT_LIMIT = 1800
const POLL_TIMEOUT_MS = 35_000

const qrBase = env => String(env.config?.qr ?? env.config?.api ?? QR_BASE).replace(/\/+$/, '/')
const base = (env, fields) => String(fields.baseUrl || env.config?.api || QR_BASE).replace(/\/+$/, '/')
const baseInfo = () => ({ channel_version: 'ds-bot' })

const logins = new Map() // loginId → { qrcode, baseUrl, expiresAt, result }

const fail = (reason, opts = {}) => Object.assign(new Error(String(reason)), opts)

export default {
  id: 'weixin',

  // ---- QR login (im-login-start / im-login-wait drive these) --------------
  async loginStart(env) {
    const response = await env.fetch(`${qrBase(env)}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_token_list: [] }),
    })
    const body = await response.json().catch(() => ({}))
    if (body.qrcode === undefined) throw fail(body.errmsg ?? 'WeChat did not return a code', { permanent: false })
    const loginId = `wx_${randomBytes(8).toString('hex')}`
    const expiresAt = Date.now() + 5 * 60_000
    logins.set(loginId, { qrcode: String(body.qrcode), expiresAt })
    for (const [id, held] of logins) if (held.expiresAt < Date.now()) logins.delete(id)
    return { loginId, qr: String(body.qrcode_img_content ?? body.qrcode), expiresAt }
  },

  async loginWait(loginId, env) {
    const held = logins.get(String(loginId))
    if (held === undefined) return { status: 'expired' }
    if (held.expiresAt < Date.now()) { logins.delete(String(loginId)); return { status: 'expired' } }
    const response = await env.fetch(`${qrBase(env)}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(held.qrcode)}`, {
      signal: AbortSignal.timeout?.(POLL_TIMEOUT_MS) ?? undefined,
    }).catch(() => undefined)
    const body = await response?.json().catch(() => ({})) ?? {}
    const status = String(body.status ?? 'wait')
    if (status === 'expired' || status === 'invalid') { logins.delete(String(loginId)); return { status: 'expired' } }
    if (status === 'scaned' || status === 'scaned_but_redirect' || status === 'binded_redirect') return { status: 'scanned' }
    if (status !== 'confirmed') return { status: 'waiting' }
    logins.delete(String(loginId))
    return {
      status: 'done',
      connection: {
        settings: { baseUrl: String(body.baseurl ?? QR_BASE) },
        secrets: { token: String(body.bot_token ?? '') },
        account: { id: String(body.ilink_bot_id ?? ''), name: 'WeChat' },
      },
      owner: { id: String(body.ilink_user_id ?? ''), name: String(body.ilink_user_id ?? '') },
    }
  },

  // The token is proven by a short getupdates poll: ret 0 is a valid bot.
  async check(fields, env) {
    const answer = await request(env, base(env, fields), fields.token, 'getupdates', { get_updates_buf: '', timeout_ms: 0 }, 8_000)
    if (Number(answer.ret) !== 0) throw fail(`WeChat answered ${answer.ret}`, { permanent: true })
    return { account: { id: String(fields.ilinkBotId ?? ''), name: 'WeChat' } }
  },

  // -------------------------------------------------------------------------
  connect(fields, env, handlers) {
    let stopped = false
    let running = false
    let generation = 0

    const runtime = () => env.runtime.get()
    const setRuntime = patch => env.runtime.set(patch)
    const contextTokens = () => runtime().contextTokens ?? {}
    const remember = (userId, token) => {
      if (token === undefined || token === '') return
      const next = { ...contextTokens(), [userId]: token }
      setRuntime({ contextTokens: next })
    }

    const deliver = async (msg) => {
      const userId = String(msg.from_user_id ?? '')
      if (userId === '') return
      remember(userId, msg.context_token)
      const images = []
      const files = []
      const texts = []
      for (const item of msg.item_list ?? []) {
        if (item.type === 1 && item.text_item?.text !== undefined) texts.push(String(item.text_item.text))
        // Voice items carry their transcript in voice_item.text.
        else if (item.type === 3 && item.voice_item?.text !== undefined) texts.push(String(item.voice_item.text))
        else if (item.type === 2 && item.image_item?.media !== undefined) {
          const bytes = await image(item.image_item.media, env).catch(() => undefined)
          if (bytes !== undefined) images.push({ mediaType: 'image/jpeg', data: bytes.toString('base64') })
        }
        else if (item.type === 4 && item.file_item !== undefined) files.push({ name: String(item.file_item.file_name ?? 'file'), data: undefined })
      }
      await handlers.onMessage({
        chat: { key: userId, kind: 'direct', title: '' },
        sender: { id: userId, name: userId },
        text: texts.join('\n').trim(), images, files,
        mentioned: false, messageId: String(msg.client_id ?? msg.message_id ?? ''),
      })
    }

    const poll = async () => {
      if (running || stopped) return
      running = true
      const gen = generation
      try {
        while (!stopped && generation === gen) {
          let answer
          try {
            answer = await request(env, base(env, fields), fields.token, 'getupdates', { get_updates_buf: runtime().cursor ?? '' }, POLL_TIMEOUT_MS + 15_000)
          } catch (error) {
            if (stopped || generation !== gen) return
            if (error?.timeout) { continue }
            env.log?.warn?.('ds-bot im: weixin poll failed: %s', error?.message ?? error)
            handlers.onStatus({ state: error.permanent ? 'error' : 'connecting', ...(error.permanent ? { error: error.message } : {}) })
            if (error.permanent) return
            await sleep(3000)
            continue
          }
          if (Number(answer.ret) !== 0) {
            env.log?.warn?.('ds-bot im: weixin getupdates answered %s', answer.ret)
            if (Number(answer.ret) === 401 || Number(answer.ret) === 403) {
              handlers.onStatus({ state: 'error', error: `WeChat answered ${answer.ret}` })
              return
            }
            await sleep(3000)
            continue
          }
          handlers.onStatus({ state: 'ready' })
          if (answer.get_updates_buf !== undefined && answer.get_updates_buf !== runtime().cursor) {
            setRuntime({ cursor: String(answer.get_updates_buf) })
          }
          for (const msg of answer.msgs ?? []) {
            await deliver(msg).catch(error => env.log?.warn?.('ds-bot im: weixin message failed: %s', error?.message ?? error))
          }
        }
      } finally {
        running = false
      }
    }

    handlers.onStatus({ state: 'connecting' })
    void poll()

    return {
      send: async (chat, { text }) => {
        const chunks = chunk(String(text ?? ''), TEXT_LIMIT)
        const contextToken = contextTokens()[chat.key]
        let messageId
        for (const chunkText of chunks) {
          const clientId = `ds-bot-${randomBytes(8).toString('hex')}`
          const answer = await request(env, base(env, fields), fields.token, 'sendmessage', {
            msg: {
              from_user_id: '', to_user_id: chat.key, client_id: clientId,
              message_type: 2, message_state: 2,
              item_list: [{ type: 1, text_item: { text: chunkText } }],
              ...(contextToken ? { context_token: contextToken } : {}),
            },
          })
          if (Number(answer.ret) !== 0 && answer.ret !== undefined) {
            throw fail(`WeChat refused the reply (${answer.errmsg ?? answer.ret})`, { permanent: true })
          }
          messageId = clientId
        }
        return { messageId }
      },
      typing: async (chat) => {
        const answer = await request(env, base(env, fields), fields.token, 'getconfig', { ilink_user_id: chat.key }, 8_000).catch(() => undefined)
        const ticket = String(answer?.typing_ticket ?? '')
        if (ticket === '') return
        await request(env, base(env, fields), fields.token, 'sendtyping', { ilink_user_id: chat.key, typing_ticket: ticket, status: 1 }, 8_000).catch(() => {})
      },
      stop: () => {
        stopped = true
        generation += 1
      },
    }
  },
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Text chunks: paragraphs/lines first, a hard cut at the limit otherwise.
const chunk = (text, limit) => {
  const chunks = []
  let rest = String(text)
  while (rest !== '') {
    if (rest.length <= limit) { chunks.push(rest); break }
    let at = limit
    const newline = rest.lastIndexOf('\n', at)
    if (newline > limit / 2) at = newline
    else {
      const space = rest.lastIndexOf(' ', at)
      if (space > limit / 2) at = space
    }
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  return chunks
}

async function request(env, baseUrl, token, endpoint, body, timeoutMs = POLL_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await env.fetch(`${baseUrl}ilink/bot/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}`, AuthorizationType: 'ilink_bot_token' } : {}),
      },
      body: JSON.stringify({ ...body, base_info: baseInfo() }),
      signal: controller.signal,
    })
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout|aborted/i.test(String(error?.message))
    throw Object.assign(new Error(timedOut ? 'timeout' : String(error?.message ?? error)), { timeout: timedOut })
  } finally {
    clearTimeout(timer)
  }
  const json = await response.json().catch(() => ({}))
  if (response.status === 429 || json.ret === 429) throw fail('WeChat rate limited the request', { retryAfter: Number(response.headers.get('retry-after')) })
  if (response.status === 401 || response.status === 403) throw fail('WeChat refused the token', { permanent: true })
  if (!response.ok) throw fail(`WeChat answered ${response.status}`)
  return json
}

// Inbound images: the CDN URL plus a base64 AES-128 key (ECB, PKCS7).
async function image(media, env) {
  const url = String(media.full_url ?? media.url ?? '')
  if (url === '') return undefined
  const response = await env.fetch(url)
  if (!response.ok) return undefined
  const encrypted = Buffer.from(await response.arrayBuffer())
  const hex = Buffer.from(String(media.aes_key ?? ''), 'base64').toString('utf8')
  const key = /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined
  if (key === undefined) return encrypted
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
