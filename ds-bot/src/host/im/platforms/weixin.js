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
const ILINK_APP_ID = 'bot'
// The iLink client version, packed as 0x00MMNNPP: 2.4.6 is what the reference
// client (dsh-im 5.10.0, the source of this port) identifies itself as.
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
// The server answers this on getupdates when the bot session is not open; the
// account has to scan a new QR code.
const SESSION_EXPIRED = -14
// Waits between attempts to open the session, from the reference client; the
// last one repeats while the network stays down, like the poll's own retry.
const START_RETRY_DELAYS_MS = [250, 1_000, 3_000]

// iLink answers with the bare host (no trailing slash), and the request URL is
// built by appending a path: normalize to exactly one slash either way.
const withSlash = value => `${String(value).replace(/\/+$/, '')}/`
const qrBase = env => withSlash(env.config?.qr ?? env.config?.api ?? QR_BASE)
const base = (env, fields) => withSlash(fields.baseUrl || env.config?.api || QR_BASE)
const baseInfo = () => ({ channel_version: 'ds-bot' })
// iLink identifies the calling client by these two headers on every request.
const clientHeaders = () => ({
  'iLink-App-Id': ILINK_APP_ID,
  'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
})
// X-WECHAT-UIN is base64 of a random uint32. The protocol reference and the
// reference client both mint a new value per request rather than keeping one.
const randomUin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')

// iLink omits ret on a successful getupdates answer, so the answer itself has to
// prove it came from iLink: a bad proxy or a stale endpoint can answer 200 with
// anything, and that must not read as an idle successful poll.
const isUpdatesAnswer = answer => answer !== null && typeof answer === 'object'
  && (Array.isArray(answer.msgs) || typeof answer.get_updates_buf === 'string' || typeof answer.sync_buf === 'string')

const logins = new Map() // loginId → { qrcode, baseUrl, expiresAt, result }

const fail = (reason, opts = {}) => Object.assign(new Error(String(reason)), opts)

export default {
  id: 'weixin',

  // ---- QR login (im-login-start / im-login-wait drive these) --------------
  async loginStart(env) {
    const response = await env.fetch(`${qrBase(env)}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
      method: 'POST',
      headers: { ...clientHeaders(), 'content-type': 'application/json' },
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
      headers: clientHeaders(),
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

  // The token is proven by a short getupdates poll: ret 0 is a valid bot. iLink
  // omits ret altogether on success and sends it only on errors; without one the
  // answer must still look like a getupdates answer.
  async check(fields, env) {
    const answer = await request(env, base(env, fields), fields.token, 'getupdates', { get_updates_buf: '', timeout_ms: 0 }, 8_000, { requireJson: true })
    if (answer.ret !== undefined) {
      if (Number(answer.ret) !== 0) throw fail(`WeChat answered ${answer.ret}`, { permanent: true })
    } else if (!isUpdatesAnswer(answer)) {
      throw fail('WeChat answered an unreadable response')
    }
    return { account: { id: String(fields.ilinkBotId ?? ''), name: 'WeChat' } }
  },

  // -------------------------------------------------------------------------
  connect(fields, env, handlers) {
    let stopped = false
    let running = false
    let generation = 0
    // Every request this connection makes ends with the connection: a stop must not
    // leave the getupdates long poll (up to 50 s) holding the host process open.
    const stopping = new AbortController()
    const call = (endpoint, body, timeoutMs, options) =>
      request(env, base(env, fields), fields.token, endpoint, body, timeoutMs, { ...options, signal: stopping.signal })

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
          const bytes = await image(item.image_item.media, env, stopping.signal).catch(() => undefined)
          if (stopping.signal.aborted) return
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
            answer = await call('getupdates', { get_updates_buf: runtime().cursor ?? '' }, POLL_TIMEOUT_MS + 15_000, { requireJson: true })
          } catch (error) {
            if (stopped || generation !== gen) return
            if (error?.timeout) { continue }
            env.log?.warn?.('ds-bot im: weixin poll failed: %s', error?.message ?? error)
            handlers.onStatus({ state: error.permanent ? 'error' : 'connecting', ...(error.permanent ? { error: error.message } : {}) })
            if (error.permanent) return
            await sleep(3000)
            continue
          }
          const code = answer.ret ?? answer.errcode
          if (Number(code) === SESSION_EXPIRED) {
            const reason = 'WeChat session expired; scan the QR code again'
            env.log?.warn?.('ds-bot im: %s', reason)
            handlers.onStatus({ state: 'error', error: reason })
            return
          }
          if (answer.ret !== undefined) {
            if (Number(answer.ret) !== 0) {
              env.log?.warn?.('ds-bot im: weixin getupdates answered %s', answer.ret)
              if (Number(answer.ret) === 401 || Number(answer.ret) === 403) {
                handlers.onStatus({ state: 'error', error: `WeChat answered ${answer.ret}` })
                return
              }
              await sleep(3000)
              continue
            }
          } else if (!isUpdatesAnswer(answer)) {
            env.log?.warn?.('ds-bot im: weixin getupdates answered an unreadable response')
            handlers.onStatus({ state: 'connecting' })
            await sleep(3000)
            continue
          }
          handlers.onStatus({ state: 'ready' })
          for (const msg of answer.msgs ?? []) {
            if (stopped || generation !== gen) return
            await deliver(msg).catch(error => env.log?.warn?.('ds-bot im: weixin message failed: %s', error?.message ?? error))
          }
          if (stopped || generation !== gen) return
          if (answer.get_updates_buf !== undefined && answer.get_updates_buf !== runtime().cursor) {
            setRuntime({ cursor: String(answer.get_updates_buf) })
          }
        }
      } finally {
        running = false
      }
    }

    // The session has to be opened before getupdates carries anything. A
    // refused or expired session is shown once and polling never starts. A
    // network failure keeps retrying, as the poll does: an app started before
    // the network is up must still connect once it is. After the quick retries
    // the failure is on screen until a start succeeds.
    const startSession = async () => {
      let shown = false
      for (let attempt = 0; ; attempt += 1) {
        if (stopped) return
        try {
          await notifyStart(env, base(env, fields), fields.token, stopping.signal)
          break
        } catch (error) {
          if (stopped) return
          const reason = String(error?.message ?? error)
          if (error?.permanent === true) {
            env.log?.warn?.('ds-bot im: weixin could not start the session: %s', reason)
            handlers.onStatus({ state: 'error', error: reason })
            return
          }
          const wait = START_RETRY_DELAYS_MS[attempt]
          if (wait === undefined && !shown) {
            shown = true
            env.log?.warn?.('ds-bot im: weixin could not start the session, still retrying: %s', reason)
            handlers.onStatus({ state: 'error', error: reason })
          } else if (wait !== undefined) {
            env.log?.warn?.('ds-bot im: weixin session start failed, retrying: %s', reason)
          }
          await sleep(wait ?? START_RETRY_DELAYS_MS.at(-1))
        }
      }
      if (!stopped) void poll()
    }

    handlers.onStatus({ state: 'connecting' })
    void startSession()

    return {
      send: async (chat, { text }) => {
        const chunks = chunk(String(text ?? ''), TEXT_LIMIT)
        const contextToken = contextTokens()[chat.key]
        let messageId
        for (const chunkText of chunks) {
          const clientId = `ds-bot-${randomBytes(8).toString('hex')}`
          const answer = await call('sendmessage', {
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
        const answer = await call('getconfig', { ilink_user_id: chat.key }, 8_000).catch(() => undefined)
        const ticket = String(answer?.typing_ticket ?? '')
        if (ticket === '') return
        await call('sendtyping', { ilink_user_id: chat.key, typing_ticket: ticket, status: 1 }, 8_000).catch(() => {})
      },
      stop: () => {
        stopped = true
        generation += 1
        stopping.abort(new Error('stopped'))
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

// iLink only carries getupdates for an opened session: before msg/notifystart
// the server keeps answering {"errcode":-14,"errmsg":"session timeout"}.
async function notifyStart(env, baseUrl, token, signal) {
  const answer = await request(env, baseUrl, token, 'msg/notifystart', {}, 10_000, { signal })
  const code = answer?.errcode ?? answer?.ret
  if (code === undefined || Number(code) === 0) return
  const reason = Number(code) === SESSION_EXPIRED
    ? 'WeChat session expired; scan the QR code again'
    : `WeChat did not start the session (${code})`
  throw fail(reason, { permanent: true })
}

async function request(env, baseUrl, token, endpoint, body, timeoutMs = POLL_TIMEOUT_MS, { requireJson = false, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  // A connection that stops aborts every request it still has in flight: the
  // getupdates long poll otherwise outlives it by up to 50 s and keeps the host
  // process alive after a quit.
  const aborted = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
  let response
  try {
    response = await env.fetch(`${baseUrl}ilink/bot/${endpoint}`, {
      method: 'POST',
      headers: {
        ...clientHeaders(),
        'content-type': 'application/json',
        'X-WECHAT-UIN': randomUin(),
        ...(token ? { authorization: `Bearer ${token}`, AuthorizationType: 'ilink_bot_token' } : {}),
      },
      body: JSON.stringify({ ...body, base_info: baseInfo() }),
      signal: aborted,
    })
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout|aborted/i.test(String(error?.message))
    // fetch reports "fetch failed" and hides ENOTFOUND, ECONNRESET and the like in
    // cause; surface it in the message and keep the chain for diagnosis.
    const cause = error?.cause?.code ?? error?.cause?.message
    throw Object.assign(new Error(timedOut ? 'timeout' : String(cause ?? error?.message ?? error), { cause: error }), { timeout: timedOut })
  } finally {
    clearTimeout(timer)
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    if (aborted.aborted) throw Object.assign(new Error('timeout', { cause: error }), { timeout: true })
    text = ''
  }
  let parsed
  try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = undefined }
  const json = parsed !== null && typeof parsed === 'object' ? parsed : undefined
  if (response.status === 429 || json?.ret === 429) throw fail('WeChat rate limited the request', { retryAfter: Number(response.headers.get('retry-after')) })
  if (response.status === 401 || response.status === 403) throw fail('WeChat refused the token', { permanent: true })
  if (!response.ok) throw fail(`WeChat answered ${response.status}`)
  // A caller that reads fields from the answer (getupdates) needs a real JSON
  // object; anyone else keeps the old empty answer on a malformed body.
  if (json === undefined) {
    if (requireJson) throw fail('WeChat answered an unreadable response', { status: response.status })
    return {}
  }
  return json
}

// Inbound images: the CDN URL plus a base64 AES-128 key (ECB, PKCS7).
async function image(media, env, signal) {
  const url = String(media.full_url ?? media.url ?? '')
  if (url === '') return undefined
  const response = await env.fetch(url, { signal })
  if (!response.ok) return undefined
  const encrypted = Buffer.from(await response.arrayBuffer())
  const hex = Buffer.from(String(media.aes_key ?? ''), 'base64').toString('utf8')
  const key = /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined
  if (key === undefined) return encrypted
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
