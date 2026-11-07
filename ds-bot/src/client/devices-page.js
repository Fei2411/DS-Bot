import { createElement as h, useCallback, useEffect, useState } from 'react'
import { dateLocale, t } from './i18n.js'

// Settings → Devices: the LAN multi-device switch, the hub this computer runs, the
// machines paired with it, and one-use pairing codes. The page polls while it is open
// so a worker that comes online shows up without reopening Settings.
const POLL_MS = 3000

const STATE_LABEL = { off: 'Off', starting: 'Starting…', listening: 'Listening', failed: 'Could not start' }

function timeText(value) {
  if (typeof value !== 'string' || value === '') return t('Never seen')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return h('button', {
    type: 'button',
    className: 'bt-soft bt-soft-sm',
    onClick: () => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {}) },
  }, t(copied ? 'Copied' : label))
}

export function NodeRow({ node, confirming, busy, onRemove }) {
  const details = [node.os, node.arch].filter(Boolean).join('/')
  return h('div', { className: 'bt-dev-node', 'data-online': node.online || undefined },
    h('span', { className: 'bt-dev-dot', 'aria-hidden': true }),
    h('span', { className: 'bt-dev-node-copy' },
      h('span', { className: 'bt-dev-node-name' }, node.name),
      h('span', { className: 'bt-dev-node-meta' },
        [node.hostname, details].filter(Boolean).join(' · ') || t('Unknown machine'),
        h('span', { className: 'bt-dev-sep', 'aria-hidden': true }),
        node.online
          ? t('Online')
          : [t('Offline'), h('span', { key: 'sep', className: 'bt-dev-sep', 'aria-hidden': true }), t('Last seen {time}', { time: timeText(node.lastSeen) })])),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm bt-dev-remove',
      'data-confirm': confirming || undefined,
      disabled: busy,
      onClick: onRemove,
    }, confirming ? t('Click again to remove') : t('Remove')))
}

function PairingPanel({ pairing, onClose }) {
  return h('div', { className: 'bt-dev-pairing' },
    h('div', { className: 'bt-dev-pairing-head' },
      h('span', { className: 'bt-dev-pairing-label' }, t('Pairing code')),
      h('code', { className: 'bt-dev-code' }, pairing.code)),
    h('div', { className: 'bt-dev-hint' }, t('Valid until {time}. One machine, one use.', { time: timeText(pairing.expiresAt) })),
    h('div', { className: 'bt-dev-hint' }, t('Run this in the ds-bot folder on the other machine:')),
    h('div', { className: 'bt-dev-command' },
      h('code', null, pairing.command),
      h(CopyButton, { text: pairing.command, label: 'Copy command' })),
    h('div', { className: 'bt-dev-hint' }, t('Replace other-pc with that machine\'s name. The same command works in PowerShell and in the macOS Terminal.')),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Done'))))
}

export function DevicesPage({ roster, actions, run, Section, Row, Switch }) {
  const fallback = roster.multiDevice ?? { available: true, enabled: false, hub: { state: 'off' }, nodes: [], policy: [] }
  const [status, setStatus] = useState(fallback)
  const [pairing, setPairing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState('')

  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  const refresh = useCallback(() => {
    if (typeof actions.multiDeviceStatus !== 'function') return
    void Promise.resolve(actions.multiDeviceStatus()).then(value => { if (value) setStatus(value) }, () => {})
  }, [actions])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const enabled = status.enabled === true
  const available = status.available !== false
  const hub = status.hub ?? { state: 'off' }
  const nodes = status.nodes ?? []
  const policy = status.policy ?? []

  const toggle = (on) => {
    if (busy) return
    setBusy(true)
    setPairing(null)
    void run(actions.multiDeviceSetEnabled(on))
      .then(ok => { if (ok) refresh() })
      .finally(() => setBusy(false))
  }

  const addMachine = () => {
    if (busy) return
    setBusy(true)
    void run(Promise.resolve()
      .then(() => actions.multiDevicePairCode())
      .then(value => { setPairing(value); return value }))
      .finally(() => setBusy(false))
  }

  const remove = (node) => {
    if (busy) return
    if (confirming !== node.id) { setConfirming(node.id); return }
    setConfirming('')
    setBusy(true)
    void run(Promise.resolve()
      .then(() => actions.multiDeviceRemove(node.id))
      .then(value => { if (value) setStatus(value) }))
      .finally(() => setBusy(false))
  }

  const hubUrl = typeof hub.url === 'string' && hub.url !== '' ? hub.url : undefined
  const hubHint = hub.localUrl === undefined ? undefined : t('On this computer: {url}', { url: hub.localUrl })

  return [
    h(Section, { key: 'switch', title: t('Multi-device') },
      h(Row, {
        label: t('Enable multi-device on this computer'),
        hint: t('Other machines run read-only commands directly; other commands and file writes ask you first. This computer is the hub.'),
      }, Switch === undefined ? null : h(Switch, { label: t('Enable multi-device on this computer'), on: enabled, disabled: !available || busy, onChange: toggle })),
      !available ? h(Row, { label: t('This computer is set up without multi-device (multiDevice: false).') }) : null),

    enabled ? h(Section, { key: 'hub', title: t('This computer') },
      h(Row, {
        label: t(STATE_LABEL[hub.state] ?? STATE_LABEL.failed),
        hint: hub.error ?? hubHint,
      }, hubUrl === undefined ? null : h('div', { className: 'bt-dev-url' },
        h('code', null, hubUrl),
        h(CopyButton, { text: hubUrl }))),
      hub.webUrl === undefined ? null : h(Row, {
        label: t('Shared chat'),
        hint: t('Other machines open this address in a browser to see the same conversation.'),
      }, h('div', { className: 'bt-dev-url' },
        h('code', null, hub.webUrl),
        h(CopyButton, { text: hub.webUrl })))) : null,

    enabled ? h(Section, { key: 'machines', title: t('Machines · {count}', { count: nodes.length }) },
      nodes.length === 0
        ? h(Row, { label: t('No machine is paired yet.'), hint: t('Add one to let the Bots here run commands on it.') })
        : nodes.map(node => h(NodeRow, {
          key: node.id,
          node,
          confirming: confirming === node.id,
          busy,
          onRemove: () => remove(node),
        })),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || hub.state !== 'listening', onClick: addMachine }, t('Add machine'))),
      confirming ? h('div', { className: 'bt-dev-hint' }, t('{name} must pair again before it can be used. Its running task is cancelled; stop the worker on that machine as well.', { name: nodes.find(node => node.id === confirming)?.name ?? t('The machine') })) : null,
      pairing === null ? null : h(PairingPanel, { pairing, onClose: () => setPairing(null) })) : null,

    enabled ? h(Section, { key: 'daemon', title: t('Run it all the time') },
      h(Row, {
        label: t('Keep the worker running on another machine'),
        hint: t('Pair that machine once, then run this in the ds-bot folder there. It starts at login and keeps reconnecting after a drop.'),
      }, status.daemon?.command === undefined ? null : h('div', { className: 'bt-dev-command' },
        h('code', null, status.daemon.command),
        h(CopyButton, { text: status.daemon.command, label: 'Copy command' }))),
      h(Row, { label: t('The command carries no pairing code: the device token stays in device.json on that machine.') })) : null,

    h(Section, { key: 'about', title: t('How it works') },
      h(Row, { label: t('One hub only. This computer is the hub: the Bots here decide which machine runs a command.') }),
      h(Row, { label: t('Other machines see the same conversation by opening this computer\'s DS Bot page in a browser, not by starting their own team.') }),
      h(Row, { label: t('To move the hub to another computer, turn multi-device on there and pair the machines again.') }),
      policy.length === 0 ? null : h(Row, { label: t('Machines run read-only commands directly: {commands}. Anything else asks you first.', { commands: policy.join(', ') }) })),
  ]
}

export const DEVICES_CSS = `
.bt-dev-url{display:flex;align-items:center;gap:8px;min-width:0}
.bt-dev-url code,.bt-dev-command code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-dev-node{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:.5px solid var(--bt-line)}
.bt-dev-node:last-of-type{border-bottom:0}
.bt-dev-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--bt-ink-3)}
.bt-dev-node[data-online] .bt-dev-dot{background:var(--bt-green)}
.bt-dev-node-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-dev-node-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-dev-node-meta{font-size:12px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-dev-sep{display:inline-block;width:4px}
.bt-dev-remove{flex:none}
.bt-dev-remove[data-confirm]{background:var(--bt-danger-soft);color:var(--bt-danger);border-color:var(--bt-danger-soft)}
.bt-dev-pairing{margin:10px 14px 14px;padding:12px;border-radius:10px;background:var(--bt-tag-bg);display:flex;flex-direction:column;gap:8px}
.bt-dev-pairing-head{display:flex;align-items:baseline;gap:10px}
.bt-dev-pairing-label{font-size:12px;color:var(--bt-ink-2)}
.bt-dev-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:22px;letter-spacing:2px;font-weight:600}
.bt-dev-hint{font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-dev-command{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--bt-card);border:.5px solid var(--bt-line);min-width:0}
.bt-dev-command code{flex:1}
`
