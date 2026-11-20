// WeChat iLink: a QR login creates the connection — get_bot_qrcode, then a
// get_qrcode_status long poll until the owner confirms on their phone; the
// reply carries bot_token, ilink_bot_id, ilink_user_id and the base URL.
// From then a getupdates long poll delivers messages (the get_updates_buf
// cursor and the latest context_token per user live in the connection
// runtime so they survive restarts); sends go out through sendmessage with
// that user's context_token, ~1800-char text chunks. Typing uses the
// getconfig ticket. Voice items arrive with a transcript; images download
// from the CDN and decrypt with their AES key. A refused send is permanent
// with the platform's reason. A quoted reply names the message it answers and
// usually repeats its text; both are passed on as `quote`, and the ids a send
// comes back with are kept so a later quote can name that message.
// Protocol ported from dsh-im (MIT, see NOTICE).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  detectImageMediaType, discardBody, FILE_LIMIT, IMAGE_LIMIT,
  isHttpUrl, mediaSignal, readCappedBytes,
} from './media.js'

const QR_BASE = 'https://ilinkai.weixin.qq.com/'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CDN_HOSTS = new Set([
  'novac2c.cdn.weixin.qq.com', 'ilinkai.weixin.qq.com', 'wx.qlogo.cn',
  'thirdwx.qlogo.cn', 'res.wx.qq.com', 'mmbiz.qpic.cn', 'mmbiz.qlogo.cn',
])
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

  // This platform hands back a quoted reply's message, so the host keeps what
  // it sent here (by platform id) for a quote to name. Platforms without it do
  // not need their replies written to the runtime file — they would never be
  // read back.
  quote: true,

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
          const bytes = await downloadMedia(item.image_item.media, item.image_item.aeskey, IMAGE_LIMIT, env, stopping.signal).catch((error) => {
            if (!stopping.signal.aborted) env.log?.warn?.('ds-bot im: weixin image download failed: %s', error?.message ?? error)
            return undefined
          })
          if (stopping.signal.aborted) return
          if (bytes !== undefined && bytes.length > 0) {
            const mediaType = detectImageMediaType(bytes)
            if (mediaType !== undefined) images.push({ mediaType, data: bytes.toString('base64') })
            else files.push({ name: 'image', data: bytes })
          }
        }
        else if (item.type === 4 && item.file_item !== undefined) {
          const name = String(item.file_item.file_name ?? 'file')
          const bytes = item.file_item.media === undefined
            ? undefined
            : await downloadMedia(item.file_item.media, item.file_item.aeskey, FILE_LIMIT, env, stopping.signal).catch((error) => {
              if (!stopping.signal.aborted) env.log?.warn?.('ds-bot im: weixin file download failed: %s', error?.message ?? error)
              return undefined
            })
          if (stopping.signal.aborted) return
          if (bytes !== undefined && bytes.length > 0) files.push({ name, data: bytes })
        }
      }
      await handlers.onMessage({
        chat: { key: userId, kind: 'direct', title: '' },
        sender: { id: userId, name: userId },
        text: texts.join('\n').trim(), images, files,
        mentioned: false, messageId: String(msg.client_id ?? msg.message_id ?? ''),
        quote: quotedOf(msg),
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
      const configuredDelays = env.config?.startRetryDelaysMs
      const delays = Array.isArray(configuredDelays) && configuredDelays.length > 0
        && configuredDelays.every(ms => Number.isFinite(ms) && ms >= 0)
        ? configuredDelays
        : START_RETRY_DELAYS_MS
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
          const wait = delays[attempt]
          if (wait === undefined && !shown) {
            shown = true
            env.log?.warn?.('ds-bot im: weixin could not start the session, still retrying: %s', reason)
            handlers.onStatus({ state: 'error', error: reason })
          } else if (wait !== undefined) {
            env.log?.warn?.('ds-bot im: weixin session start failed, retrying: %s', reason)
          }
          await sleep(wait ?? delays.at(-1))
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
        const ids = []
        // A long reply goes out as several WeChat messages with an id each, so a
        // quote names one chunk: keep every chunk's ids next to its own text.
        const parts = []
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
            // WeChat may already have accepted earlier chunks. Hand them back on
            // the error so the host can still remember them for quoted replies:
            // a later failure must not lose the ids of delivered messages.
            throw fail(`WeChat refused the reply (${answer.errmsg ?? answer.ret})`, { permanent: true, parts })
          }
          messageId = clientId
          addId(ids, clientId)
          const partIds = [clientId]
          for (const id of answerIds(answer)) {
            addId(ids, id)
            addId(partIds, id)
          }
          parts.push({ ids: partIds, text: chunkText })
        }
        return { messageId, ids, parts }
      },
      sendImage: async (chat, image) => {
        const bytes = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data ?? [])
        if (bytes.byteLength === 0) throw fail('Empty image', { permanent: true })
        if (bytes.byteLength > IMAGE_LIMIT) throw fail('Image too large for WeChat', { permanent: true })
        const fileKey = randomBytes(16).toString('hex')
        const aesKey = randomBytes(16)
        const padded = Math.ceil((bytes.byteLength + 1) / 16) * 16
        const upload = await call('getuploadurl', {
          filekey: fileKey,
          media_type: 1,
          to_user_id: chat.key,
          rawsize: bytes.byteLength,
          rawfilemd5: createHash('md5').update(bytes).digest('hex'),
          filesize: padded,
          no_need_thumb: true,
          aeskey: aesKey.toString('hex'),
        })
        const upCode = upload?.ret ?? upload?.errcode
        if (upCode !== undefined && Number(upCode) !== 0) {
          throw fail(`WeChat refused the image upload (${upload.errmsg ?? upCode})`, { permanent: true })
        }
        const full = String(upload?.upload_full_url ?? '').trim()
        const param = String(upload?.upload_param ?? '').trim()
        const configuredCdn = String(env.config?.cdn ?? CDN_BASE).replace(/\/+$/, '')
        let url
        try {
          if (full !== '') url = new URL(full)
          else if (param !== '') {
            url = new URL(`${configuredCdn}/upload`)
            url.searchParams.set('encrypted_query_param', param)
            url.searchParams.set('filekey', fileKey)
          } else {
            throw fail('WeChat returned no upload address', { permanent: true })
          }
        } catch (error) {
          if (error?.permanent === true) throw error
          throw fail('WeChat returned an invalid upload address', { permanent: true })
        }
        const allowedCustomHost = (() => {
          for (const raw of [env.config?.cdn, env.config?.api]) {
            try { if (raw && new URL(String(raw)).host === url.host) return true } catch {}
          }
          return false
        })()
        const trustedProdHost = (CDN_HOSTS.has(url.hostname)
          || /(^|\.)(wechat|weixin)\.qq\.com$/i.test(url.hostname)
          || /(^|\.)wechat\.com$/i.test(url.hostname))
          && url.protocol === 'https:'
          && (url.port === '' || url.port === '443')
        const allowed = url.username === '' && url.password === ''
          && ((allowedCustomHost && (url.protocol === 'http:' || url.protocol === 'https:')) || trustedProdHost)
        if (!allowed) {
          throw fail(`Untrusted upload address (${url.hostname})`, { permanent: true })
        }
        const cipher = createCipheriv('aes-128-ecb', aesKey, null)
        const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
        const response = await env.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(encrypted.byteLength) },
          body: encrypted,
          redirect: 'error',
          signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(30_000)]),
        })
        if (!response.ok) {
          const error = fail(`WeChat image upload failed (HTTP ${response.status})`)
          error.status = response.status
          if (response.status === 429) error.retryAfter = Number(response.headers.get('retry-after'))
          error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
          throw error
        }
        const downloadParam = response.headers.get('x-encrypted-param')
        if (!downloadParam) throw fail('WeChat upload returned no download parameter', { permanent: true })
        const clientId = `ds-bot-${randomBytes(8).toString('hex')}`
        const contextToken = contextTokens()[chat.key]
        let answer
        try {
          answer = await call('sendmessage', {
            msg: {
              from_user_id: '', to_user_id: chat.key, client_id: clientId,
              message_type: 2, message_state: 2,
              item_list: [{
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: downloadParam,
                    aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
                    encrypt_type: 1,
                  },
                  mid_size: encrypted.byteLength,
                },
              }],
              ...(contextToken ? { context_token: contextToken } : {}),
            },
          })
        } catch (error) {
          if (error?.timeout === true) error.unknown = true
          throw error
        }
        const sendCode = answer?.ret ?? answer?.errcode
        if (sendCode !== undefined && Number(sendCode) !== 0) {
          throw fail(`WeChat refused the image (${answer.errmsg ?? sendCode})`, { permanent: true })
        }
        return { messageId: clientId }
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

// iLink has sent the same id as a string and as a number, and fills the field
// with 0 when a message quotes nothing: every form has to end up comparable.
const addId = (ids, value) => {
  if (value === undefined || value === null) return
  const id = String(value).trim()
  if (id === '' || id === '0') return
  if (!ids.includes(id)) ids.push(id)
}

// A reply quotes one earlier message. iLink names it at the top level and again
// inside a ref_msg item, under several fields, and repeats its text when it has
// it. The ids go in the protocol's order: the first one is the message itself,
// the rest only ever name the same message, and a caller matches them in turn.
const quotedOf = (msg) => {
  const ids = []
  let text = ''
  addId(ids, msg.referenced_msg_id)
  for (const item of msg.item_list ?? []) {
    const ref = item?.ref_msg
    if (ref === undefined || ref === null) continue
    addId(ids, ref.message_item?.msg_id)
    addId(ids, ref.msg_id)
    addId(ids, ref.referenced_msg_id)
    if (text === '') text = String(ref.message_item?.text_item?.text ?? '').trim()
  }
  if (ids.length === 0 && text === '') return undefined
  return { ids, text }
}

// The platform names the message it accepted in one of several places, and a
// quoted reply can use any of them: keep every name it gives. A malformed shape
// is ignored rather than thrown: the message has already been delivered, and a
// throw from here would read as a failed send and be retried.
const answerIds = (answer) => {
  const ids = []
  for (const holder of [answer, answer?.msg, answer?.data]) {
    if (holder === null || typeof holder !== 'object') continue
    for (const value of [holder.message_id, holder.msg_id, holder.msgid, holder.client_id]) addId(ids, value)
    const items = Array.isArray(holder) ? holder : Array.isArray(holder.item_list) ? holder.item_list : []
    for (const item of items) addId(ids, item?.msg_id)
  }
  return ids
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

// Inbound media: the CDN URL plus an optional AES-128 key (ECB, PKCS7), carried
// either as strict base64-encoded 32-char hex / 16-byte raw key on `media.aes_key`,
// or as plain 32-char hex on the item's `aeskey`.
const STRICT_B64 = /^[A-Za-z0-9+/]+={0,2}$/
function parseWeixinAesKeys(rawKey, fallbackHex) {
  const keys = []
  const seen = new Set()
  const add = (buf) => {
    const id = buf.toString('hex')
    if (seen.has(id)) return
    seen.add(id)
    keys.push(buf)
  }
  const candidates = [rawKey, fallbackHex].filter(value => typeof value === 'string' && value.trim() !== '')
  for (const raw of candidates) {
    const trimmed = raw.trim()
    if (/^[0-9a-f]{32}$/i.test(trimmed)) { add(Buffer.from(trimmed, 'hex')); continue }
    if (trimmed.length % 4 !== 0 || !STRICT_B64.test(trimmed)) continue
    const decoded = Buffer.from(trimmed, 'base64')
    if (decoded.length === 16) { add(decoded); continue }
    const text = decoded.toString('utf8').trim()
    if (/^[0-9a-f]{32}$/i.test(text)) add(Buffer.from(text, 'hex'))
  }
  return keys
}

const cdnBase = env => String(env.config?.cdn ?? CDN_BASE).replace(/\/+$/, '')

async function downloadMedia(media, fallbackHex, limit, env, signal) {
  let url = String(media.full_url ?? media.url ?? '').trim()
  const encryptedCdn = url === '' && Boolean(media.encrypt_query_param)
  if (encryptedCdn) {
    url = `${cdnBase(env)}/download?encrypted_query_param=${encodeURIComponent(String(media.encrypt_query_param))}`
  }
  if (!isHttpUrl(url)) return undefined
  const keySpecified = (typeof media.aes_key === 'string' && media.aes_key.trim() !== '')
    || (typeof fallbackHex === 'string' && fallbackHex.trim() !== '')
  const keys = parseWeixinAesKeys(media.aes_key, fallbackHex)
  if ((encryptedCdn || keySpecified) && keys.length === 0) {
    env.log?.warn?.('ds-bot im: weixin media missing valid AES key, skipped')
    return undefined
  }
  const response = await env.fetch(url, { signal: mediaSignal(signal) })
  if (!response.ok) {
    await discardBody(response)
    env.log?.warn?.('ds-bot im: weixin media download answered %s', response.status)
    return undefined
  }
  const got = await readCappedBytes(response, limit)
  if (got.overLimit) {
    env.log?.warn?.('ds-bot im: weixin media over %d byte cap, skipped', limit)
    return undefined
  }
  if (got.bytes === undefined || got.bytes.length === 0) return undefined
  if (keys.length === 0) return got.bytes
  for (const key of keys) {
    try {
      const decipher = createDecipheriv('aes-128-ecb', key, null)
      return Buffer.concat([decipher.update(got.bytes), decipher.final()])
    } catch { /* try next candidate key */ }
  }
  env.log?.warn?.('ds-bot im: weixin media decrypt failed, skipped')
  return undefined
}
