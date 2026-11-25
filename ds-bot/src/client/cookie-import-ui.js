// Shared cookie import flow (hook + UI views) used by both the Bot browser panel
// (`browser-pane.js`) and Settings → Browser (`browser-settings.js`).
import { createElement as h, useEffect, useRef, useState } from 'react'
import { STORAGE } from './storage.js'
import { Segmented, stepMenuFocus } from './motion.js'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CopyIcon, InfoIcon, SearchIcon } from './icons.js'
import { BrowserMark } from './browser-marks.js'
import { t } from './i18n.js'
import { useEscape } from './overlay-hooks.js'
import { writeClipboard } from './dsh-primitives.js'

const icon = paths => function CookieImportIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
const FileIcon = icon(['M6 3.5h5.2a1 1 0 0 1 .7.3l2.3 2.3a1 1 0 0 1 .3.7V15a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 15V5A1.5 1.5 0 0 1 6 3.5z', 'M11 3.5V6a1 1 0 0 0 1 1h2.5'])
const PasteIcon = icon(['M7.5 3.75h5a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1z', 'M6.5 5.25H6A1.5 1.5 0 0 0 4.5 6.75v8A1.5 1.5 0 0 0 6 16.25h8a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 14 5.25h-.5'])

/** Whether a cookie site belongs to the same host or direct domain hierarchy as the current tab. */
export function siteMatchesHost(site, host) {
  const s = String(site ?? '').replace(/^\.+/, '').toLowerCase()
  const h = String(host ?? '').replace(/^\.+/, '').toLowerCase()
  if (!s || !h) return false
  if (s === h) return true
  // Never match bare single-label TLDs as parents (only real multi-label domains).
  if (s.includes('.') && h.endsWith(`.${s}`)) return true
  if (h.includes('.') && s.endsWith(`.${h}`)) return true
  return false
}

const hostOfUrl = (url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

export const lastImportSource = () => {
  try { return localStorage.getItem(STORAGE.browserImportSource) || null } catch { return null }
}

export const saveLastImportSource = (id) => {
  if (!id) return
  try { localStorage.setItem(STORAGE.browserImportSource, String(id)) } catch { /* storage unavailable */ }
}

export function orderImportSources(sources, lastId) {
  if (!Array.isArray(sources) || !lastId) return sources ?? []
  const index = sources.findIndex((s) => s.id === lastId)
  if (index <= 0) return sources
  return [sources[index], ...sources.slice(0, index), ...sources.slice(index + 1)]
}

export function importError(error) {
  if (error === 'too-large') return t('That file is too large to be a cookie export.')
  if (error === 'unreadable') return t('That file could not be read.')
  if (error === 'app-bound') return t('This browser encrypts its cookies so only it can read them. Export them to a file first, then import that file.')
  if (error === 'keychain-denied') return t('Keychain access was cancelled. Click Allow when macOS asks to read your browser cookies.')
  if (error === 'devtools-denied') return t('Remote debugging permission was declined in the browser. Try again and click Allow.')
  if (error === 'devtools-timeout') return t('Timed out waiting for you to click Allow in the browser.')
  if (error === 'devtools-wrong-profile') return t('Another browser profile is active. Switch to the chosen profile window in your browser, then try again.')
  if (error === 'browser-locked') return t('This browser’s cookie database is busy. Quit the browser and try again.')
  if (error === 'safari-corrupt') return t('Safari cookies could not be read. Try again or import from a file.')
  return String(error)
}

/**
 * Shared cookie import state machine.
 * `idleFlow` is `null` for the browser overlay (closing returns to the web page) and `'menu'`
 * for Settings → Browser (where the source list stays inline on the page).
 */
export function useCookieImportFlow({ imports, botId = null, botIds = null, pageUrl = '', resetKey = null, idleFlow = null, onReload }) {
  const [flow, setFlow] = useState(idleFlow)
  // A mirrored flow: cleanup on leaving the tab/panel/dialog still cancels
  // an unconfirmed pending import or an in-flight live harvest.
  const flowRef = useRef(idleFlow)
  const reqRef = useRef(0)
  const liveReqIdRef = useRef(null)
  const sourcesReqRef = useRef(0)
  const [sources, setSources] = useState(null)
  const [lastSourceId, setLastSourceId] = useState(lastImportSource)
  const [busy, setBusy] = useState(false)
  const targetBotIds = Array.isArray(botIds) ? botIds.filter(Boolean) : (botId ? [botId] : [])

  const setFlowTracked = (next) => {
    flowRef.current = typeof next === 'function' ? next(flowRef.current) : next
    setFlow(flowRef.current)
  }
  const cancelPendingImport = () => {
    const liveId = liveReqIdRef.current
    liveReqIdRef.current = null
    if (liveId) void imports?.cancel(liveId).catch(() => {})
    const id = typeof flowRef.current === 'object' && flowRef.current !== null ? flowRef.current.id : null
    if (id) void imports?.cancel(id).catch(() => {})
  }
  const refreshSources = () => {
    if (!imports) return
    const req = ++sourcesReqRef.current
    void imports.sources().then(
      (list) => { if (req === sourcesReqRef.current) setSources(Array.isArray(list) ? list : []) },
      () => { if (req === sourcesReqRef.current) setSources((prev) => prev ?? []) },
    )
  }

  // Reset and cancel any in-flight work when leaving the tab/panel/page.
  useEffect(() => {
    reqRef.current += 1
    sourcesReqRef.current += 1
    cancelPendingImport()
    setBusy(false)
    setFlowTracked(idleFlow)
    if (idleFlow === 'menu' && imports) {
      setLastSourceId(lastImportSource())
      refreshSources()
    }
    return () => {
      reqRef.current += 1
      sourcesReqRef.current += 1
      cancelPendingImport()
    }
    // The flow controls live in this hook; the effect re-runs only on resetKey / bridge availability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, Boolean(imports)])

  const openImport = () => {
    reqRef.current += 1
    setBusy(false)
    cancelPendingImport()
    setFlowTracked('menu')
    setLastSourceId(lastImportSource())
    refreshSources()
  }
  const showPicked = (r, token) => {
    if (token !== undefined && token !== reqRef.current) {
      if (r?.id) void imports?.cancel(r.id).catch(() => {})
      return
    }
    if (r?.canceled) {
      if (flowRef.current?.stage === 'connecting') setFlowTracked(idleFlow)
      return
    }
    if (r?.id) setFlowTracked({ stage: 'preview', id: r.id, preview: r.preview, restarted: r.restarted === true, method: r.method ?? null })
    else if (r?.error) setFlowTracked({ stage: 'error', message: importError(r.error) })
    else setFlowTracked(idleFlow)
  }
  const job = async (work) => {
    const token = ++reqRef.current
    setBusy(true)
    try { await work(token) } catch (error) {
      if (token === reqRef.current) setFlowTracked({ stage: 'error', message: String(error?.message ?? error) })
    } finally {
      if (token === reqRef.current) setBusy(false)
    }
  }
  const pickFile = () => job(async (token) => showPicked(await imports.pick(), token))
  const openPaste = () => {
    reqRef.current += 1
    setBusy(false)
    cancelPendingImport()
    setFlowTracked({ stage: 'paste', siteUrl: hostOfUrl(pageUrl) ? pageUrl : '' })
  }
  const submitPaste = (text, siteUrl) => job(async (token) => {
    if (!imports?.paste) return
    showPicked(await imports.paste(text, siteUrl || undefined), token)
  })
  const runLiveImport = async (source, close, token) => {
    const prevLive = liveReqIdRef.current
    if (prevLive) void imports?.cancel(prevLive).catch(() => {})
    const requestId = `live-${Date.now()}-${token}`
    liveReqIdRef.current = requestId
    try {
      return await imports.live(source.id, close, requestId)
    } finally {
      if (liveReqIdRef.current === requestId) liveReqIdRef.current = null
    }
  }
  const pickSource = (source) => job(async (token) => {
    setFlowTracked({ stage: 'connecting', source })
    const r = await runLiveImport(source, false, token)
    if (token !== reqRef.current) {
      if (r?.id) void imports?.cancel(r.id).catch(() => {})
      return
    }
    if (r?.canceled) {
      if (flowRef.current?.stage === 'connecting') setFlowTracked(idleFlow)
      return
    }
    if (r?.needsProfileChoice) {
      setSources(null)
      setFlowTracked('menu')
      refreshSources()
      return
    }
    if (r?.needsFullDiskAccess) setFlowTracked({ stage: 'safari-permission', source, info: r })
    else if (r?.needsRemoteDebugging) setFlowTracked({ stage: 'remote-debug', source, info: r })
    else if (r?.running) setFlowTracked({ stage: 'running', source })
    else showPicked(r, token)
  })
  const closeAndImport = () => job(async (token) => {
    const source = flowRef.current?.source
    if (!source) return
    const r = await runLiveImport(source, true, token)
    if (token !== reqRef.current) {
      if (r?.id) void imports?.cancel(r.id).catch(() => {})
      return
    }
    if (r?.canceled) {
      if (flowRef.current?.stage === 'connecting') setFlowTracked(idleFlow)
      return
    }
    if (r?.needsRemoteDebugging) setFlowTracked({ stage: 'remote-debug', source, info: r })
    else showPicked(r, token)
  })
  const applyImport = (options) => job(async (token) => {
    const current = flowRef.current
    if (!current?.id || targetBotIds.length === 0) return
    const target = targetBotIds.length === 1 ? targetBotIds[0] : targetBotIds
    const report = await imports.apply(target, current.id, options)
    if (token !== reqRef.current) return
    const sourceId = current.preview?.source?.id
    if (sourceId) { saveLastImportSource(sourceId); setLastSourceId(sourceId) }
    const shouldReload = Boolean(pageUrl && onReload) && ((report?.stored ?? 0) > 0 || (report?.originsStored ?? 0) > 0)
    if (shouldReload) void onReload()
    setFlowTracked({
      stage: 'result',
      report,
      label: current.preview?.source?.label ?? null,
      botCount: report?.botCount ?? targetBotIds.length,
      reloaded: shouldReload,
    })
  })
  const cancelImport = () => {
    reqRef.current += 1
    setBusy(false)
    cancelPendingImport()
    setFlowTracked(idleFlow)
    if (idleFlow === 'menu') refreshSources()
  }
  const doneImport = () => {
    setFlowTracked(idleFlow)
    if (idleFlow === 'menu') refreshSources()
  }

  return {
    flow,
    sources: orderImportSources(sources, lastSourceId),
    loadingSources: sources === null,
    lastSourceId,
    busy,
    setFlowTracked,
    openImport,
    pickFile,
    openPaste,
    submitPaste,
    pickSource,
    closeAndImport,
    applyImport,
    cancelImport,
    doneImport,
    retrySource: () => { if (flow?.source) void pickSource(flow.source) },
    launchSource: () => { if (flow?.source && imports?.launch) void imports.launch(flow.source.id) },
    openPermission: () => { if (imports?.openPermission) void imports.openPermission() },
  }
}

function ImportHeader({ title, subtitle, mark, onBack, onClose, busy }) {
  return h('div', { className: 'bt-import-head' },
    onBack ? h('button', {
      type: 'button', className: 'bt-icon-btn bt-import-head-btn', 'aria-label': t('Back'), title: t('Back'),
      disabled: busy, onClick: onBack,
    }, h(ChevronLeftIcon)) : null,
    mark ? h('span', { className: 'bt-import-head-mark', 'aria-hidden': true }, mark) : null,
    h('div', { className: 'bt-import-head-text' },
      h('div', { className: 'bt-import-title' }, title),
      subtitle ? h('div', { className: 'bt-import-sub' }, subtitle) : null),
    onClose ? h('button', {
      type: 'button', className: 'bt-icon-btn bt-import-head-btn', 'aria-label': t('Close'), title: t('Close'),
      disabled: busy, onClick: onClose,
    }, h(CloseIcon)) : null)
}

// The source picker: installed browser profiles first (most-recent pinned), then file & paste.
export function ImportMenu({ sources, lastSourceId, loading, busy, canPaste, inline = false, onFile, onPaste, onSource, onClose }) {
  const menuRef = useRef(null)
  useEscape(() => { if (!busy) onClose?.() }, !inline && typeof onClose === 'function')
  useEffect(() => {
    const onKey = (event) => { stepMenuFocus(menuRef.current, event) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])
  return h('div', {
    ref: menuRef,
    className: `bt-import-stage bt-import-menu${inline ? ' bt-import-inline' : ''}`,
    role: 'menu',
    'aria-label': t('Import cookies'),
  },
    inline ? null : h(ImportHeader, { title: t('Import cookies'), onClose, busy }),
    h('div', { className: 'bt-import-section' },
      h('div', { className: 'bt-import-label' }, t('Import from browser')),
      loading
        ? h('div', { className: 'bt-import-rows', 'aria-busy': true },
          h('span', { className: 'bt-sr' }, t('Loading…')),
          h('div', { className: 'bt-import-skel-row' },
            h('span', { className: 'bt-import-skel-ico' }),
            h('span', { className: 'bt-import-skel-lines' },
              h('span', { className: 'bt-import-skel-bar bt-import-skel-w1' }),
              h('span', { className: 'bt-import-skel-bar bt-import-skel-w2' }))),
          h('div', { className: 'bt-import-skel-row' },
            h('span', { className: 'bt-import-skel-ico' }),
            h('span', { className: 'bt-import-skel-lines' },
              h('span', { className: 'bt-import-skel-bar bt-import-skel-w3' }))))
        : sources.length === 0
          ? h('div', { className: 'bt-import-menu-note' }, t('No browsers found'))
          : h('div', { className: 'bt-import-rows' },
            sources.map((source) => {
              const isLast = source.id === lastSourceId
              const needsPerm = Boolean(source.needsPermission)
              const isReady = Boolean(source.liveDebugReady)
              const hasCount = typeof source.cookieCount === 'number' && !needsPerm && !isReady
              const showFallback = !isLast && !needsPerm && !isReady && !hasCount && !source.email
              const subline = source.email || (showFallback ? t('Browser profile') : null)
              const hasMeta = needsPerm || isReady || hasCount
              return h('button', {
                key: source.id, type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy,
                title: source.email ? `${source.label} (${source.email})` : source.label,
                onClick: () => onSource(source),
              },
                h('span', { className: 'bt-import-mark', 'aria-hidden': true }, h(BrowserMark, { source, size: 26 })),
                h('span', { className: 'bt-import-item-main' },
                  h('span', { className: 'bt-import-item-name' }, source.label),
                  subline || isLast ? h('span', { className: 'bt-import-item-subrow' },
                    isLast ? h('span', { className: 'bt-import-item-tag' }, t('Last used')) : null,
                    subline ? h('span', { className: 'bt-import-item-email' }, subline) : null) : null),
                hasMeta ? h('span', { className: 'bt-import-item-meta' },
                  needsPerm ? h('span', { className: 'bt-import-item-sub', 'data-missing': true },
                    h('span', { className: 'bt-import-dot', 'aria-hidden': true }),
                    t('Permission needed')) : null,
                  isReady ? h('span', { className: 'bt-import-item-sub', 'data-ready': true },
                    h('span', { className: 'bt-import-dot', 'aria-hidden': true }),
                    t('Ready')) : null,
                  hasCount ? h('span', { className: 'bt-import-item-sub' }, t('{count} cookies', { count: source.cookieCount })) : null) : null,
                h('span', { className: 'bt-import-chev', 'aria-hidden': true }, h(ChevronRightIcon)))
            }))),
    h('div', { className: 'bt-import-sep', role: 'separator' }),
    h('div', { className: 'bt-import-rows bt-import-alt-rows' },
      h('button', { type: 'button', className: 'bt-import-item bt-import-item-alt', role: 'menuitem', disabled: busy, onClick: onFile },
        h('span', { className: 'bt-import-alt-ico', 'aria-hidden': true }, h(FileIcon)),
        h('span', { className: 'bt-import-item-name' }, t('From a file…')),
        h('span', { className: 'bt-import-alt-hint' }, t('cookies.txt, JSON, storageState'))),
      canPaste ? h('button', { type: 'button', className: 'bt-import-item bt-import-item-alt', role: 'menuitem', disabled: busy, onClick: onPaste },
        h('span', { className: 'bt-import-alt-ico', 'aria-hidden': true }, h(PasteIcon)),
        h('span', { className: 'bt-import-item-name' }, t('Paste cookies or cURL…')),
        h('span', { className: 'bt-import-alt-hint' }, t('JSON, cURL, header'))) : null))
}

export function SafariPermissionCard({ flow, busy, imports, inline = false, onOpenPermission, onPermissionGranted, onRetrySource, onBack, onCancel }) {
  const { source } = flow
  const [granted, setGranted] = useState(false)
  const notifiedRef = useRef(false)
  const onGrantedRef = useRef(onPermissionGranted)
  onGrantedRef.current = onPermissionGranted

  useEffect(() => {
    const canProbe = typeof imports?.probe === 'function'
    if (!canProbe) return undefined
    let active = true
    let timer = null
    const schedule = () => {
      if (!active) return
      timer = setTimeout(poll, 2000)
    }
    const poll = () => {
      void imports.probe(source.id).then(
        (res) => {
          if (!active) return
          const ok = Boolean(res?.permissionGranted)
          setGranted(ok)
          if (ok && !notifiedRef.current) {
            notifiedRef.current = true
            onGrantedRef.current?.()
          }
        },
        () => {},
      ).finally(schedule)
    }
    schedule()
    return () => { active = false; clearTimeout(timer) }
  }, [imports, source.id])

  return h('div', { className: 'bt-import-stage' },
    h(ImportHeader, { title: t('Allow Safari access'), mark: h(BrowserMark, { source: { kind: 'safari' }, size: 22 }), onBack, onClose: inline ? null : onCancel, busy }),
    h('div', { className: 'bt-import-text' },
      t('macOS protects Safari cookies with Full Disk Access. Enable DS Bot once in System Settings to import from Safari.')),
    h('div', { className: 'bt-import-steps' },
      h('div', { className: 'bt-import-step' }, t('1. Open Full Disk Access in System Settings and turn on DS Bot.')),
      h('div', { className: 'bt-import-step' }, t('2. If macOS asks to quit and reopen DS Bot, click Quit & Reopen, then try again.'))),
    granted ? h('div', { className: 'bt-import-ready-note' },
      h(CheckIcon),
      h('span', null, t('Full Disk Access granted — ready to import.'))) : null,
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      granted && imports?.openPermission
        ? h('button', {
            type: 'button',
            className: 'bt-import-plain',
            disabled: busy,
            onClick: onOpenPermission,
          }, t('Open System Settings'))
        : null,
      h('button', {
        type: 'button',
        className: granted || !imports?.openPermission ? 'bt-import-primary' : 'bt-import-plain',
        disabled: busy,
        onClick: onRetrySource,
      }, busy ? t('Reading…') : granted ? t('Import') : t('Try again')),
      !granted && imports?.openPermission
        ? h('button', {
            type: 'button',
            className: 'bt-import-primary',
            disabled: busy,
            onClick: onOpenPermission,
          }, t('Open System Settings'))
        : null))
}

export function RemoteDebugCard({ flow, busy, imports, inline = false, onRetrySource, onLaunchSource, onFile, onBack, onCancel }) {
  const { source, info } = flow
  const inspectUrl = info?.inspectUrl || 'chrome://inspect/#remote-debugging'
  const browserName = info?.browserName || source.name
  const [copied, setCopied] = useState(false)
  const [detected, setDetected] = useState(false)
  const copyTimerRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(copyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const canProbe = typeof imports?.probe === 'function'
    const canList = typeof imports?.sources === 'function'
    if (!canProbe && !canList) return undefined
    let active = true
    let timer = null
    const schedule = () => {
      if (!active) return
      timer = setTimeout(poll, 2000)
    }
    const poll = () => {
      const req = canProbe
        ? imports.probe(source.id).then((res) => Boolean(res?.liveDebugReady))
        : imports.sources().then((list) => Array.isArray(list) && Boolean(list.find((s) => s.id === source.id)?.liveDebugReady))
      void req.then(
        (ready) => { if (active) setDetected(ready) },
        () => {},
      ).finally(schedule)
    }
    schedule()
    return () => { active = false; clearTimeout(timer) }
  }, [imports, source.id])

  const copyAddress = () => {
    void Promise.resolve(writeClipboard(inspectUrl)).then((ok) => {
      if (!ok || !mountedRef.current) return
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setCopied(false)
      }, 1800)
    }, () => {})
  }

  return h('div', { className: 'bt-import-stage' },
    h(ImportHeader, { title: t('Connect to {name}', { name: browserName }), mark: h(BrowserMark, { source, size: 22 }), onBack, onClose: inline ? null : onCancel, busy }),
    h('div', { className: 'bt-import-text' },
      t('{name} protects its cookies on Windows. Enable its built-in remote debugging switch once — no extension needed.', { name: browserName })),
    h('div', { className: 'bt-import-steps' },
      h('div', { className: 'bt-import-step' }, t('1. Open this address in {name}:', { name: browserName })),
      h('div', { className: 'bt-import-copy-row' },
        h('code', { className: 'bt-import-code' }, inspectUrl),
        h('button', { type: 'button', className: 'bt-import-mini', onClick: copyAddress },
          h(copied ? CheckIcon : CopyIcon),
          copied ? t('Copied') : t('Copy'))),
      h('div', { className: 'bt-import-step' }, t('2. Turn on “Allow remote debugging for this browser instance”, then click Allow when {name} prompts.', { name: browserName }))),
    detected ? h('div', { className: 'bt-import-ready-note' },
      h(CheckIcon),
      h('span', null, t('Remote debugging detected — ready to import.'))) : null,
    h('div', { className: 'bt-import-actions' },
      !info?.running && info?.hasExe
        ? h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onLaunchSource }, t('Open {name}', { name: browserName }))
        : h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onFile }, t('From a file…')),
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onRetrySource }, busy ? t('Connecting…') : t('Connect and import'))))
}

function PasteCard({ flow, busy, inline = false, onSubmitPaste, onBack, onCancel }) {
  const [text, setText] = useState('')
  const [siteUrl, setSiteUrl] = useState(flow.siteUrl || '')
  return h('div', { className: 'bt-import-stage' },
    h(ImportHeader, { title: t('Paste cookies or cURL'), onBack, onClose: inline ? null : onCancel, busy }),
    h('textarea', {
      className: 'bt-import-textarea',
      rows: 5,
      spellCheck: false,
      placeholder: t('Paste Cookie-Editor JSON, Netscape cookies.txt, Copy as cURL, or a Cookie header…'),
      value: text,
      onChange: (event) => setText(event.target.value),
    }),
    h('input', {
      type: 'text',
      className: 'bt-import-input',
      spellCheck: false,
      placeholder: t('Site URL (only needed for plain Cookie headers)'),
      value: siteUrl,
      onChange: (event) => setSiteUrl(event.target.value),
    }),
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', {
        type: 'button', className: 'bt-import-primary', disabled: busy || !text.trim(),
        onClick: () => onSubmitPaste(text, siteUrl.trim()),
      }, busy ? t('Reading…') : t('Continue'))))
}

export function PreviewCard({ flow, page = { url: '' }, busy, canApply = true, inline = false, onApply, onBack, onCancel }) {
  const { preview } = flow
  const sites = (preview.sites ?? []).filter((s) => (s.cookies ?? 0) > 0 || (s.localStorage ?? 0) > 0)
  const currentHost = hostOfUrl(page?.url)
  const matchingCurrent = currentHost
    ? sites.filter((s) => siteMatchesHost(s.site, currentHost)).map((s) => s.site)
    : []
  const [selected, setSelected] = useState(() => new Set(sites.map((s) => s.site)))
  const [query, setQuery] = useState('')
  const [persistSession, setPersistSession] = useState(true)

  const hasSession = preview.notes.includes('session-cookies')
  const allSelected = selected.size === sites.length
  const currentOnlySelected = matchingCurrent.length > 0
    && selected.size === matchingCurrent.length
    && matchingCurrent.every((s) => selected.has(s))

  const visibleSites = query.trim()
    ? sites.filter((s) => s.site.toLowerCase().includes(query.trim().toLowerCase()))
    : sites
  const selectedCookies = sites.reduce((sum, s) => sum + (selected.has(s.site) ? s.cookies : 0), 0)
  const selectedStorage = sites.reduce((sum, s) => sum + (selected.has(s.site) ? (s.localStorage ?? 0) : 0), 0)

  const toggleSite = (site) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(site)) next.delete(site)
      else next.add(site)
      return next
    })
  }
  const selectAll = () => setSelected(new Set(sites.map((s) => s.site)))
  const clearAll = () => setSelected(new Set())
  const selectCurrent = () => setSelected(new Set(matchingCurrent))

  const submit = () => {
    const chosen = allSelected ? undefined : [...selected]
    onApply({ sites: chosen, persistSession: hasSession ? persistSession : false })
  }

  const subtitle = [
    preview.source?.label || null,
    flow.restarted ? t('the browser was restarted') : null,
    selectedStorage > 0 ? t('{count} storage entries', { count: selectedStorage }) : null,
  ].filter(Boolean).join(' · ')
  const scopeValue = allSelected ? 'all' : currentOnlySelected ? 'current' : 'custom'

  return h('div', { className: 'bt-import-stage' },
    h(ImportHeader, {
      title: t('Import {count} cookies', { count: selectedCookies }),
      subtitle,
      mark: preview.source ? h(BrowserMark, { source: preview.source, size: 22 }) : null,
      onBack: inline ? onBack : null,
      onClose: inline ? null : onCancel,
      busy,
    }),
    matchingCurrent.length > 0 && sites.length > 1 ? h(Segmented, {
      label: t('Import cookies'),
      value: scopeValue,
      className: 'bt-import-scope',
    },
      h('button', {
        type: 'button', 'aria-pressed': allSelected,
        onClick: selectAll,
      }, t('All sites ({count})', { count: sites.length })),
      h('button', {
        type: 'button', 'aria-pressed': currentOnlySelected,
        onClick: selectCurrent,
      }, t('This site ({host})', { host: currentHost }))) : null,
    sites.length > 6 ? h('div', { className: 'bt-import-search' },
      h('span', { className: 'bt-import-search-ico', 'aria-hidden': true }, h(SearchIcon)),
      h('input', {
        type: 'text', className: 'bt-import-search-in', spellCheck: false,
        placeholder: t('Filter sites…'),
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      h('button', {
        type: 'button', className: 'bt-import-search-btn',
        onClick: allSelected ? clearAll : selectAll,
      }, allSelected ? t('Clear') : t('All'))) : null,
    sites.length ? h('div', { className: 'bt-import-list' },
      visibleSites.length === 0
        ? h('div', { className: 'bt-import-list-empty' }, t('No results'))
        : visibleSites.map((site) => {
          const checked = selected.has(site.site)
          return h('label', { key: site.site, className: 'bt-import-line bt-import-check-row', 'data-checked': checked || undefined },
            h('input', {
              type: 'checkbox',
              className: 'bt-import-cb-input',
              checked,
              onChange: () => toggleSite(site.site),
            }),
            h('span', { className: 'bt-import-cb', 'aria-hidden': true }, checked ? h(CheckIcon) : null),
            h('span', { className: 'bt-import-line-name' }, site.site),
            h('span', { className: 'bt-import-line-count' },
              t('{count}', { count: site.cookies }),
              site.localStorage > 0 ? ` · ${t('storage')}` : site.session > 0 ? ` · ${t('{count} session', { count: site.session })}` : ''))
        })) : null,
    hasSession ? h('div', { className: 'bt-import-opt-row' },
      h('span', { className: 'bt-import-opt-label' }, t('Keep session logins after app restart')),
      h('button', {
        type: 'button', role: 'switch', className: 'bt-switch',
        'aria-checked': persistSession,
        'aria-label': t('Keep session logins after app restart'),
        onClick: () => setPersistSession((value) => !value),
      }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true }))) : null,
    preview.skipped.length || preview.warnings.length ? h('div', { className: 'bt-import-meta-group' },
      preview.skipped.length ? h('details', { className: 'bt-import-disclosure' },
        h('summary', null,
          h('span', { className: 'bt-import-disc-chev', 'aria-hidden': true }, h(ChevronRightIcon)),
          h('span', null, t('{count} skipped', { count: preview.skipped.length }))),
        h('div', { className: 'bt-import-disc-body' },
          preview.skipped.slice(0, 5).map((item, index) => h('div', { key: index, className: 'bt-import-detail-line' },
            h('span', { className: 'bt-import-detail-name' }, item.name ?? item.where),
            h('span', { className: 'bt-import-line-reason' }, item.reason))),
          preview.skipped.length > 5 ? h('div', { className: 'bt-import-detail-line' },
            h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: preview.skipped.length - 5 }))) : null)) : null,
      preview.warnings.length ? h('details', { className: 'bt-import-disclosure' },
        h('summary', null,
          h('span', { className: 'bt-import-disc-chev', 'aria-hidden': true }, h(ChevronRightIcon)),
          h('span', null, t('{count} adjusted', { count: preview.warnings.reduce((n, w) => n + w.count, 0) }))),
        h('div', { className: 'bt-import-disc-body' },
          preview.warnings.map((w, index) => h('div', { key: index, className: 'bt-import-detail-line' },
            h('span', { className: 'bt-import-line-reason' }, `${w.count} × ${w.message}`))))) : null) : null,
    preview.notes.includes('local-storage-left') ? h('div', { className: 'bt-import-callout' },
      h(InfoIcon),
      h('span', null, t('Some sites also keep sign-in outside cookies; you may need to sign in again there.'))) : null,
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-import-primary', disabled: busy || !canApply || (selectedCookies === 0 && selectedStorage === 0), onClick: submit }, busy ? t('Importing…') : t('Import'))))
}

// The card that runs an import: connecting / safari-permission / remote-debug / running / paste → preview → result | error.
export function ImportCard({ flow, page = { url: '' }, busy, canApply = true, imports, inline = false, onApply, onCancel, onBack, onCloseAndImport, onRetrySource, onLaunchSource, onOpenPermission, onPermissionGranted, onFile, onSubmitPaste, onDone, onReload }) {
  const { stage } = flow
  useEscape(() => {
    if (stage === 'result') onDone()
    else if (!busy || stage === 'connecting' || stage === 'running') onCancel()
  })
  if (stage === 'connecting') {
    return h('div', { className: 'bt-import-stage bt-import-status' },
      h('div', { className: 'bt-import-status-orbit', 'aria-hidden': true },
        h('span', { className: 'bt-import-orbit-ring bt-loading-spin' }),
        h(BrowserMark, { source: flow.source, size: 30 })),
      h('div', { className: 'bt-import-title' }, t('Reading {name}…', { name: flow.source.name })),
      h('div', { className: 'bt-import-sub' }, flow.source.label),
      h('div', { className: 'bt-import-text' }, t('If {name} or your system asks for permission, click Allow.', { name: flow.source.name })),
      h('div', { className: 'bt-import-actions' },
        h('button', { type: 'button', className: 'bt-import-plain', onClick: onCancel }, t('Cancel'))))
  }
  if (stage === 'safari-permission') {
    return h(SafariPermissionCard, { flow, busy, imports, inline, onOpenPermission, onPermissionGranted, onRetrySource, onBack, onCancel })
  }
  if (stage === 'remote-debug') {
    return h(RemoteDebugCard, { flow, busy, imports, inline, onRetrySource, onLaunchSource, onFile, onBack, onCancel })
  }
  if (stage === 'paste') {
    return h(PasteCard, { flow, busy, inline, onSubmitPaste, onBack, onCancel })
  }
  if (stage === 'running') {
    return h('div', { className: 'bt-import-stage' },
      h(ImportHeader, { title: t('{name} is running', { name: flow.source.name }), mark: h(BrowserMark, { source: flow.source, size: 22 }), onBack, onClose: inline ? null : onCancel, busy }),
      h('div', { className: 'bt-import-text' }, t('It must close for a moment so its cookies can be copied. It will reopen with your tabs.')),
      h('div', { className: 'bt-import-actions' },
        h('button', { type: 'button', className: 'bt-import-plain', onClick: onCancel }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onCloseAndImport }, busy ? t('Closing…') : t('Close {name} and import', { name: flow.source.name }))))
  }
  if (stage === 'error') {
    return h('div', { className: 'bt-import-stage bt-import-status' },
      h('div', { className: 'bt-import-status-badge bt-import-status-err', 'aria-hidden': true }, h(CloseIcon)),
      h('div', { className: 'bt-import-title' }, t('Import failed')),
      h('div', { className: 'bt-import-text' }, flow.message),
      h('div', { className: 'bt-import-actions' },
        !inline && onBack ? h('button', { type: 'button', className: 'bt-import-plain', onClick: onBack }, t('Back')) : null,
        h('button', { type: 'button', className: 'bt-import-primary', onClick: onCancel }, inline ? t('Back') : t('Close'))))
  }
  if (stage === 'result') {
    const { report } = flow
    const problems = [...(report.dropped ?? []), ...(report.failed ?? [])]
    const ok = (report.stored ?? 0) > 0 || (report.originsStored ?? 0) > 0
    const title = report.stored > 0
      ? t('Imported {count} cookies', { count: report.stored })
      : (report.originsStored ?? 0) > 0
        ? t('Imported storage for {count} sites', { count: report.originsStored })
        : t('No cookies were stored')
    const subtitle = [
      flow.label,
      (flow.botCount ?? 1) > 1 ? t('{count} Bots', { count: flow.botCount }) : null,
      (report.stored ?? 0) > 0 && (report.originsStored ?? 0) > 0 ? t('{count} sites storage', { count: report.originsStored }) : null,
      flow.reloaded ? t('page reloaded') : null,
    ].filter(Boolean).join(' · ')
    return h('div', { className: 'bt-import-stage bt-import-status' },
      h('div', { className: `bt-import-status-badge ${ok ? 'bt-import-status-ok' : 'bt-import-status-muted'}`, 'aria-hidden': true },
        h(ok ? CheckIcon : InfoIcon)),
      h('div', { className: 'bt-import-title' }, title),
      subtitle ? h('div', { className: 'bt-import-sub' }, subtitle) : null,
      problems.length ? h('div', { className: 'bt-import-problems' },
        problems.slice(0, 8).map((item, index) => h('div', { key: index, className: 'bt-import-detail-line' },
          h('span', { className: 'bt-import-detail-name' }, item.name ?? '—'),
          h('span', { className: 'bt-import-line-reason' }, item.reason))),
        problems.length > 8 ? h('div', { className: 'bt-import-detail-line' },
          h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: problems.length - 8 }))) : null) : null,
      h('div', { className: 'bt-import-actions' },
        page?.url && !flow.reloaded && onReload ? h('button', { type: 'button', className: 'bt-import-plain', onClick: onReload }, t('Reload the page')) : null,
        h('button', { type: 'button', className: 'bt-import-primary', onClick: onDone }, t('Done'))))
  }
  return h(PreviewCard, { key: flow.id, flow, page, busy, canApply, inline, onApply, onBack, onCancel })
}
