// DeepSeek account sign-in bridge for the desktop window's own interface.
// Uses only the host's public `engine-account-*` endpoints and exposes the exact
// `signInEntry` / `canSignIn` / `accountT` contract shared views (`AccountLauncher`,
// `FailureCell`, `ModelChoiceDock`, `DeepSeekSignIn`) expect.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hostText, language, t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon } from '../../../ds-bot/src/client/icons.js'
import { ESCAPE_PRIORITY, useEscape, useModalFocusTrap } from '../../../ds-bot/src/client/overlay-hooks.js'
import { createSource } from '../../../ds-bot/src/client/sources.js'

const SAFE_EXTERNAL_URL = /^https?:\/\//i
const safeExternalUrl = value => (typeof value === 'string' && SAFE_EXTERNAL_URL.test(value.trim()) ? value.trim() : null)
const SIGNIN_POLL_MS = 2000
const IN_FLIGHT_PHASES = new Set(['initializing', 'waiting-browser', 'exchanging', 'committing'])

const ACCOUNT_COPY = {
  signOut: () => t('Sign out'),
  signOutDescription: () => t('Sign out of your DeepSeek account?'),
  signOutRunningDescription: () => t('Some Bots are still working. Signing out will stop them.'),
  signOutUnknownDescription: () => t('Signing out may stop running work.'),
}

function accountPayload() {
  return {
    locale: language(),
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function loopbackOrigin() {
  if (typeof window === 'undefined' || typeof window.location?.origin !== 'string') return undefined
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(window.location.origin)
    ? window.location.origin
    : undefined
}

function DesktopDeepSeekSignInModal({ useAccount, refresh, startSignIn, cancelSignIn, complete, useApiKey }) {
  const state = useAccount(value => value)
  const view = state?.view ?? null
  const attempt = view?.attempt ?? null
  const signedIn = view?.status === 'credential-stored'
  const signingIn = Boolean(attempt && IN_FLIGHT_PHASES.has(attempt.phase))
  const authorizeUrl = safeExternalUrl(attempt?.authorizeUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEscape(complete, true, { priority: ESCAPE_PRIORITY.DIALOG })
  useModalFocusTrap(dialogRef, true, { initialFocusRef: closeRef })

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  useEffect(() => {
    if (!signedIn) return
    complete()
  }, [signedIn, complete])

  useEffect(() => {
    if (!signingIn) return undefined
    const timer = setInterval(() => {
      void refresh().catch(() => {})
    }, SIGNIN_POLL_MS)
    return () => clearInterval(timer)
  }, [signingIn, refresh])

  const begin = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const next = await startSignIn()
      const url = safeExternalUrl(next?.view?.attempt?.authorizeUrl)
      if (url && typeof window !== 'undefined') window.open?.(url, '_blank', 'noopener,noreferrer')
    } catch (failure) {
      if (mountedRef.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [busy, startSignIn])

  const cancel = useCallback(async () => {
    const attemptId = attempt?.id
    if (busy || !attemptId) { complete(); return }
    setBusy(true)
    setError('')
    try {
      await cancelSignIn(attemptId)
    } catch (failure) {
      if (mountedRef.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [attempt?.id, busy, cancelSignIn, complete])

  const failureMessage = error || (attempt?.phase === 'failed' && attempt?.error ? hostText(String(attempt.error)) : '')
  const body = h('div', {
    className: 'dsb-signin-mask',
    onMouseDown: (event) => { if (event.target === event.currentTarget) complete() },
  },
  h('section', {
    ref: dialogRef,
    tabIndex: -1,
    className: 'dsb-signin-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('Sign in to DeepSeek'),
  },
  h('div', { className: 'dsb-signin-head' },
    h('h2', { className: 'dsb-signin-title' }, t('Sign in to DeepSeek')),
    h('button', {
      ref: closeRef,
      type: 'button',
      className: 'bt-icon-btn',
      'aria-label': t('Close'),
      title: t('Close'),
      onClick: complete,
    }, h(CloseIcon))),
  h('div', { className: 'dsb-signin-body' },
    signingIn
      ? h('p', { className: 'dsb-signin-note', role: 'status' }, t('Complete sign-in in your browser'))
      : null,
    failureMessage
      ? h('p', { className: 'bt-error', role: 'alert' }, failureMessage)
      : null),
  h('div', { className: 'dsb-signin-foot' },
    typeof useApiKey === 'function'
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: useApiKey }, t('Enter a DeepSeek API key'))
      : null,
    h('div', { className: 'dsb-signin-actions' },
      signingIn
        ? [
            authorizeUrl ? h('a', { key: 'open', className: 'bt-soft bt-soft-sm dsb-engine-link', href: authorizeUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open sign-in')) : null,
            h('button', { key: 'cancel', type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void cancel() } }, t('Cancel')),
          ]
        : [
            h('button', { key: 'close', type: 'button', className: 'bt-soft bt-soft-sm', onClick: complete }, t('Cancel')),
            h('button', { key: 'go', type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: () => { void begin() } }, busy ? t('Waiting for sign-in…') : (failureMessage ? t('Try again') : t('Sign in'))),
          ]))))

  const target = typeof document !== 'undefined' && document.body ? document.body : null
  return target ? createPortal(body, target) : body
}

const ACCOUNT_LISTENERS_KEY = Symbol.for('ds-bot.desktopAccountListeners')
const accountStateListeners = globalThis[ACCOUNT_LISTENERS_KEY] ?? (globalThis[ACCOUNT_LISTENERS_KEY] = new Set())

/**
 * Broadcasts a freshly fetched `engine-account-state` payload (e.g. from Settings → Account)
 * to all active desktop account bridges so the sidebar Account menu stays in sync without reload.
 */
export function publishDesktopAccountState(reply) {
  if (!reply || typeof reply !== 'object') return
  for (const listener of accountStateListeners) {
    try { listener(reply) } catch {}
  }
}

export function createDesktopAccountBridge({ call, after, work, refreshModels }) {
  const account = createSource({ available: null, view: null })
  const theme = createSource({ dark: typeof document !== 'undefined' && document.body?.hasAttribute?.('data-ds-dark-theme') === true })
  let inflight = null

  const applyReply = (reply) => {
    if (!reply || typeof reply !== 'object') return account.getSnapshot()
    const next = {
      available: reply.available !== false,
      view: reply.view ?? null,
    }
    const prev = account.getSnapshot()
    if (prev.available !== next.available || JSON.stringify(prev.view) !== JSON.stringify(next.view)) {
      const becameSignedIn = prev.view?.status !== 'credential-stored' && next.view?.status === 'credential-stored'
      account.set(next)
      if (becameSignedIn) void Promise.resolve(refreshModels?.()).catch(() => {})
    }
    return next
  }

  const subscribeExternal = () => {
    accountStateListeners.add(applyReply)
    return () => { accountStateListeners.delete(applyReply) }
  }

  const refresh = () => {
    if (inflight) return inflight
    inflight = Promise.resolve(call('engine-account-state', { details: false, ...accountPayload() }))
      .then(applyReply)
      .catch(() => account.getSnapshot())
      .finally(() => { inflight = null })
    return inflight
  }

  const startSignIn = async () => {
    const origin = loopbackOrigin()
    const reply = await call('engine-account-signin', {
      ...(origin ? { callbackOrigin: origin } : {}),
      loginSource: 'desktop',
      ...accountPayload(),
    })
    applyReply(reply)
    return reply
  }

  const cancelSignIn = async (attemptId) => {
    const reply = await call('engine-account-cancel', { attemptId })
    applyReply(reply)
    return reply
  }

  const signOut = async () => {
    const reply = await after(call('engine-account-signout', accountPayload()))
    applyReply(reply)
    void Promise.resolve(refreshModels?.()).catch(() => {})
    return reply
  }

  const hasRunningAccountTasks = async () => {
    const snap = work?.getSnapshot?.() ?? {}
    if (Object.keys(snap.bots ?? {}).length > 0) return true
    if (Object.keys(snap.rooms ?? {}).length > 0) return true
    if (Object.keys(snap.agents ?? {}).length > 0) return true
    if (Object.keys(snap.turns ?? {}).length > 0) return true
    return false
  }

  // Keep one stable entry reference so `useMemo(() => entry.inject(), [entry])` in shared
  // views (`AccountLauncher`, `FailureCell`) never re-subscribes on unrelated re-renders.
  const ops = {
    hooks: { account, theme },
    refresh,
    startSignIn,
    cancelSignIn,
    signOut,
    hasRunningAccountTasks,
  }
  const entry = {
    component: DesktopDeepSeekSignInModal,
    inject: () => ops,
  }

  const accountT = () => key => (typeof ACCOUNT_COPY[key] === 'function' ? ACCOUNT_COPY[key]() : key)

  return {
    account,
    refresh,
    signInEntry: () => (account.getSnapshot().available === false ? null : entry),
    canSignIn: () => account.getSnapshot().available !== false,
    accountT,
    subscribeExternal,
  }
}
