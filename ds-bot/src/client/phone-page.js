import { createElement as h, useEffect, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Switch } from './bot-settings.js'
import { dateLocale, t } from './i18n.js'
import { browserPairingUrl } from './phone-browser.js'

const OFF = { server: '', on: false, status: 'off', phones: [], pairing: null }
// The quiet zone around a QR code is part of the code: scanners need it to find the edges.
const QUIET = 4

function statusText(phone) {
  if (phone.error) return phone.error
  if (!phone.on) return t('Off')
  if (phone.status === 'online') {
    return (phone.phones ?? []).some(entry => entry.connected) ? t('Phone online') : t('Ready')
  }
  if (phone.status === 'offline') return t('Cannot reach the Server. Trying again…')
  return t('Connecting…')
}

function serverHost(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return t('Default')
  try { return new URL(raw).host || raw } catch { return raw }
}

function QrCode({ text }) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const size = count + QUIET * 2
  let path = ''
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) if (qr.isDark(y, x)) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`
  }
  return h('svg', { className: 'bt-phone-qr', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': t('Pairing QR code'), shapeRendering: 'crispEdges' },
    h('rect', { width: size, height: size }),
    h('path', { d: path }))
}

function minutesLeft(until) {
  return Math.max(0, Math.ceil((until - Date.now()) / 60_000))
}

// The phone app ships with each DS Bot release, as the release's Android APK.
const APP_DOWNLOAD = 'https://github.com/Fei2411/DS-Bot/releases/latest'

// Settings → Connect → Phone: the DS Bot phone app reaches this computer through a Relay Server.
export function PhonePage({ roster, actions, Section, Row }) {
  const phone = roster.phone ?? OFF
  const [server, setServer] = useState(phone.server)
  const [editingServer, setEditingServer] = useState(false)
  const [wantPair, setWantPair] = useState(false)
  const wantPairRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(null)
  const prevState = useRef({ on: phone.on, status: phone.status, error: phone.error })
  const [, tick] = useState(0)
  useEffect(() => { setServer(phone.server) }, [phone.server])
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  useEffect(() => {
    setCopied(false)
    clearTimeout(copyTimer.current)
    if (!phone.pairing) return undefined
    const timer = setInterval(() => tick(count => count + 1), 15_000)
    return () => clearInterval(timer)
  }, [phone.pairing])
  const run = task => {
    setBusy(true)
    setError(null)
    return Promise.resolve(task)
      .then(() => true, (failure) => { setError(failure?.message ?? String(failure)); return false })
      .finally(() => setBusy(false))
  }
  // One-click pairing: turning on phone access from the Pair button starts pairing as soon as online.
  // Only cancel pending intent on fresh transitions (not stale pre-click error/offline state);
  // clear wantPairRef synchronously so React StrictMode double-effects never invoke phonePair twice.
  useEffect(() => {
    const prev = prevState.current
    prevState.current = { on: phone.on, status: phone.status, error: phone.error }
    if (!wantPair || !wantPairRef.current) return
    if (phone.pairing) { wantPairRef.current = false; setWantPair(false); return }
    const newlyFailed = Boolean(phone.error) && phone.error !== prev.error
    const newlyOffline = phone.status === 'offline' && prev.status !== 'offline'
    const turnedOff = !phone.on && prev.on
    if (newlyFailed || newlyOffline || turnedOff) { wantPairRef.current = false; setWantPair(false); return }
    if (phone.on && phone.status === 'online') {
      wantPairRef.current = false
      setWantPair(false)
      void run(actions.phonePair())
    }
  }, [wantPair, phone.on, phone.status, phone.pairing, phone.error])

  const saveServer = () => {
    if (busy || server.trim() === phone.server) return
    void run(actions.phoneSet({ server })).then((ok) => { if (ok) setEditingServer(false) })
  }
  const startPair = () => {
    if (busy) return
    if (phone.on && phone.status === 'online') {
      void run(actions.phonePair())
      return
    }
    wantPairRef.current = true
    setWantPair(true)
    if (!phone.on) {
      void run(actions.phoneSet({ on: true })).then((ok) => { if (!ok) { wantPairRef.current = false; setWantPair(false) } })
    }
  }
  const copyBrowserLink = (url) => {
    const task = navigator.clipboard?.writeText(url)
    if (task === undefined) {
      setError(t('Clipboard is not available'))
      return
    }
    void run(task.then(() => {
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2_000)
    }))
  }
  const online = phone.on && phone.status === 'online'
  let browserUrl = null
  if (phone.pairing?.browserUri) {
    try { browserUrl = browserPairingUrl(phone.server, phone.pairing.browserUri) } catch { /* malformed server URL */ }
  }
  return h('div', { className: 'bt-phone' },
    h(Section, { title: t('Connection') },
      h(Row, { label: t('Phone access'), hint: statusText(phone), className: phone.error || phone.status === 'offline' ? 'bt-phone-warn' : '' },
        h(Switch, {
          on: phone.on,
          label: t('Phone access'),
          disabled: busy,
          onChange: (on) => {
            if (!on) { wantPairRef.current = false; setWantPair(false) }
            void run(actions.phoneSet({ on }))
          },
        })),
      h(Row, { label: t('Server'), hint: serverHost(phone.server), tour: 'phone-server' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setEditingServer(open => !open) }, editingServer ? t('Hide') : t('Edit'))),
      editingServer ? h('div', { className: 'bt-set-row bt-phone-server' },
        h('input', { className: 'bt-input', value: server, placeholder: 'wss://relay.dsbot.app/v1/link', spellCheck: false, 'aria-label': t('Server'), onChange: event => setServer(event.target.value), onKeyDown: event => { if (event.key === 'Enter') saveServer() } }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || server.trim() === phone.server, onClick: saveServer }, t('Save'))) : null),
    error ? h('div', { className: 'bt-connector-error bt-phone-error', role: 'alert' }, error) : null,
    h(Section, { title: t('Pair a phone'), tour: 'phone-pair' }, phone.pairing
      ? h('div', { className: 'bt-phone-pair' },
        h(QrCode, { text: phone.pairing.uri }),
        h('div', { className: 'bt-phone-pair-copy' },
          h('span', null, t('Scan this code with the DS Bot app on your phone.')),
          h('span', { className: 'bt-set-hint' }, t('The code works once. It stops working in {count} min.', { count: minutesLeft(phone.pairing.expiresAt) })),
          browserUrl !== null
            ? h('div', { className: 'bt-phone-pair-actions' },
              h('a', { className: 'bt-soft bt-soft-sm', href: browserUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open in a browser')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => copyBrowserLink(browserUrl) }, copied ? t('Copied') : t('Copy browser link')))
            : null,
          browserUrl !== null ? h('span', { className: 'bt-set-hint' }, t('The browser runs the page the Server sends. Only use a Server you trust.')) : null,
          h('div', null, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.phonePairCancel()) }, t('Cancel')))))
      : h(Row, { key: 'qr', label: t('Show QR code') },
        wantPair
          ? [
              h('span', { key: 'wait', className: 'bt-set-hint' }, t('Waiting for connection…')),
              h('button', { key: 'cancel', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { wantPairRef.current = false; setWantPair(false) } }, t('Cancel')),
            ]
          : h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: startPair }, online ? t('Show QR code') : t('Turn on & pair'))),
      h(Row, { key: 'app', label: t('Android beta') },
        h('a', { className: 'bt-soft bt-soft-sm', href: APP_DOWNLOAD, target: '_blank', rel: 'noopener noreferrer' }, t('Download')))),
    h(Section, { title: t('Phones') }, phone.phones.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No phones yet')))
      : phone.phones.map(entry => h(Row, {
        key: entry.id,
        label: entry.kind === 'browser' ? t('Web browser') : entry.name || t('Phone'),
        hint: entry.connected ? t('Connected') : t('Paired on {date}', { date: new Date(entry.pairedAt).toLocaleDateString(dateLocale(), { dateStyle: 'medium' }) }),
      }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.phoneRemove(entry.id)) }, t('Remove'))))))
}
