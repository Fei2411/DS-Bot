import { Component, createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMainOf } from './sources.js'
import { ApiIcon, BlocksIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, CloseIcon, CompassIcon, ConnectorIcon, GlobeIcon, InfoIcon, KeyboardIcon, LayersIcon, MonitorIcon, OverviewIcon, PaletteIcon, PhoneIcon, PlusIcon, PuzzleIcon, SearchIcon, SendIcon, ShieldIcon, SlidersIcon, TerminalIcon, WaveIcon, SETTINGS_ICONS } from './icons.js'
import { IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium } from './dsh-primitives.js'
import { AdminStar, BotAvatar, RoomAvatar } from './mark.js'
import { settingsOwnsKeyboard, useEscape } from './overlay-hooks.js'
export { settingsOwnsKeyboard }
import { Switch } from './bot-settings.js'
import { Segmented, useGlide } from './motion.js'
import { KeyIcon } from './secret-card.js'
import { FeedbackIcon } from './feedback.js'
import { SettingsTour, canAutoStartTour, hasSectionTour, markTourSeen } from './settings-tour.js'
import { FolderMenu } from './folder-menu.js'
import { ModelMenu } from './model-menu.js'
import { SelectMenu } from './select-menu.js'
import { isLocalRoute } from './agent-routes.js'
import { noteClientError } from './diagnostics.js'
import { requestWindowReload } from './reload-action.js'
import { t } from './i18n.js'
import { PREFERENCE_ITEMS, SettingsPreferences } from './settings-preferences.js'
import { isShortcutRecording } from './shortcuts-model.js'
import { isImeComposing } from './enter-key.js'
import {
  AboutPage,
  ApiPage,
  AppearancePage,
  BotModelsPage,
  BotSettingsForm,
  BrowserPage,
  CapabilitiesPage,
  ComputerPage,
  ConnectorsPage,
  CreateBot,
  DeepSeekServicesPage,
  FeedbackPage,
  GroupSettingsForm,
  ImPage,
  KeptPrivateSection,
  LocalAgentsPage,
  NewGroupForm,
  OverviewPage,
  PhonePage,
  PluginsPage,
  PrivacyPage,
  ProvidersPage,
  SchedulesPage,
  SecretsPage,
  SettingsPalette,
  ShortcutsPage,
  UsagePage,
} from './settings-pages.js'

const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? '')


// Settings dialog: a nav rail beside the page, with search on top. A domain with several
// parts shows them as discrete tabs; every existing openSettings(page, id) route resolves
// to its group and opens its tab directly.
const NAV_GROUPS = [
  { id: 'overview', label: 'Overview', icon: 'overview', pages: [['overview', 'Overview']], section: 'top' },
  { id: 'general', label: 'General', icon: 'general', pages: [['general', 'General'], ['shortcuts', 'Shortcuts']], section: 'main' },
  { id: 'appearance', label: 'Appearance', icon: 'appearance', pages: [['appearance', 'Appearance']], section: 'main' },
  {
    id: 'models',
    label: 'Models',
    icon: 'models',
    pages: [['models', 'Providers'], ['local-agents', 'Local agents'], ['bot-models', 'Bot models'], ['deepseek-services', 'DeepSeek services']],
    section: 'main',
  },
  {
    id: 'team',
    label: 'Team',
    icon: 'bots',
    pages: [['bots', 'Bots'], ['groups', 'Group chats'], ['schedules', 'Scheduled tasks']],
    section: 'main',
  },
  {
    id: 'connect',
    label: 'Connect',
    icon: 'connectors',
    pages: [['connectors', 'Connectors'], ['im', 'IM'], ['phone', 'Phone'], ['api', 'API']],
    section: 'main',
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: 'capabilities',
    pages: [['computer', 'Computer use'], ['browser', 'Browser'], ['capabilities', 'Capabilities'], ['secrets', 'Secrets']],
    section: 'main',
  },
  { id: 'plugins', label: 'Plugins', icon: 'plugins', pages: [['plugins', 'Plugins']], section: 'main' },
  { id: 'usage', label: 'Usage', icon: 'usage', pages: [['usage', 'Usage']], section: 'main' },
  {
    id: 'about',
    label: 'About DS Bot',
    icon: 'about',
    pages: [['about', 'About'], ['privacy', 'Privacy'], ['feedback', 'Feedback']],
    section: 'last',
  },
]

// `guide` was the landing page before Overview.
const GROUP_ALIASES = { team: 'bots', connect: 'connectors', tools: 'computer', guide: 'overview' }

// DSH sections DS Bot's own pages already hold.
const MERGED_SECTIONS = new Set(['general', 'models', 'plugins'])
// DSH General rows placed in Appearance, Basics, or Privacy; the rest go under Advanced.
const LOOK_ITEMS = ['appearance', 'font-size']
const BASIC_ITEMS = ['language', 'composer-enter']
const PRIVACY_ITEMS = ['session-log-deepseek']
const lookRows = dsh => LOOK_ITEMS.filter(id => (dsh?.items ?? []).some(row => row.id === id)).map(id => dshItem(dsh, id))
const DSH_ICONS = { account: IconUserOutlineMedium, 'agent-presets': IconAgentPresetOutlineMedium, plugins: PuzzleIcon, 'archived-sessions': IconArchiveOutlineMedium }
export const dshPages = dsh => (dsh?.sections ?? []).filter(row => row.id !== '' && !MERGED_SECTIONS.has(row.id))
const hasSection = (dsh, id) => (dsh?.sections ?? []).some(row => row.id === id)
const dshItem = (dsh, id) => h('div', { key: id, className: 'bt-dsh-item', 'data-item': id },
  dsh.preferences && PREFERENCE_ITEMS.has(id) ? h(SettingsPreferences, { id, preferences: dsh.preferences }) : dsh.renderSlot('settings.general.item', {}, { only: id }))
const PAGE_ICONS = { ...SETTINGS_ICONS, overview: OverviewIcon, shortcuts: KeyboardIcon, appearance: PaletteIcon, models: SlidersIcon, 'bot-models': LayersIcon, 'local-agents': TerminalIcon, connectors: ConnectorIcon, im: SendIcon, phone: PhoneIcon, api: ApiIcon, capabilities: BlocksIcon, 'deepseek-services': WaveIcon, browser: GlobeIcon, plugins: PuzzleIcon, computer: MonitorIcon, schedules: ClockIcon, secrets: KeyIcon, privacy: ShieldIcon, feedback: FeedbackIcon, about: InfoIcon }

// What each MEMORY.md holds by default, in characters of entry text.
const MEMORY_SIZES = [
  { scope: 'group', label: 'Group memory size', size: 12_000 },
  { scope: 'bot', label: 'Bot memory size', size: 8_000 },
  { scope: 'team', label: 'Team memory size', size: 4_000 },
]
function MemorySize({ label, value, save, disabled = false }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    if (disabled) return
    const number = Number(text)
    if (Number.isInteger(number) && number >= 1_000 && number <= 200_000 && number !== value) save(number)
    else setText(String(value))
  }
  return h('input', { className: 'bt-input bt-set-number', type: 'number', min: 1_000, max: 200_000, step: 1_000, disabled, 'aria-label': label, value: text, onChange: event => setText(event.target.value), onBlur: commit, onKeyDown: event => { if (event.key === 'Enter') event.target.blur() } })
}

// Seconds a Bot's own chat waits for a command before it goes on in the background
// (host default 5; the host checks the range again).
const BACKGROUND_AFTER_SEC = 5
function SecondsField({ label, value, save, disabled = false }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    if (disabled) return
    const number = Number(text)
    if (text.trim() !== '' && Number.isInteger(number) && number >= 0 && number <= 600 && number !== value) save(number)
    else setText(String(value))
  }
  return h('input', { className: 'bt-input bt-set-number', type: 'number', min: 0, max: 600, step: 1, disabled, 'aria-label': label, value: text, onChange: event => setText(event.target.value), onBlur: commit, onKeyDown: event => { if (event.key === 'Enter') event.target.blur() } })
}

function SetSection({ title, action = null, className = '', tour = null, children }) {
  return h('section', { className: `bt-set-section ${className}`.trim(), 'data-tour': tour || undefined },
    action ? h('div', { className: 'bt-la-sec-head' }, h('h3', null, title), action) : title ? h('h3', null, title) : null,
    h('div', { className: 'bt-set-card' }, children))
}
function SetRow({ label, hint, children, className = '', tour = null }) {
  return h('div', { className: `bt-set-row ${className}`.trim(), 'data-tour': tour || undefined },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)
}

function Choice({ label, value, options, pick, className = 'bt-look-seg' }) {
  return h(Segmented, { label, value, className }, options.map(([id, text]) => h('button', {
    key: id, type: 'button', 'aria-pressed': value === id,
    onClick: () => { if (value !== id) pick(id) },
  }, t(text))))
}

function GeneralPage({ roster, actions, run, dsh, openAdvanced = 0 }) {
  const items = (dsh?.items ?? []).map(row => row.id).filter(id => id !== '')
  const basicDsh = BASIC_ITEMS.filter(id => items.includes(id))
  const more = items.filter(id => !LOOK_ITEMS.includes(id) && !BASIC_ITEMS.includes(id) && !PRIVACY_ITEMS.includes(id))
  const prefs = roster.prefs ?? {}
  const readOnly = Boolean(roster?.readOnly)
  const inAgentMode = Boolean(actions.setSurface && actions.surfaceMode?.() === 'agent')
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(openAdvanced))
  useEffect(() => { if (openAdvanced) setAdvancedOpen(true) }, [openAdvanced])
  const advancedSummary = [t('Memory'), t('Background work')].join(' · ')
  return [
    // In Agent mode, keep the way back to Bot mode visible at the top.
    inAgentMode ? h(SetSection, { key: 'mode', title: t('Mode') },
      h(SetRow, { label: t('Bot mode') }, h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: () => actions.setSurface('bot') }, t('Switch')))) : null,
    h(SetSection, { key: 'basics', title: t('Basics') },
      basicDsh.includes('language') ? dshItem(dsh, 'language') : null,
      h(SetRow, { label: t('Default model'), className: 'bt-set-model', tour: 'default-model' },
        h(ModelMenu, {
          bot: { id: 'new-bots', name: t('New Bots'), model: isLocalRoute(prefs.defaultBotModel) ? undefined : prefs.defaultBotModel },
          roster, actions, run, wide: true, withEfforts: false, disabled: readOnly,
          fallbackModel: roster.defaultModel,
          onPick: ref => run(actions.setPrefs({ defaultBotModel: ref })),
        }),
        prefs.defaultBotModel ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly, onClick: () => run(actions.setPrefs({ defaultBotModel: null })) }, t('Reset')) : null),
      h(SetRow, { label: t('Enter sends message') },
        h(Switch, { label: t('Enter sends message'), on: prefs.enterToSend !== false, disabled: readOnly, onChange: enterToSend => run(actions.setPrefs({ enterToSend })) })),
      basicDsh.includes('composer-enter') ? dshItem(dsh, 'composer-enter') : null),
    h(SetSection, { key: 'approvals', title: t('Approvals') },
      h(SetRow, { label: t('Approval model'), className: 'bt-set-model' },
        h(ModelMenu, {
          bot: { id: 'approval-model', name: t('Approval model'), model: prefs.approvalModel || prefs.defaultBotModel || roster.defaultModel },
          roster: { ...roster, models: (roster.models ?? []).filter(model => !isLocalRoute(model.ref)) }, actions, run, wide: true, withEfforts: false, disabled: readOnly,
          onPick: ref => run(actions.setPrefs({ approvalModel: ref })),
        }),
        prefs.approvalModel ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly, onClick: () => run(actions.setPrefs({ approvalModel: null })) }, t('Follow team default')) : null)),
    h(LocationsSection, { key: 'places', actions, run, readOnly }),
    actions.setSurface && !inAgentMode ? h(SetSection, { key: 'classic-mode', title: t('Mode') },
      h(SetRow, { label: t('Classic Agent mode') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.setSurface('agent') }, t('Switch')))) : null,
    h(SetSection, { key: 'more', className: 'bt-dsh-items' },
      h('button', {
        type: 'button',
        className: 'bt-set-row bt-set-collapse',
        'aria-expanded': advancedOpen,
        'data-tour': 'advanced',
        onClick: () => setAdvancedOpen(open => !open),
      },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-set-collapse-title' }, t('Advanced')),
        !advancedOpen ? h('span', { className: 'bt-set-hint' }, advancedSummary) : null),
      h('span', { className: 'bt-chevron bt-collapse-chevron', 'data-open': advancedOpen || undefined }, h(ChevronDownIcon))),
      advancedOpen ? [
        h(SetRow, { key: 'recall', label: t('Bring up related memory') },
          h(Switch, { label: t('Bring up related memory'), on: prefs.memoryAutoRecall !== false, disabled: readOnly, onChange: memoryAutoRecall => run(actions.setPrefs({ memoryAutoRecall })) })),
        ...MEMORY_SIZES.map(({ scope, label, size }) => h(SetRow, { key: scope, label: t(label) },
          h(MemorySize, { label: t(label), value: prefs.memoryLimits?.[scope] ?? size, disabled: readOnly, save: value => run(actions.setPrefs({ memoryLimits: { [scope]: value } })) }))),
        h(SetRow, { key: 'bg', label: t('Background commands after (seconds)') },
          h(SecondsField, { label: t('Background commands after (seconds)'), value: prefs.backgroundAfterSec ?? BACKGROUND_AFTER_SEC, disabled: readOnly, save: backgroundAfterSec => run(actions.setPrefs({ backgroundAfterSec })) })),
        ...more.map(id => dshItem(dsh, id)),
      ] : null),
  ]
}

// The desktop app's preload hands its window `dsBotApp` so data can be moved; in browser
// or standalone DSH sessions, `folders` still reports the live data path as read-only.
function LocationsSection({ actions, run, readOnly = false }) {
  const app = globalThis.dsBotApp
  const [team, setTeam] = useState(null)
  const [data, setData] = useState(null)
  // One change at a time: the data move checks the new folder against the team workspace, and
  // a later team workspace must not finish before an earlier one.
  const [moving, setMoving] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    void Promise.resolve(actions.folders()).then((info) => {
      setTeam(info?.team ?? null)
      if (app === undefined && info?.data) setData({ path: info.data, fixed: true })
    }).catch(() => {})
    if (app !== undefined) void Promise.resolve(app.dataLocation()).then(setData).catch(() => {})
  }, [])
  const pickTeam = (path) => {
    if (busy.current || readOnly) return undefined
    busy.current = true
    setMoving(true)
    return run(Promise.resolve(actions.setTeamWorkspace(path)).then((answer) => {
      setTeam(answer.team)
      app?.teamWorkspaceChanged(answer.team)
    }).finally(() => {
      busy.current = false
      setMoving(false)
    }))
  }
  return h(SetSection, { title: t('Locations'), className: 'bt-set-places', tour: 'locations' },
    h(SetRow, { label: t('Team workspace') },
      team === null ? null : h(FolderMenu, { value: team, team: true, actions, run, onPick: pickTeam, disabled: moving || readOnly })),
    data === null ? null : h(SetRow, { label: t('Data location'), hint: data.path },
      data.fixed ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: moving || readOnly, onClick: () => { if (!busy.current && !readOnly) void run(app.moveData(team ?? undefined)) } }, t('Change…'))))
}

// Multiple Bots can hold the Main Bot role at once; clicking any Bot pill toggles it
// (the last remaining Main Bot stays selected). When several are selected, the user can
// pick which one appears as the primary sidebar tile.
function MainBotsSection({ roster, actions, run }) {
  const readOnly = Boolean(roster?.readOnly)
  const mains = (roster.mainBotIds ?? []).map(id => roster.byId[id]).filter(Boolean)
  const first = mains[0]
  const [confirmed, setConfirmed] = useState(null)
  const confirmTimer = useRef(0)
  useEffect(() => () => clearTimeout(confirmTimer.current), [])
  const toggleMain = (bot, isMain) => {
    if (readOnly) return
    const turningOn = !isMain
    void Promise.resolve(run(actions.setMain(bot.id, turningOn))).then((ok) => {
      if (ok === false || !turningOn) return
      clearTimeout(confirmTimer.current)
      setConfirmed(bot.id)
      confirmTimer.current = setTimeout(() => setConfirmed(cur => (cur === bot.id ? null : cur)), 380)
    })
  }
  return h(SetSection, { title: t('Main Bots'), tour: 'main-bot' },
    h('div', { className: 'bt-main-bots', role: 'group', 'aria-label': t('Main Bots') },
      roster.bots.map((bot) => {
        const isMain = isMainOf(roster, bot.id)
        const isLastMain = isMain && mains.length <= 1
        return h('button', {
          key: bot.id,
          type: 'button',
          className: 'bt-main-pill',
          'aria-pressed': isMain,
          'data-confirm': confirmed === bot.id ? '' : undefined,
          disabled: isLastMain || readOnly,
          title: isLastMain ? t('Keep at least one Main Bot') : undefined,
          onClick: () => toggleMain(bot, isMain),
        },
        h(BotAvatar, { bot, size: 22, badge: false, live: false }),
        h('span', { className: 'bt-main-pill-name' }, bot.name),
        h('span', { key: isMain ? 'on' : 'off', className: 'bt-main-pill-mark', 'aria-hidden': true }, isMain ? h(CheckIcon) : h(PlusIcon)))
      })),
    mains.length > 1 ? h(SetRow, { label: t('Primary tile') },
      h(SelectMenu, {
        'aria-label': t('Primary tile'),
        value: first?.id ?? '',
        disabled: readOnly,
        options: mains.map(bot => ({ value: bot.id, label: bot.name })),
        onChange: id => { if (!readOnly && id && id !== first?.id) void run(actions.setMain(id, true, { primary: true })) },
      })) : null)
}

function BotsPage({ roster, actions, run }) {
  const readOnly = Boolean(roster?.readOnly)
  const newBotBtn = h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'data-tour': 'new-bot', disabled: readOnly, onClick: () => actions.openSettings('bots', 'new') }, h(PlusIcon), t('New Bot'))
  return [
    h(MainBotsSection, { key: 'main', roster, actions, run }),
    h(SetSection, { key: 'bots', title: t('All Bots · {count}', { count: roster.bots.length }), action: newBotBtn, tour: 'bot-list' },
      roster.bots.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('bots', bot.id) },
        h('span', { className: 'bt-set-bot' },
          h(BotAvatar, { bot, size: 28, badge: false, live: false }),
          h('span', { className: 'bt-row-title' }, bot.name),
          bot.role ? h('span', { className: 'bt-tag' }, bot.role) : null,
          isMainOf(roster, bot.id) ? h('span', { className: 'bt-tag' }, t('Main Bot')) : null,
          bot.hidden && !isMainOf(roster, bot.id) ? h('span', { className: 'bt-tag' }, t('Hidden')) : null),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))))),
    h(KeptPrivateSection, { key: 'kept', roster, actions, run, Section: SetSection, Row: SetRow }),
  ]
}

function GroupsPage({ roster, actions, run }) {
  const readOnly = Boolean(roster?.readOnly)
  const [creating, setCreating] = useState(false)
  const newGroupBtn = creating ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'data-tour': 'new-group', disabled: readOnly || roster.bots.length < 2, title: roster.bots.length < 2 ? t('A group chat needs at least two Bots') : undefined, onClick: () => setCreating(true) }, h(PlusIcon), t('Create group chat'))
  return [
    creating ? h(NewGroupForm, { key: 'create', roster, actions, run, onCancel: () => setCreating(false), onCreated: room => actions.openSettings('groups', room.id) }) : null,
    h(SetSection, { key: 'groups', title: t('Group chats · {count}', { count: roster.rooms.length }), action: newGroupBtn, tour: 'group-list' },
      roster.rooms.length === 0
        ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No group chats yet.')))
        : roster.rooms.map((room) => {
            const admin = roster.byId[room.admin]
            return h('button', { key: room.id, type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('groups', room.id) },
              h('span', { className: 'bt-set-bot' },
                h(RoomAvatar, { room, roster, size: 28 }),
                h('span', { className: 'bt-row-title' }, room.name),
                h('span', { className: 'bt-tag' }, t('{count} members', { count: room.members.length })),
                admin ? h('span', { className: 'bt-tag bt-tag-admin' }, h(AdminStar), admin.name) : null,
                room.hidden ? h('span', { className: 'bt-tag' }, t('Hidden')) : null),
              h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))
          })),
  ]
}

// A page that throws while it renders shows a line in its place. Uncaught, the
// error takes down the plugin's whole overlay, and no dialog opens again until
// the window reloads. The page's key resets it; Usage stays mounted, so its
// boundary resets when the shown page changes.
class PageBoundary extends Component {
  state = { failed: false, reset: this.props.reset }
  static getDerivedStateFromError() { return { failed: true } }
  static getDerivedStateFromProps(props, state) {
    return props.reset === state.reset ? null : { failed: false, reset: props.reset }
  }
  componentDidCatch(error) { console.error('ds-bot: a settings page failed', error); noteClientError('settings-page', error) }
  render() { return this.state.failed ? h('div', { className: 'bt-error', role: 'alert' }, t('This page could not be shown.')) : this.props.children }
}

// Isolates failures inside SettingsPalette (including lazy chunk errors) so the Settings
// dialog stays open, the broken overlay dismisses cleanly, and retry works on reopen.
class PaletteBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) {
    console.error('ds-bot: settings palette failed', error)
    noteClientError('settings-palette', error)
    this.props.onError?.(error)
  }
  render() { return this.state.failed ? null : this.props.children }
}

// Where a part of a scrolling page sits, for the anchor row: the last part whose top
// has passed the top of the box, or the last one once the box is scrolled to its end.
function partAt(box) {
  const parts = [...(box?.querySelectorAll?.('[data-part]') ?? [])]
  if (parts.length === 0) return null
  if (box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 2) return parts.at(-1).dataset.part
  const top = box.getBoundingClientRect().top + 36
  let found = parts[0]
  for (const part of parts) if (part.getBoundingClientRect().top <= top) found = part
  return found.dataset.part
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
// Parts whose own top section heading already titles the part (promoted directly to
// Level-2 typography so no duplicate outer heading ever stacks above it).
const OWN_HEAD_PARTS = new Set(['groups', 'schedules', 'capabilities', 'feedback'])

// While `leaving`, the dialog plays its exit and takes no input.
export function SettingsDialog({ page, id, roster, actions, useUpdate, leaving = false, dsh }) {
  const [error, setError] = useState('')
  const [palette, setPalette] = useState(false)
  const [paletteFailures, setPaletteFailures] = useState(0)
  const [advancedToken, setAdvancedToken] = useState(0)
  const [tour, setTour] = useState(() => (!leaving && (!page || page === 'overview' || page === 'general' || page === 'guide') && !id && canAutoStartTour() ? { mode: 'full', nonce: 1 } : null))
  const dialogRef = useRef(null)
  const scrollRef = useRef(null)
  const tourNonceRef = useRef(1)
  const tourRef = useRef(tour)
  tourRef.current = tour
  const update = useUpdate?.(value => value) ?? {}
  const close = useCallback(() => {
    if (tourRef.current?.mode === 'full') markTourSeen()
    actions.closeSettings()
  }, [actions])
  const onEscape = useCallback(() => {
    if (palette) { setPalette(false); return }
    close()
  }, [palette, close])
  useEscape(onEscape, !leaving)
  // Search sits over the page; a walkthrough under way ends when the user opens it, since
  // the walkthrough keeps the keyboard to its own card.
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  const startTour = useCallback((mode) => {
    setPalette(false)
    tourNonceRef.current += 1
    setTour({ mode, nonce: tourNonceRef.current })
  }, [])
  const dismissTour = useCallback(() => {
    if (tourRef.current?.mode === 'full') markTourSeen()
    setTour(null)
  }, [])
  const openPalette = useCallback(() => {
    if (tourRef.current) dismissTour()
    setPalette(true)
  }, [dismissTour])
  // ⌘K on a Mac, Ctrl+K elsewhere, toggles search from anywhere in Settings. Ctrl+K on a
  // Mac stays the text fields' delete-to-end.
  useEffect(() => {
    if (leaving || typeof window === 'undefined') return undefined
    const mac = isMac()
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || isImeComposing(event) || isShortcutRecording()) return
      if (!settingsOwnsKeyboard(dialogRef.current)) return
      const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!modifier || event.altKey || event.shiftKey || (event.code !== 'KeyK' && String(event.key).toLowerCase() !== 'k')) return
      event.preventDefault()
      event.stopPropagation()
      if (paletteRef.current) setPalette(false)
      else openPalette()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [leaving, openPalette])
  // Each explicit trip to a page counts, so going again to the part already routed (or to
  // the first part of the open domain) still scrolls to it.
  const [jump, setJump] = useState(0)
  const go = useCallback((nextPage, nextId) => {
    setJump(count => count + 1)
    if (nextId === undefined) actions.openSettings(nextPage)
    else actions.openSettings(nextPage, nextId)
  }, [actions])
  const navigateForTour = useCallback((nextPage) => {
    setPalette(false)
    go(nextPage)
  }, [go])
  const [narrowNav, setNarrowNav] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 768px)').matches : false))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const queryList = window.matchMedia('(max-width: 768px)')
    const sync = () => setNarrowNav(queryList.matches)
    sync()
    queryList.addEventListener?.('change', sync)
    return () => queryList.removeEventListener?.('change', sync)
  }, [])
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })

  const hasProviders = actions.providers !== undefined
  const hasServices = actions.deepseekServices !== undefined
  const hasSurface = typeof actions.setSurface === 'function'
  const ownWindow = dsh?.ownWindow ?? (dsh === undefined)
  const pageAvailable = key => (key !== 'models' || actions.providers !== undefined) && (key !== 'deepseek-services' || actions.deepseekServices !== undefined) && (key !== 'shortcuts' || ownWindow)
  const groups = useMemo(() => NAV_GROUPS.map(group => ({
    ...group,
    pages: group.pages.filter(([key]) => pageAvailable(key)),
  })).filter(group => group.pages.length > 0), [hasProviders, hasServices, ownWindow])

  const extra = dshPages(dsh)
  const [rawSectionId, rawSubTarget] = typeof id === 'string' && (page === 'dsh' || page === 'plugins') ? id.split(':', 2) : [id, undefined]
  const legacyEnginePlugins = page === 'dsh' && rawSectionId === 'plugins' && hasSection(dsh, 'plugins')
  const resolvedPage = legacyEnginePlugins ? 'plugins' : (GROUP_ALIASES[page] ?? (page === 'models' && !hasProviders ? 'bot-models' : page))
  const [sectionId, subTarget] = legacyEnginePlugins || (resolvedPage === 'plugins' && rawSectionId === 'dsh')
    ? ['plugins', rawSubTarget]
    : [rawSectionId, rawSubTarget]
  // A DSH page is `dsh` with its section id; one no longer registered falls back to Overview.
  const section = resolvedPage === 'dsh' ? extra.find(row => row.id === sectionId) : undefined
  // DSH's Models page, one level into Models.
  const advanced = resolvedPage === 'models' && id === 'advanced' && hasSection(dsh, 'models')
  // DSH's Plugins page (e.g. Web Search API, Automation tasks & engine plugin switches), one level into Plugins.
  const enginePlugins = (legacyEnginePlugins || (resolvedPage === 'plugins' && rawSectionId === 'dsh')) && hasSection(dsh, 'plugins')
  const validPage = groups.some(group => group.pages.some(([key]) => key === resolvedPage))
  const shown = section ? 'dsh' : validPage ? resolvedPage : 'overview'
  // A Bot or group deleted while its form is open leaves its page on the list.
  const creatingBot = shown === 'bots' && id === 'new'
  const bot = shown === 'bots' && id && !creatingBot ? roster.byId[id] : undefined
  const room = shown === 'groups' && id ? roster.roomsById[id] : undefined
  const activeGroup = section ? null : groups.find(group => group.pages.some(([key]) => key === shown)) ?? groups[0]
  const usageFocus = shown === 'usage' && id ? id : null
  const depth = bot || creatingBot || room || advanced || enginePlugins ? 1 : 0
  const atHome = shown === 'overview'
  const label = section ? section.label : creatingBot ? t('New Bot') : advanced ? t('Advanced settings') : enginePlugins ? t('Engine plugins') : atHome && narrowNav ? t('Settings') : t(activeGroup.label)
  // Phone width: the rail hides and Overview lists the pages, so each page leads back there.
  const back = bot || creatingBot ? t('Back to Bots') : room ? t('Back to group chats') : usageFocus ? t('All usage') : advanced ? t('Back to models') : enginePlugins ? t('Back to Plugins') : narrowNav && !atHome ? t('Settings') : null
  const goBack = () => actions.openSettings(depth > 0 || usageFocus ? shown : 'overview')
  const navKey = section ? `dsh:${section.id}` : activeGroup.id
  const nav = useGlide(navKey, { axis: 'y' })
  useEffect(() => {
    nav.box.current?.querySelector('[aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [navKey])

  const usableModels = (roster.models ?? []).filter(entry => entry.needsKey !== true && !isLocalRoute(entry.ref))
  const needsModel = hasProviders && usableModels.length === 0
  const keyMissing = (roster.models ?? []).some(entry => entry.needsKey === true && (roster.bots ?? []).some(one => (one.model ?? one.appliedModel) === entry.ref))
  const phoneConnected = Boolean(roster.phone?.on && roster.phone?.status === 'online' && (roster.phone?.phones ?? []).some(entry => entry.connected))

  const pickHit = (hit) => {
    if (!hit) return
    setPalette(false)
    if (tourRef.current) dismissTour()
    if (hit.expandAdvanced) {
      pendingAdvancedScroll.current = true
      setAdvancedToken(token => token + 1)
    }
    if (hit.page === 'dsh') go('dsh', hit.dshId)
    else go(hit.page, hit.target)
  }

  // The parts of a multi-part domain share one scrolling page while none is drilled into,
  // separated by crisp hairlines and synced with the top anchor bar.
  const parts = !section && depth === 0 && activeGroup.pages.length > 1 ? activeGroup.pages : null
  const partKeys = parts ? parts.map(([key]) => key) : []
  const [spied, setSpied] = useState(null)
  const activePart = parts ? (partKeys.includes(spied) ? spied : shown) : null
  const anchors = useGlide(activePart ?? '', { axis: 'x', selector: '[aria-current="location"]' })
  // Phone width: the anchor row scrolls sideways, so the current one stays in view.
  useEffect(() => {
    anchors.box.current?.querySelector?.('[aria-current=location]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activePart])

  // A page enters from the right when it is one level in, from the left when it comes
  // back out, and fades gently beside it. Parts of one domain share one scrolling page so
  // moving between them scrolls smoothly without replaying the domain entrance. Usage keeps
  // its own entrance and its data across its own levels, so they share one page.
  const pageKey = parts
    ? `group:${activeGroup.id}`
    : `${shown}:${bot?.id ?? (creatingBot ? 'new' : null) ?? room?.id ?? section?.id ?? (advanced ? 'advanced' : enginePlugins ? 'dsh' : shown === 'schedules' ? (id ?? '') : '')}`
  // The part an anchor scrolled to itself; the route it sets preserves any saved part request.
  const anchored = useRef(null)
  // A request a part opened with (a search's model preset, a new-task link, a Bot filter) stays
  // with the part while the user moves between the domain's parts; a new request replaces it,
  // and another domain or an explicit direct route (like "Show all") clears it.
  const requests = useRef({ pageKey, route: null, parts: {} })
  if (requests.current.pageKey !== pageKey) requests.current = { pageKey, route: null, parts: {} }
  const route = `${shown}|${id ?? ''}|${jump}`
  if (requests.current.route !== route) {
    requests.current.route = route
    if (shown === 'bot-models' || shown === 'schedules') {
      if (id) requests.current.parts[shown] = { key: `${shown}:${id}:${jump}`, id }
      else if (anchored.current !== shown) delete requests.current.parts[shown]
    }
  }
  const request = part => requests.current.parts[part]
  useEffect(() => { setError('') }, [pageKey])
  useEffect(() => { if (shown !== 'general' && advancedToken !== 0) setAdvancedToken(0) }, [shown])
  // A section guide runs while its domain stays open.
  useEffect(() => {
    if (!tour || tour.mode === 'full') return
    const owner = groups.find(group => group.pages.some(([key]) => key === tour.mode))
    if (section || owner?.id !== activeGroup?.id || depth > 0) setTour(null)
  }, [tour, shown, section, depth])

  // Opening a part scrolls to it, the first part to the top; a page's own data can still
  // arrive and move it, so the jump repeats once the page has settled unless the user
  // scrolled meanwhile. An anchor scrolls smoothly on its own and holds until arrival.
  const userScrolled = useRef(false)
  const pendingAdvancedScroll = useRef(false)
  const heading = useRef(null)
  const headingTimer = useRef(0)
  useEffect(() => () => clearTimeout(headingTimer.current), [])
  const scrollToAdvanced = () => {
    const box = scrollRef.current ?? dialogRef.current?.querySelector?.('.bt-settings-scroll')
    const target = box?.querySelector?.('[data-tour="advanced"]')
    if (!box || !target) return false
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 16
    box.scrollTo?.({ top: Math.max(0, top), behavior: 'auto' })
    return true
  }
  const scrollToPart = (key, smooth) => {
    const box = scrollRef.current
    const target = box?.querySelector?.(`[data-part="${key}"]`)
    if (!box || !target) return
    const top = key === partKeys[0] ? 0 : target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTo?.({ top: Math.max(0, top), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
  }
  useEffect(() => {
    if (shown !== 'general' || advancedToken === 0 || !pendingAdvancedScroll.current) return undefined
    const settle = () => {
      if (userScrolled.current) return
      scrollToAdvanced()
    }
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(settle) : 0
    const later = setTimeout(() => {
      settle()
      pendingAdvancedScroll.current = false
    }, 450)
    return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); clearTimeout(later) }
  }, [shown, advancedToken])
  useEffect(() => {
    if (!parts) return undefined
    if (anchored.current === shown) { anchored.current = null; return undefined }
    anchored.current = null
    heading.current = null
    setSpied(shown)
    userScrolled.current = false
    const settle = () => {
      if (userScrolled.current) return
      if (shown === 'general' && pendingAdvancedScroll.current) {
        if (scrollToAdvanced()) return
      }
      scrollToPart(shown, false)
    }
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(settle) : 0
    const later = setTimeout(settle, 420)
    // Lazy sibling sections above the target part may resolve after 420 ms and grow;
    // keep re-anchoring until the user takes over scrolling or the settle window ends.
    let observer = null
    let stopObserve = 0
    const box = scrollRef.current
    if (box && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        if (userScrolled.current) { observer?.disconnect(); observer = null; return }
        settle()
      })
      for (const el of box.querySelectorAll?.('[data-part]') ?? []) observer.observe(el)
      stopObserve = setTimeout(() => { observer?.disconnect(); observer = null }, 3000)
    }
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      clearTimeout(later)
      clearTimeout(stopObserve)
      observer?.disconnect()
    }
  }, [shown, pageKey, jump])
  const onPartsScroll = () => {
    const next = partAt(scrollRef.current)
    if (heading.current !== null) {
      if (next !== heading.current) return
      heading.current = null
    }
    if (next && next !== spied) setSpied(next)
  }
  const takeOver = () => {
    userScrolled.current = true
    heading.current = null
  }
  const goPart = (key) => {
    userScrolled.current = true
    heading.current = key
    clearTimeout(headingTimer.current)
    headingTimer.current = setTimeout(() => { heading.current = null }, 900)
    setSpied(key)
    scrollToPart(key, true)
    if (key !== shown) {
      anchored.current = key
      actions.openSettings(key)
    }
  }
  const onAnchorKeyDown = (event) => {
    if (!parts) return
    const currentIndex = partKeys.indexOf(activePart ?? shown)
    if (currentIndex < 0) return
    let nextIndex = -1
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % partKeys.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + partKeys.length) % partKeys.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = partKeys.length - 1
    if (nextIndex < 0) return
    event.preventDefault()
    const nextKey = partKeys[nextIndex]
    goPart(nextKey)
    anchors.box.current?.querySelector?.(`#bt-anchor-${nextKey}`)?.focus?.({ preventScroll: true })
  }

  const depthRef = useRef({ key: pageKey, depth, move: 'up' })
  if (depthRef.current.key !== pageKey) {
    depthRef.current = { key: pageKey, depth, move: depth > depthRef.current.depth ? 'in' : depth < depthRef.current.depth ? 'out' : 'up' }
  }
  // Usage stays mounted from its first visit until Settings closes: coming back to it
  // shows the same page at once instead of loading it again. Meanwhile it keeps its
  // rendered state off screen (content-visibility).
  const [usageOpened, setUsageOpened] = useState(shown === 'usage')
  if (shown === 'usage' && !usageOpened) setUsageOpened(true)
  // Over a domain's parts the error stays at the top of the view, whichever part failed.
  const errorLine = error
    ? h('div', { className: parts ? 'bt-error bt-set-error-pin' : 'bt-error', role: 'alert', style: parts ? undefined : { padding: 0 } },
      h('span', null, error),
      paletteFailures >= 2
        ? h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          style: { marginLeft: 8 },
          onClick: () => { requestWindowReload({ onBlocked: (reason) => { setError(reason) } }) },
        }, t('Reload window'))
        : null)
    : null

  const groupStatus = (groupId) => {
    if (groupId === 'models' && (needsModel || keyMissing)) return h('span', { className: 'bt-settings-dot', 'data-tone': 'warn', role: 'img', 'aria-label': t('Needs your attention') })
    if (groupId === 'connect' && phoneConnected) return h('span', { className: 'bt-settings-dot', 'data-tone': 'ok', role: 'img', 'aria-label': t('Phone online') })
    if (groupId === 'team' && (roster.bots?.length ?? 0) > 0) return h('span', { className: 'bt-settings-count' }, roster.bots.length)
    if (groupId === 'plugins' && roster.plugins?.pendingRestart) return h('span', { className: 'bt-settings-dot', 'data-tone': 'warn', role: 'img', 'aria-label': t('Restart required') })
    if (groupId === 'about' && update.available) return h('span', { className: 'bt-settings-chip' }, t('Update'))
    return null
  }

  const goUser = (nextPage, nextId) => {
    if (tourRef.current) dismissTour()
    go(nextPage, nextId)
  }

  const groupButton = (group) => {
    const active = !section && activeGroup.id === group.id
    return h('button', {
      key: group.id,
      type: 'button',
      className: 'bt-settings-item',
      'aria-current': active ? 'page' : undefined,
      onClick: () => goUser(group.pages[0][0]),
    },
    h(PAGE_ICONS[group.icon]),
    h('span', { className: 'bt-settings-label' }, t(group.label)),
    groupStatus(group.id))
  }
  const dshIcon = (row, size, active) => dsh.renderSlot('settings.section.icon', { size, active }, {
    only: row.id, fallback: h(DSH_ICONS[row.id] ?? IconSettingsOutlineMedium, { size }),
  })

  const topGroups = groups.filter(group => group.section === 'top')
  const mainGroups = groups.filter(group => group.section === 'main')
  const lastGroups = groups.filter(group => group.section === 'last')
  const guideKey = activePart ?? shown
  const showSectionGuide = !section && depth === 0 && !usageFocus && hasSectionTour(guideKey)

  // Phone width: Overview's list of pages, in the rail's order.
  const homeGroups = [
    { key: 'main', items: mainGroups.map(group => ({ key: group.id, label: t(group.label), iconKey: group.icon, page: group.pages[0][0] })) },
    extra.length > 0 ? { key: 'engine', items: extra.map(row => ({ key: `dsh:${row.id}`, label: row.label, icon: h('span', { className: 'bt-settings-icon' }, dshIcon(row, 16, false)), page: 'dsh', id: row.id })) } : null,
    { key: 'last', items: lastGroups.map(group => ({ key: group.id, label: t(group.label), iconKey: group.icon, page: group.pages[0][0] })) },
  ].filter(Boolean)

  const partPage = (key) => {
    switch (key) {
      case 'general': return h(GeneralPage, { roster, actions, run, dsh, openAdvanced: advancedToken })
      case 'shortcuts': return h(ShortcutsPage, { roster, actions, surfaceMode: dsh?.surfaceMode ?? 'bot', Section: SetSection, Row: SetRow })
      case 'models': return h(ProvidersPage, { actions, run, roster, Section: SetSection, advanced: hasSection(dsh, 'models') ? () => actions.openSettings('models', 'advanced') : null })
      case 'local-agents': return h(LocalAgentsPage, { run, Section: SetSection, Row: SetRow })
      // A preset opens the page afresh each time search offers it.
      case 'bot-models': return h(BotModelsPage, { key: request('bot-models')?.key ?? 'bot-models', roster, actions, run, Section: SetSection, preset: request('bot-models')?.id ?? null })
      // It reads the DeepSeek key once; a key saved under Providers changes the catalog's key.
      case 'deepseek-services': return h(DeepSeekServicesPage, {
        key: roster.modelsKey ?? '', actions, run, Section: SetSection, Row: SetRow, Switch, Segmented,
        onOpenWebSearch: hasSection(dsh, 'plugins') ? () => actions.openSettings('plugins', 'dsh:web-search') : undefined,
        openEnginePlugins: hasSection(dsh, 'plugins') ? () => actions.openSettings('plugins', 'dsh') : null,
      })
      case 'bots': return h(BotsPage, { roster, actions, run })
      case 'groups': return h(GroupsPage, { roster, actions, run })
      case 'schedules': return h(SchedulesPage, { key: request('schedules')?.key ?? 'schedules', roster, actions, start: request('schedules')?.id })
      case 'connectors': return h(ConnectorsPage, { roster, actions })
      case 'im': return h(ImPage, { roster, actions })
      case 'phone': return h(PhonePage, { roster, actions, Section: SetSection, Row: SetRow })
      case 'api': return h(ApiPage, { roster, actions, Section: SetSection, Row: SetRow })
      case 'computer': return h(ComputerPage, { roster, actions, run, Section: SetSection, Row: SetRow, Switch })
      case 'browser': return h(BrowserPage, { roster, actions, run, Section: SetSection, Row: SetRow })
      case 'capabilities': return h(CapabilitiesPage, { roster, actions, run })
      case 'secrets': return h(SecretsPage, { roster, actions, run, Section: SetSection })
      case 'privacy': return h(PrivacyPage, { actions, run, Section: SetSection, Row: SetRow, readOnly: Boolean(roster?.readOnly) })
      case 'feedback': return h(FeedbackPage, { actions, run, Section: SetSection, Row: SetRow })
      case 'about': return h(AboutPage, { useUpdate, actions, run, Section: SetSection, Row: SetRow, Switch, onStartTour: () => startTour('full'), inlineFeedback: false })
      default: return null
    }
  }
  const beta = key => (key === 'phone' ? h('span', { className: 'bt-tag bt-tab-tag' }, t('Beta')) : null)

  const body = () => {
    if (shown === 'usage') return null
    if (parts) {
      return h('div', {
        key: pageKey,
        ref: scrollRef,
        className: 'bt-settings-scroll bt-settings-page bt-settings-parts',
        'data-move': depthRef.current.move,
        'data-page': shown,
        onScroll: onPartsScroll,
        onWheel: takeOver,
        onTouchMove: takeOver,
        onKeyDown: (event) => { if (SCROLL_KEYS.has(event.key)) takeOver() },
        onPointerDown: (event) => { if (event.target === event.currentTarget) takeOver() },
      },
      errorLine,
      parts.map(([key, partLabel], index) => {
        const ownHead = index === 0 || OWN_HEAD_PARTS.has(key)
        return h('section', {
          key,
          className: 'bt-set-part',
          'data-part': key,
          'data-own-head': ownHead ? '' : undefined,
          'aria-label': ownHead ? t(partLabel) : undefined,
          'aria-labelledby': ownHead ? undefined : `bt-part-${key}`,
        },
        ownHead ? null : h('h3', { id: `bt-part-${key}`, className: 'bt-part-head' }, t(partLabel), beta(key)),
        h(PageBoundary, { reset: `${pageKey}:${key}` }, partPage(key)))
      }))
    }
    return h('div', { key: pageKey, className: 'bt-settings-scroll bt-settings-page', 'data-move': depthRef.current.move, 'data-page': shown },
      errorLine,
      h(PageBoundary, null,
        atHome ? h(OverviewPage, {
          roster, actions, run, icons: PAGE_ICONS, hasProviders, needsModel, homeGroups,
          homeStatus: key => groupStatus(key),
          onHomeOpen: item => (item.page === 'dsh' ? goUser('dsh', item.id) : goUser(item.page)),
          onSearch: openPalette,
          narrow: narrowNav,
          keyMissing,
        }) : null,
        shown === 'general' ? h(GeneralPage, { roster, actions, run, dsh, openAdvanced: advancedToken }) : null,
        shown === 'appearance' ? h(AppearancePage, { roster, actions, run, Section: SetSection, Row: SetRow, Choice, Switch, ownWindow: dsh?.ownWindow ?? (dsh === undefined), dshRows: lookRows(dsh) }) : null,
        shown === 'plugins' && !enginePlugins ? h(PluginsPage, { roster, actions, Section: SetSection, Row: SetRow, initialFilter: id === 'browser' ? 'browser' : null, ownWindow: dsh?.ownWindow, openEnginePlugins: hasSection(dsh, 'plugins') ? () => actions.openSettings('plugins', 'dsh') : null }) : null,
        enginePlugins ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close, subTarget, jump }, { only: 'plugins' })) : null,
        advanced ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close }, { only: 'models' })) : null,
        section ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close, subTarget }, { only: section.id })) : null,
        creatingBot ? h('div', { className: 'bt-settings-form' }, h(CreateBot, { roster, actions, inline: true, onBack: () => actions.openSettings('bots'), onCreated: created => actions.openSettings('bots', created.id) })) : null,
        bot ? h('div', { className: 'bt-settings-form' }, h(BotSettingsForm, { key: bot.id, bot, roster, actions, run })) : null,
        room ? h('div', { className: 'bt-settings-form' }, h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null,
        !parts && !atHome && !bot && !creatingBot && !room && !advanced && !enginePlugins && !section && !['general', 'appearance', 'plugins', 'usage'].includes(shown) ? partPage(shown) : null))
  }

  return h('div', { className: 'bt-settings-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { ref: dialogRef, className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('Settings'), 'data-shortcut-modal': 'settings', 'data-home': atHome || undefined },
      h('div', { className: 'bt-settings-rail' },
        h('button', { type: 'button', className: 'bt-set-search', 'data-tour': 'search', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': isMac() ? 'Meta+K' : 'Control+K', onClick: openPalette },
          h(SearchIcon),
          h('span', { className: 'bt-set-search-label' }, t('Search')),
          h('kbd', { className: 'bt-set-kbd' }, isMac() ? '⌘K' : 'Ctrl K')),
        h('nav', { ref: nav.box, className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
          h('span', { ref: nav.thumb, className: 'bt-thumb', 'aria-hidden': true }),
          topGroups.map(groupButton),
          h('span', { className: 'bt-settings-gap', 'aria-hidden': true }),
          mainGroups.map(groupButton),
          extra.length > 0 ? h('span', { className: 'bt-settings-heading' }, t('Engine')) : null,
          extra.map(row => h('button', {
            key: `dsh:${row.id}`, type: 'button', className: 'bt-settings-item', 'aria-current': section?.id === row.id ? 'page' : undefined,
            onClick: () => goUser('dsh', row.id),
          }, h('span', { className: 'bt-settings-icon', 'aria-hidden': true }, dshIcon(row, 16, section?.id === row.id)), h('span', { className: 'bt-settings-label' }, row.label))),
          h('span', { className: 'bt-settings-fill', 'aria-hidden': true }),
          lastGroups.map(groupButton))),
      h('div', { className: 'bt-settings-main' },
        h('div', { className: 'bt-settings-head', 'data-parts': parts ? '' : undefined },
          back ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': back, title: back, onClick: goBack }, h(ChevronLeftIcon)) : null,
          h('h2', { key: bot?.id ?? (creatingBot ? 'new' : null) ?? room?.id ?? section?.id ?? (advanced ? 'advanced' : enginePlugins ? 'dsh' : activeGroup.id) }, bot?.name ?? room?.name ?? label),
          h('div', { className: 'bt-settings-head-end' },
            dsh ? h('div', { className: 'bt-settings-actions' }, dsh.renderSlot('settings.action', {})) : null,
            showSectionGuide ? h('button', {
              type: 'button',
              className: 'bt-soft bt-soft-sm bt-with-icon bt-tour-trigger',
              onClick: () => startTour(guideKey),
            }, h(CompassIcon), t('Guide')) : null)),
        parts ? h('nav', {
          ref: anchors.box,
          className: 'bt-settings-anchors',
          'aria-label': t('On this page'),
          onKeyDown: onAnchorKeyDown,
        },
          h('span', { ref: anchors.thumb, className: 'bt-thumb', 'aria-hidden': true }),
          parts.map(([key, partLabel]) => h('button', {
            key,
            id: `bt-anchor-${key}`,
            type: 'button',
            className: 'bt-anchor',
            'aria-current': activePart === key ? 'location' : undefined,
            onClick: () => goPart(key),
          }, t(partLabel), beta(key)))) : null,
        body(),
        usageOpened ? h('div', { key: 'usage', className: 'bt-settings-scroll bt-settings-usage', 'data-off': shown === 'usage' ? undefined : '', 'aria-hidden': shown === 'usage' ? undefined : true, inert: shown !== 'usage' },
          shown === 'usage' ? errorLine : null,
          h(PageBoundary, { reset: shown }, h(UsagePage, { roster, actions, focusId: usageFocus }))) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon)),
      palette && !leaving ? h(PaletteBoundary, {
        onError: () => {
          SettingsPalette.reset?.()
          setPalette(false)
          setPaletteFailures(count => count + 1)
          setError(t('This page could not be shown.'))
        },
      }, h(SettingsPalette, {
        roster, extra, dsh, icons: PAGE_ICONS, pageAvailable, hasSurface,
        onPick: pickHit,
        onClose: () => setPalette(false),
        returnFocus: true,
      })) : null,
      leaving ? null : h(SettingsTour, {
        tour,
        currentPage: activePart ?? shown,
        dialogRef,
        hasProviders,
        hasAdvancedModels: hasSection(dsh, 'models'),
        onNavigate: navigateForTour,
        onDismiss: dismissTour,
      })))
}
