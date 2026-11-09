import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { CheckIcon } from './icons.js'
import { useDockHold } from './card-hold.js'
import { heldCardKey } from './sources.js'
import { CellEmpty } from './cell-empty.js'
import { lookOf } from './characters.js'
import { t } from './i18n.js'
import { toolArgs } from './text.js'

// -------------------------------------------------------------------------
// Computer use: the switch page, a Bot's Control card, its Computer drawer page,
// the app-access card, the handoff card's computer variant, and the bar that
// lists who holds a lease.

export const LEVELS = [
  ['off', 'Off'],
  ['view', 'View only'],
  ['background', 'Background'],
  ['foreground', 'Foreground'],
]
const levelId = bot => LEVELS.some(([id]) => id === bot?.computer?.level) ? bot.computer.level : 'background'

export function LevelPicker({ bot, actions, run, disabled }) {
  const level = levelId(bot)
  return h('select', {
    className: 'bt-select bt-level-pick', 'aria-label': t('Computer use level'), value: level, disabled,
    onChange: event => run(actions.computerSetLevel(bot.id, event.target.value)),
  }, LEVELS.map(([id, label]) => h('option', { key: id, value: id }, t(label))))
}

const PROVIDER_TEXT = {
  loading: ['Loading the provider…', 'loading'],
  ready: ['Ready', 'ready'],
  error: ['Could not load the provider', 'error'],
  missing: ['The provider package is not installed', 'error'],
  occupied: ['Another computer-use provider is running', 'error'],
  unsupported: ['Computer use is not available on this platform', 'error'],
}

// A missing provider package: what to install, and the command to copy.
function InstallRow({ install, Row }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(install.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }, () => {}) }
  return h(Row, { label: t('Install it in this DSH'), hint: t('Run {command}, then restart DSH.', { command: install.command }) },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, copied ? t('Copied') : t('Copy command')))
}

const providerWorks = provider => provider.state === 'ready' || provider.state === 'loading'

// Settings → Computer use. The switch, where the provider stands, the macOS
// permission rows, and every Bot's level.
export function ComputerPage({ roster, actions, run, Section, Row, Switch }) {
  const computer = roster.computer ?? { enabled: false }
  const [system, setSystem] = useState(null)
  const provider = computer.provider ?? { state: computer.enabled ? 'loading' : 'off' }
  const refresh = () => { if (actions.computerSystemStatus) void Promise.resolve(actions.computerSystemStatus()).then(setSystem, () => {}) }
  useEffect(() => {
    if (computer.enabled && computer.macos === true) refresh()
    return undefined
  }, [computer.enabled, computer.macos])
  const perms = system ?? {}
  const permRow = (key, label) => {
    const state = perms[key]?.state ?? perms[key]
    const granted = state === 'granted' || state === true
    return h(Row, { key, label: t(label) },
      h('span', { className: 'bt-perm-state', 'data-on': granted || undefined }, granted ? t('Allowed') : t('Not allowed')),
      granted ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(Promise.resolve(actions.computerPermission(key)).then(refresh)) }, t('Grant')))
  }
  return [
    h(Section, { key: 'switch' },
      h(Row, { label: t('Let Bots use the computer') },
        Switch === undefined ? null : h(Switch, { label: t('Let Bots use the computer'), on: computer.enabled === true, onChange: on => run(actions.computerSetEnabled(on)) }))),
    computer.enabled ? h(Section, { key: 'provider', title: t('Computer provider') },
      h(Row, { label: t(PROVIDER_TEXT[provider.state]?.[0] ?? PROVIDER_TEXT.error[0]), hint: provider.message },
        ['error', 'missing', 'occupied'].includes(provider.state) && actions.computerProviderRetry
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.computerProviderRetry()) }, t('Retry')) : null),
      provider.state === 'missing' && provider.install?.command ? h(InstallRow, { install: provider.install, Row }) : null,
      computer.macos === true ? [permRow('accessibility', 'Accessibility'), permRow('screenRecording', 'Screen Recording')] : null) : null,
    h(Section, { key: 'bots', title: t('Bots') },
      computer.enabled && !providerWorks(provider) ? h('p', { className: 'bt-set-hint' }, t('Bots get no computer tools until the provider is ready.')) : null,
      roster.bots.map(bot => h(Row, { key: bot.id, label: bot.name },
        h(LevelPicker, { bot, actions, run, disabled: !computer.enabled })))),
  ]
}

// The Bot's own card in its settings: its level and the apps the user Always allows.
export function BotComputerCard({ bot, roster, actions, run, Card, Row }) {
  const computer = roster.computer ?? { enabled: false }
  const apps = Object.entries(bot.computer?.apps ?? {})
  return h(Card, { title: t('Control') },
    !computer.enabled
      ? h(Row, { label: t('Computer use') }, h('span', { className: 'bt-muted' }, t('Off in Settings → Computer use')))
      : [
          h(Row, { key: 'level', label: t('Computer use'), hint: providerWorks(computer.provider ?? { state: 'loading' }) ? undefined : t('Bots get no computer tools until the provider is ready.') }, h(LevelPicker, { bot, actions, run })),
          apps.map(([key, app]) => h(Row, { key, label: app.name },
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.computerRevokeApp(bot.id, key)) }, t('Revoke')))),
        ])
}

// The drawer's Computer page: what the Bot does on the computer right now.
export function ComputerView({ bot, actions, hooks }) {
  const live = hooks.useComputer?.(map => map) ?? {}
  const entry = live.bots?.[bot.id] ?? { state: 'idle', steps: [] }
  const [shot, setShot] = useState(null)
  useEffect(() => {
    const id = entry.lastShot?.attachmentId
    if (id === undefined || !actions.computerShot) { setShot(null); return undefined }
    let current = true
    void Promise.resolve(actions.computerShot(id)).then(value => { if (current) setShot(value) }, () => {})
    return () => { current = false }
  }, [entry.lastShot?.attachmentId])
  const controlLabel = { idle: 'Idle', bot: 'Operating', user: 'You have the computer', waiting: 'Waiting for you' }[entry.state] ?? 'Idle'
  return h('div', { className: 'bt-cview' },
    h('div', { className: 'bt-cview-head' },
      h('span', { className: 'bt-cview-state', 'data-state': entry.state }, t(controlLabel)),
      entry.app ? h('span', { className: 'bt-cview-app' }, entry.app) : null),
    shot?.dataUrl ? h('img', { className: 'bt-cview-shot', src: shot.dataUrl, alt: t('Latest screenshot') }) : null,
    entry.waitingFor === 'user-idle'
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void actions.computerAllowForeground(bot.id) }, t('Let it continue'))
      : null,
    h('div', { className: 'bt-cview-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void actions.computerStop(bot.id) }, t('Stop')),
      entry.state !== 'user'
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void actions.computerTakeover(bot.id) }, t('Take over the computer'))
        : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void actions.computerHandback(bot.id) }, t('Hand back'))),
    entry.steps.length > 0 ? h('div', { className: 'bt-cview-steps' },
      h('div', { className: 'bt-section-title' }, t('Recent steps')),
      [...entry.steps].reverse().map((step, index) => h('div', { key: index, className: 'bt-cview-step', 'data-ok': step.ok === false ? 'no' : undefined },
        h('span', { className: 'bt-cview-step-what' }, [step.app, step.action].filter(Boolean).join(' · ')),
        step.ok === false ? h('span', { className: 'bt-cview-step-err', title: step.error }, t('failed')) : null))) : null)
}

// ---- The app-access card: "Allow {bot} to use {app}?" ----
export function PendingAppAccess({ ask, actions, inline }) {
  const [closed, setClosed] = useState(false)
  const busyRef = useRef(false)
  const titleId = useId()
  const keep = useDockHold(ask.sessionId, 'computer-app', ask.id, actions, inline)
  const answer = (choice) => {
    if (busyRef.current) return
    busyRef.current = true
    keep()
    setClosed(true)
    void Promise.resolve(actions.computerAppAnswer(ask.id, choice)).catch((error) => {
      setClosed(false)
      actions.reportError?.(error, 'computer')
    })
  }
  return h('div', {
    className: inline ? 'bt-q-inline' : 'bt-q-dock',
    style: closed ? { display: 'none' } : undefined,
    onFocusCapture: keep,
    onPointerDownCapture: keep,
  },
    h('section', { className: inline ? 'bt-q' : 'bt-q bt-q-raised', role: 'group', 'aria-labelledby': titleId },
      h('div', { className: 'bt-q-head' },
        h('div', { className: 'bt-q-text' },
          h('p', { className: 'bt-q-title', id: titleId }, t('Allow {name} to use {app}?', { name: ask.botName ?? 'a Bot', app: ask.appName })))),
      h('div', { className: 'bt-q-foot' },
        h('button', { type: 'button', className: 'bt-q-btn', onClick: () => answer('deny') }, t('Deny')),
        h('button', { type: 'button', className: 'bt-q-btn', onClick: () => answer('once') }, t('This time')),
        h('button', { type: 'button', className: 'bt-q-submit', onClick: () => answer('always') }, t('Always')))))
}

// One line per computer call: the app and the action. A screenshot result adds a
// thumbnail that opens larger on click.
const ACTION_NAMES = { click: 'Click', doubleClick: 'Double click', rightClick: 'Right click', drag: 'Drag', typeText: 'Type', pressKey: 'Key', hotkey: 'Hotkey', scroll: 'Scroll', screenshot: 'Screenshot', getScreenSize: 'Screen size', getCapabilities: 'Capabilities', listApps: 'List apps', listWindows: 'List windows', getState: 'State', getAccessibilityTree: 'Accessibility tree', launchApp: 'Launch', killApp: 'Kill', bringToFront: 'Bring to front', invokeMenu: 'Menu', setValue: 'Set value', getWindowState: 'Window state', verifyState: 'Verify state' }
const actionName = (method) => {
  const known = ACTION_NAMES[method]
  if (known !== undefined) return known
  const words = String(method ?? '').replace(/^cua_driver_native__/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim()
  return words === '' ? 'Computer' : words[0].toUpperCase() + words.slice(1)
}
export function ComputerCallRow({ sessionId, call, roster, actions, hooks }) {
  const { value: argValue } = toolArgs(call)
  const method = argValue('method') ?? String(call?.name ?? '').replace(/^cua_driver_native__/, '')
  const stepApp = hooks?.useComputer?.(map => (map.bots?.[roster.byId[sessionId]?.id]?.steps ?? []).find(step => step.callId === call?.callId)?.app)
  const selector = argValue('params')?.selector
  // getApp names its target in the selector; a step record names the app later calls act on.
  const app = stepApp ?? (method === 'getApp' && typeof selector === 'string' && selector !== '' ? selector : undefined)
  const shot = (call?.content ?? []).find(block => (block?.type === 'image' || block?.type === 'file') && block.attachment !== undefined)?.attachment
  const [url, setUrl] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const id = shot?.attachmentId
    if (id === undefined || !actions.computerShot) { setUrl(null); return undefined }
    let current = true
    void Promise.resolve(actions.computerShot(id)).then(value => { if (current) setUrl(value?.dataUrl ?? null) }, () => {})
    return () => { current = false }
  }, [shot?.attachmentId])
  return h('div', { className: 'bt-cstep' },
    h('span', { className: 'bt-cstep-label' }, app !== undefined ? `${app} · ${actionName(method)}` : actionName(method)),
    url !== null ? h('button', { type: 'button', className: open ? 'bt-cstep-shot bt-cstep-shot-open' : 'bt-cstep-shot', onClick: () => setOpen(value => !value) },
      h('img', { src: url, alt: actionName(method) })) : null)
}

// The call the ask waits on: drawn at it in the chat, like the handoff card.
export function AppAccessCall({ sessionId, callId, roster, actions, heldCards, hooks }) {
  const bot = roster.byId[sessionId]
  const ask = hooks.useComputer?.(map => Object.values(map.asks ?? {}).find(item => item.callId === callId))
  if (!bot || ask === undefined || !actions.computerAppAnswer) return h(CellEmpty)
  if (heldCards?.[heldCardKey('computer-app', ask.id)] > 0) return h(CellEmpty)
  return h(PendingAppAccess, { key: ask.id, ask: { ...ask, botName: bot.name }, actions, inline: true })
}

// An app ask docked above the composer of the Bot's own chat: its call is a
// hidden group Session's, or a turn the transcript does not draw.
export function AppAccessDock({ sessionId, useRoster, useCards, useHeldCards, useComputer, actions }) {
  const bot = useRoster(value => value.byId[sessionId])
  const ask = useComputer?.(map => (bot ? Object.values(map.asks ?? {}).find(item => item.botId === bot.id) : undefined))
  const drawn = useCards?.(state => ask?.callId !== undefined && state[sessionId]?.[ask.callId] > 0) === true
  const held = useHeldCards?.(state => state[sessionId]?.[heldCardKey('computer-app', ask?.id)] > 0) === true
  if (!bot || ask === undefined || !actions.computerAppAnswer || (drawn && !held)) return null
  return h(PendingAppAccess, { key: ask.id, ask: { ...ask, botName: bot.name }, actions, inline: false })
}

// ---- The handoff card's computer variant ----
const HANDOFF_TITLES = {
  login: 'Sign-in needed',
  payment: 'Payment needed',
  captcha: 'Verification needed',
  confirm: 'Needs your confirmation',
  other: 'Help needed on the computer',
}
const handoffTitle = hold => t(HANDOFF_TITLES[hold.reason] ?? HANDOFF_TITLES.other)

export function PendingComputerHandoff({ sessionId, bot, hold, actions, inline }) {
  const [closed, setClosed] = useState(false)
  const busyRef = useRef(false)
  const titleId = useId()
  const keep = useDockHold(sessionId, 'handoff', hold.callId ?? hold.id, actions, inline)
  const taken = hold.by === 'user'
  const run = (make, close) => {
    if (busyRef.current) return
    busyRef.current = true
    keep()
    if (close) setClosed(true)
    void Promise.resolve().then(make).catch((error) => {
      setClosed(false)
      actions.reportError?.(error, 'handoff')
    }).finally(() => { busyRef.current = false })
  }
  const answer = outcome => run(() => actions.computerHoldAnswer(bot.id, { callId: hold.callId ?? hold.id, outcome }), true)
  const takeOver = () => run(async () => {
    await actions.computerTakeover(bot.id)
    actions.openDetails?.(sessionId, 'computer')
  }, false)
  return h('div', {
    className: inline ? 'bt-q-inline' : 'bt-q-dock',
    style: closed ? { display: 'none' } : undefined,
    onFocusCapture: keep,
    onPointerDownCapture: keep,
  },
    h('section', { className: inline ? 'bt-q bt-handoff' : 'bt-q bt-q-raised bt-handoff', role: 'group', 'aria-labelledby': titleId },
      h('div', { className: 'bt-q-head' },
        h('div', { className: 'bt-q-text' },
          h('p', { className: 'bt-q-title', id: titleId }, handoffTitle(hold)),
          hold.note ? h('div', { className: 'bt-q-detail' }, hold.note) : null,
          taken ? h('div', { className: 'bt-handoff-state', role: 'status' },
            h('span', { className: 'bt-handoff-dot', 'aria-hidden': true }),
            t('You control the computer')) : null))),
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', onClick: () => answer('skip') }, t('Skip')),
      taken ? null : h('button', { type: 'button', className: 'bt-q-btn', onClick: takeOver }, t('Take over')),
      h('button', { type: 'button', className: 'bt-q-submit', onClick: () => answer('done') }, t("I'm done"))))
}

export function ComputerHandoffCall({ sessionId, callId, roster, actions, heldCards, hooks }) {
  const bot = roster.byId[sessionId]
  const hold = hooks.useComputer?.(map => (bot ? map.holds?.[bot.id] : undefined))
  if (!bot || hold?.callId !== callId || !actions.computerHoldAnswer) return h(CellEmpty, { className: 'bt-q-gone' })
  if (heldCards?.[heldCardKey('handoff', callId)] > 0) return h(CellEmpty)
  return h(PendingComputerHandoff, { key: callId, sessionId, bot, hold, actions, inline: true })
}

export function ComputerHandoffDock({ sessionId, useRoster, useCards, useHeldCards, useComputer, actions }) {
  const bot = useRoster(value => value.byId[sessionId])
  const hold = useComputer?.(map => (bot ? map.holds?.[bot.id] : undefined))
  const holdKey = hold?.callId ?? hold?.id
  const drawn = useCards?.(state => state[sessionId]?.[holdKey] > 0) === true
  const held = useHeldCards?.(state => state[sessionId]?.[heldCardKey('handoff', holdKey)] > 0) === true
  if (!bot || holdKey === undefined || !actions.computerHoldAnswer || (drawn && !held)) return null
  return h(PendingComputerHandoff, { key: JSON.stringify([sessionId, holdKey]), sessionId, bot, hold, actions, inline: false })
}

// The settled card, for a persisted computer handoff reply.
export function SettledComputerHandoff({ handoff }) {
  const skipped = handoff.outcome === 'skipped'
  const returned = handoff.outcome === 'returned'
  const title = t(HANDOFF_TITLES[handoff.reason] ?? HANDOFF_TITLES.other)
  return h('div', { className: 'bt-q-inline' },
    h('div', { className: skipped ? 'bt-q bt-q-settled bt-q-dismissed' : 'bt-q bt-q-settled', role: 'group', 'aria-label': title },
      h('div', { className: 'bt-q-head' },
        h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, title)),
        skipped || returned
          ? h('span', { className: 'bt-q-badge' }, t(skipped ? 'Skipped' : 'Returned'))
          : h('span', { className: 'bt-q-check', title: t('Done') }, h(CheckIcon)))))
}

// ---- The indicator: who is on the computer, with a Stop for each. ----
export function ComputerIndicator({ useComputer, useRoster, actions }) {
  const live = useComputer?.(map => map) ?? {}
  const roster = useRoster(value => value)
  const leases = live.leases ?? []
  const waiting = Object.entries(live.bots ?? {}).filter(([, entry]) => entry.waitingFor === 'user-idle')
  if (leases.length === 0 && waiting.length === 0) return null
  const botOf = id => roster.byId[id]
  const nameOf = id => botOf(id)?.name ?? t('a Bot')
  const avatarOf = (id) => {
    const look = lookOf(botOf(id))
    if (typeof look.image === 'string' && look.image.startsWith('data:image/')) return h('img', { className: 'bt-cbar-ava', src: look.image, alt: '' })
    return h('span', { className: 'bt-cbar-ava bt-cbar-ava-dot', style: { background: look.color } }, String(nameOf(id)).slice(0, 1))
  }
  const entries = [
    ...leases.map(entry => ({ key: `l:${entry.botId}`, botId: entry.botId, waiting: false, app: entry.kind === 'foreground' ? t('In the foreground') : entry.appName })),
    ...waiting.map(([botId]) => ({ key: `w:${botId}`, botId, waiting: true, app: t('waits for the computer') })),
  ]
  return h('div', { className: 'bt-cbar', role: 'status' },
    h('span', { className: 'bt-cbar-live', title: t('Computer use') }),
    ...entries.flatMap((entry, index) => [
      index > 0 ? h('span', { key: `s${index}`, className: 'bt-cbar-sep' }) : null,
      h('span', { key: entry.key, className: entry.waiting ? 'bt-cbar-entry bt-cbar-wait' : 'bt-cbar-entry' },
        avatarOf(entry.botId),
        h('span', { className: 'bt-cbar-text' },
          h('b', { className: 'bt-cbar-name' }, nameOf(entry.botId)),
          h('i', { className: 'bt-cbar-app' }, entry.app)),
        entry.waiting
          ? h('button', { type: 'button', className: 'bt-cbar-go', onClick: () => void actions.computerAllowForeground(entry.botId) }, t('Let it continue'))
          : h('button', { type: 'button', className: 'bt-cbar-stop', 'aria-label': t('Stop'), title: t('Stop'), onClick: () => void actions.computerStop(entry.botId) },
              h('span', { className: 'bt-cbar-stopsq' }))),
    ]),
    leases.length > 1 ? h('button', { type: 'button', className: 'bt-cbar-all', onClick: () => void actions.computerStop(null, true) }, t('Stop all')) : null)
}

export const COMPUTER_CSS = `
.bt-level-pick{max-width:200px}
.bt-perm-state{font-size:13px;color:var(--bt-ink-2);margin-right:8px}
.bt-perm-state[data-on]{color:var(--bt-green)}
.bt-cview{display:flex;flex-direction:column;gap:12px}
.bt-cview-head{display:flex;align-items:center;gap:8px}
.bt-cview-state{font-size:13px;font-weight:500}
.bt-cview-state[data-state=user]{color:var(--bt-accent)}
.bt-cview-app{font-size:13px;color:var(--bt-ink-2)}
.bt-cview-shot{max-width:100%;border-radius:8px;border:1px solid var(--bt-line)}
.bt-cview-actions{display:flex;gap:8px}
.bt-cview-steps{display:flex;flex-direction:column;gap:4px}
.bt-cview-step{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--bt-ink-2)}
.bt-cview-step[data-ok=no]{color:var(--bt-danger)}
.bt-cview-step-err{font-size:11px}
.bt-cbar{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;max-width:min(760px,calc(100vw - 32px));padding:6px 12px;border-radius:999px;background:var(--bt-glass-bg);border:.5px solid var(--bt-glass-rim);box-shadow:var(--bt-glass-shadow);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font-size:12.5px}
.bt-cbar-live{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-danger);box-shadow:0 0 0 3px var(--bt-danger-glow)}
.bt-cbar-sep{flex:none;width:1px;height:14px;background:var(--bt-line);opacity:.7}
.bt-cbar-entry{display:flex;align-items:center;gap:6px;min-width:0}
.bt-cbar-ava{flex:none;width:16px;height:16px;border-radius:50%;object-fit:cover}
.bt-cbar-ava-dot{display:inline-flex;align-items:center;justify-content:center;color:var(--bt-mark-ink);font-size:9px;font-weight:600;line-height:1}
.bt-cbar-text{display:flex;align-items:baseline;gap:5px;min-width:0;overflow:hidden}
.bt-cbar-name{flex:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-cbar-app{font-style:normal;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}
.bt-cbar-stop{flex:none;width:22px;height:22px;border:0;border-radius:50%;background:var(--bt-hover);color:var(--bt-ink-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.bt-cbar-stopsq{width:8px;height:8px;border-radius:4px;background:currentColor}
.bt-cbar-stop:hover{background:var(--bt-danger);color:var(--bt-mark-ink)}
.bt-cbar-go,.bt-cbar-all{flex:none;border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;border:1px solid var(--bt-line-2)}
.bt-cbar-go{background:var(--bt-accent-soft);color:var(--bt-accent);border-color:var(--bt-accent-soft)}
.bt-cbar-all{background:var(--bt-danger-soft);color:var(--bt-danger);border-color:var(--bt-danger-soft)}
.bt-cstep{display:flex;align-items:center;gap:10px;padding:3px 0;color:var(--bt-ink-2);font-size:12.5px}
.bt-cstep-shot{flex:none;border:1px solid var(--bt-line);border-radius:8px;padding:0;background:none;cursor:zoom-in;overflow:hidden;max-height:40px}
.bt-cstep-shot img{display:block;max-height:40px;max-width:72px;object-fit:cover}
.bt-cstep-shot-open{max-height:none;cursor:zoom-out}
.bt-cstep-shot-open img{max-height:280px;max-width:480px}
`
