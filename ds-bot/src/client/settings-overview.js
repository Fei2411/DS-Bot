import { createElement as h, useEffect, useState } from 'react'
import { BotAvatar } from './mark.js'
import { ChevronRightIcon, PlusIcon, SearchIcon } from './icons.js'
import { KeyIcon } from './secret-card.js'
import { KeyEditor, UsedBy, translated, usersOf } from './providers-page.js'
import { modelLine } from './bot-models-page.js'
import { modelRefOf } from './bot-model-batch.js'
import { nextText, useSchedules } from './schedules.js'
import { platformOf } from './im-page.js'
import { RANGES, compact, summarize } from './usage-data.js'
import { allThemes, effectsOf, layoutOf } from './themes.js'
import { isLocalRoute } from './agent-routes.js'
import { t } from './i18n.js'

// Settings → Overview: what needs the user first, the team, and one card per area.
// Each card opens its page; a missing API key is fixed in place.

const TEAM_SLOTS = 6

// `loaded`: the first answer came, or failed; until then Overview cannot tell which bar a
// keyless Bot needs.
function useProviders(actions) {
  const [view, setView] = useState(null)
  const [loaded, setLoaded] = useState(actions.providers === undefined)
  useEffect(() => {
    if (actions.providers === undefined) return
    void translated(actions.providers())
      .then((next) => { if (next?.providers) setView(next) })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])
  return [view, setView, loaded]
}

// The last seven days of tokens, from the same rows as the Usage page. Phone width shows
// no cards, so it asks for none.
function useWeek(actions, wanted) {
  const [week, setWeek] = useState(null)
  useEffect(() => {
    if (!wanted || typeof actions.usage !== 'function') return undefined
    let stopped = false
    let timer
    const load = () => Promise.resolve(actions.usage()).then((view) => {
      if (stopped || !view?.rows) return
      const range = RANGES.find(entry => entry.id === '7d')
      const sum = summarize(view, range)
      setWeek({ total: sum.total.total, days: sum.buckets.map(bucket => bucket.sum.total) })
      if (view.scanning) timer = setTimeout(load, 3000)
    }).catch(() => {})
    void load()
    return () => { stopped = true; clearTimeout(timer) }
  }, [wanted])
  return week
}

const needsKey = (bot, roster) => {
  const ref = modelRefOf(bot)
  return Boolean(ref) && (roster.models ?? []).some(entry => entry.ref === ref && entry.needsKey === true)
}

// Without the providers' view (no Providers page here) a Bot on a keyless model still
// shows, from the roster alone, and leads to its model.
function Attention({ roster, actions, run, view, setView, loaded, needsModel, keyMissing }) {
  const missing = (view?.providers ?? [])
    .filter(provider => provider.key && !provider.key.configured)
    .map(provider => ({ provider, users: usersOf(provider, roster) }))
    .filter(entry => entry.users.length > 0)
  const apply = promise => run(translated(promise).then((next) => {
    if (next?.providers) setView(next)
    void actions.refreshModels?.()
  }))
  const blind = keyMissing && loaded && missing.length === 0
  if (missing.length === 0 && !needsModel && !blind) return null
  return h('section', { className: 'bt-ov-attention', 'aria-label': t('Needs your attention') },
    missing.map(({ provider, users }) => h('div', { key: provider.id, className: 'bt-ov-alert' },
      h('span', { className: 'bt-ov-alert-icon', 'aria-hidden': true }, h(KeyIcon)),
      h('span', { className: 'bt-ov-alert-copy' },
        h('span', { className: 'bt-ov-alert-title' }, t('{provider} needs an API key', { provider: provider.name })),
        h('span', { className: 'bt-ov-alert-meta' }, h(UsedBy, { bots: users, size: 16, max: 3 }), t('Used by {names}', { names: users.map(bot => bot.name).join(t(', ')) }))),
      provider.key.writable
        ? h(KeyEditor, { provider, apply, actions, compact: true })
        : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('models') }, t('Open')))),
    missing.length === 0 && needsModel ? h('div', { className: 'bt-ov-alert' },
      h('span', { className: 'bt-ov-alert-icon', 'aria-hidden': true }, h(KeyIcon)),
      h('span', { className: 'bt-ov-alert-copy' }, h('span', { className: 'bt-ov-alert-title' }, t('Add a model provider'))),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: () => actions.openSettings('models') }, t('Set up'))) : null,
    missing.length === 0 && !needsModel && blind ? h('div', { className: 'bt-ov-alert' },
      h('span', { className: 'bt-ov-alert-icon', 'aria-hidden': true }, h(KeyIcon)),
      h('span', { className: 'bt-ov-alert-copy' }, h('span', { className: 'bt-ov-alert-title' }, t('Needs an API key'))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('bot-models') }, t('Open'))) : null)
}

function Team({ roster, actions }) {
  const bots = roster.bots ?? []
  const room = bots.length + 1 > TEAM_SLOTS
  const shown = room ? bots.slice(0, TEAM_SLOTS - 2) : bots
  const main = new Set(roster.mainBotIds ?? [])
  return h('section', { className: 'bt-ov-section' },
    h('div', { className: 'bt-ov-head' },
      h('h3', null, t('Team')),
      h('button', { type: 'button', className: 'bt-ov-link', onClick: () => actions.openSettings('bots') },
        h('span', null, t('Bots · {count}', { count: bots.length })),
        h('span', null, t('Group chats · {count}', { count: (roster.rooms ?? []).length })))),
    h('div', { className: 'bt-ov-team' },
      shown.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-ov-bot', onClick: () => actions.openSettings('bots', bot.id) },
        h('span', { className: 'bt-ov-face' },
          h(BotAvatar, { bot, size: 40, main: main.has(bot.id), live: false }),
          needsKey(bot, roster) ? h('span', { className: 'bt-ov-face-dot', role: 'img', 'aria-label': t('Needs an API key') }) : null),
        h('span', { className: 'bt-ov-bot-name' }, bot.name),
        h('span', { className: 'bt-ov-bot-model' }, modelLine(bot, roster)))),
      room ? h('button', { type: 'button', className: 'bt-ov-bot bt-ov-more', onClick: () => actions.openSettings('bots') },
        h('span', { className: 'bt-ov-more-count' }, `+${bots.length - shown.length}`),
        h('span', { className: 'bt-ov-bot-name' }, t('All Bots'))) : null,
      h('button', { type: 'button', className: 'bt-ov-bot bt-ov-new', onClick: () => actions.openSettings('bots', 'new') },
        h(PlusIcon), h('span', { className: 'bt-ov-bot-name' }, t('New Bot')))))
}

function Chip({ tone, children }) {
  return h('span', { className: 'bt-ov-chip', 'data-tone': tone || undefined }, tone === 'ok' ? h('span', { className: 'bt-ov-chip-dot', 'aria-hidden': true }) : null, children)
}

function Tile({ icon: Icon, title, onOpen, value, unit, children, extra = null }) {
  return h('button', { type: 'button', className: 'bt-ov-tile', onClick: onOpen },
    h('span', { className: 'bt-ov-tile-head' }, h(Icon), h('span', { className: 'bt-ov-tile-title' }, title), h(ChevronRightIcon)),
    h('span', { className: 'bt-ov-tile-body' },
      h('span', { className: 'bt-ov-value' }, value, unit ? h('span', { className: 'bt-ov-unit' }, unit) : null),
      extra),
    h('span', { className: 'bt-ov-tile-foot' }, children))
}

const uniq = list => [...new Set(list.filter(Boolean))]

function Tiles({ roster, actions, icons, view, hasProviders, narrow }) {
  const week = useWeek(actions, !narrow)
  const schedules = useSchedules(actions)
  const prefs = roster.prefs ?? {}
  const models = roster.models ?? []
  const usable = models.filter(entry => entry.needsKey !== true && !isLocalRoute(entry.ref))
  const keyless = uniq((view?.providers ?? []).filter(provider => provider.key && !provider.key.configured && usersOf(provider, roster).length > 0).map(provider => provider.name))
  const providers = uniq(usable.map(entry => entry.providerName ?? entry.ref.split('/')[0])).filter(name => !keyless.includes(name))
  const local = (roster.bots ?? []).filter(bot => isLocalRoute(modelRefOf(bot))).length

  const connectors = roster.connectors ?? {}
  const mail = connectors.mail?.accounts ?? []
  const apps = (connectors.connectors ?? []).filter(app => app.id !== 'mail' && app.state !== 'off')
  const im = roster.im?.connections ?? []
  const phone = roster.phone ?? {}
  const phoneOnline = Boolean(phone.on && phone.status === 'online' && (phone.phones ?? []).some(entry => entry.connected))
  const connected = mail.length + apps.length + im.length + (phoneOnline ? 1 : 0)

  const capabilities = roster.capabilities ?? []
  const secrets = roster.secrets ?? []

  const tasks = (schedules?.tasks ?? []).filter(task => task.status === 'active')
  const soonest = [...tasks].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0]

  const themes = allThemes()
  const theme = themes[prefs.theme] ?? themes.deepseek
  const peak = week ? Math.max(1, ...week.days) : 1

  return h('section', { className: 'bt-ov-tiles', 'aria-label': t('Overview') },
    h(Tile, { icon: icons.models, title: t('Models'), onOpen: () => actions.openSettings(hasProviders ? 'models' : 'bot-models'), value: usable.length, unit: t('models') },
      providers.slice(0, 3).map(name => h(Chip, { key: name }, name)),
      keyless.map(name => h(Chip, { key: `k:${name}`, tone: 'warn' }, name)),
      local > 0 ? h(Chip, null, t('Local {count}', { count: local })) : null),
    h(Tile, { icon: icons.connectors, title: t('Connect'), onOpen: () => actions.openSettings('connectors'), value: connected, unit: t('connected') },
      phone.on ? h(Chip, { tone: phoneOnline ? 'ok' : null }, t('Phone')) : null,
      uniq(im.map(conn => t(platformOf(conn.platform).name))).slice(0, 2).map(name => h(Chip, { key: `im:${name}` }, name)),
      apps.slice(0, 2).map(app => h(Chip, { key: app.id }, app.name)),
      mail.length > 0 ? h(Chip, null, t('Mailbox')) : null),
    h(Tile, { icon: icons.capabilities, title: t('Tools'), onOpen: () => actions.openSettings('computer'), value: capabilities.length, unit: t('capabilities') },
      roster.browser ? h(Chip, null, t('Browser')) : null,
      roster.computer?.enabled ? h(Chip, null, t('Computer use')) : null,
      secrets.length > 0 ? h(Chip, null, t('Secrets {count}', { count: secrets.length })) : null),
    h(Tile, {
      icon: icons.usage, title: t('Last 7 days'), onOpen: () => actions.openSettings('usage'),
      value: week ? compact(week.total) : '–', unit: t('tokens'),
      extra: week ? h('span', { className: 'bt-ov-bars', 'aria-hidden': true }, week.days.map((day, at) => h('span', {
        key: at, className: 'bt-ov-bar', 'data-today': at === week.days.length - 1 || undefined, style: { height: `${Math.max(8, Math.round((day / peak) * 100))}%` },
      }))) : null,
    }, week ? t('Today {count}', { count: compact(week.days.at(-1) ?? 0) }) : null),
    h(Tile, { icon: icons.schedules, title: t('Scheduled tasks'), onOpen: () => actions.openSettings('schedules'), value: tasks.length, unit: t('active') },
      soonest ? h('span', { className: 'bt-ov-meta' }, nextText(soonest)) : null),
    h(Tile, {
      icon: icons.appearance, title: t('Appearance'), onOpen: () => actions.openSettings('appearance'),
      value: t(theme.label),
      extra: h('span', { className: 'bt-ov-swatch', 'aria-hidden': true },
        h('span', { style: { background: theme.light.bg } }, h('i', { style: { background: theme.light.accent } })),
        h('span', { style: { background: theme.dark.bg } }, h('i', { style: { background: theme.dark.accent } }))),
    }, h('span', { className: 'bt-ov-meta' }, [layoutOf(prefs) === 'flat' ? t('Flat') : t('Bubble'), effectsOf(prefs) === 'full' ? null : effectsOf(prefs) === 'reduced' ? t('Reduced') : t('None')].filter(Boolean).join(' · '))))
}

// Phone width: the page list, as rows under the team.
function HomeList({ groups, icons, status, onOpen }) {
  return h('nav', { className: 'bt-ov-list', 'aria-label': t('Settings pages') },
    groups.map(list => h('div', { key: list.key, className: 'bt-ov-list-card' },
      list.items.map(item => h('button', { key: item.key, type: 'button', className: 'bt-ov-list-row', onClick: () => onOpen(item) },
        h('span', { className: 'bt-ov-list-icon', 'data-group': item.key }, item.icon ?? h(icons[item.iconKey] ?? icons.general)),
        h('span', { className: 'bt-ov-list-label' }, item.label),
        status(item.key),
        h(ChevronRightIcon))))))
}

export function OverviewPage({ roster, actions, run, icons, hasProviders, needsModel, keyMissing = false, narrow = false, homeGroups, homeStatus, onHomeOpen, onSearch }) {
  const [view, setView, loaded] = useProviders(actions)
  return [
    h('button', { key: 'search', type: 'button', className: 'bt-ov-search', 'data-tour': 'search', onClick: onSearch }, h(SearchIcon), h('span', null, t('Search'))),
    h(Attention, { key: 'attention', roster, actions, run, view, setView, loaded, needsModel, keyMissing }),
    h(Team, { key: 'team', roster, actions }),
    h(Tiles, { key: 'tiles', roster, actions, icons, view, hasProviders, narrow }),
    h(HomeList, { key: 'home', groups: homeGroups, icons, status: homeStatus, onOpen: onHomeOpen }),
  ]
}
