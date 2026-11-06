import { createElement as h, useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { IM_PLATFORMS } from '../shared/im-platforms.js'
import { MaskedInput } from './secret-card.js'
import { t } from './i18n.js'

// Settings → IM: one row per IM bot the user added. Marks are original — a rounded
// square with a short label in the platform's color, never a real logo. The colors
// are --bt-im-* variables, so the page follows the theme.
const SHORT = {
  telegram: 'Tg', weixin: '微', feishu: '飞', dingtalk: '钉',
  wecom: '企', qq: 'QQ', discord: 'Dc', slack: 'Sl',
}
const LINKS = {
  telegram: ['https://t.me/BotFather', 'BotFather'],
  feishu: ['https://open.feishu.cn/app', 'open.feishu.cn'],
  lark: ['https://open.larksuite.com/app', 'open.larksuite.com'],
  dingtalk: ['https://open-dev.dingtalk.com/', 'open-dev.dingtalk.com'],
  wecom: ['https://work.weixin.qq.com/', 'work.weixin.qq.com'],
  qq: ['https://q.qq.com/qqbot/', 'q.qq.com'],
  discord: ['https://discord.com/developers/applications', 'discord.com'],
  slack: ['https://api.slack.com/apps', 'api.slack.com'],
}

const Mark = ({ id }) => h('span', { className: 'bt-im-mark', style: { background: `var(--bt-im-${id}, var(--bt-hover))` } }, SHORT[id] ?? id.slice(0, 2))

const QUIET = 4
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
  return h('svg', { className: 'bt-im-qr', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': t('Pairing QR code'), shapeRendering: 'crispEdges' },
    h('rect', { width: size, height: size }),
    h('path', { d: path }))
}

// QR-login platforms (WeChat iLink): im-login-start returns the code text,
// then im-login-wait long-polls until the owner scans and confirms or the
// code expires.
function QrPanel({ actions, platform, botId, onDone }) {
  const [login, setLogin] = useState(null)
  const [status, setStatus] = useState('waiting')
  const [error, setError] = useState(null)
  useEffect(() => {
    let live = true
    let loginId
    void (async () => {
      try {
        const started = await actions.imLoginStart({ platform, botId })
        if (!live) return
        loginId = started.loginId
        setLogin(started)
        for (;;) {
          const answer = await actions.imLoginWait({ platform, botId, loginId })
          if (!live) return
          if (answer.status === 'done') { onDone(); return }
          setStatus(answer.status)
          if (answer.status === 'expired') return
        }
      } catch (failure) {
        if (live) setError(failure?.message ?? String(failure))
      }
    })()
    return () => { live = false }
  }, [])
  return h('div', { className: 'bt-im-qr-panel' },
    login === null && error === null ? h('p', { className: 'bt-mid' }, t('Connecting…')) : null,
    login !== null && status !== 'expired' ? h(QrCode, { text: login.qr }) : null,
    login !== null && status === 'scanned' ? h('p', { className: 'bt-mid' }, t('Scanned — confirm on the phone')) : null,
    status === 'expired' ? h('p', { className: 'bt-mid' }, t('Code expired')) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-connector-form-row' },
      status === 'expired' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Done')) : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Cancel'))))
}

function statusText(status) {
  if (status === undefined) return t('Not connected')
  if (status.state === 'connecting') return t('Connecting…')
  if (status.state === 'error') return t('Could not connect: {error}', { error: status.error ?? '' })
  if (status.state === 'ready') return t('Connected')
  return t('Not connected')
}

function TargetPicker({ value, roster, onChange, label }) {
  return h('select', { className: 'bt-select', 'aria-label': label ?? t('Bound to'), value: value ?? '', onChange: event => onChange(event.target.value || null) },
    h('option', { value: '' }, t('Not bound')),
    roster.bots.map(bot => h('option', { key: bot.id, value: `b:${bot.id}` }, bot.name)),
    roster.rooms.map(room => h('option', { key: room.id, value: `r:${room.id}` }, `${room.name}`)))
}
const targetValue = chat => (chat.target?.roomId !== undefined ? `r:${chat.target.roomId}` : chat.target?.botId !== undefined ? `b:${chat.target.botId}` : '')

function ConnectionRow({ conn, status, roster, actions }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState(null)
  const platform = IM_PLATFORMS.find(entry => entry.id === conn.platform) ?? { name: conn.platform, fields: [] }
  const run = (task) => {
    setBusy(true)
    setError(null)
    return Promise.resolve(task)
      .catch(failure => setError(failure?.message ?? String(failure)))
      .finally(() => setBusy(false))
  }
  const setBot = (value) => {
    if (value === null || !value.startsWith('b:')) return
    void run(actions.imUpdate(conn.id, { botId: value.slice(2) }))
  }
  const removeChat = chatKey => () => void run(actions.imChat(conn.id, { chatKey, remove: true }))
  const setChatTarget = (chatKey, value) => {
    const target = value === null ? null : value.startsWith('b:') ? { botId: value.slice(2) } : { roomId: value.slice(2) }
    void run(actions.imChat(conn.id, { chatKey, target }))
  }
  const chats = Object.entries(conn.chats ?? {})
  return h('div', { className: 'bt-connector', 'data-state': status?.state ?? 'off' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(Mark, { id: conn.platform })),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, conn.account?.name ?? platform.name),
        h('span', { className: 'bt-connector-status' }, conn.enabled ? `${platform.name} · ${statusText(status)}` : `${platform.name} · ${t('Disabled')}`)),
      h('span', { className: 'bt-connector-actions' },
        status?.state === 'error' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.imRetry(conn.id)) }, t('Try again')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setOpen(value => !value) }, open ? t('Collapse') : t('Manage')))),
    open ? h('div', { className: 'bt-connector-form' },
      h('div', { className: 'bt-im-line' },
        h('span', { className: 'bt-im-label' }, t('Talks to')),
        h('select', { className: 'bt-select', 'aria-label': t('Talks to'), value: conn.botId ?? '', onChange: event => setBot(`b:${event.target.value}`) },
          roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.imUpdate(conn.id, { enabled: !conn.enabled })) }, conn.enabled ? t('Disable') : t('Enable')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => {
          if (!confirmRemove) { setConfirmRemove(true); return }
          void run(actions.imRemove(conn.id))
        } }, confirmRemove ? t('Remove?') : t('Remove'))),
      conn.requests.length > 0 ? h('div', { className: 'bt-im-block' },
        h('div', { className: 'bt-im-label' }, t('Wants to connect')),
        conn.requests.map(request => h('div', { key: request.id, className: 'bt-im-line' },
          h('span', { className: 'bt-im-name' }, request.name),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.imPair(conn.id, request.id, true)) }, t('Allow')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.imPair(conn.id, request.id, false)) }, t('Deny'))))) : null,
      conn.paired.length > 0 ? h('div', { className: 'bt-im-block' },
        h('div', { className: 'bt-im-label' }, t('Connected accounts')),
        conn.paired.map(entry => h('div', { key: entry.id, className: 'bt-im-line' },
          h('span', { className: 'bt-im-name' }, entry.name),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.imUnpair(conn.id, entry.id)) }, t('Remove'))))) : null,
      chats.length > 0 ? h('div', { className: 'bt-im-block' },
        h('div', { className: 'bt-im-label' }, t('Chats')),
        chats.map(([chatKey, chat]) => h('div', { key: chatKey, className: 'bt-im-line' },
          h('span', { className: 'bt-im-name' }, chat.title ?? chatKey),
          chat.kind === 'group'
            ? h(TargetPicker, { roster, value: targetValue(chat), label: t('Bound to'), onChange: value => setChatTarget(chatKey, value) })
            : h('span', { className: 'bt-im-label' }, t('Direct')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: removeChat(chatKey) }, t('Remove'))))) : null) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

function AddForm({ roster, actions, onDone }) {
  const platforms = (roster.im?.platforms ?? []).map(id => IM_PLATFORMS.find(entry => entry.id === id)).filter(Boolean)
  const [platform, setPlatform] = useState(platforms[0]?.id ?? '')
  const [fields, setFields] = useState({})
  const [botId, setBotId] = useState(roster.bots[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const shown = IM_PLATFORMS.find(entry => entry.id === platform)
  const link = platform === 'feishu' && fields.domain === 'lark' ? LINKS.lark : LINKS[platform]
  const add = () => {
    if (busy || botId === '') return
    setBusy(true)
    setError(null)
    void Promise.resolve(actions.imAdd({ platform, botId, fields }))
      .then(() => { setFields({}); onDone() })
      .catch(failure => setError(failure?.message ?? String(failure)))
      .finally(() => setBusy(false))
  }
  if (platforms.length === 0) return null
  return h('div', { className: 'bt-connector-form' },
    h('div', { className: 'bt-im-line' },
      h('select', { className: 'bt-select', 'aria-label': t('Platform'), value: platform, onChange: event => { setPlatform(event.target.value); setFields({}) } },
        platforms.map(entry => h('option', { key: entry.id, value: entry.id }, entry.name))),
      h('select', { className: 'bt-select', 'aria-label': t('Talks to'), value: botId, onChange: event => setBotId(event.target.value) },
        roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
    shown?.login === 'qr'
      ? h(QrPanel, { key: `${platform}:${botId}`, actions, platform, botId, onDone })
      : (shown?.fields ?? []).map(field => field.options !== undefined
      ? h('div', { key: field.key, className: 'bt-im-line' },
        h('span', { className: 'bt-im-label' }, field.label),
        h('select', { className: 'bt-select', 'aria-label': field.label, value: fields[field.key] ?? field.options[0][0], onChange: event => setFields(current => ({ ...current, [field.key]: event.target.value })) },
          field.options.map(([id, label]) => h('option', { key: id, value: id }, label))))
      : h('label', { key: field.key, className: 'bt-q-field bt-secret-field' },
        field.secret
          ? h(MaskedInput, { value: fields[field.key] ?? '', onChange: value => setFields(current => ({ ...current, [field.key]: value })), onEnter: add, label: field.hint ? `${field.label} (${field.hint}…)` : field.label })
          : h('input', { className: 'bt-input', 'aria-label': field.label, placeholder: field.label, value: fields[field.key] ?? '', onChange: event => setFields(current => ({ ...current, [field.key]: event.target.value })) }))),
    shown?.login === 'qr' ? null : h('div', { className: 'bt-connector-form-row' },
      link ? h('a', { className: 'bt-connector-link', href: link[0], target: '_blank', rel: 'noopener noreferrer' }, link[1]) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: add }, busy ? t('Connecting…') : t('Connect'))),
    shown?.login === 'qr' ? null : error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

export function ImPage({ roster, actions }) {
  const [adding, setAdding] = useState(false)
  const list = roster.im?.connections ?? []
  const statuses = roster.imStatus ?? {}
  const pending = list.reduce((count, conn) => count + (conn.requests?.length ?? 0), 0)
  return [
    h('div', { key: 'new', className: 'bt-actions' },
      adding ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setAdding(true) }, t('Add IM bot'))),
    adding ? h('section', { key: 'add', className: 'bt-set-section' }, h('div', { className: 'bt-set-card bt-connectors-card' }, h(AddForm, { roster, actions, onDone: () => setAdding(false) }))) : null,
    h('section', { key: 'list', className: 'bt-set-section' },
      h('h3', null, pending > 0 ? t('IM · {count} requests', { count: pending }) : t('IM bots')),
      h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
        ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No IM bots')))
        : list.map(conn => h(ConnectionRow, { key: conn.id, conn, status: statuses[conn.id], roster, actions })))),
  ]
}

export const IM_CSS = `
.bt-im-mark{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;color:var(--bt-im-mark-ink);font-size:11px;font-weight:700;letter-spacing:.02em}
.bt-im-line{display:flex;align-items:center;gap:8px;min-height:32px;flex-wrap:wrap}
.bt-im-line+.bt-im-line{margin-top:6px}
.bt-im-label{font-size:12px;color:var(--bt-ink-3);white-space:nowrap}
.bt-im-name{min-width:0;font-size:13px;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-im-block{margin-top:12px;display:flex;flex-direction:column;gap:2px}
.bt-im-block>.bt-im-label{margin-bottom:4px}
`
