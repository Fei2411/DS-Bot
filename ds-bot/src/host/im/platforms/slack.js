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
// A section block's `text` is capped at 3000 characters. Slack rejects the whole
// message with invalid_blocks when one is longer, so the blocks have to be split
// by that limit even though the message-level `text` field allows more.
const SECTION_LIMIT = 3000
const FENCE = '```'

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
      // A section block's `text` is capped at 3,000 characters and Slack rejects the whole
      // message with invalid_blocks when one is longer, so long text is split here rather
      // than left to the 4,000-character message limit.
      const blocks = sectionsOf(String(text ?? '')).map(section => ({ type: 'section', text: { type: 'mrkdwn', text: section } }))
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
      edit: async (chat, messageId, { text, buttons, sentLength }) => {
        // `send` spreads a long card over several messages and answers with the last
        // one, so the edit has to rebuild that same last chunk: rebuilding the whole
        // card here put every earlier section back into the final message.
        const body = settledChunk(text, sentLength)
        // The blocks render `body` whole: trimming it to the 4,000-character message limit
        // first removed the closing fence of a card that nearly filled it, `toMrkdwn` then
        // read the code as prose, and the answer ended up inside the block. Sections are
        // what Slack caps at 3,000, and the split there reopens a fence it has to cut.
        // The top-level `text` is a 4,000-character field that screen readers read instead
        // of the blocks, so it carries the question plus the answer rather than the tail
        // of the card alone — which for a settled card is just `— yes`.
        await api('chat.update', {
          channel: chat.key,
          ts: messageId,
          text: toMrkdwn(accessibleText(body, sentLength)).slice(0, TEXT_LIMIT),
          blocks: blocksFor(toMrkdwn(body), buttons),
        })
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

// Slack caps a section block's text at SECTION_LIMIT characters and rejects the whole
// message when one is longer. Converted Markdown can also grow (a [label](url) link
// becomes <url|link>), so the split is applied to the rendered text rather than to the
// Markdown that chunkMarkdown measured.
function sectionsOf(text) {
  const parts = []
  let rest = text
  const closingMarker = `\n${FENCE}`
  while (rest.length > SECTION_LIMIT) {
    let at = cutAt(rest, SECTION_LIMIT)
    let fence = fenceAt(rest, at)
    // A cut inside a fence leaves one section with an unclosed fence and the next with
    // stray code. The section that ends inside it closes it and the next one reopens it
    // with the same info string; both marker lines come out of this section's budget, so a
    // cut that fits the text alone has to move back. Moving back can land before the line
    // that opened the fence, which turns the fence off rather than carrying a marker that
    // no longer belongs there — so the fence is read again at the cut that is really used.
    for (let pass = 0; pass < 3 && fence !== null; pass += 1) {
      // A fence line too long to leave room for text is not worth reopening: the block
      // continues as plain text instead of growing `rest` on every pass.
      if (fence.length + 1 + closingMarker.length >= SECTION_LIMIT) {
        fence = null
        at = cutAt(rest, SECTION_LIMIT)
        break
      }
      const budget = SECTION_LIMIT - closingMarker.length - (fence.length + 1)
      if (at <= budget) break
      at = cutAt(rest, budget)
      fence = fenceAt(rest, at)
    }
    // What is open at the cut that is really used is the state this section ends in.
    if (fence !== null) fence = fenceAt(rest, at)
    const closing = fence === null || at + closingMarker.length > SECTION_LIMIT ? '' : closingMarker
    // A continuation that is longer than the text it moves to the next section would make
    // `rest` grow instead of shrink, and the loop would never end. The bare marker keeps
    // the block open when the info string cannot.
    const reopen = fence === null ? null : fence.length + 1 < at ? `${fence}\n` : `${FENCE}\n`
    const opening = reopen !== null && reopen.length < at ? reopen : ''
    parts.push(`${rest.slice(0, at).replace(/\n+$/, '')}${closing}`)
    rest = `${opening}${rest.slice(at).replace(/^\n+/, '')}`
  }
  if (rest !== '' || parts.length === 0) parts.push(rest)
  return parts
}

// Where one section ends: a line break in the second half of the limit when there is one,
// otherwise the limit itself. A cut between the halves of a surrogate pair is stepped back
// one unit, or both sections carry half an emoji.
function cutAt(text, limit) {
  const newline = text.lastIndexOf('\n', limit)
  let at = newline > limit / 2 ? newline : limit
  const before = text.charCodeAt(at - 1)
  if (at > 1 && before >= 0xd800 && before <= 0xdbff) at -= 1
  return at
}

// The fence a cut lands inside: the line that opened it, or null when no block is open at
// `at`. A line that starts with a fence marker opens or closes a block, which is what both
// Slack and this split have to agree on.
function fenceAt(text, at) {
  let open = null
  for (const line of text.slice(0, at).split('\n')) {
    if (!line.trimStart().startsWith(FENCE)) continue
    open = open === null ? line.trim() : null
  }
  return open
}

// The chunk an edit has to write. `send` spreads a long card over several messages and
// answers with the last one, so the edit belongs to that message's own chunk. A settled
// card arrives as the card plus `\n— <answer>`: cutting the combined text again moves
// every boundary, and a card already near the limit comes out as the answer alone. Take
// the chunk that was already sent and append what came after it — whole, because the
// blocks split it by the section limit and trimming here would cut a closing fence.
function settledChunk(text, sentLength) {
  const whole = String(text ?? '')
  if (sentLength === undefined || sentLength >= whole.length) return chunkMarkdown(whole, TEXT_LIMIT).at(-1) ?? ''
  const sent = whole.slice(0, Math.max(0, sentLength))
  const tail = whole.slice(Math.max(0, sentLength))
  return (chunkMarkdown(sent, TEXT_LIMIT).at(-1) ?? '') + tail
}

// The top-level `text` field: Slack shows it to screen readers and in notifications
// instead of the blocks. The blocks above carry the whole card, but that field is capped
// at 4,000 characters, so a card that nearly fills a message plus its answer has to be
// summarised. Keeping the head of the card keeps the question; appending the answer keeps
// the outcome. Trimming the combined text instead left exactly `— yes!!`, which named
// neither the question nor which card it belonged to.
function accessibleText(body, sentLength) {
  const whole = String(body ?? '')
  if (whole.length <= TEXT_LIMIT) return whole
  const tail = sentLength !== undefined && sentLength < whole.length ? whole.slice(sentLength) : ''
  if (tail === '' || tail.length >= TEXT_LIMIT) return whole.slice(0, TEXT_LIMIT)
  const room = TEXT_LIMIT - tail.length - 1
  const head = room > 0 ? whole.slice(0, room) : ''
  // A budget can land between the halves of an astral character.
  const at = head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.length - 1 : head.length
  return `${head.slice(0, at).replace(/\s+$/, '')}\n${tail}`
}

const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff
