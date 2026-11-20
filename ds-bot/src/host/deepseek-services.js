// DeepSeek's document service (api.deepseek.com/v1/tools/ocr): an optional OCR tool for
// every Bot. It is a paid call on the official endpoint only, billed on the user's
// DeepSeek API key — never the account sign-in — and it is off until the user turns it
// on. The speech services of the same key arrive in their own change.
// https://api-docs.deepseek.com/guides/ocr.md
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { own } from './store.js'

// The text answer every team tool gives (tools.js exports the same shape).
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const OFFICIAL_ORIGIN = 'https://api.deepseek.com'
const DEFAULT_REF = 'DEEPSEEK_API_KEY'
const PROVIDER = 'deepseek-official'

const OCR_MAX_BYTES = 100 * 1024 * 1024
const OCR_TIMEOUT_MS = 175_000
// The recognized text goes into the tool result up to this length; past it the whole
// result also lands in a file next to the Session's work, which the model then reads.
const OCR_INLINE_MAX = 8_000

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const unavailable = message => Object.assign(new Error(message), { code: 'bot/unavailable' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

export const defaultServices = () => ({ ocr: false })

// What the user saved, cleaned into the shape the status answers. Unknown fields drop.
export function normalizeServices(input) {
  const out = {}
  if (input?.ocr === true) out.ocr = true
  return out
}
const servicePrefs = rt => ({ ...defaultServices(), ...normalizeServices(rt.state?.prefs?.deepseekServices) })

export function install(rt) {
  const { ctx } = rt
  const credentials = () => ctx.get?.('credentials')
  const isRef = value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)

  // The official DeepSeek route may point somewhere else — a gateway the user gave a
  // baseURL in settings, or DEEPSEEK_BASE_URL in the launch environment (the adapter's
  // own precedence: profile value, then the env override, then the default). Then its
  // stored key is that gateway's, and must not go to api.deepseek.com — not even when
  // it happens to be named DEEPSEEK_API_KEY. `route` answers {ref} or {blocked} when
  // the same name would leak it.
  const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
  function keyRoute() {
    let ref = DEFAULT_REF
    const entry = ctx.llm?.listConfigurableProviders?.().find(candidate => candidate.provider === PROVIDER)
    if (entry === undefined) {
      const envURL = ctx.get?.('launchEnvironment')?.get?.(BASE_URL_ENV)?.value
      let envOrigin
      try { envOrigin = envURL === undefined ? undefined : new URL(envURL).origin } catch { envOrigin = 'unparseable' }
      // Without a route there is no profile to name another ref, so DEEPSEEK_API_KEY
      // is the only credential an independent service could mean — unless the env
      // points the route elsewhere: then a DEEPSEEK_API_KEY set for that env is the
      // gateway's key under the official name.
      if (envOrigin !== undefined && envOrigin !== OFFICIAL_ORIGIN) return { blocked: `DEEPSEEK_BASE_URL points at another endpoint and the only credential name is ${DEFAULT_REF}; DS Bot cannot tell that key from the official DeepSeek API key` }
      return { ref: DEFAULT_REF }
    }
    const section = ctx.get?.('settings')?.describe?.({ redactSecrets: true })?.find(section => section.ns === entry.settingsNs)
    const profile = entry.settingsPath.reduce((value, key) => value?.[key], section?.value)
    if (typeof profile?.apiKeyEnv === 'string' && isRef(profile.apiKeyEnv)) ref = profile.apiKeyEnv
    // The adapter's real endpoint: the profile's baseURL, then the env override
    // (the names the adapter publishes, plus the one this repo's adapter reads),
    // then the shipped default. Any origin that is not api.deepseek.com is another
    // server whose key must not leave under the official name.
    const env = ctx.get?.('launchEnvironment')
    const envURL = [...(entry.baseURLEnv ?? []), BASE_URL_ENV]
      .map(name => env?.get?.(name)?.value).find(value => typeof value === 'string' && value !== '')
    // The descriptor carries no defaultBaseURL: the shipped endpoint is the
    // adapter's own default (dsh-llm-deepseek's PUBLIC_BASE_URL), which is
    // api.deepseek.com — used only when neither profile nor env overrides it.
    const baseURL = typeof profile?.baseURL === 'string' && profile.baseURL.trim() !== '' ? profile.baseURL
      : (envURL !== undefined ? envURL : (entry.defaultBaseURL ?? 'https://api.deepseek.com/anthropic'))
    let official = false
    try {
      official = baseURL !== undefined && new URL(baseURL).origin === OFFICIAL_ORIGIN
    } catch { official = false }
    if (official) return { ref }
    // The route is not the official endpoint, so the key its profile names is the
    // other server's. A custom env name is harmless: the independent ref below still
    // resolves DEEPSEEK_API_KEY. Only when both names coincide would the other
    // server's key go out under the official name, so that combination is refused.
    if (ref === DEFAULT_REF) {
      return { blocked: `the DeepSeek model route points at another endpoint and stores its key as ${DEFAULT_REF}; DS Bot cannot tell that key from the official DeepSeek API key` }
    }
    return { ref: DEFAULT_REF }
  }

  // A plain-string ref rides the credentials seam the same way providers.js' set does.
  async function describeKey() {
    const route = keyRoute()
    if (route.blocked !== undefined) return { ref: DEFAULT_REF, configured: false, reason: `DS Bot cannot tell the DeepSeek key from another server's: ${route.blocked}. These services stay off until the DeepSeek model route points at api.deepseek.com or its key uses another credential name.` }
    const creds = credentials()
    if (creds === undefined) return { ref: route.ref, configured: false, reason: 'This DSH has no credential store.' }
    const info = await creds.describe(route.ref).catch(() => undefined)
    return { ref: route.ref, configured: info?.configured === true }
  }

  // The value itself, resolved only at call time (a changed key reaches the next call).
  async function resolveKey() {
    const key = await describeKey()
    if (key.configured !== true) {
      throw unavailable(key.reason ?? `The DeepSeek API key (${key.ref}) is not set. Add it under Settings → Models; these services bill that key directly on api.deepseek.com.`)
    }
    const resolved = await credentials().resolve(key.ref).catch(() => undefined)
    if (resolved?.value === undefined) throw unavailable(`The DeepSeek API key (${key.ref}) could not be read.`)
    return resolved.value
  }

  // Upstream failures answer with the HTTP status and a fixed phrase per status;
  // the body may quote the request or the key, so nothing from it crosses into
  // the answer.
  const STATUS_TEXT = {
    400: 'the request was refused',
    401: 'the DeepSeek API key was not accepted',
    402: 'the account balance is not enough for this call',
    408: 'the upload took too long',
    413: 'the file is too large',
    429: 'too many calls in progress — try again',
    500: 'the service could not process the file',
    503: 'the service is busy — try again later',
    504: 'the service ran out of time',
  }
  const statusDetail = status => ` — ${STATUS_TEXT[status] ?? 'the service reported an error'}`

  // One request: a single deadline covers the upload, the headers and the whole
  // body read; the caller's signal and the module unload both cancel it. Redirects
  // are refused outright — the key must never leave api.deepseek.com.
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('ds-bot stopped')) }, 'ds-bot: deepseek services')
  async function requestService(path, init, { timeoutMs, signal } = {}) {
    const key = await resolveKey()
    const deadline = new AbortController()
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => deadline.abort(new Error('DeepSeek did not answer in time')), timeoutMs)
    const combined = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal === undefined ? [] : [signal])])
    let response
    try {
      response = await fetch(`${OFFICIAL_ORIGIN}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, ...init.headers },
        signal: combined,
        redirect: 'error',
      })
    } catch (error) {
      // A network, abort or redirect failure never returns a call object, so its
      // timer is cleared here rather than by call.done().
      clearTimeout(timer)
      throw error
    }
    // The abort reason of a combined signal is the caller's or the deadline's;
    // a timed-out body read surfaces as aborted, which the callers turn into
    // their own failure text.
    const read = async (maxBytes) => {
      const reader = response.body?.getReader?.()
      if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
      const chunks = []
      let size = 0
      for (;;) {
        const { done: ended, value } = await reader.read()
        if (ended) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => {})
          throw refused(`DeepSeek returned more data than expected (over ${Math.floor(maxBytes / 1024 / 1024)} MiB)`)
        }
        chunks.push(value)
      }
      return concat(chunks)
    }
    // done() releases the deadline and closes an unconsumed body so a refused
    // call cannot hold the connection (or its upload meter) open.
    const done = () => {
      clearTimeout(timer)
      void response.body?.cancel?.().catch(() => {})
    }
    return { response, read, done }
  }

  // Both shapes from the guides: an HTTP error before work starts, and an HTTP 200
  // whose body carries {error} when recognition already began. The status text is
  // fixed; upstream messages stay on the wire.
  async function jsonResult(call, what, status, maxBytes = 16 * 1024 * 1024) {
    if (!status.ok) {
      call.done()
      throw refused(`${what} failed (HTTP ${status.status})${statusDetail(status.status)}`)
    }
    try {
      const text = await call.read(maxBytes)
      const body = (() => { try { return JSON.parse(new TextDecoder().decode(text).trim()) } catch { return undefined } })()
      // A 200 with an error body gets the same fixed phrase as its status; the
      // upstream type and message can quote the request, so neither comes back.
      if (body?.error !== undefined) throw refused(`${what} failed — the service reported an error`)
      if (body === undefined || typeof body !== 'object') throw refused(`${what} failed: DeepSeek returned no usable answer (HTTP ${status.status})`)
      return body
    } finally {
      call.done()
    }
  }

  // ---- OCR ----------------------------------------------------------------------
  const PURPOSES = ['text_recognition', 'rich_layout_recognition']
  const OCR_MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
  const nameOfPath = value => basename(value) || 'document'
  const mimeOfName = value => OCR_MIMES[(nameOfPath(value).split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'

  // The ref named by attachment_id must be in the calling Session's own
  // messages — a file upload or an image upload; a guessed id reads nothing.
  async function attachmentOf(exec, attachmentId) {
    const session = exec.agent?.session
    if (session === undefined || typeof session.eventAt !== 'function') throw refused('This file is not an upload in this conversation')
    for (const seq of session.surface?.nodes ?? []) {
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue
      const message = session.deriveEventMessage(event)
      for (const block of message?.content ?? []) {
        if ((block?.type === 'file' || block?.type === 'image') && String(block.attachment?.attachmentId) === attachmentId) {
          return { kind: block.type, ref: block.attachment }
        }
      }
    }
    throw invalid('That attachment is not in this conversation; upload the file or image to the chat, or give a path in your working folder')
  }

  async function inputBytes(exec, args) {
    const attachments = ctx.get?.('attachments')
    const path = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined
    const attachmentId = typeof args.attachment_id === 'string' && args.attachment_id !== '' ? args.attachment_id : undefined
    if ((path === undefined) === (attachmentId === undefined)) {
      throw invalid('Give exactly one of path or attachment_id')
    }
    if (attachmentId !== undefined) {
      if (attachments === undefined) throw unavailable('This DSH cannot read uploaded files')
      const found = await attachmentOf(exec, attachmentId)
      if (found.kind === 'image') {
        if (typeof attachments.readImage !== 'function') throw unavailable('This DSH cannot read uploaded images')
        const { data, ref } = await attachments.readImage(found.ref, exec.signal)
        if (data.byteLength > OCR_MAX_BYTES) throw invalid('The image is larger than 100 MiB')
        const mediaType = typeof ref.mediaType === 'string' && ref.mediaType !== '' ? ref.mediaType : 'image/png'
        const ext = mediaType.split('/')[1]?.replace(/[^a-z]+/g, '') ?? 'png'
        return { bytes: data, name: nameOfPath(ref.name ?? `image.${ext}`), mediaType }
      }
      const ref = found.ref
      const chunks = []
      let size = 0
      for await (const chunk of attachments.readFileStream(ref, exec.signal)) {
        size += chunk.byteLength
        if (size > OCR_MAX_BYTES) throw invalid('The file is larger than 100 MiB')
        chunks.push(chunk)
      }
      return { bytes: concat(chunks), name: nameOfPath(ref.name ?? 'document'), mediaType: mimeOfName(ref.name ?? '') }
    }
    const fs = ctx.get?.('fs')
    if (fs === undefined) throw unavailable('This DSH cannot read workspace files here')
    const cwd = typeof ctx.get?.('workingDirectory')?.ensure === 'function' && exec.agent !== undefined
      ? await ctx.get('workingDirectory').ensure(exec.agent, exec.signal)
      : undefined
    const target = await fs.resolve(path, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal })
    const info = await fs.stat(target, exec.signal)
    if (info === undefined) throw invalid(`There is no file at ${path}`)
    if (info.type !== 'file') throw invalid(`${path} is not a file`)
    const processPath = typeof fs.processPath === 'function' ? fs.processPath(target) : target.displayPath
    if (typeof rt.inData === 'function' && await rt.inData(processPath)) {
      throw invalid(`${path} is inside DeepSeek Harness or team data, which Bots cannot read`)
    }
    const bytes = await fs.readBytes(target, exec.signal, OCR_MAX_BYTES)
    return { bytes, name: nameOfPath(processPath), mediaType: mimeOfName(processPath) }
  }
  const concat = (chunks) => {
    if (chunks.length === 1) return chunks[0]
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let at = 0
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
    return out
  }

  // A long result's whole text is filed so the model can read it back. Non-private
  // Sessions use DSH's spill store. A private Bot's text must stay inside a path
  // that names the Bot's own Session id: the default spill backend hashes that id
  // into the directory name, which ownerOfPath does not see, so another Bot could
  // glob and read it. Those results go under the Bot's own folder instead.
  async function spillPrivate(bot, sessionId, text, suggestedName) {
    const base = typeof bot.workDir === 'string' && bot.workDir !== '' ? bot.workDir : undefined
    if (base === undefined) return undefined
    const dir = join(base, '.ocr', bot.id, sessionId)
    const locator = join(dir, suggestedName)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(locator, text, 'utf8')
      return {
        locator,
        bytes: Buffer.byteLength(text, 'utf8'),
        retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
      }
    } catch (error) {
      rt.warn('ds-bot: OCR result spill failed: %s', error)
      return undefined
    }
  }

  async function spillResult(exec, text, name) {
    const sessionId = exec.agent?.session?.id
    if (sessionId === undefined) return undefined
    const suggestedName = `${name.replace(/\.[^.]*$/, '')}.ocr.txt`
    const botId = rt.selfOf(exec.agent?.id)
    const bot = botId !== undefined && typeof rt.botOf === 'function' ? rt.botOf(botId) : undefined
    if (bot?.private === true) return spillPrivate(bot, sessionId, text, suggestedName)
    const store = ctx.get?.('spillStore')
    if (store === undefined) return undefined
    try {
      return await store.saveText({
        owner: { sessionId },
        source: { kind: 'tool', toolName: 'read_document', callId: exec.callId ?? 'read_document', label: name },
        suggestedName,
        content: text,
      })
    } catch (error) {
      rt.warn('ds-bot: OCR result spill failed: %s', error)
      return undefined
    }
  }

  async function ocrDocument(args, exec) {
    const prefs = servicePrefs(rt)
    if (prefs.ocr !== true) throw unavailable('DeepSeek document recognition is off. Ask the user to turn it on in DS Bot settings.')
    const purpose = args.purpose === undefined ? 'text_recognition' : String(args.purpose)
    if (!PURPOSES.includes(purpose)) throw invalid(`purpose must be ${PURPOSES.join(' or ')}`)
    const input = await inputBytes(exec, args)
    const form = new FormData()
    form.append('purpose', purpose)
    form.append('file', new Blob([input.bytes], { type: input.mediaType }), input.name)
    const call = await requestService('/v1/tools/ocr', { method: 'POST', body: form }, { timeoutMs: OCR_TIMEOUT_MS, signal: exec.signal })
    const body = await jsonResult(call, 'Document recognition', call.response)
    const pages = Array.isArray(body.pages) ? body.pages : []
    const count = typeof body.page_count === 'number' ? body.page_count : pages.length
    if (pages.length === 0) throw refused('Document recognition returned no pages')
    const whole = pages.map((page) => {
      const index = typeof page?.index === 'number' ? page.index : '?'
      const cut = page?.finish_reason === 'length' ? ' — possibly incomplete' : ''
      return `[page ${index}${cut}]\n${typeof page?.text === 'string' ? page.text : ''}`
    }).join('\n\n')
    const head = [`Recognized ${input.name} on api.deepseek.com: ${count} page${count === 1 ? '' : 's'}, ${pages.reduce((total, page) => total + String(page?.text ?? '').length, 0)} characters.`]
    if (pages.some(page => page?.finish_reason === 'length')) head.push('Pages marked "possibly incomplete" were cut at the service\'s per-page output limit.')
    if (whole.length <= OCR_INLINE_MAX) return `${head.join(' ')}\n\n${whole}`
    const spilled = await spillResult(exec, whole, input.name)
    if (spilled === undefined) return `${head.join(' ')} The full result is below; this DSH could not file a copy for later.\n\n${whole}`
    // The locator is the model-facing handle (an absolute path for the local
    // backend); retrievalHint is generic guidance that never names it, so the
    // answer quotes the locator literally for a copyable read/grep target.
    return `${head.join(' ')} The full result was saved to ${JSON.stringify(String(spilled.locator))} (${spilled.bytes} bytes). ${spilled.retrievalHint}\n\n${whole.slice(0, OCR_INLINE_MAX)}\n\n[... ${whole.length - OCR_INLINE_MAX} more characters in the saved result]`
  }

  // Off until Settings turns OCR on: a registered schema still costs context tokens
  // and invites the model to call it. addTeamTool/removeTeamTool also update live
  // Agent scopes; unit tests that only install this module fall back to push/splice.
  const readDocument = defineTool({
    name: 'read_document',
    description: 'Read the text of a document or scanned file — PDF, Word, PowerPoint, or an image of a page — with DeepSeek\'s document recognition (a paid call on your DeepSeek API key, enabled in DS Bot settings). Give exactly one of path or attachment_id. The text comes back page by page; a long result is also written to a file you can read.',
    parameters: {
      path: { type: 'string', description: 'Path of a file in your working folder; a relative path starts in that folder. For an uploaded file or image, use attachment_id' },
      attachment_id: { type: 'string', description: 'attachmentId of a file or image uploaded to this conversation; the only way to read an upload with this tool' },
      purpose: { type: 'string', enum: PURPOSES, description: '"text_recognition" (default): direct text extraction for text documents, page recognition otherwise. "rich_layout_recognition": every page recognized with layout and figure locations' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (rt.selfOf(exec.agent?.id) === undefined) return 'Only Bots on the team can use read_document.'
      return ocrDocument(args, exec)
    },
  })

  function syncOcrTool() {
    const want = servicePrefs(rt).ocr === true
    const have = rt.teamTools.some(tool => tool.name === 'read_document')
    if (want && !have) {
      if (typeof rt.addTeamTool === 'function') rt.addTeamTool(readDocument)
      else rt.teamTools.push(readDocument)
    } else if (!want && have) {
      if (typeof rt.removeTeamTool === 'function') rt.removeTeamTool('read_document')
      else {
        const at = rt.teamTools.findIndex(tool => tool.name === 'read_document')
        if (at !== -1) rt.teamTools.splice(at, 1)
      }
    }
  }

  // ---- channel endpoints ----------------------------------------------------------
  async function servicesStatus() {
    const key = await describeKey()
    const prefs = servicePrefs(rt)
    return {
      endpoint: OFFICIAL_ORIGIN,
      key,
      ocr: {
        supported: true,
        enabled: prefs.ocr,
        configured: key.configured,
        reason: key.configured !== true ? (key.reason ?? `The DeepSeek API key (${key.ref}) is not set`) : undefined,
      },
      preferences: prefs,
    }
  }

  async function updateServices(body) {
    const current = own(rt.state.prefs, 'deepseekServices') ?? {}
    const next = { ...current }
    if ('ocr' in body) {
      if (body.ocr === null) delete next.ocr
      else if (body.ocr === true || body.ocr === false) next.ocr = body.ocr
      else throw invalid('ocr must be true, false or null')
    }
    const cleaned = normalizeServices(next)
    if (Object.keys(cleaned).length === 0) delete rt.state.prefs.deepseekServices
    else rt.state.prefs.deepseekServices = cleaned
    await rt.save()
    syncOcrTool()
    return servicesStatus()
  }

  async function deepseekEndpoint(endpoint, body) {
    await rt.load()
    syncOcrTool()
    switch (endpoint) {
      case 'deepseek-services': return servicesStatus()
      case 'deepseek-services-config': return updateServices(body ?? {})
      default:
        throw invalid(`Unknown endpoint ${endpoint}`)
    }
  }

  syncOcrTool()
  // Load after the rest of the plugin has installed: store.adopt needs groups'
  // keepGroupLine, which this module precedes in MODULES. A microtask waits
  // until createRuntime's loop (and its post-loop sync) has finished.
  queueMicrotask(() => {
    void Promise.resolve(rt.load?.()).then(() => { syncOcrTool() }).catch(() => {})
  })

  Object.assign(rt, { servicesStatus, deepseekEndpoint, servicePrefs: () => servicePrefs(rt) })
}
