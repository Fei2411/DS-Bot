// Electron main-process bridge for `ds-bot/web-fetch`'s isolated browser fallback.
//
// Each request borrows an exclusive slot from a bounded pool of non-persistent (in-memory)
// Electron partitions and runs in a hidden, muted, non-focusable, sandboxed BrowserWindow.
// Partition storage, cache, auth cache, and request listeners are cleaned before the slot
// returns to the pool, so no user or Bot cookies/storage are ever read or leaked and
// ElectronBrowserContext instances stay bounded. Passively reads rendered DOM (never clicks
// or solves CAPTCHAs).
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { classifyContentType, createOriginPolicy, normalizeHost, validateFetchUrl } from 'ds-bot/web-fetch'

const DEFAULT_MAX_CONCURRENT = 3
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 60_000
const MIN_BODY_CHARS = 1_000
const MAX_BODY_CHARS = 500_000
const SETTLE_POLL_MS = 350
const MAX_SETTLE_WAIT_MS = 2_500
const STABLE_TEXT_CHARS = 300
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const BLOCKED_STATUSES = new Set([403, 406, 429, 503, 520, 521, 522, 523, 524, 525, 526])

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

const EXTRACT_SCRIPT = `(() => {
  const contentType = String(document.contentType || '')
  let html = ''
  if (document.documentElement) {
    const clone = document.documentElement.cloneNode(true)
    for (const el of clone.querySelectorAll('script, style, noscript, template, svg, iframe, object, embed')) el.remove()
    html = clone.outerHTML || ''
  }
  return {
    url: String(location.href || ''),
    contentType,
    html,
    text: document.body ? (document.body.innerText || '') : '',
  }
})()`

const TEXT_LEN_SCRIPT = `(() => (document.body ? (document.body.innerText || '').trim().length : 0))()`

function readHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
    }
  }
  return ''
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {})
    return Promise.reject(signal.reason ?? new Error('aborted'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

async function resolveRecords(hostname, lookupImpl, signal) {
  const host = normalizeHost(hostname)
  const ipKind = isIP(host)
  if (ipKind !== 0) return [{ address: host, family: ipKind }]
  const records = await raceWithSignal(lookupImpl(host, { all: true, verbatim: true }), signal)
  return Array.isArray(records) ? records.filter(r => typeof r?.address === 'string') : []
}

async function isHostDnsBlocked(hostname, policy, lookupImpl, signal) {
  try {
    const records = await resolveRecords(hostname, lookupImpl, signal)
    return !policy.areResolvedRecordsAllowed(hostname, records)
  } catch {
    // When cancelled/aborted, block the pending request; otherwise allow Electron's proxy DNS
    // to resolve while onHeadersReceived still enforces details.ip.
    return Boolean(signal?.aborted)
  }
}

function normalizeUrlForCompare(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return ''
  try {
    return new URL(raw).toString()
  } catch {
    return raw.trim()
  }
}

/**
 * Create the IPC handler for `ds-bot:web-fetch` and `ds-bot:web-fetch-abort`.
 * @param {{ BrowserWindow: any, session: any, lookup?: Function, maxConcurrent?: number, settlePollMs?: number, maxSettleWaitMs?: number }} deps
 */
export function createWebFetchBridge({
  BrowserWindow,
  session,
  lookup = dnsLookup,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  settlePollMs = SETTLE_POLL_MS,
  maxSettleWaitMs = MAX_SETTLE_WAIT_MS,
}) {
  let closed = false
  let nextSlotId = maxConcurrent
  const freeSlots = Array.from({ length: maxConcurrent }, (_, index) => `web-fetch-slot-${index}`)
  const queue = []
  const active = new Map()

  const pump = () => {
    while (!closed && freeSlots.length > 0 && queue.length > 0) {
      const next = queue.shift()
      if (!next || next.aborted) continue
      const partition = freeSlots.shift()
      const recycle = (clean) => {
        // Retire a partition whose cleanup rejected so cookies/storage can never leak to a later fetch.
        freeSlots.push(clean ? partition : `web-fetch-slot-${nextSlotId++}`)
        pump()
      }
      void runTask(next, partition).then(recycle, () => recycle(false))
    }
  }

  async function runTask(task, partition) {
    const { id, url, timeoutMs, maxBodyChars, reply } = task
    const parsedInitial = new URL(url)
    const policy = createOriginPolicy(parsedInitial)
    const taskAbort = new AbortController()
    let win
    let ses
    let timer
    let settleTimer
    let settled = false
    let blockedRedirectHost
    let cancelledMainFrame
    let unsupportedContentType
    let downloadTriggered = false
    let mainFrameCommittedReadable = false
    let currentMainUrl = normalizeUrlForCompare(url)
    let onDownload = null
    let abortPendingWait = null
    let cleaned = false
    let cleanOk = true

    const detachSessionListeners = (target) => {
      if (!target) return
      try { target.webRequest?.onBeforeRequest?.(null) } catch {}
      try { target.webRequest?.onHeadersReceived?.(null) } catch {}
      try { target.webRequest?.onCompleted?.(null) } catch {}
      try { target.setPermissionRequestHandler?.(null) } catch {}
      try { target.setPermissionCheckHandler?.(null) } catch {}
      if (onDownload) {
        try { target.off?.('will-download', onDownload) } catch {}
        onDownload = null
      }
    }

    const destroyWindowAndListeners = () => {
      clearTimeout(timer)
      clearTimeout(settleTimer)
      if (!taskAbort.signal.aborted) taskAbort.abort(new Error('aborted'))
      abortPendingWait?.()
      abortPendingWait = null
      detachSessionListeners(ses)
      if (win && !win.isDestroyed?.()) {
        try { win.destroy() } catch {}
      }
      win = undefined
    }

    const releaseSession = async () => {
      if (cleaned) return cleanOk
      cleaned = true
      destroyWindowAndListeners()
      const target = ses
      ses = undefined
      if (target) {
        detachSessionListeners(target)
        const results = await Promise.allSettled([
          Promise.resolve().then(() => target.clearStorageData?.()),
          Promise.resolve().then(() => target.clearCache?.()),
          Promise.resolve().then(() => target.clearAuthCache?.()),
        ])
        if (results.some(r => r.status === 'rejected')) {
          cleanOk = false
        }
      }
      active.delete(id)
      return cleanOk
    }

    const finish = (payload) => {
      if (settled) return
      settled = true
      destroyWindowAndListeners()
      reply(payload)
    }

    task.cancel = (code = 'WEB_ABORTED', error = 'web fetch aborted') => {
      task.aborted = true
      finish({ type: 'ds-bot:web-fetch-response', id, code, error })
    }

    if (task.aborted || closed) {
      finish({ type: 'ds-bot:web-fetch-response', id, code: 'WEB_ABORTED', error: 'web fetch aborted' })
      return await releaseSession()
    }

    const startedAt = Date.now()
    timer = setTimeout(() => {
      task.aborted = true
      finish({ type: 'ds-bot:web-fetch-response', id, code: 'WEB_FETCH_TIMEOUT', error: 'browser web fetch timed out' })
    }, timeoutMs)

    const runBody = async () => {
      if (!policy.initialPrivateLiteral && isIP(policy.initialHost) === 0) {
        try {
          const records = await resolveRecords(policy.initialHost, lookup, taskAbort.signal)
          if (task.aborted || settled) return
          const classification = policy.classifyInitialRecords(records)
          if (!classification.allowed) {
            finish({
              type: 'ds-bot:web-fetch-response',
              id,
              code: 'WEB_BLOCKED_URL',
              error: `mixed public/private DNS resolution (${policy.initialHost}) is blocked`,
            })
            return
          }
        } catch {
          if (task.aborted || settled) return
        }
      }
      if (task.aborted || settled) return

      // Bounded non-persistent partition pool: memory-only, isolated per slot, cleared on release.
      ses = session.fromPartition(partition)
      ses.setPermissionRequestHandler?.((_wc, _permission, callback) => { callback(false) })
      ses.setPermissionCheckHandler?.(() => false)

      let mainStatusCode
      let mainContentType = ''

      onDownload = (_event, item) => {
        try { item.cancel() } catch {}
        if (mainFrameCommittedReadable) return
        const itemUrl = normalizeUrlForCompare(item?.getURL?.())
        const urlChain = Array.isArray(item?.getURLChain?.())
          ? item.getURLChain().map(normalizeUrlForCompare).filter(Boolean)
          : []
        const hasUrlMetadata = itemUrl.length > 0 || urlChain.length > 0
        const matchesMain = !hasUrlMetadata
          || itemUrl === currentMainUrl
          || itemUrl === normalizeUrlForCompare(url)
          || urlChain.includes(currentMainUrl)
          || urlChain.includes(normalizeUrlForCompare(url))
        if (!matchesMain) return
        downloadTriggered = true
        abortPendingWait?.(new Error('unsupported downloadable content'))
      }
      ses.on?.('will-download', onDownload)

      ses.webRequest?.onBeforeRequest?.((details, callback) => {
        const reqUrl = String(details?.url ?? '')
        const isMain = details?.resourceType === 'mainFrame'
        if (reqUrl === 'about:blank') {
          callback({ cancel: false })
          return
        }
        if (!isMain && (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:'))) {
          callback({ cancel: false })
          return
        }
        let parsed
        try {
          parsed = new URL(reqUrl)
        } catch {
          if (isMain) cancelledMainFrame = { code: 'WEB_INVALID_URL', message: `invalid URL: ${reqUrl}` }
          callback({ cancel: true })
          return
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          if (isMain) cancelledMainFrame = { code: 'WEB_INVALID_URL', message: `unsupported URL scheme "${parsed.protocol}"` }
          callback({ cancel: true })
          return
        }
        if (parsed.username.length > 0 || parsed.password.length > 0) {
          if (isMain) cancelledMainFrame = { code: 'WEB_BLOCKED_URL', message: 'credentials in URLs are not allowed' }
          callback({ cancel: true })
          return
        }
        if (!policy.initialPrivateLiteral) {
          if (!policy.isTargetHostAllowed(parsed.hostname)) {
            if (isMain) blockedRedirectHost = parsed.hostname
            callback({ cancel: true })
            return
          }
          if (isIP(normalizeHost(parsed.hostname)) === 0) {
            void isHostDnsBlocked(parsed.hostname, policy, lookup, taskAbort.signal).then((blocked) => {
              if (blocked) {
                if (isMain && !taskAbort.signal.aborted) blockedRedirectHost = parsed.hostname
                callback({ cancel: true })
              } else {
                if (isMain) currentMainUrl = parsed.toString()
                callback({ cancel: false })
              }
            }, () => {
              if (taskAbort.signal.aborted) {
                callback({ cancel: true })
              } else {
                if (isMain) currentMainUrl = parsed.toString()
                callback({ cancel: false })
              }
            })
            return
          }
        }
        if (isMain) currentMainUrl = parsed.toString()
        callback({ cancel: false })
      })

      ses.webRequest?.onHeadersReceived?.((details, callback) => {
        const isMain = details?.resourceType === 'mainFrame'
        let reqHost = ''
        try { reqHost = new URL(String(details?.url ?? '')).hostname } catch {}
        if (!policy.initialPrivateLiteral && typeof details?.ip === 'string' && details.ip.length > 0 && !policy.isConnectedIpAllowed(reqHost, details.ip)) {
          if (isMain) blockedRedirectHost = details.ip
          callback({ cancel: true })
          return
        }
        if (isMain && typeof details?.statusCode === 'number' && !REDIRECT_STATUSES.has(details.statusCode)) {
          const disp = readHeaderValue(details.responseHeaders, 'content-disposition')
          if (/^\s*attachment\b/i.test(disp)) {
            downloadTriggered = true
            callback({ cancel: true })
            return
          }
          const ct = readHeaderValue(details.responseHeaders, 'content-type')
          if (ct && classifyContentType(ct) === undefined && !BLOCKED_STATUSES.has(details.statusCode)) {
            unsupportedContentType = ct
            callback({ cancel: true })
            return
          }
          if (classifyContentType(ct) !== undefined) {
            mainFrameCommittedReadable = true
          }
        }
        callback({ cancel: false })
      })

      ses.webRequest?.onCompleted?.((details) => {
        if (details?.resourceType !== 'mainFrame') return
        if (typeof details.statusCode === 'number') mainStatusCode = details.statusCode
        const ct = readHeaderValue(details.responseHeaders, 'content-type')
        if (ct) mainContentType = ct
      })

      win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        focusable: false,
        width: 1280,
        height: 900,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
          spellcheck: false,
          backgroundThrottling: false,
          autoplayPolicy: 'document-user-activation-required',
        },
      })
      const wc = win.webContents
      wc.setAudioMuted?.(true)
      wc.setWindowOpenHandler?.(() => ({ action: 'deny' }))
      wc.on?.('login', (event) => { event.preventDefault?.() })
      wc.on?.('select-client-certificate', (event) => { event.preventDefault?.() })

      await new Promise((resolve, reject) => {
        if (task.aborted || settled) { reject(new Error('aborted')); return }
        let done = false
        const settleLoad = (fn, value) => {
          if (done) return
          done = true
          abortPendingWait = null
          wc.off?.('did-finish-load', onFinish)
          wc.off?.('did-fail-load', onFail)
          wc.off?.('destroyed', onGone)
          wc.off?.('render-process-gone', onGone)
          fn(value)
        }
        const onFinish = () => settleLoad(resolve)
        const onGone = () => settleLoad(reject, new Error('renderer closed'))
        const onFail = (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
          if (isMainFrame === false) return
          // -3 is ERR_ABORTED, emitted routinely during redirects unless we deliberately blocked/cancelled.
          if (errorCode === -3 && !blockedRedirectHost && !cancelledMainFrame && !unsupportedContentType && !downloadTriggered && !task.aborted) return
          settleLoad(reject, new Error(blockedRedirectHost
            ? `redirect from public host to private address (${blockedRedirectHost}) is blocked`
            : cancelledMainFrame
              ? cancelledMainFrame.message
              : unsupportedContentType
                ? `unsupported content type "${unsupportedContentType}"`
                : downloadTriggered
                  ? 'unsupported downloadable content'
                  : `load failed (${errorCode}): ${errorDescription || 'network error'}`))
        }
        abortPendingWait = (err) => settleLoad(reject, err ?? new Error('aborted'))
        wc.once('did-finish-load', onFinish)
        wc.on('did-fail-load', onFail)
        wc.once?.('destroyed', onGone)
        wc.once?.('render-process-gone', onGone)
        void Promise.resolve(wc.loadURL(url)).catch((error) => {
          if (error?.code === 'ERR_ABORTED' && !blockedRedirectHost && !cancelledMainFrame && !unsupportedContentType && !downloadTriggered && !task.aborted) return
          settleLoad(reject, error)
        })
      })

      if (task.aborted || settled) return

      // Wait briefly for SPA hydration / client-side data without delaying fast static pages.
      const remainingBeforeSettle = timeoutMs - (Date.now() - startedAt)
      const settleBudget = Math.min(maxSettleWaitMs, Math.max(0, remainingBeforeSettle - 1_500))
      if (settleBudget >= settlePollMs && (!mainContentType || classifyContentType(mainContentType) === 'html')) {
        const settleDeadline = Date.now() + settleBudget
        let prevLen = -1
        while (!task.aborted && !settled && Date.now() < settleDeadline) {
          const len = await wc.executeJavaScript(TEXT_LEN_SCRIPT, true).catch(() => -1)
          if (len >= STABLE_TEXT_CHARS && len === prevLen) break
          prevLen = len
          const wait = Math.min(settlePollMs, settleDeadline - Date.now())
          if (wait <= 0) break
          await new Promise((resolve) => {
            const doneWait = () => {
              clearTimeout(settleTimer)
              abortPendingWait = null
              resolve()
            }
            abortPendingWait = doneWait
            settleTimer = setTimeout(doneWait, wait)
          })
        }
      }

      if (task.aborted || settled) return

      const extracted = await wc.executeJavaScript(EXTRACT_SCRIPT, true)
      if (task.aborted || settled) return

      const finalUrl = String(extracted?.url || wc.getURL?.() || url)
      const parsedFinal = validateFetchUrl(finalUrl)
      if (!policy.initialPrivateLiteral) {
        if (!policy.isTargetHostAllowed(parsedFinal.hostname) || await isHostDnsBlocked(parsedFinal.hostname, policy, lookup, taskAbort.signal)) {
          if (task.aborted || settled) return
          finish({
            type: 'ds-bot:web-fetch-response',
            id,
            code: 'WEB_REDIRECT_BLOCKED',
            error: `redirect from public host to private address (${parsedFinal.hostname}) is blocked`,
          })
          return
        }
        if (task.aborted || settled) return
      }

      const effectiveContentType = mainContentType || String(extracted?.contentType ?? '')
      const classified = classifyContentType(effectiveContentType)
      if (effectiveContentType && classified === undefined) {
        finish({
          type: 'ds-bot:web-fetch-response',
          id,
          code: 'WEB_UNSUPPORTED_CONTENT_TYPE',
          error: `unsupported content type "${effectiveContentType}"`,
        })
        return
      }
      const kind = classified === 'text' ? 'text' : 'html'
      const raw = kind === 'text' ? String(extracted?.text ?? '') : String(extracted?.html ?? '')
      const truncated = raw.length > maxBodyChars
      const content = truncated ? raw.slice(0, maxBodyChars) : raw
      finish({
        type: 'ds-bot:web-fetch-response',
        id,
        result: {
          url: finalUrl,
          statusCode: mainStatusCode ?? 200,
          body: { kind, content },
          truncated,
        },
      })
    }

    try {
      await runBody()
    } catch (error) {
      if (!task.aborted && !settled) {
        const code = blockedRedirectHost
          ? 'WEB_REDIRECT_BLOCKED'
          : cancelledMainFrame
            ? cancelledMainFrame.code
            : (unsupportedContentType || downloadTriggered)
              ? 'WEB_UNSUPPORTED_CONTENT_TYPE'
              : 'WEB_PROVIDER_ERROR'
        finish({
          type: 'ds-bot:web-fetch-response',
          id,
          code,
          error: error?.message ?? String(error),
        })
      }
    } finally {
      cleanOk = await releaseSession()
    }
    return cleanOk
  }

  return {
    handle(message, send) {
      if (message?.type === 'ds-bot:web-fetch-abort' && typeof message.id === 'string') {
        const task = active.get(message.id)
        if (task) {
          task.aborted = true
          task.cancel?.('WEB_ABORTED', 'web fetch aborted')
        }
        return true
      }
      if (message?.type !== 'ds-bot:web-fetch' || typeof message.id !== 'string') return false
      const reply = (payload) => { try { send(payload) } catch {} }
      if (closed) {
        reply({ type: 'ds-bot:web-fetch-response', id: message.id, code: 'WEB_ABORTED', error: 'web fetch bridge closed' })
        return true
      }
      let parsedUrl
      try {
        parsedUrl = validateFetchUrl(message.url)
      } catch (error) {
        reply({
          type: 'ds-bot:web-fetch-response',
          id: message.id,
          code: error?.code ?? 'WEB_INVALID_URL',
          error: error?.message ?? 'invalid URL',
        })
        return true
      }
      const task = {
        id: message.id,
        url: parsedUrl.toString(),
        timeoutMs: clamp(message.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 15_000),
        maxBodyChars: clamp(message.maxBodyChars, MIN_BODY_CHARS, MAX_BODY_CHARS, 100_000),
        aborted: false,
        reply,
        cancel: null,
      }
      task.cancel = (code, error) => {
        task.aborted = true
        active.delete(task.id)
        reply({ type: 'ds-bot:web-fetch-response', id: task.id, code, error })
      }
      active.set(task.id, task)
      queue.push(task)
      pump()
      return true
    },
    close() {
      closed = true
      queue.length = 0
      for (const task of [...active.values()]) {
        task.aborted = true
        task.cancel?.('WEB_ABORTED', 'web fetch bridge closed')
      }
      active.clear()
    },
  }
}
