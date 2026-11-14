import { Component, createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { ACCENT_INKS, INKS } from './inks.js'
import { isMainOf } from './sources.js'
import { MESSAGE_WIDTH, allThemes, effectsOf, flatWidthOf, layoutOf, thinkingShown, widthOf } from './themes.js'
import { CloseIcon, ChevronLeftIcon, ChevronRightIcon, ChatsIcon, ClockIcon, ConnectorIcon, GlobeIcon, InfoIcon, MonitorIcon, PhoneIcon, PlugIcon, PlusIcon, SlidersIcon, TerminalIcon, SETTINGS_ICONS } from './icons.js'
import { IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminStar, BotAvatar, RoomAvatar } from './mark.js'
import { useEscape } from './overlay-hooks.js'
import { BotSettingsForm, Switch } from './bot-settings.js'
import { Segmented, useGlide } from './motion.js'
import { GroupSettingsForm, NewGroupForm } from './group-settings.js'
import { CreateBot } from './create-bot.js'
import { KeptPrivateSection } from './kept-private.js'
import { KeyIcon, SecretsPage } from './secret-card.js'
import { UsagePage } from './usage-page.js'
import { ConnectorsPage } from './connectors-page.js'
import { PhonePage } from './phone-page.js'
import { ImPage } from './im-page.js'
import { CapabilitiesPage } from './capability-settings.js'
import { BrowserPage } from './browser-settings.js'
import { ComputerPage } from './computer.js'
import { SchedulesPage } from './schedules.js'
import { FeedbackIcon, FeedbackPage } from './feedback.js'
import { AboutPage } from './about.js'
import { ProvidersPage } from './providers-page.js'
import { LocalAgentsPage } from './local-agents-page.js'
import { FolderMenu } from './folder-menu.js'
import { ModelMenu } from './model-menu.js'
import { isLocalRoute } from './agent-routes.js'
import { t } from './i18n.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

// Settings dialog: a 198px page list beside the page. Bots and group chats each list
// their members, and one opens on its own settings form. Usage widens the dialog.
// DS Bot's pages come first; below a rule, the pages DSH and other plugins register
// (`settings.section`), then Feedback and About. DSH's General rows join General, and
// its Models page opens from DS Bot's Models page as the advanced settings.
const SETTINGS_PAGES = [['general', 'General'], ['models', 'Models'], ['local-agents', 'Local agents'], ['bots', 'Bots'], ['groups', 'Group chats'], ['connectors', 'Connectors'], ['im', 'IM'], ['phone', 'Phone'], ['capabilities', 'Capabilities'], ['browser', 'Browser'], ['computer', 'Computer use'], ['schedules', 'Scheduled tasks'], ['usage', 'Usage'], ['secrets', 'Secrets'], ['feedback', 'Feedback'], ['about', 'About DS Bot']]
const LAST_PAGES = new Set(['feedback', 'about'])
// DSH sections DS Bot's own pages already hold.
const MERGED_SECTIONS = new Set(['general', 'models'])
// DSH General rows that sit under Appearance; the rest go under More.
const LOOK_ITEMS = ['appearance', 'font-size']
const DSH_ICONS = { account: IconUserOutlineMedium, 'agent-presets': IconAgentPresetOutlineMedium, plugins: IconPersonalizationOutlineMedium, 'archived-sessions': IconArchiveOutlineMedium }
export const dshPages = dsh => (dsh?.sections ?? []).filter(row => row.id !== '' && !MERGED_SECTIONS.has(row.id))
const hasSection = (dsh, id) => (dsh?.sections ?? []).some(row => row.id === id)
const dshItem = (dsh, id) => h('div', { key: id, className: 'bt-dsh-item', 'data-item': id }, dsh.renderSlot('settings.general.item', {}, { only: id }))
const PAGE_ICONS = { ...SETTINGS_ICONS, models: SlidersIcon, 'local-agents': TerminalIcon, connectors: ConnectorIcon, im: ChatsIcon, phone: PhoneIcon, capabilities: PlugIcon, browser: GlobeIcon, computer: MonitorIcon, schedules: ClockIcon, secrets: KeyIcon, feedback: FeedbackIcon, about: InfoIcon }

// What each MEMORY.md holds by default, in characters of entry text.
const MEMORY_SIZES = [
  { scope: 'group', label: 'Group memory size', size: 12_000 },
  { scope: 'bot', label: 'Bot memory size', size: 8_000 },
  { scope: 'team', label: 'Team memory size', size: 4_000 },
]
function MemorySize({ label, value, save }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const number = Number(text)
    if (Number.isInteger(number) && number >= 1_000 && number <= 200_000 && number !== value) save(number)
    else setText(String(value))
  }
  return h('input', { className: 'bt-input bt-set-number', type: 'number', min: 1_000, max: 200_000, step: 1_000, 'aria-label': label, value: text, onChange: event => setText(event.target.value), onBlur: commit, onKeyDown: event => { if (event.key === 'Enter') event.target.blur() } })
}

function SetSection({ title, action = null, className = '', children }) {
  return h('section', { className: `bt-set-section ${className}`.trim() },
    action ? h('div', { className: 'bt-la-sec-head' }, h('h3', null, title), action) : title ? h('h3', null, title) : null,
    h('div', { className: 'bt-set-card' }, children))
}
function SetRow({ label, hint, children, className = '' }) {
  return h('div', { className: `bt-set-row ${className}`.trim() },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)
}

const LAYOUTS = [['bubble', 'Bubble'], ['flat', 'Flat']]
const EFFECTS = [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'None']]

function Choice({ label, value, options, pick }) {
  return h(Segmented, { label, value, className: 'bt-look-seg' }, options.map(([id, text]) => h('button', {
    key: id, type: 'button', 'aria-pressed': value === id,
    onClick: () => { if (value !== id) pick(id) },
  }, t(text))))
}

// A width in percent of the column. A drag saves once it rests, as the custom accent
// does; a change still waiting when the dialog closes is saved, not dropped.
function WidthSlider({ label, value, save }) {
  const [width, setWidth] = useState(value)
  const pending = useRef(null)
  const timer = useRef(0)
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => { if (pending.current === null) setWidth(value) }, [value])
  const flush = () => {
    const next = pending.current
    pending.current = null
    if (next !== null) saveRef.current(next)
  }
  useEffect(() => () => { clearTimeout(timer.current); flush() }, [])
  const pick = (next) => {
    setWidth(next)
    pending.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 350)
  }
  const { min, max, step } = MESSAGE_WIDTH
  return h('div', { className: 'bt-range', style: { '--bt-fill': `${((width - min) / (max - min)) * 100}%` } },
    h('input', { type: 'range', min, max, step, value: width, 'aria-label': label, 'aria-valuetext': `${width}%`, onChange: event => pick(Number(event.target.value)) }),
    h('output', null, `${width}%`))
}

function GeneralPage({ roster, actions, run, dsh }) {
  const items = (dsh?.items ?? []).map(row => row.id).filter(id => id !== '')
  const look = LOOK_ITEMS.filter(id => items.includes(id))
  const more = items.filter(id => !LOOK_ITEMS.includes(id))
  const prefs = roster.prefs ?? {}
  const themes = allThemes()
  const current = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const [custom, setCustom] = useState(prefs.accent ?? '#4d6bfe')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const pickCustom = (value) => {
    setCustom(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => run(actions.setPrefs({ accent: value })), 350)
  }
  return [
    h(SetSection, { key: 'look', title: t('Appearance') },
      h(SetRow, { label: t('Theme'), hint: t('Colors for the whole team, on every device.') },
        h('select', { className: 'bt-select', 'aria-label': t('Theme'), value: current, onChange: event => run(actions.setPrefs({ theme: event.target.value })) },
          Object.entries(themes).map(([id, theme]) => h('option', { key: id, value: id }, t(theme.label))))),
      h(SetRow, { label: t('Accent'), hint: t('Unread marks, badges, and the brand mark.') },
        h('div', { className: 'bt-swatches' },
          h('button', { type: 'button', className: 'bt-swatch bt-swatch-default', title: t('Theme accent'), 'aria-label': t('Theme accent'), 'aria-pressed': !prefs.accent, onClick: () => run(actions.setPrefs({ accent: null })) }),
          ACCENT_INKS.map(ink => h('button', {
            key: ink, type: 'button', className: 'bt-swatch', title: t(capitalize(ink)), 'aria-label': t(capitalize(ink)), 'aria-pressed': prefs.accent === INKS[ink][0],
            style: { background: INKS[ink][0] }, onClick: () => run(actions.setPrefs({ accent: INKS[ink][0] })),
          })),
          h('label', { className: 'bt-swatch bt-swatch-custom', title: t('Custom accent'), 'data-on': Boolean(prefs.accent) && !ACCENT_INKS.some(ink => INKS[ink][0] === prefs.accent) },
            h('input', { type: 'color', value: custom, 'aria-label': t('Custom accent'), onChange: event => pickCustom(event.target.value) })))),
      h(SetRow, { label: t('Message layout') }, h(Choice, { label: t('Message layout'), value: layoutOf(prefs), options: LAYOUTS, pick: id => run(actions.setPrefs({ layout: id })) })),
      // The flat layout's text has a width of its own; the bubble width stays for the user's messages.
      layoutOf(prefs) === 'flat' ? h(SetRow, { label: t('Text width') }, h(WidthSlider, { label: t('Text width'), value: flatWidthOf(prefs), save: flatWidth => run(actions.setPrefs({ flatWidth })) })) : null,
      h(SetRow, { label: t('Bubble width') }, h(WidthSlider, { label: t('Bubble width'), value: widthOf(prefs), save: width => run(actions.setPrefs({ width })) })),
      h(SetRow, { label: t('Interface motion') }, h(Choice, { label: t('Interface motion'), value: effectsOf(prefs), options: EFFECTS, pick: id => run(actions.setPrefs({ effects: id })) })),
      h(SetRow, { label: t('Show thinking') }, h(Switch, { label: t('Show thinking'), on: thinkingShown(prefs), onChange: thinking => run(actions.setPrefs({ thinking })) })),
      look.map(id => dshItem(dsh, id))),
    h(SetSection, { key: 'new', title: t('New Bots') },
      h(SetRow, { label: t('Default model'), className: 'bt-set-model' },
        h(ModelMenu, {
          bot: { id: 'new-bots', name: t('New Bots'), model: isLocalRoute(prefs.defaultBotModel) ? undefined : prefs.defaultBotModel },
          roster, actions, run, wide: true, withEfforts: false,
          onPick: ref => run(actions.setPrefs({ defaultBotModel: ref })),
        }),
        prefs.defaultBotModel ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setPrefs({ defaultBotModel: null })) }, t('Reset')) : null)),
    h(SetSection, { key: 'input', title: t('Input') },
      h(SetRow, { label: t('Enter sends message') },
        h(Switch, { label: t('Enter sends message'), on: prefs.enterToSend !== false, onChange: enterToSend => run(actions.setPrefs({ enterToSend })) }))),
    h(SetSection, { key: 'memory', title: t('Memory') },
      h(SetRow, { label: t('Bring up related memory') },
        h(Switch, { label: t('Bring up related memory'), on: prefs.memoryAutoRecall !== false, onChange: memoryAutoRecall => run(actions.setPrefs({ memoryAutoRecall })) })),
      MEMORY_SIZES.map(({ scope, label, size }) => h(SetRow, { key: scope, label: t(label) },
        h(MemorySize, { label: t(label), value: prefs.memoryLimits?.[scope] ?? size, save: value => run(actions.setPrefs({ memoryLimits: { [scope]: value } })) })))),
    // Settings opens in Agent mode too; there the way goes back to Bot mode.
    actions.setSurface ? h(SetSection, { key: 'mode', title: t('Mode') },
      actions.surfaceMode?.() === 'agent'
        ? h(SetRow, { label: t('Bot mode') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.setSurface('bot') }, t('Switch')))
        : h(SetRow, { label: t('Classic Agent mode') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.setSurface('agent') }, t('Switch')))) : null,
    h(LocationsSection, { key: 'places', actions, run }),
    more.length > 0 ? h(SetSection, { key: 'more', title: t('More'), className: 'bt-dsh-items' }, more.map(id => dshItem(dsh, id))) : null,
  ]
}

// The desktop app's preload hands its window `dsBotApp`; only there does the data location
// show, since DSH keeps the plugin's data where it runs.
function LocationsSection({ actions, run }) {
  const app = globalThis.dsBotApp
  const [team, setTeam] = useState(null)
  const [data, setData] = useState(null)
  // One change at a time: the data move checks the new folder against the team workspace, and
  // a later team workspace must not finish before an earlier one.
  const [moving, setMoving] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    void Promise.resolve(actions.folders()).then(info => setTeam(info?.team ?? null)).catch(() => {})
    if (app !== undefined) void Promise.resolve(app.dataLocation()).then(setData).catch(() => {})
  }, [])
  const pickTeam = (path) => {
    if (busy.current) return undefined
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
  return h(SetSection, { title: t('Locations'), className: 'bt-set-places' },
    h(SetRow, { label: t('Team workspace'), hint: t('Where Bots without a folder of their own work.') },
      team === null ? null : h(FolderMenu, { value: team, team: true, actions, run, onPick: pickTeam, disabled: moving })),
    data === null ? null : h(SetRow, { label: t('Data location'), hint: data.path },
      data.fixed ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: moving, onClick: () => { if (!busy.current) void run(app.moveData(team ?? undefined)) } }, t('Change…'))))
}

// The first Main Bot is the sidebar tile. Picking another Bot there hands it the role
// in one step; more Main Bots can sit beside it.
function MainBotsSection({ roster, actions, run }) {
  const mains = (roster.mainBotIds ?? []).map(id => roster.byId[id]).filter(Boolean)
  const [first, ...others] = mains
  const candidates = roster.bots.filter(bot => !isMainOf(roster, bot.id))
  return h(SetSection, { title: t('Main Bot') },
    h(SetRow, {
      label: t('Main Bot'),
      hint: first ? t('First in the sidebar. Pick another Bot to hand it the role; {name} then stops being a Main Bot.', { name: first.name }) : undefined,
    },
    h('select', {
      className: 'bt-select', 'aria-label': t('Main Bot'), value: first?.id ?? '',
      onChange: event => run(actions.setMain(event.target.value, true, first ? { replace: first.id } : {})),
    }, first ? null : h('option', { value: '' }, t('Choose a Bot…')), roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
    others.map(bot => h(SetRow, { key: bot.id, label: bot.name, hint: t('Also a Main Bot.') },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, true, { primary: true })) }, t('Move to first')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, false)) }, t('Remove Main Bot role')))),
    candidates.length > 0 ? h(SetRow, { label: t('Add a Main Bot'), hint: t('Main Bots can create and change Bots, and run every group chat.') },
      h('select', {
        className: 'bt-select', 'aria-label': t('Add a Main Bot'), value: '',
        onChange: (event) => { if (event.target.value) void run(actions.setMain(event.target.value, true)) },
      }, h('option', { value: '' }, t('Choose a Bot…')), candidates.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))) : null)
}

const MOTIONS = [['quiet', 'Quiet'], ['normal', 'Normal'], ['lively', 'Lively']]
function MotionSection({ roster, actions, run }) {
  const motion = roster.prefs?.motion === 'quiet' || roster.prefs?.motion === 'lively' ? roster.prefs.motion : 'normal'
  return h(SetSection, { title: t('Animation') },
    h(SetRow, { label: t('Bot animation') },
      h(Segmented, { label: t('Bot animation'), value: motion, className: 'bt-motion-seg' }, MOTIONS.map(([id, label]) => h('button', {
        key: id, type: 'button', 'aria-pressed': motion === id,
        onClick: () => { if (motion !== id) run(actions.setPrefs({ motion: id })) },
      }, t(label))))))
}

function BotsPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  const newBotBtn = creating ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setCreating(true) }, h(PlusIcon), t('New Bot'))
  return [
    h(MainBotsSection, { key: 'main', roster, actions, run }),
    h(MotionSection, { key: 'motion', roster, actions, run }),
    creating ? h(CreateBot, { key: 'create', roster, actions, inline: true, onBack: () => setCreating(false), onCreated: bot => actions.openSettings('bots', bot.id) }) : null,
    h(SetSection, { key: 'bots', title: t('Bots · {count}', { count: roster.bots.length }), action: newBotBtn },
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
  const [creating, setCreating] = useState(false)
  const newGroupBtn = creating ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: roster.bots.length < 2, title: roster.bots.length < 2 ? t('A group chat needs at least two Bots') : undefined, onClick: () => setCreating(true) }, h(PlusIcon), t('Create group chat'))
  return [
    creating ? h(NewGroupForm, { key: 'create', roster, actions, run, onCancel: () => setCreating(false), onCreated: room => actions.openSettings('groups', room.id) }) : null,
    h(SetSection, { key: 'groups', title: t('Group chats · {count}', { count: roster.rooms.length }), action: newGroupBtn },
      roster.rooms.length === 0
        ? h(SetRow, { label: t('No group chats yet.'), hint: t('A group chat lets several Bots work on one thing with you.') })
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
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(previous) { if (this.state.failed && previous.reset !== this.props.reset) this.setState({ failed: false }) }
  componentDidCatch(error) { console.error('ds-bot: a settings page failed', error) }
  render() { return this.state.failed ? h('div', { className: 'bt-error', role: 'alert' }, t('This page could not be shown.')) : this.props.children }
}

// While `leaving`, the dialog plays its exit and takes no input.
export function SettingsDialog({ page, id, roster, actions, useUpdate, leaving = false, dsh }) {
  const [error, setError] = useState('')
  const close = useCallback(() => actions.closeSettings(), [])
  useEscape(close)
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  // A Bot or group deleted while its form is open leaves its page on the list.
  const bot = page === 'bots' && id ? roster.byId[id] : undefined
  const room = page === 'groups' && id ? roster.roomsById[id] : undefined
  const pages = SETTINGS_PAGES.filter(([key]) => key !== 'models' || actions.providers !== undefined)
  const extra = dshPages(dsh)
  // A DSH page is `dsh` with its section id; one no longer registered falls back to General.
  const section = page === 'dsh' ? extra.find(row => row.id === id) : undefined
  // DSH's Models page, one level into Models.
  const advanced = page === 'models' && id === 'advanced' && hasSection(dsh, 'models')
  const shown = section ? 'dsh' : pages.some(([key]) => key === page) ? page : 'general'
  const usageFocus = shown === 'usage' && id ? id : null
  const label = section ? section.label : advanced ? t('Advanced settings') : t(pages.find(([key]) => key === shown)[1])
  const back = bot ? t('Back to Bots') : room ? t('Back to group chats') : usageFocus ? t('All usage') : advanced ? t('Back to models') : null
  const nav = useGlide(section ? `dsh:${section.id}` : shown, { axis: 'y' })
  // A page enters from the right when it is one level in, from the left when it comes
  // back out, and from below beside it. Usage keeps its own entrance and its data
  // across its own levels, so they share one page.
  const pageKey = `${shown}:${bot?.id ?? room?.id ?? section?.id ?? (advanced ? 'advanced' : '')}`
  const depth = bot || room || advanced ? 1 : 0
  const last = useRef({ key: pageKey, depth, move: 'up' })
  if (last.current.key !== pageKey) {
    last.current = { key: pageKey, depth, move: depth > last.current.depth ? 'in' : depth < last.current.depth ? 'out' : 'up' }
  }
  // Usage stays mounted from its first visit until Settings closes: coming back to it
  // shows the same page at once instead of loading it again. Meanwhile it keeps its
  // rendered state off screen (content-visibility).
  const [usageOpened, setUsageOpened] = useState(shown === 'usage')
  if (shown === 'usage' && !usageOpened) setUsageOpened(true)
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  const pageButton = (key, text) => h('button', {
    key, type: 'button', className: 'bt-settings-item', 'aria-current': shown === key ? 'page' : undefined, onClick: () => actions.openSettings(key),
  }, h(PAGE_ICONS[key]), t(text), key === 'phone' ? h('span', { className: 'bt-tag', style: { marginLeft: 'auto' } }, t('Beta')) : null)
  return h('div', { className: 'bt-settings-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('Settings'), 'data-shortcut-modal': 'settings' },
      h('nav', { ref: nav.box, className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
        h('span', { ref: nav.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        pages.filter(([key]) => !LAST_PAGES.has(key)).map(([key, text]) => pageButton(key, text)),
        extra.length > 0 ? h('span', { className: 'bt-settings-rule', 'aria-hidden': true }) : null,
        extra.map(row => h('button', {
          key: `dsh:${row.id}`, type: 'button', className: 'bt-settings-item', 'aria-current': section?.id === row.id ? 'page' : undefined,
          onClick: () => actions.openSettings('dsh', row.id),
        }, h('span', { className: 'bt-settings-icon', 'aria-hidden': true }, dsh.renderSlot('settings.section.icon', { size: 16, active: section?.id === row.id }, {
          only: row.id, fallback: h(DSH_ICONS[row.id] ?? IconSettingsOutlineMedium, { size: 16 }),
        })), row.label)),
        h('span', { className: 'bt-settings-rule', 'aria-hidden': true }),
        pages.filter(([key]) => LAST_PAGES.has(key)).map(([key, text]) => pageButton(key, text))),
      h('div', { className: 'bt-settings-main' },
        h('div', { className: 'bt-settings-head' },
          back ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': back, title: back, onClick: () => actions.openSettings(shown) }, h(ChevronLeftIcon)) : null,
          h('h2', { key: bot?.id ?? room?.id ?? section?.id ?? (advanced ? 'advanced' : shown) }, bot?.name ?? room?.name ?? label),
          dsh ? h('div', { className: 'bt-settings-actions' }, dsh.renderSlot('settings.action', {})) : null),
        shown === 'usage' ? null : h('div', { key: pageKey, className: 'bt-settings-scroll bt-settings-page', 'data-move': last.current.move },
          errorLine,
          h(PageBoundary, null,
          shown === 'computer' ? h(ComputerPage, { roster, actions, run, Section: SetSection, Row: SetRow, Switch }) : null,
          shown === 'general' ? h(GeneralPage, { roster, actions, run, dsh }) : null,
          shown === 'models' && !advanced ? h(ProvidersPage, { actions, run, Section: SetSection, advanced: hasSection(dsh, 'models') ? () => actions.openSettings('models', 'advanced') : null }) : null,
          advanced ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close }, { only: 'models' })) : null,
          section ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close }, { only: section.id })) : null,
          shown === 'local-agents' ? h(LocalAgentsPage, { run, Section: SetSection, Row: SetRow }) : null,
          bot ? h('div', { className: 'bt-settings-form' }, h(BotSettingsForm, { key: bot.id, bot, roster, actions, run })) : null,
          shown === 'bots' && !bot ? h(BotsPage, { roster, actions, run }) : null,
          room ? h('div', { className: 'bt-settings-form' }, h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null,
          shown === 'groups' && !room ? h(GroupsPage, { roster, actions, run }) : null,
          shown === 'connectors' ? h(ConnectorsPage, { roster, actions }) : null,
          shown === 'im' ? h(ImPage, { roster, actions }) : null,
          shown === 'capabilities' ? h(CapabilitiesPage, { roster, actions, run }) : null,
          shown === 'phone' ? h(PhonePage, { roster, actions, Section: SetSection, Row: SetRow }) : null,
          shown === 'browser' ? h(BrowserPage, { roster, actions, run, Section: SetSection, Row: SetRow }) : null,
          shown === 'schedules' ? h(SchedulesPage, { roster, actions, start: id ?? undefined }) : null,
          shown === 'secrets' ? h(SecretsPage, { roster, actions, run, Section: SetSection }) : null,
          shown === 'feedback' ? h(FeedbackPage, { actions, run, Section: SetSection, Row: SetRow }) : null,
          shown === 'about' ? h(AboutPage, { useUpdate, actions, run, Section: SetSection, Row: SetRow }) : null)),
        usageOpened ? h('div', { key: 'usage', className: 'bt-settings-scroll bt-settings-usage', 'data-off': shown === 'usage' ? undefined : '', 'aria-hidden': shown === 'usage' ? undefined : true },
          shown === 'usage' ? errorLine : null,
          h(PageBoundary, { reset: shown }, h(UsagePage, { roster, actions, focusId: usageFocus }))) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon))))
}
