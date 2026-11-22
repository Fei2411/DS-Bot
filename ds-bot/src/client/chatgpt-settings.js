import { createElement as h, useEffect, useRef, useState } from 'react'
import { hostText, t } from './i18n.js'

const STATE_TEXT = {
  unsupported: 'ChatGPT sign-in requires the DS Bot desktop app and OS-backed secure storage.',
  'signed-out': 'Sign in to use your ChatGPT plan',
  'signing-in': 'Complete sign-in in your browser',
  connected: 'Connected',
  'plan-usage-off': 'Enable plan usage to load your ChatGPT models',
  'needs-sign-in': 'Your ChatGPT session expired or was revoked. Sign in again.',
  'temporarily-unavailable': 'ChatGPT is temporarily unavailable. Retry without signing out.',
}
const EMPTY_MODELS = 'No models are available for this ChatGPT account.'

// Polling is authoritative, including changes made by the desktop relay. A generation
// prevents an older status read from undoing a just-completed account operation.
export function ChatGPTSettings({ actions, apply, provider }) {
  const [status, setStatus] = useState(null)
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [notice, setNotice] = useState('')
  const live = useRef(false)
  const generation = useRef(0)
  const busy = useRef(null)
  useEffect(() => {
    live.current = true
    let disposed = false
    let timer
    const poll = async () => {
      const version = generation.current
      try {
        const next = await actions.chatgpt()
        if (!disposed && version === generation.current) { setStatus(next); setPollError('') }
      } catch {
        if (!disposed && version === generation.current) setPollError(t('Could not read the ChatGPT connection. Retry.'))
      }
      if (!disposed) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => { disposed = true; live.current = false; clearTimeout(timer); generation.current++ }
  }, [actions])
  const operate = async (kind, body) => {
    if (busy.current !== null && !(kind === 'cancel' && busy.current === 'sign-in')) return
    const version = ++generation.current
    busy.current = kind
    setPending(kind)
    setError('')
    setPollError('')
    setNotice('')
    if (kind === 'sign-in') setStatus(current => ({ ...current, state: 'signing-in' }))
    try {
      const next = await ({
        'sign-in': () => actions.chatgptSignIn(body),
        cancel: () => actions.chatgptCancel(),
        'sign-out': () => actions.chatgptSignOut(),
        models: () => actions.chatgptModels(),
        retry: () => actions.chatgpt(),
      })[kind]()
      if (live.current && version === generation.current) {
        if (kind !== 'models') setStatus(next)
        if (kind === 'models' && Array.isArray(next) && next.length === 0) setNotice(EMPTY_MODELS)
        if (kind === 'sign-out' && next.remoteRevocationConfirmed === false) setNotice('Local credentials were cleared, but remote revocation was not confirmed.')
      }
    } catch (failure) {
      if (live.current && version === generation.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      // Failed operations can still change the session; never infer sign-out from an error.
      try {
        const next = await actions.chatgpt()
        if (live.current && version === generation.current) setStatus(next)
      } catch { /* Keep the last known account and the operation's error. */ }
      try {
        if (kind !== 'retry' && kind !== 'cancel') {
          await apply(actions.providers())
          void actions.refreshModels?.()
        }
      } catch (failure) {
        if (live.current && version === generation.current) setError(hostText(failure?.message ?? String(failure)))
      } finally {
        if (live.current && version === generation.current) { busy.current = null; setPending(null) }
      }
    }
  }
  return h(ChatGPTControls, { status, pending, error: error || pollError, notice, models: provider?.models ?? [], operate })
}

export function ChatGPTControls({ status, pending = null, error = '', notice = '', models = [], operate }) {
  const state = status?.state
  const account = status?.account
  const working = pending !== null
  const button = (label, kind, body, disabled = working) => h('button', {
    key: kind, type: 'button', className: `bt-soft bt-soft-sm${kind === 'sign-out' ? ' bt-secret-danger' : ''}`,
    disabled, onClick: () => operate(kind, body),
  }, t(label))
  const controls = []
  if (!status) controls.push(button('Retry', 'retry'))
  else if (state === 'unsupported') controls.push(button('Sign in with ChatGPT', 'sign-in', undefined, true))
  else if (state === 'signing-in') controls.push(button('Cancel', 'cancel', undefined, working && pending !== 'sign-in'))
  else {
    if (state === 'signed-out' || state === 'needs-sign-in') controls.push(button('Sign in with ChatGPT', 'sign-in'))
    if (state === 'plan-usage-off') controls.push(button('Enable plan usage', 'sign-in', { consent: true }))
    if (state === 'temporarily-unavailable') controls.push(button('Retry', typeof status.planUsage === 'boolean' ? 'models' : 'sign-in'))
    if (state === 'connected') controls.push(button('Refresh models', 'models'))
    if (state !== 'signed-out') controls.push(button('Sign out', 'sign-out'))
  }
  return h('div', { className: 'bt-secret-edit-block bt-chatgpt' },
    h('div', { className: 'bt-secret-edit-label' }, t('ChatGPT plan')),
    account?.name || account?.email ? h('div', { className: 'bt-chatgpt-account' },
      account.name ? h('span', null, account.name) : null,
      account.email ? h('span', { className: 'bt-set-hint' }, account.email) : null) : null,
    h('div', { className: 'bt-set-hint', role: 'status' }, t(STATE_TEXT[state] ?? 'Checking ChatGPT connection…')),
    typeof status?.planUsage === 'boolean' && state !== 'signed-out' && state !== 'unsupported'
      ? h('div', { className: 'bt-set-hint' }, t(status.planUsage ? 'Plan usage enabled' : 'Plan usage disabled')) : null,
    state === 'connected' && models.length === 0 && notice !== EMPTY_MODELS ? h('div', { className: 'bt-set-hint' }, t(EMPTY_MODELS)) : null,
    models.length > 0 ? h('div', { className: 'bt-provider-models', 'aria-label': t('Models') },
      models.map(model => h('span', { key: model.ref ?? model.id, className: 'bt-tag', title: model.ref ?? model.id }, model.name ?? model.id))) : null,
    h('div', { className: 'bt-secret-row-actions', 'aria-busy': working || undefined }, controls),
    notice ? h('div', { className: 'bt-set-hint', role: 'status' }, t(notice)) : null,
    error ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, error) : null)
}
