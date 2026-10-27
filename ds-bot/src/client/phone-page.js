import { createElement as h, useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Switch } from './bot-settings.js'
import { dateLocale, t } from './i18n.js'

const OFF = { server: '', on: false, status: 'off', phones: [], pairing: null }
// The quiet zone around a QR code is part of the code: scanners need it to find the edges.
const QUIET = 4

function statusText(phone) {
  if (phone.error) return phone.error
  if (!phone.on) return t('Off. Phones cannot reach this computer.')
  if (phone.status === 'online') return t('On. Paired phones can use DS Bot here.')
  if (phone.status === 'offline') return t('Cannot reach the Server. Trying again…')
  return t('Connecting…')
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

// Settings → Phone: the DS Bot phone app reaches this computer through a Relay Server.
export function PhonePage({ roster, actions, Section, Row }) {
  const phone = roster.phone ?? OFF
  const [server, setServer] = useState(phone.server)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [, tick] = useState(0)
  useEffect(() => { setServer(phone.server) }, [phone.server])
  useEffect(() => {
    if (!phone.pairing) return undefined
    const timer = setInterval(() => tick(count => count + 1), 15_000)
    return () => clearInterval(timer)
  }, [phone.pairing])
  const run = task => {
    setBusy(true)
    setError(null)
    return task.catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const saveServer = () => {
    if (busy || server.trim() === phone.server) return
    void run(actions.phoneSet({ server }))
  }
  const online = phone.on && phone.status === 'online'
  return h('div', { className: 'bt-phone' },
    h(Section, { title: t('Connection') },
      h(Row, { label: t('Phone access'), hint: statusText(phone), className: phone.error || phone.status === 'offline' ? 'bt-phone-warn' : '' },
        h(Switch, { on: phone.on, label: t('Phone access'), disabled: busy, onChange: on => void run(actions.phoneSet({ on })) })),
      h(Row, { label: t('Server'), hint: t('The Relay Server that passes encrypted messages between your phone and this computer. It cannot read them.') }),
      h('div', { className: 'bt-set-row bt-phone-server' },
        h('input', { className: 'bt-input', value: server, placeholder: 'wss://relay.example.com/v1/link', spellCheck: false, 'aria-label': t('Server'), onChange: event => setServer(event.target.value), onKeyDown: event => { if (event.key === 'Enter') saveServer() } }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || server.trim() === phone.server, onClick: saveServer }, t('Save')))),
    error ? h('div', { className: 'bt-connector-error bt-phone-error', role: 'alert' }, error) : null,
    h(Section, { title: t('Pair a phone') }, phone.pairing
      ? h('div', { className: 'bt-phone-pair' },
        h(QrCode, { text: phone.pairing.uri }),
        h('div', { className: 'bt-phone-pair-copy' },
          h('span', null, t('Scan this code with the DS Bot app on your phone.')),
          h('span', { className: 'bt-set-hint' }, t('The code works once. It stops working in {count} min.', { count: minutesLeft(phone.pairing.expiresAt) })),
          h('div', null, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.phonePairCancel()) }, t('Cancel')))))
      : h(Row, { label: t('Show a QR code'), hint: online ? t('Your phone scans it once. After that it connects by itself.') : t('Turn on phone access first') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !online, onClick: () => void run(actions.phonePair()) }, t('Show')))),
    h(Section, { title: t('Phones') }, phone.phones.length === 0
      ? h(Row, { label: t('No phones yet') })
      : phone.phones.map(entry => h(Row, {
        key: entry.id,
        label: entry.name || t('Phone'),
        hint: entry.connected ? t('Connected') : t('Paired on {date}', { date: new Date(entry.pairedAt).toLocaleDateString(dateLocale(), { dateStyle: 'medium' }) }),
      }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.phoneRemove(entry.id)) }, t('Remove'))))))
}
