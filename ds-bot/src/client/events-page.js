// Event-driven triggers UI: Watchers & Local Push tab, Subscriptions & Event Feed tab,
// and Bot-detail active watches summary. Mounted inside Settings → Schedules & Triggers.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { PlusIcon, TrashIcon, CopyIcon, CheckIcon } from './icons.js'
import { Switch } from './bot-settings.js'
import { dateLocale, hostText, t } from './i18n.js'

const POLL_MS = 15_000
const CONFIRM_MS = 3_500
let sharedEvents = null
const listeners = new Set()

function publishEvents(view) {
  sharedEvents = view
  for (const listener of listeners) listener(view)
}

export function parseCommandArgs(input) {
  const out = []
  let current = ''
  let quote = null
  let inToken = false
  const text = String(input ?? '')
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      // Only escape embedded quotes or doubled backslashes inside double quotes so
      // Windows paths ("D:\data\report.csv") and regexes ("\d+") keep literal backslashes.
      if (ch === '\\' && quote === '"' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[++i]
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '\\' && i + 1 < text.length && /[\s"']/.test(text[i + 1])) {
      // Preserve unquoted escaping for whitespace and quotes (e.g. /tmp/report\ data.csv)
      // while leaving ordinary backslashes literal for Windows paths and regexes.
      current += text[++i]
      inToken = true
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) {
        out.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += ch
      inToken = true
    }
  }
  if (inToken) out.push(current)
  return out
}

function useTwoStepConfirm() {
  const [confirmId, setConfirmId] = useState(null)
  const timerRef = useRef(null)
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current) }, [])
  const ask = (id, run) => {
    if (confirmId === id) {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
      setConfirmId(null)
      run()
      return
    }
    setConfirmId(id)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { timerRef.current = null; setConfirmId(null) }, CONFIRM_MS)
  }
  return [confirmId, ask]
}

export function useEventsView(actions) {
  const [view, setView] = useState(sharedEvents)
  useEffect(() => {
    listeners.add(setView)
    let stopped = false
    let timer
    const load = () => actions.eventsView?.()
      .then((next) => { if (!stopped && next) publishEvents(next) })
      .catch(() => {})
      .finally(() => { if (!stopped) timer = setTimeout(load, POLL_MS) })
    load()
    return () => { stopped = true; clearTimeout(timer); listeners.delete(setView) }
  }, [])
  return view
}

const fmtTime = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Intl.DateTimeFormat(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms)
}

const WATCHER_KINDS = [
  ['github', 'GitHub'],
  ['mail', 'Mail'],
  ['folder', 'Folder'],
  ['http', 'HTTPS / RSS'],
  ['command', 'Local command'],
]

function targetLabel(target, roster) {
  if (!target) return ''
  if (target.kind === 'room') return roster.roomsById?.[target.roomId]?.name ?? target.roomId
  const botName = roster.byId?.[target.botId]?.name ?? target.botId
  return target.kind === 'task' ? `${botName} · ${target.taskId}` : botName
}

function WatcherForm({ roster, actions, onDone, onCancel }) {
  const [kind, setKind] = useState('github')
  const [name, setName] = useState('')
  const [targetRef, setTargetRef] = useState(roster.bots[0]?.id ? `bot:${roster.bots[0].id}` : '')
  const [intervalSec, setIntervalSec] = useState(60)
  const [repo, setRepo] = useState('')
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [account, setAccount] = useState('')
  const [fromFilter, setFromFilter] = useState('')
  const [executable, setExecutable] = useState('')
  const [argsText, setArgsText] = useState('')
  const [speculative, setSpeculative] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const [tKind, tId] = targetRef.split(':')
    const target = tKind === 'room' ? { kind: 'room', roomId: tId } : { kind: 'bot', botId: tId }
    const config = kind === 'github' ? { repo }
      : kind === 'http' ? { url }
        : kind === 'folder' ? { path }
          : kind === 'mail' ? { account, fromFilter }
            : { executable, args: parseCommandArgs(argsText) }
    void actions.watcherSave({ name, kind, target, intervalSec: Number(intervalSec), speculative, config })
      .then((next) => { publishEvents(next); onDone(next) }, (failure) => { setError(hostText(failure?.message ?? String(failure))); setBusy(false) })
  }

  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Source'))),
      h('select', { className: 'bt-select bt-task-bot', value: kind, onChange: e => setKind(e.target.value) },
        WATCHER_KINDS.map(([id, label]) => h('option', { key: id, value: id }, t(label))))),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
      h('input', { className: 'bt-bs-input', value: name, maxLength: 100, placeholder: t('Repo pull requests'), autoFocus: true, onChange: e => setName(e.target.value) })),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Send to'))),
      h('select', { className: 'bt-select bt-task-bot', value: targetRef, onChange: e => setTargetRef(e.target.value) },
        h('optgroup', { label: t('Bots') }, roster.bots.map(bot => h('option', { key: bot.id, value: `bot:${bot.id}` }, bot.name))),
        roster.rooms.length > 0 ? h('optgroup', { label: t('Group chats') }, roster.rooms.map(room => h('option', { key: room.id, value: `room:${room.id}` }, room.name))) : null)),
    kind === 'github' ? h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Repository'))),
      h('input', { className: 'bt-bs-input', value: repo, placeholder: 'owner/repo', onChange: e => setRepo(e.target.value) })) : null,
    kind === 'http' ? h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('HTTPS URL'))),
      h('input', { className: 'bt-bs-input', value: url, placeholder: 'https://example.com/feed.xml', onChange: e => setUrl(e.target.value) })) : null,
    kind === 'folder' ? h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Folder path'))),
      h('input', { className: 'bt-bs-input', value: path, placeholder: '/path/to/folder', onChange: e => setPath(e.target.value) })) : null,
    kind === 'mail' ? h(Fragment, null,
      h('label', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Mail account'))),
        h('input', { className: 'bt-bs-input', value: account, placeholder: t('Optional (uses connected account)'), onChange: e => setAccount(e.target.value) })),
      h('label', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('From filter'))),
        h('input', { className: 'bt-bs-input', value: fromFilter, placeholder: t('Optional sender filter'), onChange: e => setFromFilter(e.target.value) }))) : null,
    kind === 'command' ? h(Fragment, null,
      h('label', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Executable'))),
        h('input', { className: 'bt-bs-input', value: executable, placeholder: '/usr/bin/env', onChange: e => setExecutable(e.target.value) })),
      h('label', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Arguments'))),
        h('input', { className: 'bt-bs-input', value: argsText, placeholder: t('Space-separated arguments'), onChange: e => setArgsText(e.target.value) }))) : null,
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Check interval (seconds)'))),
      h('input', { className: 'bt-input bt-set-number', type: 'number', min: 15, max: 86400, value: intervalSec, onChange: e => setIntervalSec(e.target.value) })),
    h('div', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, t('Speculative read-only check')),
        h('span', { className: 'bt-set-hint' }, t('Inspect changes in read-only mode and report only when actionable.'))),
      h(Switch, { on: speculative, onChange: setSpeculative, label: t('Speculative read-only check') })),
    error ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-danger bt-set-hint' }, error)) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy || name.trim() === '' }, busy ? t('Saving…') : t('Add watcher'))))
}

function SubscriptionForm({ roster, watchers, actions, onDone, onCancel }) {
  const [name, setName] = useState('')
  const [targetRef, setTargetRef] = useState(roster.bots[0]?.id ? `bot:${roster.bots[0].id}` : '')
  const [sourceId, setSourceId] = useState('')
  const [threadKey, setThreadKey] = useState('')
  const [keywords, setKeywords] = useState('')
  const [mode, setMode] = useState('drive')
  const [mandate, setMandate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const [tKind, tId] = targetRef.split(':')
    const target = tKind === 'room' ? { kind: 'room', roomId: tId } : { kind: 'bot', botId: tId }
    const kwList = keywords.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    void actions.subscriptionSave({
      name: name.trim() || threadKey.trim() || t('Subscription'),
      target,
      mode,
      match: {
        ...(sourceId ? { sourceId } : {}),
        ...(threadKey.trim() ? { threadKey: threadKey.trim() } : {}),
        ...(kwList.length > 0 ? { keywords: kwList } : {}),
      },
      mandate: { scope: mandate.trim() },
    }).then((next) => { publishEvents(next); onDone(next) }, (failure) => { setError(hostText(failure?.message ?? String(failure))); setBusy(false) })
  }

  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: submit },
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
      h('input', { className: 'bt-bs-input', value: name, maxLength: 100, placeholder: t('Watch PR reviews'), autoFocus: true, onChange: e => setName(e.target.value) })),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Deliver to'))),
      h('select', { className: 'bt-select bt-task-bot', value: targetRef, onChange: e => setTargetRef(e.target.value) },
        h('optgroup', { label: t('Bots') }, roster.bots.map(bot => h('option', { key: bot.id, value: `bot:${bot.id}` }, bot.name))),
        roster.rooms.length > 0 ? h('optgroup', { label: t('Group chats') }, roster.rooms.map(room => h('option', { key: room.id, value: `room:${room.id}` }, room.name))) : null)),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Watcher'))),
      h('select', { className: 'bt-select bt-task-bot', value: sourceId, onChange: e => setSourceId(e.target.value) },
        h('option', { value: '' }, t('Any source')),
        watchers.map(w => h('option', { key: w.id, value: w.id }, `${w.name} (${w.kind})`)))),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Thread key'))),
      h('input', { className: 'bt-bs-input', value: threadKey, placeholder: 'github:owner/repo#42 or internal:group_task:*', onChange: e => setThreadKey(e.target.value) })),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Keywords'))),
      h('input', { className: 'bt-bs-input', value: keywords, placeholder: t('Comma-separated (optional)'), onChange: e => setKeywords(e.target.value) })),
    h('label', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Mode'))),
      h('select', { className: 'bt-select bt-task-bot', value: mode, onChange: e => setMode(e.target.value) },
        h('option', { value: 'drive' }, t('Wake target')),
        h('option', { value: 'context' }, t('Context only')))),
    h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Mandate'))),
      h('textarea', { className: 'bt-bs-input bt-bs-area', rows: 2, value: mandate, placeholder: t('Scope boundary for acting on matching events.'), onChange: e => setMandate(e.target.value) })),
    error ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-danger bt-set-hint' }, error)) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy }, busy ? t('Saving…') : t('Add subscription'))))
}

export function WatchersTab({ roster, actions }) {
  const view = useEventsView(actions)
  const [adding, setAdding] = useState(false)
  const [checkingId, setCheckingId] = useState(null)
  const [tokenName, setTokenName] = useState('')
  const [freshToken, setFreshToken] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmId, askConfirm] = useTwoStepConfirm()
  const copyTimerRef = useRef(null)
  useEffect(() => () => { if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current) }, [])

  if (view === null) return h('div', { className: 'bt-set-hint' }, t('Loading…'))
  const readOnly = Boolean(roster.readOnly)
  const watchers = view.watchers ?? []
  const push = view.push ?? { enabled: false, port: 17830, listening: false, url: 'http://127.0.0.1:17830/v1/events', tokens: [] }

  const togglePush = (next) => {
    if (readOnly) return
    setBusy(true)
    void actions.eventPushConfig({ enabled: next })
      .then(publishEvents, error => actions.reportError?.(error, 'events'))
      .finally(() => setBusy(false))
  }
  const createToken = (event) => {
    event.preventDefault()
    if (readOnly || !tokenName.trim()) return
    setBusy(true)
    void actions.eventPushTokenCreate({ name: tokenName.trim() })
      .then((res) => {
        if (res?.view) publishEvents(res.view)
        if (res?.created?.token) { setFreshToken(res.created.token); setTokenName('') }
      }, error => actions.reportError?.(error, 'events'))
      .finally(() => setBusy(false))
  }
  const copyToken = () => {
    if (!freshToken || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(freshToken).then(() => {
      setCopied(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => { copyTimerRef.current = null; setCopied(false) }, 1800)
    }).catch(() => {})
  }

  return h(Fragment, null,
    adding && !readOnly ? h(WatcherForm, { roster, actions, onDone: () => setAdding(false), onCancel: () => setAdding(false) }) : null,
    h('section', { className: 'bt-set-section' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Event watchers')),
        adding || readOnly ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setAdding(true) }, h(PlusIcon), t('New watcher'))),
      h('div', { className: 'bt-set-card' },
        watchers.length === 0
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No event watchers yet.')))
          : watchers.map((w) => {
              const pausedReason = w.runtime?.pausedReason
              const statusText = w.enabled
                ? (w.runtime?.lastCheckedAt ? t('Checked {time}', { time: fmtTime(w.runtime.lastCheckedAt) }) : t('Running'))
                : (pausedReason || t('Paused'))
              const confirmingDelete = confirmId === `w:${w.id}`
              return h('div', { key: w.id, className: 'bt-set-row bt-ev-row', 'data-paused': !w.enabled || undefined },
                h('div', { className: 'bt-set-copy' },
                  h('span', { className: 'bt-ev-title' },
                    w.name,
                    h('span', { className: 'bt-tag' }, w.kind)),
                  h('span', { className: 'bt-set-hint' }, `${targetLabel(w.target, roster)} · ${t('Every {count}s', { count: w.intervalSec })} · ${statusText}`)),
                h('div', { className: 'bt-ev-actions' },
                  h('button', {
                    type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || checkingId === w.id,
                    onClick: () => {
                      setCheckingId(w.id)
                      void actions.watcherCheckNow(w.id).then(res => { if (res?.view) publishEvents(res.view) }, err => actions.reportError?.(err, 'events')).finally(() => setCheckingId(null))
                    },
                  }, checkingId === w.id ? t('Checking…') : t('Check now')),
                  h('button', {
                    type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly,
                    onClick: () => void actions.watcherToggle(w.id, !w.enabled).then(publishEvents, err => actions.reportError?.(err, 'events')),
                  }, w.enabled ? t('Pause') : t('Resume')),
                  h('button', {
                    type: 'button', className: 'bt-mini bt-task-remove', 'data-confirm': confirmingDelete || undefined,
                    disabled: readOnly, 'aria-label': confirmingDelete ? t('Remove?') : t('Delete watcher'),
                    onClick: () => askConfirm(`w:${w.id}`, () => void actions.watcherDelete(w.id).then(publishEvents, err => actions.reportError?.(err, 'events'))),
                  }, confirmingDelete ? t('Remove?') : h(TrashIcon))))
            }))),
    h('section', { className: 'bt-set-section' },
      h('h3', null, t('Local push endpoint')),
      h('div', { className: 'bt-set-card' },
        h('div', { className: 'bt-set-row' },
          h('div', { className: 'bt-set-copy' },
            h('span', null, t('Accept local events on 127.0.0.1')),
            h('span', { className: 'bt-set-hint bt-ev-mono' }, push.listening ? `POST ${push.url}` : t('Off · binds only to 127.0.0.1 when enabled'))),
          h(Switch, { on: push.enabled, disabled: readOnly || busy, onChange: togglePush, label: t('Accept local events on 127.0.0.1') })),
        freshToken ? h('div', { className: 'bt-set-row bt-ev-token-box' },
          h('div', { className: 'bt-set-copy' },
            h('span', { className: 'bt-set-hint' }, t('Copy this token now; it will not be shown again.')),
            h('code', { className: 'bt-ev-mono' }, freshToken)),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: copyToken }, copied ? h(CheckIcon) : h(CopyIcon), copied ? t('Copied') : t('Copy'))) : null,
        h('form', { className: 'bt-set-row bt-ev-token-form', onSubmit: createToken },
          h('input', { className: 'bt-input', value: tokenName, disabled: readOnly || busy, placeholder: t('Token name (e.g. market-script)'), onChange: e => setTokenName(e.target.value) }),
          h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy || !tokenName.trim() }, t('New token'))),
        (push.tokens ?? []).filter(tk => !tk.revoked).map((tk) => {
          const confirmingRevoke = confirmId === `tk:${tk.keyId}`
          return h('div', { key: tk.keyId, className: 'bt-set-row' },
            h('div', { className: 'bt-set-copy' },
              h('span', null, tk.name),
              h('span', { className: 'bt-set-hint bt-ev-mono' }, `${tk.keyId}${tk.lastUsedAt ? ` · ${t('Used {time}', { time: fmtTime(tk.lastUsedAt) })}` : ''}`)),
            h('button', {
              type: 'button', className: 'bt-soft bt-soft-sm bt-ev-danger', 'data-confirm': confirmingRevoke || undefined,
              disabled: readOnly,
              onClick: () => askConfirm(`tk:${tk.keyId}`, () => void actions.eventPushTokenRevoke(tk.keyId).then(publishEvents, err => actions.reportError?.(err, 'events'))),
            }, confirmingRevoke ? t('Revoke?') : t('Revoke')))
        }))))
}

export function SubscriptionsTab({ roster, actions }) {
  const view = useEventsView(actions)
  const [adding, setAdding] = useState(false)
  const [confirmId, askConfirm] = useTwoStepConfirm()
  if (view === null) return h('div', { className: 'bt-set-hint' }, t('Loading…'))
  const readOnly = Boolean(roster.readOnly)
  const subs = view.subscriptions ?? []
  const events = view.events ?? []
  const deadLetters = view.deadLetters ?? []

  return h(Fragment, null,
    adding && !readOnly ? h(SubscriptionForm, { roster, watchers: view.watchers ?? [], actions, onDone: () => setAdding(false), onCancel: () => setAdding(false) }) : null,
    h('section', { className: 'bt-set-section' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Subscriptions')),
        adding || readOnly ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setAdding(true) }, h(PlusIcon), t('New subscription'))),
      h('div', { className: 'bt-set-card' },
        subs.length === 0
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No event subscriptions yet.')))
          : subs.map((s) => {
              const confirmingDelete = confirmId === `s:${s.id}`
              return h('div', { key: s.id, className: 'bt-set-row bt-ev-row', 'data-paused': !s.enabled || undefined },
                h('div', { className: 'bt-set-copy' },
                  h('span', { className: 'bt-ev-title' },
                    s.name || s.match?.threadKey || s.id,
                    h('span', { className: 'bt-tag' }, s.mode === 'context' ? t('Context only') : t('Wake'))),
                  h('span', { className: 'bt-set-hint' }, [
                    targetLabel(s.target, roster),
                    s.match?.threadKey || s.match?.sourceId || s.match?.sourceKind || '*',
                    s.filteredCount > 0 ? t('{count} filtered', { count: s.filteredCount }) : '',
                    !s.enabled && s.pausedReason ? s.pausedReason : '',
                  ].filter(Boolean).join(' · '))),
                h('div', { className: 'bt-ev-actions' },
                  h('button', {
                    type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly,
                    onClick: () => void actions.subscriptionToggle(s.id, !s.enabled).then(publishEvents, err => actions.reportError?.(err, 'events')),
                  }, s.enabled ? t('Pause') : t('Resume')),
                  h('button', {
                    type: 'button', className: 'bt-mini bt-task-remove', 'data-confirm': confirmingDelete || undefined,
                    disabled: readOnly, 'aria-label': confirmingDelete ? t('Remove?') : t('Delete subscription'),
                    onClick: () => askConfirm(`s:${s.id}`, () => void actions.subscriptionDelete(s.id).then(publishEvents, err => actions.reportError?.(err, 'events'))),
                  }, confirmingDelete ? t('Remove?') : h(TrashIcon))))
            }))),
    deadLetters.length > 0 ? h('section', { className: 'bt-set-section' },
      h('h3', null, t('Failed deliveries · {count}', { count: deadLetters.length })),
      h('div', { className: 'bt-set-card' }, deadLetters.map(d => h('div', { key: d.id, className: 'bt-set-row bt-ev-row' },
        h('div', { className: 'bt-set-copy' },
          h('span', { className: 'bt-ev-title' }, d.summary || d.eventId),
          h('span', { className: 'bt-set-hint bt-danger' }, `${targetLabel(d.target, roster)} · ${d.reason}`)),
        h('div', { className: 'bt-ev-actions' },
          h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly,
            onClick: () => void actions.eventDeadLetterReplay(d.id).then(res => { if (res?.view) publishEvents(res.view) }, err => actions.reportError?.(err, 'events')),
          }, t('Replay')),
          h('button', {
            type: 'button', className: 'bt-mini bt-task-remove', disabled: readOnly, 'aria-label': t('Dismiss'),
            onClick: () => void actions.eventDeadLetterDismiss(d.id).then(publishEvents, err => actions.reportError?.(err, 'events')),
          }, h(TrashIcon))))))) : null,
    h('section', { className: 'bt-set-section' },
      h('h3', null, t('Recent events')),
      h('div', { className: 'bt-set-card' },
        events.length === 0
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No events recorded yet.')))
          : events.slice(0, 40).map((ev) => {
              const lastOutcome = ev.decisions?.at(-1)?.outcome ?? 'recorded'
              return h('div', { key: ev.id, className: 'bt-set-row bt-ev-row' },
                h('div', { className: 'bt-set-copy' },
                  h('span', { className: 'bt-ev-title' },
                    ev.summary || ev.eventType,
                    h('span', { className: 'bt-tag' }, ev.source?.kind ?? 'event'),
                    h('span', { className: 'bt-chip' }, lastOutcome)),
                  h('span', { className: 'bt-set-hint' }, [ev.source?.name, ev.threadKey, fmtTime(ev.time)].filter(Boolean).join(' · '))))
            }))))
}

// Bot details panel summary: reads lightweight live counts from roster.eventsSummary
// (zero background polling from the details drawer).
export function WatchSummary({ bot, roster, actions }) {
  const counts = roster?.eventsSummary?.byBot?.[bot.id]
  const watchers = counts?.watchers ?? 0
  const subscriptions = counts?.subscriptions ?? 0
  const total = watchers + subscriptions
  if (total === 0) return null
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t('Watching · {count}', { count: total })),
    h('div', { className: 'bt-task-list' },
      watchers > 0 ? h('button', {
        type: 'button', className: 'bt-task-line',
        onClick: () => actions.openSettings('schedules', 'watchers'),
      }, h('span', { className: 'bt-task-line-title' }, t('Event watchers')), h('span', { className: 'bt-task-line-when' }, String(watchers))) : null,
      subscriptions > 0 ? h('button', {
        type: 'button', className: 'bt-task-line',
        onClick: () => actions.openSettings('schedules', 'subscriptions'),
      }, h('span', { className: 'bt-task-line-title' }, t('Subscriptions')), h('span', { className: 'bt-task-line-when' }, String(subscriptions))) : null))
}

export const EVENTS_CSS = `
.bt-ev-tabs{margin-bottom:16px}
.bt-ev-row{gap:10px;align-items:center}
.bt-ev-row[data-paused]{opacity:.68}
.bt-ev-title{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:13px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-ev-actions{display:flex;align-items:center;gap:6px;flex:none}
.bt-ev-danger[data-confirm]{color:var(--bt-danger);background:var(--bt-danger-soft)}
.bt-ev-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.bt-ev-token-box{background:var(--bt-hover)}
.bt-ev-token-form{gap:8px}
.bt-ev-token-form .bt-input{flex:1;min-width:0}
`
