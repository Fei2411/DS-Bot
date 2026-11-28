// Electron main-process bridge for `ds-bot/web-fetch`'s isolated browser fallback.
//
// Each request runs in a fresh, non-persistent (in-memory) Electron session and a hidden
// sandboxed BrowserWindow, so no user or Bot cookies/storage are ever read or written.
// Electron's Chromium automatically inherits the OS system proxy, real Chromium TLS/HTTP2
// stack, and full JavaScript execution for SPA / WAF-protected pages, while passively
// reading the rendered page (never clicking or solving CAPTCHAs).
import { randomUUID } from 'node:crypto'
import { classifyContentType, isPrivateHost, validateFetchUrl } from 'ds-bot/web-fetch'

const DEFAULT_MAX_CONCURRENT = 3
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 60_000
const MIN_BODY_CHARS = 1_000
const MAX_BODY_CHARS = 500_000
const SETTLE_POLL_MS = 350
const MAX_SETTLE_WAIT_MS = 2_500
const STABLE_TEXT_CHARS = 300

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

/**
 * Create the IPC handler for `ds-bot:web-fetch` and `ds-bot:web-fetch-abort`.
 * @param {{ BrowserWindow: any, session: any, maxConcurrent?: number, settlePollMs?: number, maxSettleWaitMs?: number }} deps
 */
export function createWebFetchBridge({
  BrowserWindow,
  session,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  settlePollMs = SETTLE_POLL_MS,
  maxSettleWaitMs = MAX_SETTLE_WAIT_MS,
}) {
  let closed = false
  let running = 0
  const queue = []
  const active = new Map()

  const pump = () => {
    while (!closed && running < maxConcurrent && queue.length > 0) {
      const next = queue.shift()
      if (!next || next.aborted) continue
      running += 1
      void runTask(next).finally(() => {
        running -= 1
        pump()
      })
    }
  }

  async function runTask(task) {
    const { id, url, timeoutMs, maxBodyChars, initialPrivate, reply } = task
    let win
    let ses
    let timer
    let settled = false
    let blockedRedirectHost

    const cleanup = () => {
      clearTimeout(timer)
      if (win && !win.isDestroyed?.()) {
        try { win.destroy() } catch {}
      }
      win = undefined
      if (ses) {
        const target = ses
        ses = undefined
        void Promise.resolve(target.clearStorageData?.()).catch(() => {})
        void Promise.resolve(target.clearCache?.()).catch(() => {})
      }
      active.delete(id)
    }

    const finish = (payload) => {
      if (settled) return
      settled = true
      cleanup()
      reply(payload)
    }

    task.cancel = (code = 'WEB_ABORTED', error = 'web fetch aborted') => {
      task.aborted = true
      finish({ type: 'ds-bot:web-fetch-response', id, code, error })
    }

    if (task.aborted || closed) {
      finish({ type: 'ds-bot:web-fetch-response', id, code: 'WEB_ABORTED', error: 'web fetch aborted' })
      return
    }

    const startedAt = Date.now()
    timer = setTimeout(() => {
      task.aborted = true
      finish({ type: 'ds-bot:web-fetch-response', id, code: 'WEB_FETCH_TIMEOUT', error: 'browser web fetch timed out' })
    }, timeoutMs)

    try {
      // Ephemeral (non-persistent) partition: no `persist:` prefix means memory-only, zero shared cookies.
      ses = session.fromPartition(`web-fetch-${randomUUID()}`)
      ses.setPermissionRequestHandler?.((_wc, _permission, callback) => { callback(false) })
      ses.on?.('will-download', (_event, item) => { try { item.cancel() } catch {} })

      let mainStatusCode
      let mainContentType = ''

      ses.webRequest?.onBeforeRequest?.((details, callback) => {
        const reqUrl = String(details?.url ?? '')
        if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:') || reqUrl === 'about:blank') {
          callback({ cancel: false })
          return
        }
        let parsed
        try {
          parsed = new URL(reqUrl)
        } catch {
          callback({ cancel: true })
          return
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          callback({ cancel: true })
          return
        }
        if (!initialPrivate && isPrivateHost(parsed.hostname)) {
          if (details?.resourceType === 'mainFrame') blockedRedirectHost = parsed.hostname
          callback({ cancel: true })
          return
        }
        callback({ cancel: false })
      })

      ses.webRequest?.onCompleted?.((details) => {
        if (details?.resourceType !== 'mainFrame') return
        if (typeof details.statusCode === 'number') mainStatusCode = details.statusCode
        const headers = details.responseHeaders ?? {}
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === 'content-type') {
            mainContentType = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
            break
          }
        }
      })

      win = new BrowserWindow({
        show: false,
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
      wc.setWindowOpenHandler?.(() => ({ action: 'deny' }))
      wc.on?.('login', (event) => { event.preventDefault?.() })

      await new Promise((resolve, reject) => {
        if (task.aborted) { reject(new Error('aborted')); return }
        const onFinish = () => {
          wc.off?.('did-fail-load', onFail)
          resolve()
        }
        const onFail = (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
          if (isMainFrame === false) return
          // -3 is ERR_ABORTED, emitted routinely when a page redirects mid-load.
          if (errorCode === -3 && !blockedRedirectHost) return
          wc.off?.('did-finish-load', onFinish)
          reject(new Error(blockedRedirectHost
            ? `redirect from public host to private address (${blockedRedirectHost}) is blocked`
            : `load failed (${errorCode}): ${errorDescription || 'network error'}`))
        }
        wc.once('did-finish-load', onFinish)
        wc.on('did-fail-load', onFail)
        void Promise.resolve(wc.loadURL(url)).catch((error) => {
          if (error?.code === 'ERR_ABORTED' && !blockedRedirectHost) return
          wc.off?.('did-finish-load', onFinish)
          wc.off?.('did-fail-load', onFail)
          reject(error)
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
          await new Promise(resolve => setTimeout(resolve, wait))
        }
      }

      if (task.aborted || settled) return

      const extracted = await wc.executeJavaScript(EXTRACT_SCRIPT, true)
      const finalUrl = String(extracted?.url || wc.getURL?.() || url)
      if (!initialPrivate) {
        const parsedFinal = validateFetchUrl(finalUrl)
        if (isPrivateHost(parsedFinal.hostname)) {
          finish({
            type: 'ds-bot:web-fetch-response',
            id,
            code: 'WEB_REDIRECT_BLOCKED',
            error: `redirect from public host to private address (${parsedFinal.hostname}) is blocked`,
          })
          return
        }
      }

      const effectiveContentType = mainContentType || String(extracted?.contentType ?? '')
      const kind = classifyContentType(effectiveContentType) === 'text' ? 'text' : 'html'
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
    } catch (error) {
      if (task.aborted || settled) return
      const code = blockedRedirectHost ? 'WEB_REDIRECT_BLOCKED' : 'WEB_PROVIDER_ERROR'
      finish({
        type: 'ds-bot:web-fetch-response',
        id,
        code,
        error: error?.message ?? String(error),
      })
    }
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
        timeoutMs: clamp(message.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 20_000),
        maxBodyChars: clamp(message.maxBodyChars, MIN_BODY_CHARS, MAX_BODY_CHARS, 100_000),
        initialPrivate: isPrivateHost(parsedUrl.hostname),
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
