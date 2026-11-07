import { createElement as h, useCallback, useEffect, useState } from 'react'
import { DevicesIcon } from './icons.js'
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

// Where another machine opens the same conversation. The Web server reports only its
// origin: the login token belongs to the URL DSH printed at startup. A loopback origin
// is not reachable from another machine, so the page shows a port forward instead of a
// link that would fail.
export function sharedSessionLink(webUrl) {
  if (typeof webUrl !== 'string' || webUrl === '') return { kind: 'none' }
  let url
  try {
    url = new URL(webUrl)
  } catch {
    return { kind: 'none' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  if (!loopback) return { kind: 'url', url: webUrl }
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return {
    kind: 'forward',
    url: webUrl,
    port,
    command: `ssh -L ${port}:127.0.0.1:${port} <user>@<this-machine>`,
  }
}

// What a row in the sidebar can say about the paired machines without repeating the
// Devices page: whether multi-device is on, and how many of the paired machines are
// online. The roster already refreshes on the normal state poll, so this needs no
// timer of its own.
export function deviceSummary(multiDevice) {
  const nodes = Array.isArray(multiDevice?.nodes) ? multiDevice.nodes : []
  const online = nodes.filter(node => node.online === true).length
  return {
    available: multiDevice?.available !== false,
    enabled: multiDevice?.enabled === true,
    total: nodes.length,
    online,
    names: nodes.map(node => `${node.name}${node.online ? ' (online)' : ' (offline)'}`).join(', '),
  }
}

function copyText(text) {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

// The always-visible entry to Settings → Devices: a strip above the account row when
// the sidebar is wide, a round button with an online count on the rail. When another
// machine can open the same conversation, the wide strip also copies that address.
export function DevicesStrip({ multiDevice, actions, wide = true }) {
  const summary = deviceSummary(multiDevice)
  if (!summary.available || !summary.enabled) return null
  const open = () => actions?.openSettings?.('devices')
  const link = sharedSessionLink(multiDevice?.hub?.webUrl)
  const label = summary.total === 0
    ? t('Devices · no machines paired')
    : t('Devices · {online} of {total} online', { online: summary.online, total: summary.total })
  if (!wide) {
    return h('button', {
      type: 'button',
      className: 'bt-round bt-dev-strip-rail',
      'aria-label': label,
      title: summary.names === '' ? label : `${label}\n${summary.names}`,
      onClick: open,
    },
    h(DevicesIcon),
    summary.online > 0 ? h('span', { className: 'bt-dev-strip-count', 'aria-hidden': true }, String(summary.online)) : null)
  }
  const strip = h('button', {
    type: 'button',
    className: 'bt-dev-strip',
    'data-online': summary.online > 0 || undefined,
    'aria-label': label,
    title: summary.names === '' ? label : `${label}\n${summary.names}`,
    onClick: open,
  },
  h('span', { className: 'bt-dev-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-dev-strip-text' }, label))
  if (link.kind !== 'url') return strip
  return h('div', { className: 'bt-dev-strip-row' },
    strip,
    h('button', {
      type: 'button',
      className: 'bt-round bt-dev-strip-copy',
      'aria-label': t('Copy session link'),
      title: t('Copy session link'),
      onClick: () => copyText(link.url),
    }, h(LinkIcon)))
}

function LinkIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
    h('path', { d: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1' }))
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
      hub.webUrl === undefined ? h(Row, {
        label: t('Shared chat'),
        hint: t('This DSH does not report a Web address. Start DSH Web on this computer, then reopen this page.'),
      }) : h(Row, {
        label: t('Shared chat'),
        hint: sharedSessionLink(hub.webUrl).kind === 'forward'
          ? t('This DSH Web listens on 127.0.0.1 only. On the other machine, forward the port first, then open this address.')
          : t('Other machines open this address in a browser to see the same conversation.'),
      }, h('div', { className: 'bt-dev-url' },
        h('code', null, hub.webUrl),
        h(CopyButton, { text: hub.webUrl, label: 'Copy address' })),
      sharedSessionLink(hub.webUrl).kind === 'forward' ? h('div', { className: 'bt-dev-command' },
        h('code', null, sharedSessionLink(hub.webUrl).command),
        h(CopyButton, { text: sharedSessionLink(hub.webUrl).command, label: 'Copy command' })) : null),
      hub.webUrl === undefined ? null : h(Row, {
        label: t('The login link DSH printed when it started is the credential; this address only opens the page.'),
      })) : null,

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
.bt-dev-strip{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;margin:0 0 4px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.bt-dev-strip:hover{background:var(--bt-hover)}
.bt-dev-strip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-dev-strip[data-online] .bt-dev-dot{background:var(--bt-green)}
.bt-dev-strip-rail{position:relative}
.bt-dev-strip-count{position:absolute;top:2px;right:2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--bt-green);color:var(--bt-main);font-size:9px;line-height:14px;text-align:center}
.bt-dev-strip-row{display:flex;align-items:center;gap:2px;margin:0 4px 4px 0}
.bt-dev-strip-row .bt-dev-strip{margin:0;flex:1;min-width:0}
.bt-dev-strip-copy{flex:none;width:26px;height:26px}
.bt-dev-strip-copy:hover{background:var(--bt-hover)}
`
