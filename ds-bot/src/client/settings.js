import { Component, createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACCENT_INKS, INKS } from './inks.js'
import { isMainOf } from './sources.js'
import { MESSAGE_WIDTH, allThemes, effectsOf, flatWidthOf, layoutOf, thinkingShown, widthOf } from './themes.js'
import { BlocksIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, CloseIcon, CompassIcon, ConnectorIcon, GlobeIcon, InfoIcon, LayersIcon, MonitorIcon, PaletteIcon, PhoneIcon, PlugIcon, PlusIcon, PuzzleIcon, SearchIcon, SendIcon, SlidersIcon, TerminalIcon, WaveIcon, SETTINGS_ICONS } from './icons.js'
import { IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium } from './dsh-primitives.js'
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
import { McpPage } from './mcp-page.js'
import { ImPage } from './im-page.js'
import { CapabilitiesPage } from './capability-settings.js'
import { DeepSeekServicesPage } from './services-settings.js'
import { BrowserPage } from './browser-settings.js'
import { ComputerPage } from './computer.js'
import { SchedulesPage } from './schedules.js'
import { FeedbackIcon, FeedbackPage } from './feedback.js'
import { AboutPage } from './about.js'
import { ProvidersPage } from './providers-page.js'
import { LocalAgentsPage } from './local-agents-page.js'
import { BotModelsPage } from './bot-models-page.js'
import { SettingsTour, canAutoStartTour, hasSectionTour, markTourSeen } from './settings-tour.js'
import { FolderMenu } from './folder-menu.js'
import { ModelMenu } from './model-menu.js'
import { isLocalRoute } from './agent-routes.js'
import { isImeComposing } from './enter-key.js'
import { noteClientError } from './diagnostics.js'
import { t } from './i18n.js'
import { PREFERENCE_ITEMS, SettingsPreferences } from './settings-preferences.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

// Settings dialog: a grouped 212px nav rail beside the page, with search on top and
// in-page segmented tabs inside multi-page domains. Every existing openSettings(page, id)
// route resolves to its owning nav group and sub-tab.
const NAV_GROUPS = [
  { id: 'general', label: 'General', icon: 'general', pages: [['general', 'General']], section: 'main' },
  { id: 'appearance', label: 'Appearance', icon: 'appearance', pages: [['appearance', 'Appearance']], section: 'main' },
  {
    id: 'models',
    label: 'Models',
    icon: 'models',
    pages: [['models', 'Providers'], ['bot-models', 'Bot models'], ['local-agents', 'Local agents'], ['deepseek-services', 'DeepSeek services']],
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
    pages: [['connectors', 'Connectors'], ['im', 'IM'], ['phone', 'Phone'], ['mcp', 'MCP access']],
    section: 'main',
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: 'capabilities',
    pages: [['computer', 'Computer use'], ['browser', 'Browser'], ['capabilities', 'Capabilities'], ['secrets', 'Secrets']],
    section: 'main',
  },
  { id: 'usage', label: 'Usage', icon: 'usage', pages: [['usage', 'Usage']], section: 'main' },
  {
    id: 'about',
    label: 'About DS Bot',
    icon: 'about',
    pages: [['about', 'About DS Bot'], ['feedback', 'Feedback']],
    section: 'last',
  },
]

const GROUP_ALIASES = { team: 'bots', connect: 'connectors', tools: 'computer' }

// DSH sections DS Bot's own pages already hold.
const MERGED_SECTIONS = new Set(['general', 'models'])
// DSH General rows placed in Appearance or Basics; the rest go under Advanced.
const LOOK_ITEMS = ['appearance', 'font-size']
const BASIC_ITEMS = ['language', 'composer-enter']
const DSH_ICONS = { account: IconUserOutlineMedium, 'agent-presets': IconAgentPresetOutlineMedium, plugins: PuzzleIcon, 'archived-sessions': IconArchiveOutlineMedium }
export const dshPages = dsh => (dsh?.sections ?? []).filter(row => row.id !== '' && !MERGED_SECTIONS.has(row.id))
const hasSection = (dsh, id) => (dsh?.sections ?? []).some(row => row.id === id)
const dshItem = (dsh, id) => h('div', { key: id, className: 'bt-dsh-item', 'data-item': id },
  dsh.preferences && PREFERENCE_ITEMS.has(id) ? h(SettingsPreferences, { id, preferences: dsh.preferences }) : dsh.renderSlot('settings.general.item', {}, { only: id }))
const PAGE_ICONS = { ...SETTINGS_ICONS, appearance: PaletteIcon, models: SlidersIcon, 'bot-models': LayersIcon, 'local-agents': TerminalIcon, connectors: ConnectorIcon, im: SendIcon, phone: PhoneIcon, mcp: PlugIcon, capabilities: BlocksIcon, 'deepseek-services': WaveIcon, browser: GlobeIcon, computer: MonitorIcon, schedules: ClockIcon, secrets: KeyIcon, feedback: FeedbackIcon, about: InfoIcon }

// Search index covering every page, sub-tab, and key control (English + localized labels).
const SEARCH_ENTRIES = [
  { id: 'general', label: 'General', group: 'General', page: 'general', icon: 'general', keywords: 'basics language workspace 语言 工作区 默认模型' },
  { id: 'default-model', label: 'Default model', group: 'General', page: 'general', icon: 'general', keywords: 'new bots model 默认模型' },
  { id: 'enter-send', label: 'Enter sends message', group: 'General', page: 'general', icon: 'general', keywords: 'input keyboard enter 回车 发送' },
  { id: 'locations', label: 'Locations', group: 'General', page: 'general', icon: 'general', keywords: 'team workspace data location folder path 目录 位置 文件夹 总工作区 数据位置' },
  { id: 'memory', label: 'Memory', group: 'General', page: 'general', icon: 'general', expandAdvanced: true, keywords: 'bring up related memory group bot team memory size recall limits 记忆 上限 召回 自动召回' },
  { id: 'background', label: 'Background work', group: 'General', page: 'general', icon: 'general', expandAdvanced: true, keywords: 'background commands after seconds timeout 后台 命令 超时 秒' },
  { id: 'mode', label: 'Classic Agent mode', group: 'General', page: 'general', icon: 'general', expandAdvanced: true, requiresSurface: true, keywords: 'bot mode agent mode surface 经典模式 切换' },
  { id: 'appearance', label: 'Appearance', group: 'Appearance', page: 'appearance', icon: 'appearance', keywords: 'theme accent color dark light font size 主题 强调色 颜色 深色 浅色 字体 字号' },
  { id: 'layout', label: 'Message layout', group: 'Appearance', page: 'appearance', icon: 'appearance', keywords: 'bubble flat text bubble width show thinking 气泡 平铺 宽度 显示思考过程 思考' },
  { id: 'motion', label: 'Motion', group: 'Appearance', page: 'appearance', icon: 'appearance', keywords: 'interface motion bot animation quiet normal lively full reduced 界面动效 动画 安静 正常 活泼' },
  { id: 'models', label: 'Providers', group: 'Models', page: 'models', icon: 'models', keywords: 'api key openai anthropic gemini deepseek 模型 服务商 密钥' },
  { id: 'bot-models', label: 'Bot models', group: 'Models', page: 'bot-models', icon: 'bot-models', keywords: 'batch switch models 批量 切换 模型' },
  { id: 'local-agents', label: 'Local agents', group: 'Models', page: 'local-agents', icon: 'local-agents', keywords: 'cli claude codex antigravity acp 本地 代理' },
  { id: 'deepseek-services', label: 'DeepSeek services', group: 'Models', page: 'deepseek-services', icon: 'deepseek-services', keywords: 'ocr tts asr speech voice dictation document 识图 语音 朗读 听写 文档' },
  { id: 'bots', label: 'Bots', group: 'Team', page: 'bots', icon: 'bots', keywords: 'main bot create private 主bot 新建 隐私' },
  { id: 'groups', label: 'Group chats', group: 'Team', page: 'groups', icon: 'groups', keywords: 'room members admin 群聊 群组 成员' },
  { id: 'schedules', label: 'Scheduled tasks', group: 'Team', page: 'schedules', icon: 'schedules', keywords: 'cron timer automation 定时任务 周期' },
  { id: 'connectors', label: 'Connectors', group: 'Connect', page: 'connectors', icon: 'connectors', keywords: 'github mail email notion figma linear slack 连接器 邮箱 应用' },
  { id: 'im', label: 'IM', group: 'Connect', page: 'im', icon: 'im', keywords: 'wechat weixin feishu dingtalk wecom qq telegram discord slack 微信 飞书 钉钉 企微 聊天软件' },
  { id: 'phone', label: 'Phone', group: 'Connect', page: 'phone', icon: 'phone', keywords: 'mobile app qr relay android ios remote 手机 二维码 远控 配对' },
  { id: 'mcp', label: 'MCP access', group: 'Connect', page: 'mcp', icon: 'mcp', keywords: 'token port client external agent mcp 端口 令牌' },
  { id: 'computer', label: 'Computer use', group: 'Tools', page: 'computer', icon: 'computer', keywords: 'screen accessibility mouse keyboard desktop 电脑操控 屏幕 辅助功能' },
  { id: 'browser', label: 'Browser', group: 'Tools', page: 'browser', icon: 'browser', keywords: 'grants site web interactive 浏览器 权限 网站' },
  { id: 'capabilities', label: 'Capabilities', group: 'Tools', page: 'capabilities', icon: 'capabilities', keywords: 'shared mcp skill pack 能力 技能 包' },
  { id: 'secrets', label: 'Secrets', group: 'Tools', page: 'secrets', icon: 'secrets', keywords: 'encrypt passphrase password keys 密钥 加密 口令' },
  { id: 'usage', label: 'Usage', group: 'Usage', page: 'usage', icon: 'usage', keywords: 'tokens cost stats chart 用量 统计 消耗' },
  { id: 'about', label: 'About DS Bot', group: 'About DS Bot', page: 'about', icon: 'about', keywords: 'version update release github guide walkthrough 关于 版本 更新 引导' },
  { id: 'feedback', label: 'Feedback', group: 'About DS Bot', page: 'feedback', icon: 'feedback', keywords: 'bug error log diagnostics issue 反馈 报错 日志 诊断' },
]

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

// Seconds a Bot's own chat waits for a command before it goes on in the background
// (host default 5; the host checks the range again).
const BACKGROUND_AFTER_SEC = 5
function SecondsField({ label, value, save }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const number = Number(text)
    if (text.trim() !== '' && Number.isInteger(number) && number >= 0 && number <= 600 && number !== value) save(number)
    else setText(String(value))
  }
  return h('input', { className: 'bt-input bt-set-number', type: 'number', min: 0, max: 600, step: 1, 'aria-label': label, value: text, onChange: event => setText(event.target.value), onBlur: commit, onKeyDown: event => { if (event.key === 'Enter') event.target.blur() } })
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

const LAYOUTS = [['bubble', 'Bubble'], ['flat', 'Flat']]
const EFFECTS = [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'None']]
const MOTIONS = [['quiet', 'Quiet'], ['normal', 'Normal'], ['lively', 'Lively']]

function Choice({ label, value, options, pick, className = 'bt-look-seg' }) {
  return h(Segmented, { label, value, className }, options.map(([id, text]) => h('button', {
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

function useDarkMode() {
  const read = () => typeof document !== 'undefined' && document.body?.hasAttribute?.('data-ds-dark-theme') === true
  const [dark, setDark] = useState(read)
  useEffect(() => {
    if (typeof document === 'undefined' || !document.body || typeof MutationObserver !== 'function') return undefined
    const sync = () => setDark(read())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function ThemeGallery({ themes, current, dark, onPick }) {
  return h('div', { className: 'bt-theme-grid', role: 'group', 'aria-label': t('Theme'), 'data-tour': 'theme-grid' },
    Object.entries(themes).map(([id, theme]) => {
      const palette = dark ? theme.dark : theme.light
      const active = current === id
      return h('button', {
        key: id,
        type: 'button',
        className: 'bt-theme-card',
        'aria-pressed': active,
        onClick: () => { if (!active) onPick(id) },
      },
      h('span', { className: 'bt-theme-preview', style: { background: palette.bg } },
        h('span', { className: 'bt-theme-preview-side', style: { background: palette.sidebar } },
          h('span', { className: 'bt-theme-preview-dot', style: { background: palette.accent } }),
          h('span', { className: 'bt-theme-preview-bar', style: { background: palette.text } }),
          h('span', { className: 'bt-theme-preview-bar bt-theme-preview-bar-sm', style: { background: palette.text } })),
        h('span', { className: 'bt-theme-preview-main' },
          h('span', { className: 'bt-theme-preview-b1', style: { background: palette.bubble } }),
          h('span', { className: 'bt-theme-preview-b2', style: { background: palette.user } }))),
      h('span', { className: 'bt-theme-card-foot' },
        h('span', null, t(theme.label)),
        active ? h('span', { className: 'bt-theme-check', 'aria-hidden': true }, h(CheckIcon)) : null))
    }))
}

function AppearancePage({ roster, actions, run, dsh }) {
  const dark = useDarkMode()
  const items = (dsh?.items ?? []).map(row => row.id).filter(id => id !== '')
  const look = LOOK_ITEMS.filter(id => items.includes(id))
  const prefs = roster.prefs ?? {}
  const themes = allThemes()
  const current = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const motion = prefs.motion === 'quiet' || prefs.motion === 'lively' ? prefs.motion : 'normal'
  const [custom, setCustom] = useState(prefs.accent ?? '#4d6bfe')
  const timer = useRef(0)
  const pendingAccent = useRef(null)
  const saveAccent = useRef((value) => run(actions.setPrefs({ accent: value })))
  saveAccent.current = (value) => run(actions.setPrefs({ accent: value }))
  const flushAccent = () => {
    clearTimeout(timer.current)
    const value = pendingAccent.current
    if (value === null) return
    pendingAccent.current = null
    void saveAccent.current(value)
  }
  useEffect(() => flushAccent, [])
  const pickCustom = (value) => {
    setCustom(value)
    pendingAccent.current = value
    clearTimeout(timer.current)
    timer.current = setTimeout(flushAccent, 350)
  }
  const pickPreset = (value) => {
    clearTimeout(timer.current)
    pendingAccent.current = null
    return run(actions.setPrefs({ accent: value }))
  }
  return [
    h(SetSection, { key: 'look', title: t('Theme') },
      h('div', { className: 'bt-set-row bt-theme-row' },
        h(ThemeGallery, { themes, current, dark, onPick: theme => run(actions.setPrefs({ theme })) })),
      h(SetRow, { label: t('Accent'), tour: 'accent' },
        h('div', { className: 'bt-swatches' },
          h('button', { type: 'button', className: 'bt-swatch bt-swatch-default', title: t('Theme accent'), 'aria-label': t('Theme accent'), 'aria-pressed': !prefs.accent, onClick: () => pickPreset(null) }),
          ACCENT_INKS.map(ink => h('button', {
            key: ink, type: 'button', className: 'bt-swatch', title: t(capitalize(ink)), 'aria-label': t(capitalize(ink)), 'aria-pressed': prefs.accent === INKS[ink][0],
            style: { background: `var(--bt-ink-${ink})` }, onClick: () => pickPreset(INKS[ink][0]),
          })),
          h('label', { className: 'bt-swatch bt-swatch-custom', title: t('Custom accent'), 'data-on': Boolean(prefs.accent) && !ACCENT_INKS.some(ink => INKS[ink][0] === prefs.accent) },
            h('input', { type: 'color', value: custom, 'aria-label': t('Custom accent'), onChange: event => pickCustom(event.target.value) })))),
      look.map(id => dshItem(dsh, id))),
    h(SetSection, { key: 'messages', title: t('Messages'), tour: 'layout' },
      h(SetRow, { label: t('Message layout') }, h(Choice, { label: t('Message layout'), value: layoutOf(prefs), options: LAYOUTS, pick: id => run(actions.setPrefs({ layout: id })) })),
      // The flat layout's text has a width of its own; the bubble width stays for the user's messages.
      layoutOf(prefs) === 'flat' ? h(SetRow, { label: t('Text width') }, h(WidthSlider, { label: t('Text width'), value: flatWidthOf(prefs), save: flatWidth => run(actions.setPrefs({ flatWidth })) })) : null,
      h(SetRow, { label: t('Bubble width') }, h(WidthSlider, { label: t('Bubble width'), value: widthOf(prefs), save: width => run(actions.setPrefs({ width })) })),
      h(SetRow, { label: t('Show thinking') }, h(Switch, { label: t('Show thinking'), on: thinkingShown(prefs), onChange: thinking => run(actions.setPrefs({ thinking })) }))),
    h(SetSection, { key: 'motion', title: t('Motion'), tour: 'motion' },
      h(SetRow, { label: t('Interface motion') }, h(Choice, { label: t('Interface motion'), value: effectsOf(prefs), options: EFFECTS, pick: id => run(actions.setPrefs({ effects: id })) })),
      h(SetRow, { label: t('Bot animation') }, h(Choice, { label: t('Bot animation'), value: motion, options: MOTIONS, className: 'bt-motion-seg', pick: id => run(actions.setPrefs({ motion: id })) }))),
  ]
}

function GeneralPage({ roster, actions, run, dsh, openAdvanced = 0 }) {
  const items = (dsh?.items ?? []).map(row => row.id).filter(id => id !== '')
  const basicDsh = BASIC_ITEMS.filter(id => items.includes(id))
  const more = items.filter(id => !LOOK_ITEMS.includes(id) && !BASIC_ITEMS.includes(id))
  const prefs = roster.prefs ?? {}
  const inAgentMode = Boolean(actions.setSurface && actions.surfaceMode?.() === 'agent')
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(openAdvanced))
  useEffect(() => { if (openAdvanced) setAdvancedOpen(true) }, [openAdvanced])
  const advancedSummary = [t('Memory'), t('Background work'), actions.setSurface && !inAgentMode ? t('Classic Agent mode') : null].filter(Boolean).join(' · ')
  return [
    // In Agent mode, keep the way back to Bot mode visible at the top.
    inAgentMode ? h(SetSection, { key: 'mode', title: t('Mode') },
      h(SetRow, { label: t('Bot mode') }, h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: () => actions.setSurface('bot') }, t('Switch')))) : null,
    h(SetSection, { key: 'basics', title: t('Basics') },
      basicDsh.includes('language') ? dshItem(dsh, 'language') : null,
      h(SetRow, { label: t('Default model'), className: 'bt-set-model', tour: 'default-model' },
        h(ModelMenu, {
          bot: { id: 'new-bots', name: t('New Bots'), model: isLocalRoute(prefs.defaultBotModel) ? undefined : prefs.defaultBotModel },
          roster, actions, run, wide: true, withEfforts: false,
          fallbackModel: roster.defaultModel,
          onPick: ref => run(actions.setPrefs({ defaultBotModel: ref })),
        }),
        prefs.defaultBotModel ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setPrefs({ defaultBotModel: null })) }, t('Reset')) : null),
      h(SetRow, { label: t('Enter sends message') },
        h(Switch, { label: t('Enter sends message'), on: prefs.enterToSend !== false, onChange: enterToSend => run(actions.setPrefs({ enterToSend })) })),
      basicDsh.includes('composer-enter') ? dshItem(dsh, 'composer-enter') : null),
    h(LocationsSection, { key: 'places', actions, run }),
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
          h(Switch, { label: t('Bring up related memory'), on: prefs.memoryAutoRecall !== false, onChange: memoryAutoRecall => run(actions.setPrefs({ memoryAutoRecall })) })),
        ...MEMORY_SIZES.map(({ scope, label, size }) => h(SetRow, { key: scope, label: t(label) },
          h(MemorySize, { label: t(label), value: prefs.memoryLimits?.[scope] ?? size, save: value => run(actions.setPrefs({ memoryLimits: { [scope]: value } })) }))),
        h(SetRow, { key: 'bg', label: t('Background commands after (seconds)') },
          h(SecondsField, { label: t('Background commands after (seconds)'), value: prefs.backgroundAfterSec ?? BACKGROUND_AFTER_SEC, save: backgroundAfterSec => run(actions.setPrefs({ backgroundAfterSec })) })),
        actions.setSurface && !inAgentMode
          ? h(SetRow, { key: 'classic', label: t('Classic Agent mode') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.setSurface('agent') }, t('Switch')))
          : null,
        ...more.map(id => dshItem(dsh, id)),
      ] : null),
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
  return h(SetSection, { title: t('Locations'), className: 'bt-set-places', tour: 'locations' },
    h(SetRow, { label: t('Team workspace') },
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
  return h(SetSection, { title: t('Main Bot'), tour: 'main-bot' },
    h(SetRow, { label: t('Main Bot') },
      h('select', {
        className: 'bt-select', 'aria-label': t('Main Bot'), value: first?.id ?? '',
        onChange: event => run(actions.setMain(event.target.value, true, first ? { replace: first.id } : {})),
      }, first ? null : h('option', { value: '' }, t('Choose a Bot…')), roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
    others.map(bot => h(SetRow, { key: bot.id, label: bot.name },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, true, { primary: true })) }, t('Move to first')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, false)) }, t('Remove Main Bot role')))),
    candidates.length > 0 ? h(SetRow, { label: t('Add a Main Bot') },
      h('select', {
        className: 'bt-select', 'aria-label': t('Add a Main Bot'), value: '',
        onChange: (event) => { if (event.target.value) void run(actions.setMain(event.target.value, true)) },
      }, h('option', { value: '' }, t('Choose a Bot…')), candidates.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))) : null)
}

function BotsPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  const newBotBtn = creating ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'data-tour': 'new-bot', onClick: () => setCreating(true) }, h(PlusIcon), t('New Bot'))
  return [
    h(MainBotsSection, { key: 'main', roster, actions, run }),
    creating ? h(CreateBot, { key: 'create', roster, actions, inline: true, onBack: () => setCreating(false), onCreated: bot => actions.openSettings('bots', bot.id) }) : null,
    h(SetSection, { key: 'bots', title: t('Bots · {count}', { count: roster.bots.length }), action: newBotBtn, tour: 'bot-list' },
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
  const newGroupBtn = creating ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'data-tour': 'new-group', disabled: roster.bots.length < 2, title: roster.bots.length < 2 ? t('A group chat needs at least two Bots') : undefined, onClick: () => setCreating(true) }, h(PlusIcon), t('Create group chat'))
  return [
    creating ? h(NewGroupForm, { key: 'create', roster, actions, run, onCancel: () => setCreating(false), onCreated: room => actions.openSettings('groups', room.id) }) : null,
    h(SetSection, { key: 'groups', title: t('Group chats · {count}', { count: roster.rooms.length }), action: newGroupBtn, tour: 'group-list' },
      roster.rooms.length === 0
        ? h(SetRow, { label: t('No group chats yet.') })
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

// While `leaving`, the dialog plays its exit and takes no input.
export function SettingsDialog({ page, id, roster, actions, useUpdate, leaving = false, dsh }) {
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [advancedToken, setAdvancedToken] = useState(0)
  const [tour, setTour] = useState(() => (!leaving && page === 'general' && !id && canAutoStartTour() ? { mode: 'full', nonce: 1 } : null))
  const dialogRef = useRef(null)
  const searchListRef = useRef(null)
  const tourNonceRef = useRef(1)
  const tourRef = useRef(tour)
  tourRef.current = tour
  const close = useCallback(() => {
    if (tourRef.current?.mode === 'full') markTourSeen()
    actions.closeSettings()
  }, [actions])
  const trimmed = query.trim().toLowerCase()
  const onEscape = useCallback(() => {
    if (query !== '') { setQuery(''); return }
    close()
  }, [query, close])
  useEscape(onEscape, !leaving)
  const startTour = useCallback((mode) => {
    setQuery('')
    tourNonceRef.current += 1
    setTour({ mode, nonce: tourNonceRef.current })
  }, [])
  const dismissTour = useCallback(() => {
    if (tourRef.current?.mode === 'full') markTourSeen()
    setTour(null)
  }, [])
  const navigateForTour = useCallback((nextPage) => {
    setQuery('')
    actions.openSettings(nextPage)
  }, [actions])
  const [narrowNav, setNarrowNav] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 640px)').matches : false))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const queryList = window.matchMedia('(max-width: 640px)')
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
  const pageAvailable = key => (key !== 'models' || actions.providers !== undefined) && (key !== 'deepseek-services' || actions.deepseekServices !== undefined)
  const groups = useMemo(() => NAV_GROUPS.map(group => ({
    ...group,
    pages: group.pages.filter(([key]) => pageAvailable(key)),
  })).filter(group => group.pages.length > 0), [hasProviders, hasServices])

  const extra = dshPages(dsh)
  const resolvedPage = GROUP_ALIASES[page] ?? (page === 'models' && !hasProviders ? 'bot-models' : page)
  // A DSH page is `dsh` with its section id; one no longer registered falls back to General.
  const section = resolvedPage === 'dsh' ? extra.find(row => row.id === id) : undefined
  // DSH's Models page, one level into Models.
  const advanced = resolvedPage === 'models' && id === 'advanced' && hasSection(dsh, 'models')
  const validPage = groups.some(group => group.pages.some(([key]) => key === resolvedPage))
  const shown = section ? 'dsh' : validPage ? resolvedPage : 'general'
  // A Bot or group deleted while its form is open leaves its page on the list.
  const bot = shown === 'bots' && id ? roster.byId[id] : undefined
  const room = shown === 'groups' && id ? roster.roomsById[id] : undefined
  const activeGroup = section ? null : groups.find(group => group.pages.some(([key]) => key === shown)) ?? groups[0]
  const usageFocus = shown === 'usage' && id ? id : null
  const label = section ? section.label : advanced ? t('Advanced settings') : t(activeGroup.label)
  const back = bot ? t('Back to Bots') : room ? t('Back to group chats') : usageFocus ? t('All usage') : advanced ? t('Back to models') : null
  const navKey = section ? `dsh:${section.id}` : activeGroup.id
  const nav = useGlide(trimmed === '' ? navKey : '', { axis: narrowNav ? 'x' : 'y' })
  useEffect(() => {
    if (trimmed !== '') return
    nav.box.current?.querySelector('[aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [navKey, trimmed, narrowNav])

  const usableModels = (roster.models ?? []).filter(entry => entry.needsKey !== true && !isLocalRoute(entry.ref))
  const needsModel = hasProviders && usableModels.length === 0
  const phoneConnected = Boolean(roster.phone?.on && roster.phone?.status === 'online' && (roster.phone?.phones ?? []).some(entry => entry.connected))

  const searchHits = useMemo(() => {
    if (trimmed === '') return []
    const tokens = trimmed.split(/\s+/).filter(Boolean)
    const allEntries = [
      ...SEARCH_ENTRIES.filter(entry => pageAvailable(entry.page) && (!entry.requiresSurface || hasSurface)).map(entry => ({
        ...entry,
        title: t(entry.label),
        groupTitle: t(entry.group),
        haystack: `${entry.label} ${t(entry.label)} ${entry.group} ${t(entry.group)} ${entry.keywords}`.toLowerCase(),
      })),
      ...extra.map(row => ({
        id: `dsh:${row.id}`,
        title: row.label,
        groupTitle: 'DSH',
        page: 'dsh',
        dshId: row.id,
        dshRow: row,
        haystack: `${row.label} ${row.id} dsh`.toLowerCase(),
      })),
    ]
    return allEntries.filter(entry => tokens.every(token => entry.haystack.includes(token)))
  }, [trimmed, hasProviders, hasServices, hasSurface, extra])

  useEffect(() => { setHitIndex(0) }, [trimmed])
  useEffect(() => {
    if (trimmed === '') return
    searchListRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' })
  }, [hitIndex, trimmed])

  const pickHit = (hit) => {
    if (!hit) return
    setQuery('')
    if (tourRef.current) dismissTour()
    if (hit.expandAdvanced) setAdvancedToken(token => token + 1)
    if (hit.page === 'dsh') actions.openSettings('dsh', hit.dshId)
    else actions.openSettings(hit.page)
  }

  // A page enters from the right when it is one level in, from the left when it comes
  // back out, and from below beside it. Usage keeps its own entrance and its data
  // across its own levels, so they share one page.
  const pageKey = `${shown}:${bot?.id ?? room?.id ?? section?.id ?? (advanced ? 'advanced' : shown === 'schedules' ? (id ?? '') : '')}`
  useEffect(() => { setError('') }, [pageKey])
  useEffect(() => { if (shown !== 'general' && advancedToken !== 0) setAdvancedToken(0) }, [shown])
  useEffect(() => {
    if (tour && tour.mode !== 'full' && shown !== tour.mode) setTour(null)
  }, [tour, shown])
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

  const groupButton = (group) => {
    const active = !section && activeGroup.id === group.id
    const dotTone = group.id === 'models' && needsModel ? 'warn'
      : group.id === 'connect' && phoneConnected ? 'ok'
      : null
    return h('button', {
      key: group.id,
      type: 'button',
      className: 'bt-settings-item',
      'aria-current': active ? 'page' : undefined,
      onClick: () => actions.openSettings(group.pages[0][0]),
    },
    h(PAGE_ICONS[group.icon]),
    h('span', { className: 'bt-settings-label' }, t(group.label)),
    dotTone ? h('span', { className: 'bt-settings-dot', 'data-tone': dotTone, 'aria-hidden': true }) : null)
  }

  const subTabs = !section && depth === 0 && activeGroup.pages.length > 1 ? activeGroup.pages : null
  const mainGroups = groups.filter(group => group.section === 'main')
  const lastGroups = groups.filter(group => group.section === 'last')
  const showSectionGuide = !section && depth === 0 && !usageFocus && hasSectionTour(shown)

  return h('div', { className: 'bt-settings-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { ref: dialogRef, className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('Settings'), 'data-shortcut-modal': 'settings' },
      h('div', { className: 'bt-settings-rail' },
        h('div', { className: 'bt-set-search-wrap', 'data-tour': 'search', 'data-open': trimmed !== '' || undefined },
          h('div', { className: 'bt-set-search' },
            h(SearchIcon),
            h('input', {
              type: 'text',
              className: 'bt-set-search-input',
              value: query,
              placeholder: t('Search settings'),
              'aria-label': t('Search settings'),
              onChange: event => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (isImeComposing(event)) return
                if (event.key === 'Escape' && query !== '') {
                  event.preventDefault()
                  event.stopPropagation()
                  event.nativeEvent?.stopPropagation?.()
                  setQuery('')
                  return
                }
                if (searchHits.length === 0) return
                if (event.key === 'ArrowDown') { event.preventDefault(); setHitIndex(index => (index + 1) % searchHits.length) }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setHitIndex(index => (index - 1 + searchHits.length) % searchHits.length) }
                else if (event.key === 'Enter') { event.preventDefault(); pickHit(searchHits[hitIndex] ?? searchHits[0]) }
              },
            }),
            query !== '' ? h('button', {
              type: 'button',
              className: 'bt-set-search-clear',
              'aria-label': t('Clear search'),
              onClick: () => setQuery(''),
            }, h(CloseIcon)) : null),
          trimmed !== ''
            ? h('div', { ref: searchListRef, className: 'bt-set-search-list', role: 'listbox', 'aria-label': t('Search settings') },
                searchHits.length === 0
                  ? h('div', { className: 'bt-set-search-empty' }, t('No matching settings'))
                  : searchHits.map((hit, index) => h('button', {
                      key: hit.id,
                      type: 'button',
                      role: 'option',
                      'aria-selected': index === hitIndex,
                      className: 'bt-set-search-hit',
                      'data-active': index === hitIndex || undefined,
                      onMouseEnter: () => setHitIndex(index),
                      onClick: () => pickHit(hit),
                    },
                    hit.dshRow
                      ? h('span', { className: 'bt-settings-icon', 'aria-hidden': true }, dsh.renderSlot('settings.section.icon', { size: 15, active: false }, {
                          only: hit.dshRow.id, fallback: h(DSH_ICONS[hit.dshRow.id] ?? IconSettingsOutlineMedium, { size: 15 }),
                        }))
                      : h(PAGE_ICONS[hit.icon]),
                    h('span', { className: 'bt-set-search-title' }, hit.title),
                    hit.groupTitle && hit.groupTitle !== hit.title ? h('span', { className: 'bt-set-search-meta' }, hit.groupTitle) : null)))
            : null),
        trimmed === ''
          ? h('nav', { ref: nav.box, className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
              h('span', { ref: nav.thumb, className: 'bt-thumb', 'aria-hidden': true }),
              mainGroups.map(groupButton),
              extra.length > 0 ? h('span', { className: 'bt-settings-rule', 'aria-hidden': true }) : null,
              extra.map(row => h('button', {
                key: `dsh:${row.id}`, type: 'button', className: 'bt-settings-item', 'aria-current': section?.id === row.id ? 'page' : undefined,
                onClick: () => actions.openSettings('dsh', row.id),
              }, h('span', { className: 'bt-settings-icon', 'aria-hidden': true }, dsh.renderSlot('settings.section.icon', { size: 16, active: section?.id === row.id }, {
                only: row.id, fallback: h(DSH_ICONS[row.id] ?? IconSettingsOutlineMedium, { size: 16 }),
              })), h('span', { className: 'bt-settings-label' }, row.label))),
              h('span', { className: 'bt-settings-rule', 'aria-hidden': true }),
              lastGroups.map(groupButton))
          : null),
      h('div', { className: 'bt-settings-main' },
        h('div', { className: 'bt-settings-head' },
          back ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': back, title: back, onClick: () => actions.openSettings(shown) }, h(ChevronLeftIcon)) : null,
          h('h2', { key: bot?.id ?? room?.id ?? section?.id ?? (advanced ? 'advanced' : activeGroup.id) }, bot?.name ?? room?.name ?? label),
          h('div', { className: 'bt-settings-head-end' },
            dsh ? h('div', { className: 'bt-settings-actions' }, dsh.renderSlot('settings.action', {})) : null,
            showSectionGuide ? h('button', {
              type: 'button',
              className: 'bt-soft bt-soft-sm bt-with-icon bt-tour-trigger',
              onClick: () => startTour(shown),
            }, h(CompassIcon), t('Guide')) : null)),
        subTabs ? h('div', { className: 'bt-settings-subnav' },
          h(Segmented, { key: activeGroup.id, label: t(activeGroup.label), value: shown, className: 'bt-settings-tabs' },
            subTabs.map(([subKey, subLabel]) => h('button', {
              key: subKey,
              type: 'button',
              'aria-pressed': shown === subKey,
              onClick: () => { if (shown !== subKey) actions.openSettings(subKey) },
            },
            t(subLabel),
            subKey === 'phone' ? h('span', { className: 'bt-tag bt-tab-tag' }, t('Beta')) : null)))) : null,
        shown === 'usage' ? null : h('div', { key: pageKey, className: 'bt-settings-scroll bt-settings-page', 'data-move': last.current.move },
          errorLine,
          h(PageBoundary, null,
          shown === 'general' ? h(GeneralPage, { roster, actions, run, dsh, openAdvanced: advancedToken }) : null,
          shown === 'appearance' ? h(AppearancePage, { roster, actions, run, dsh }) : null,
          shown === 'computer' ? h(ComputerPage, { roster, actions, run, Section: SetSection, Row: SetRow, Switch }) : null,
          shown === 'models' && !advanced ? h(ProvidersPage, { actions, run, roster, Section: SetSection, advanced: hasSection(dsh, 'models') ? () => actions.openSettings('models', 'advanced') : null }) : null,
          advanced ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close }, { only: 'models' })) : null,
          section ? h('div', { className: 'bt-dsh-section' }, dsh.renderSlot('settings.section', { close }, { only: section.id })) : null,
          shown === 'local-agents' ? h(LocalAgentsPage, { run, Section: SetSection, Row: SetRow }) : null,
          bot ? h('div', { className: 'bt-settings-form' }, h(BotSettingsForm, { key: bot.id, bot, roster, actions, run })) : null,
          shown === 'bots' && !bot ? h(BotsPage, { roster, actions, run }) : null,
          shown === 'bot-models' ? h(BotModelsPage, { roster, actions, run, Section: SetSection }) : null,
          room ? h('div', { className: 'bt-settings-form' }, h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null,
          shown === 'groups' && !room ? h(GroupsPage, { roster, actions, run }) : null,
          shown === 'connectors' ? h(ConnectorsPage, { roster, actions }) : null,
          shown === 'im' ? h(ImPage, { roster, actions }) : null,
          shown === 'capabilities' ? h(CapabilitiesPage, { roster, actions, run }) : null,
          shown === 'deepseek-services' ? h(DeepSeekServicesPage, { actions, run, Section: SetSection, Row: SetRow, Switch, Segmented }) : null,
          shown === 'phone' ? h(PhonePage, { roster, actions, Section: SetSection, Row: SetRow }) : null,
          shown === 'mcp' ? h(McpPage, { roster, actions, Section: SetSection, Row: SetRow }) : null,
          shown === 'browser' ? h(BrowserPage, { roster, actions, run, Section: SetSection, Row: SetRow }) : null,
          shown === 'schedules' ? h(SchedulesPage, { roster, actions, start: id ?? undefined }) : null,
          shown === 'secrets' ? h(SecretsPage, { roster, actions, run, Section: SetSection }) : null,
          shown === 'feedback' ? h(FeedbackPage, { actions, run, Section: SetSection, Row: SetRow }) : null,
          shown === 'about' ? h(AboutPage, { useUpdate, actions, run, Section: SetSection, Row: SetRow, onStartTour: () => startTour('full') }) : null)),
        usageOpened ? h('div', { key: 'usage', className: 'bt-settings-scroll bt-settings-usage', 'data-off': shown === 'usage' ? undefined : '', 'aria-hidden': shown === 'usage' ? undefined : true },
          shown === 'usage' ? errorLine : null,
          h(PageBoundary, { reset: shown }, h(UsagePage, { roster, actions, focusId: usageFocus }))) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon)),
      leaving ? null : h(SettingsTour, {
        tour,
        currentPage: shown,
        dialogRef,
        hasProviders,
        hasAdvancedModels: hasSection(dsh, 'models'),
        onNavigate: navigateForTour,
        onDismiss: dismissTour,
      })))
}
