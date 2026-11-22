import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { LayersIcon, SearchIcon, SwitchIcon } from './icons.js'
import { IconSettingsOutlineMedium } from './dsh-primitives.js'
import { modelLine, modelName } from './bot-models-page.js'
import { isLocalRoute } from './agent-routes.js'
import { isImeComposing } from './enter-key.js'
import { t } from './i18n.js'

// Every page, part, and key control, with English and Chinese keywords.
export const SEARCH_ENTRIES = [
  { id: 'overview', label: 'Overview', group: 'Overview', page: 'overview', icon: 'overview', keywords: 'home status summary 概览 首页 状态' },
  { id: 'general', label: 'General', group: 'General', page: 'general', icon: 'general', keywords: 'basics language workspace 语言 工作区 默认模型' },
  { id: 'default-model', label: 'Default model', group: 'General', page: 'general', icon: 'general', keywords: 'new bots model 默认模型' },
  { id: 'enter-send', label: 'Enter sends message', group: 'General', page: 'general', icon: 'general', keywords: 'input keyboard enter 回车 发送' },
  { id: 'locations', label: 'Locations', group: 'General', page: 'general', icon: 'general', keywords: 'team workspace data location folder path 目录 位置 文件夹 总工作区 数据位置' },
  { id: 'memory', label: 'Memory', group: 'General', page: 'general', icon: 'general', expandAdvanced: true, keywords: 'bring up related memory group bot team memory size recall limits 记忆 上限 召回 自动召回' },
  { id: 'background', label: 'Background work', group: 'General', page: 'general', icon: 'general', expandAdvanced: true, keywords: 'background commands after seconds timeout 后台 命令 超时 秒' },
  { id: 'mode', label: 'Classic Agent mode', group: 'General', page: 'general', icon: 'general', expandAdvanced: true, requiresSurface: true, keywords: 'bot mode agent mode surface 经典模式 切换' },
  { id: 'appearance', label: 'Appearance', group: 'Appearance', page: 'appearance', icon: 'appearance', keywords: 'theme accent color dark light font size 主题 强调色 颜色 深色 浅色 字体 字号' },
  { id: 'layout', label: 'Message layout', group: 'Appearance', page: 'appearance', icon: 'appearance', keywords: 'bubble flat text bubble width text width show thinking 气泡 平铺 宽度 气泡宽度 正文宽度 显示思考过程 思考' },
  { id: 'motion', label: 'Motion', group: 'Appearance', page: 'appearance', icon: 'appearance', keywords: 'interface motion bot animation quiet normal lively full reduced 界面动效 动画 安静 正常 活泼' },
  { id: 'models', label: 'Providers', group: 'Models', page: 'models', icon: 'models', keywords: 'api key openai anthropic gemini deepseek 模型 服务商 密钥' },
  { id: 'local-agents', label: 'Local agents', group: 'Models', page: 'local-agents', icon: 'local-agents', keywords: 'cli claude codex antigravity acp 本地 代理' },
  { id: 'bot-models', label: 'Bot models', group: 'Models', page: 'bot-models', icon: 'bot-models', keywords: 'batch switch models 批量 切换 模型' },
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

const matches = (haystack, tokens) => tokens.every(token => haystack.includes(token))
const PER_KIND = 6

// The hits for one query, in the order the list shows them: settings, Bots, group chats,
// then models with the batch switch beside each one.
export function searchHits(query, { roster, extra = [], pageAvailable = () => true, hasSurface = false }) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const settings = [
    ...SEARCH_ENTRIES.filter(entry => pageAvailable(entry.page) && (!entry.requiresSurface || hasSurface)).map(entry => ({
      ...entry,
      kind: 'setting',
      title: t(entry.label),
      meta: t(entry.group),
      haystack: `${entry.label} ${t(entry.label)} ${entry.group} ${t(entry.group)} ${entry.keywords}`.toLowerCase(),
    })),
    ...extra.map(row => ({
      id: `dsh:${row.id}`, kind: 'setting', title: row.label, meta: t('Engine'), page: 'dsh', dshId: row.id, dshRow: row,
      haystack: `${row.label} ${row.id} dsh engine ${t('Engine')}`.toLowerCase(),
    })),
  ].filter(entry => matches(entry.haystack, tokens))
  const bots = (roster.bots ?? []).map(bot => ({
    id: `bot:${bot.id}`, kind: 'bot', bot, title: bot.name, meta: modelLine(bot, roster), page: 'bots', target: bot.id,
    haystack: `${bot.name} ${bot.role ?? ''} ${bot.model ?? bot.appliedModel ?? ''}`.toLowerCase(),
  })).filter(entry => matches(entry.haystack, tokens)).slice(0, PER_KIND)
  const rooms = (roster.rooms ?? []).map(room => ({
    id: `room:${room.id}`, kind: 'room', room, title: room.name, meta: t('{count} members', { count: room.members?.length ?? 0 }), page: 'groups', target: room.id,
    haystack: `${room.name} ${t('Group chats')}`.toLowerCase(),
  })).filter(entry => matches(entry.haystack, tokens)).slice(0, PER_KIND)
  const usable = (roster.models ?? []).filter(entry => !entry.needsKey && !isLocalRoute(entry.ref))
  const models = usable
    .filter(entry => matches(`${entry.name ?? ''} ${entry.ref} ${entry.providerName ?? ''}`.toLowerCase(), tokens))
    .slice(0, 3)
    .flatMap((entry) => {
      const name = modelName(entry, usable)
      // The switch is offered only when some Bot would move: not one on a local agent, not
      // one already on the model.
      const movers = (roster.bots ?? []).filter(bot => !isLocalRoute(bot.model ?? bot.appliedModel) && (bot.model ?? bot.appliedModel) !== entry.ref)
      return [
        { id: `model:${entry.ref}`, kind: 'model', title: entry.name ?? entry.ref, meta: entry.providerName ?? entry.ref.split('/')[0], page: 'models', icon: 'models' },
        movers.length > 0 ? { id: `switch:${entry.ref}`, kind: 'action', title: t('Switch Bots to {model}…', { model: name }), meta: t('Bot models'), page: 'bot-models', target: entry.ref } : null,
      ].filter(Boolean)
    })
  return [...settings, ...bots, ...rooms, ...models]
}

const KIND_TITLES = { setting: 'Settings', bot: 'Bots', room: 'Group chats', model: 'Models', action: 'Models' }

// Search over Settings, opened from the rail or with ⌘K / Ctrl+K.
// Focus comes back to what opened it when it closes. Tab stays on the field: the list is
// read through aria-activedescendant.
export function SettingsPalette({ roster, extra, dsh, icons, pageAvailable, hasSurface, onPick, onClose, returnFocus = false }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  useEffect(() => {
    if (!returnFocus || typeof document === 'undefined') return undefined
    const opener = document.activeElement
    return () => { if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus({ preventScroll: true }) }
  }, [])
  const hits = useMemo(() => searchHits(query, { roster, extra, pageAvailable, hasSurface }), [query, roster, extra, hasSurface])
  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => { inputRef.current?.focus?.({ preventScroll: true }) }, [])
  useEffect(() => {
    listRef.current?.querySelector?.('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' })
  }, [index, query])
  const pick = (hit) => { if (hit) onPick(hit) }
  const icon = (hit) => {
    if (hit.kind === 'bot') return h(BotAvatar, { bot: hit.bot, size: 22, badge: false, live: false })
    if (hit.kind === 'room') return h(RoomAvatar, { room: hit.room, roster, size: 22 })
    if (hit.kind === 'action') return h('span', { className: 'bt-set-hit-icon', 'data-tone': 'accent' }, h(SwitchIcon))
    if (hit.dshRow) {
      return h('span', { className: 'bt-set-hit-icon' }, dsh?.renderSlot?.('settings.section.icon', { size: 15, active: false }, {
        only: hit.dshRow.id, fallback: h(IconSettingsOutlineMedium, { size: 15 }),
      }) ?? h(IconSettingsOutlineMedium, { size: 15 }))
    }
    const Icon = icons[hit.icon] ?? LayersIcon
    return h('span', { className: 'bt-set-hit-icon' }, h(Icon))
  }
  const rows = []
  hits.forEach((hit, at) => {
    const title = KIND_TITLES[hit.kind]
    if (at === 0 || KIND_TITLES[hits[at - 1].kind] !== title) rows.push(h('div', { key: `head:${title}`, className: 'bt-set-palette-group', role: 'presentation' }, t(title)))
    rows.push(h('button', {
      key: hit.id,
      id: `bt-set-hit-${at}`,
      type: 'button',
      tabIndex: -1,
      role: 'option',
      'aria-selected': at === index,
      className: 'bt-set-search-hit',
      'data-active': at === index || undefined,
      onMouseMove: () => { if (at !== index) setIndex(at) },
      onClick: () => pick(hit),
    },
    icon(hit),
    h('span', { className: 'bt-set-search-title' }, hit.title),
    hit.meta && hit.meta !== hit.title ? h('span', { className: 'bt-set-search-meta' }, hit.meta) : null))
  })
  return h('div', { className: 'bt-set-palette-layer' },
    h('div', { className: 'bt-set-palette-scrim', onMouseDown: onClose }),
    h('div', { className: 'bt-set-palette', role: 'dialog', 'aria-label': t('Search settings') },
      h('div', { className: 'bt-set-palette-head' },
        h(SearchIcon),
        h('input', {
          ref: inputRef,
          type: 'text',
          className: 'bt-set-search-input',
          value: query,
          placeholder: t('Search settings'),
          'aria-label': t('Search settings'),
          role: 'combobox',
          'aria-expanded': hits.length > 0,
          'aria-controls': 'bt-set-hits',
          'aria-activedescendant': hits.length > 0 ? `bt-set-hit-${index}` : undefined,
          autoComplete: 'off',
          spellCheck: false,
          onChange: event => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Tab') { event.preventDefault(); return }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              event.nativeEvent?.stopPropagation?.()
              onClose()
              return
            }
            if (hits.length === 0) return
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(at => (at + 1) % hits.length) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(at => (at - 1 + hits.length) % hits.length) }
            else if (event.key === 'Enter') { event.preventDefault(); pick(hits[index] ?? hits[0]) }
          },
        }),
        h('kbd', { className: 'bt-set-kbd' }, 'esc')),
      query.trim() === '' ? null
        : h('div', { ref: listRef, id: 'bt-set-hits', className: 'bt-set-search-list', role: 'listbox', 'aria-label': t('Search settings') },
            hits.length === 0 ? h('div', { className: 'bt-set-search-empty' }, t('No matching settings')) : rows)))
}

export const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent ?? '')
