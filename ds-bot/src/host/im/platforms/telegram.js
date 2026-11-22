// Telegram Bot API adapter: getUpdates long polling in, sendMessage out. Parts of the
// protocol mapping follow dsh-im (MIT, © 2026 xmanrui — see NOTICE).
import { chunkTelegram } from '../format.js'
import { retryDelay, retryWait } from './retry.js'

const CLOUD_API = 'https://api.telegram.org'
const TEXT_LIMIT = 4096
const POLL_TIMEOUT = 50
// Cloud Bot API `getFile` rejects files larger than 20 MiB.
const TELEGRAM_MAX_FILE_BYTES = 20 * 1024 * 1024
const UPDATES = ['message', 'callback_query']

const reason = (error) => {
  const text = [error, error?.cause].map(part => String(part?.message ?? part ?? '')).filter(Boolean).join(': ')
  return text.slice(0, 300) || 'error'
}

const nameOf = (from) => {
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim()
  return from?.username ? `@${from.username}` : (name || String(from?.id ?? ''))
}

export default {
  id: 'telegram',

  async check(fields, env) {
    const token = String(fields.token ?? '').trim()
    if (token === '') throw new Error('Paste the bot token first')
    const me = await callApi(env, token, 'getMe', {})
    if (typeof me?.id !== 'number' || typeof me.username !== 'string') throw new Error('Telegram did not say who this token belongs to')
    return { account: { id: String(me.id), name: `@${me.username}` } }
  },

  connect(fields, env, handlers) {
    const token = String(fields.token ?? '').trim()
    const api = apiBase(env)
    const isCloudApi = api === CLOUD_API
    const base = `${api}/bot${token}`
    const fileBase = `${api}/file/bot${token}`
    let stopped = false
    // Every call in flight keeps its own controller, so stop() ends them all —
    // a long poll must not outlive the adapter by ~65 s and collide with the
    // restarted one (Telegram answers 409).
    const inFlight = new Set()
    let selfName = ''

    const call = async (method, params, { download = false, timeout = 30_000 } = {}) => {
      const abort = new AbortController()
      inFlight.add(abort)
      if (stopped) abort.abort(stoppedError())
      const timer = setTimeout(() => abort.abort(new Error('timeout')), timeout)
      try {
        const response = await env.fetch(download ? `${fileBase}/${method}` : `${base}/${method}`, download ? { signal: abort.signal } : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: abort.signal,
        })
        if (download) {
          if (!response.ok) throw Object.assign(new Error(`Telegram answered ${response.status}`), { status: response.status, permanent: response.status >= 400 && response.status < 500 })
          return new Uint8Array(await response.arrayBuffer())
        }
        const body = await response.json().catch(() => ({}))
        if (!body.ok) {
          const error = new Error(String(body.description ?? `Telegram answered ${response.status}`))
          error.status = body.error_code ?? response.status
          if (body.parameters?.retry_after !== undefined) error.retryAfter = Number(body.parameters.retry_after)
          error.permanent = error.status >= 400 && error.status < 500 && error.status !== 429
          throw error
        }
        return body.result
      } catch (error) {
        if (stopped) throw stoppedError()
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          const timeout = new Error('Telegram did not answer in time')
          timeout.unknown = true
          throw timeout
        }
        throw error
      } finally {
        clearTimeout(timer)
        inFlight.delete(abort)
      }
    }
    const stoppedError = () => Object.assign(new Error('stopped'), { stopped: true })

    const getMe = async () => {
      const me = await call('getMe', {})
      selfName = me.username ? `@${me.username}` : ''
      return me
    }

    const strip = (text) => {
      if (selfName === '') return text
      const field = /(?:^|\n)\d+:/.exec(text)?.index ?? text.length
      const header = text.slice(0, field).replace(/(?<![\w.@])@\w+(?![\w.-])/g, mention => mention === selfName ? '' : mention)
      return header.trimStart() + text.slice(field)
    }

    const fetchMedia = async (item, kind) => {
      const label = item.file_name ? `${kind} "${item.file_name}"` : kind
      const sizeNote = typeof item.file_size === 'number' && item.file_size > 0
        ? ` (${(item.file_size / (1024 * 1024)).toFixed(1)} MB)`
        : ''
      if (isCloudApi && typeof item.file_size === 'number' && item.file_size > TELEGRAM_MAX_FILE_BYTES) {
        env.log?.warn?.('ds-bot im: telegram %s not fetched: file is too big (%s bytes)', kind, item.file_size)
        return { note: `[Telegram ${label}${sizeNote} could not be downloaded: exceeds Telegram Bot API 20 MB download limit. Tell the user.]` }
      }
      try {
        const file = await call('getFile', { file_id: item.file_id })
        if (!file?.file_path) throw new Error('Telegram did not return a file path')
        const data = await call(file.file_path, {}, { download: true, timeout: 60_000 })
        return { file, data }
      } catch (error) {
        if (error?.stopped || stopped) throw error
        const why = reason(error)
        env.log?.warn?.('ds-bot im: telegram %s not fetched: %s', kind, why)
        const detail = /file is too big/i.test(why)
          ? 'exceeds Telegram Bot API 20 MB download limit'
          : why
        return { note: `[Telegram ${label}${sizeNote} could not be downloaded: ${detail}. Tell the user.]` }
      }
    }

    const fileBlocks = async (message) => {
      const images = []
      const files = []
      const notes = []
      const photo = Array.isArray(message.photo) && message.photo.length > 0 ? message.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a)) : undefined
      if (photo?.file_id !== undefined) {
        const got = await fetchMedia(photo, 'photo')
        if (got.data !== undefined) images.push({ mediaType: 'image/jpeg', data: Buffer.from(got.data).toString('base64') })
        else if (got.note !== undefined) notes.push(got.note)
      }
      // Check animation before document: Telegram also sets document on animations for compatibility.
      const media = [
        ['video', message.video],
        ['animation', message.animation],
        ['video_note', message.video_note],
        ['document', message.document],
        ['voice', message.voice],
        ['audio', message.audio],
      ].find(([, item]) => item?.file_id !== undefined)
      if (media !== undefined) {
        const [kind, item] = media
        const got = await fetchMedia(item, kind)
        if (got.data !== undefined) {
          files.push({ name: item.file_name ?? got.file.file_path?.split('/').pop() ?? kind, data: got.data })
        } else if (got.note !== undefined) {
          notes.push(got.note)
        }
      }
      return { images, files, notes }
    }

    const onUpdate = async (update) => {
      if (update.message !== undefined) {
        const message = update.message
        const chat = message.chat ?? {}
        const kind = chat.type === 'private' ? 'direct' : 'group'
        const from = message.from ?? {}
        const raw = String(message.text ?? message.caption ?? '')
        const mentioned = kind === 'group' && (
          (selfName !== '' && raw.includes(selfName))
          || (message.entities ?? []).some(entity => entity.type === 'mention' && raw.slice(entity.offset, entity.offset + entity.length) === selfName)
          || message.reply_to_message?.from?.is_bot === true && selfName !== '' && message.reply_to_message?.from?.username === selfName.slice(1)
          || /^\/\w+@/.test(raw) && raw.toLowerCase().includes(selfName.toLowerCase())
        )
        const { images, files, notes } = await fileBlocks(message)
        const body = kind === 'group' ? strip(raw) : raw
        await handlers.onMessage({
          chat: { key: String(chat.id), kind, title: chat.title ?? nameOf(from) },
          sender: { id: String(from.id ?? ''), name: nameOf(from) },
          text: [body, ...notes].filter(Boolean).join('\n'),
          images,
          files,
          mentioned,
          messageId: message.message_id,
        })
        return
      }
      if (update.callback_query !== undefined) {
        const query = update.callback_query
        const message = query.message ?? {}
        const chat = message.chat ?? {}
        const from = query.from ?? {}
        await call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {})
        await handlers.onAction({
          chat: { key: String(chat.id), kind: chat.type === 'private' ? 'direct' : 'group', title: chat.title ?? nameOf(from) },
          sender: { id: String(from.id ?? ''), name: nameOf(from) },
          data: String(query.data ?? ''),
          messageId: message.message_id,
        })
      }
    }

    let attempt = 0
    let ready = false
    // The first getMe is part of the poll loop: a network failure there is a retry,
    // not the end of the connection (#1119). A refused token stops instead.
    const poll = async () => {
      while (!stopped) {
        try {
          if (!ready) {
            const me = await getMe()
            ready = true
            attempt = 0
            handlers.onStatus({ state: 'ready', account: { id: String(me.id), name: selfName || String(me.id) } })
          }
          const updates = await call('getUpdates', { offset: env.runtime.get().offset ?? 0, timeout: POLL_TIMEOUT, allowed_updates: UPDATES }, { timeout: (POLL_TIMEOUT + 15) * 1000 })
          for (const update of Array.isArray(updates) ? updates : []) {
            if (typeof update.update_id === 'number') env.runtime.set({ offset: update.update_id + 1 })
            await onUpdate(update).catch(error => env.log?.warn?.('ds-bot im: telegram update failed: %s', reason(error)))
          }
          attempt = 0
          handlers.onStatus({ state: 'ready' })
        } catch (error) {
          if (error.stopped || stopped) return
          if (error.status === 409) {
            handlers.onStatus({ state: 'error', error: 'A webhook or another program uses this bot' })
            return
          }
          // A refused token will not fix itself; a network failure is retried at the
          // preset's retry_after, or after a growing wait.
          if (error?.permanent === true) {
            handlers.onStatus({ state: 'error', error: reason(error) })
            return
          }
          handlers.onStatus({ state: 'retrying', error: reason(error) })
          const wait = error.retryAfter !== undefined ? Math.max(0, Number(error.retryAfter)) * 1000 : retryDelay(attempt)
          attempt += 1
          await retryWait(wait)
        }
      }
    }
    void poll()

    const send = async (chat, { text, buttons }) => {
      const chunks = chunkTelegram(text, TEXT_LIMIT)
      let messageId
      for (const [index, chunk] of chunks.entries()) {
        const markup = index === chunks.length - 1 && buttons?.length > 0
          ? { reply_markup: { inline_keyboard: buttons.map(button => [{ text: button.label, callback_data: button.data }]) } }
          : {}
        const sendOne = async (body) => {
          try {
            return await call('sendMessage', { chat_id: chat.key, text: body, parse_mode: 'HTML', ...markup })
          } catch (error) {
            // Telegram rejects entities it cannot parse; the same text goes plain.
            if (body !== chunk.text && /can't parse entities|parse entities/i.test(String(error?.message ?? ''))) {
              return await call('sendMessage', { chat_id: chat.key, text: chunk.text, ...markup })
            }
            throw error
          }
        }
        const sent = await sendOne(chunk.html)
        messageId = sent?.message_id ?? messageId
      }
      return { messageId }
    }

    const sendImage = async (chat, image) => {
      const bytes = Buffer.isBuffer(image?.data) ? image.data : Buffer.from(image?.data ?? [])
      if (bytes.byteLength === 0) throw Object.assign(new Error('Empty image'), { permanent: true })
      const upload = async (method, field) => {
        const form = new FormData()
        form.append('chat_id', String(chat.key))
        form.append(field, new Blob([bytes], { type: image.mediaType || 'image/png' }), image.name || 'image.png')
        const abort = new AbortController()
        inFlight.add(abort)
        if (stopped) abort.abort(stoppedError())
        const timer = setTimeout(() => abort.abort(new Error('timeout')), 30_000)
        try {
          const response = await env.fetch(`${base}/${method}`, { method: 'POST', body: form, signal: abort.signal })
          const body = await response.json().catch(() => ({}))
          if (!body.ok) {
            const error = new Error(String(body.description ?? `Telegram answered ${response.status}`))
            error.status = body.error_code ?? response.status
            if (body.parameters?.retry_after !== undefined) error.retryAfter = Number(body.parameters.retry_after)
            error.permanent = error.status >= 400 && error.status < 500 && error.status !== 429
            throw error
          }
          return { messageId: body.result?.message_id }
        } catch (error) {
          if (stopped) throw stoppedError()
          if (abort.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
            throw Object.assign(new Error('Telegram did not answer in time'), { unknown: true })
          }
          throw error
        } finally {
          clearTimeout(timer)
          inFlight.delete(abort)
        }
      }
      if (image.mediaType === 'image/gif') return upload('sendAnimation', 'animation')
      try {
        return await upload('sendPhoto', 'photo')
      } catch (error) {
        // Tall screenshots or WebP files can exceed sendPhoto's dimension/format limits;
        // fall back to sendDocument so the user still gets the original image intact.
        if (/PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|PHOTO_SAVE_FILE_INVALID/i.test(String(error?.message ?? ''))) {
          return upload('sendDocument', 'document')
        }
        throw error
      }
    }

    return {
      send,
      sendImage,
      edit: async (chat, messageId, { text, buttons }) => {
        const markup = { reply_markup: { inline_keyboard: (buttons ?? []).map(button => [{ text: button.label, callback_data: button.data }]) } }
        try {
          await call('editMessageText', { chat_id: chat.key, message_id: messageId, text: chunkTelegram(text, TEXT_LIMIT)[0]?.html ?? '', parse_mode: 'HTML', ...markup })
        } catch (error) {
          if (/can't parse entities|parse entities/i.test(String(error?.message ?? ''))) {
            await call('editMessageText', { chat_id: chat.key, message_id: messageId, text: chunkTelegram(text, TEXT_LIMIT)[0]?.text ?? '', ...markup })
            return
          }
          throw error
        }
      },
      typing: chat => call('sendChatAction', { chat_id: chat.key, action: 'typing' }).catch(() => {}),
      stop: () => {
        stopped = true
        for (const abort of inFlight) abort.abort(stoppedError())
      },
    }
  },
}

const apiBase = env => String(env.config?.api ?? 'https://api.telegram.org').replace(/\/+$/, '')

// One Bot API call without the connection's abort bookkeeping, used by `check`
// before a connection exists.
async function callApi(env, token, method, params) {
  const response = await env.fetch(`${apiBase(env)}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const body = await response.json().catch(() => ({}))
  if (!body.ok) throw new Error(String(body.description ?? `Telegram answered ${response.status}`))
  return body.result
}
