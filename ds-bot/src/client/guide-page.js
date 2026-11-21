// Settings → Guide: live overview and one-click entry to every Settings area.
import { createElement as h, useEffect, useState } from 'react'
import { isLocalRoute } from './agent-routes.js'
import { BlocksIcon, ChevronRightIcon, ConnectorIcon, GearIcon, PaletteIcon, PeopleIcon, SlidersIcon } from './icons.js'
import { BotAvatar } from './mark.js'
import { allThemes } from './themes.js'
import { t } from './i18n.js'

const isDarkNow = () => typeof document !== 'undefined' && document.body?.hasAttribute?.('data-ds-dark-theme') === true

export function useDarkMode() {
  const [dark, setDark] = useState(isDarkNow)
  useEffect(() => {
    if (typeof document === 'undefined' || !document.body || typeof MutationObserver !== 'function') return undefined
    const sync = () => setDark(isDarkNow())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function StatusPill({ tone = 'muted', text }) {
  return h('span', { className: 'bt-guide-status', 'data-tone': tone },
    h('span', { className: 'bt-guide-dot', 'aria-hidden': true }),
    h('span', null, text))
}

function GuideCard({ icon, title, status, target, onOpen, children }) {
  return h('section', { className: 'bt-guide-card' },
    h('button', { type: 'button', className: 'bt-guide-head', onClick: () => onOpen(target) },
      h('span', { className: 'bt-guide-icon', 'aria-hidden': true }, h(icon)),
      h('span', { className: 'bt-guide-title' }, title),
      status,
      h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
    h('div', { className: 'bt-guide-body' }, children))
}

function Chip({ label, page, id = null, active = false, onOpen }) {
  return h('button', {
    type: 'button',
    className: 'bt-guide-chip',
    'data-on': active || undefined,
    onClick: () => onOpen(page, id),
  }, label)
}

export function GuidePage({ roster, actions, run, dsh }) {
  const dark = useDarkMode()
  const open = (page, id = null) => actions.openSettings(page, id)
  const prefs = roster?.prefs ?? {}
  const models = roster?.models ?? []
  const usableModels = models.filter(entry => entry.needsKey !== true && !isLocalRoute(entry.ref))
  const hasProviders = actions.providers !== undefined
  const hasServices = actions.deepseekServices !== undefined
  const needsModel = hasProviders && usableModels.length === 0

  const bots = roster?.bots ?? []
  const rooms = roster?.rooms ?? []
  const mainBot = roster?.byId?.[(roster?.mainBotIds ?? [])[0]]

  const connData = roster?.connectors ?? {}
  const readyApps = (connData.mail?.accounts?.length ?? 0)
    + (connData.connectors ?? []).filter(entry => entry.id !== 'mail' && entry.state === 'ready').length
  const enabledIm = (roster?.im?.connections ?? []).filter(entry => entry.enabled).length
  const connectedPhones = (roster?.phone?.phones ?? []).filter(entry => entry.connected).length
  const phoneOnline = Boolean(roster?.phone?.on && roster?.phone?.status === 'online' && connectedPhones > 0)
  const phoneReady = Boolean(roster?.phone?.on && roster?.phone?.status === 'online')
  const mcpOn = roster?.mcp?.on === true
  const connectCount = readyApps + enabledIm + connectedPhones + (mcpOn ? 1 : 0)

  const computerOn = roster?.computer?.enabled === true
  const secretsCount = (roster?.secrets ?? []).length
  const secretsEncrypted = roster?.secretStore?.mode === 'encrypted'

  const themes = allThemes()
  const currentTheme = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const hasPlugins = (dsh?.sections ?? []).some(row => row.id === 'plugins')
  const inAgentMode = actions.setSurface && actions.surfaceMode?.() === 'agent'

  const modelStatus = needsModel
    ? h(StatusPill, { tone: 'warn', text: t('Needs an API key') })
    : h(StatusPill, { tone: usableModels.length > 0 ? 'ok' : 'muted', text: usableModels.length > 0 ? t('{count} models', { count: usableModels.length }) : t('Not set') })

  const teamStatus = h('span', { className: 'bt-guide-team' },
    mainBot ? h(BotAvatar, { bot: mainBot, size: 18, badge: false, live: false }) : null,
    h('span', { className: 'bt-guide-meta' }, [
      t('{count} Bots', { count: bots.length }),
      rooms.length > 0 ? t('{count} groups', { count: rooms.length }) : null,
    ].filter(Boolean).join(' · ')))

  const connectStatus = phoneOnline && connectCount === connectedPhones
    ? h(StatusPill, { tone: 'ok', text: t('Phone online') })
    : connectCount > 0
      ? h(StatusPill, { tone: 'ok', text: t('{count} connected', { count: connectCount }) })
      : phoneReady
        ? h(StatusPill, { tone: 'ok', text: t('Ready') })
        : h(StatusPill, { tone: 'muted', text: t('Off') })

  const toolsSummary = computerOn
    ? t('On')
    : secretsCount > 0
      ? [t('{count} secrets', { count: secretsCount }), secretsEncrypted ? t('Encrypted') : null].filter(Boolean).join(' · ')
      : t('Off')
  const toolsStatus = h(StatusPill, { tone: computerOn || secretsEncrypted ? 'ok' : 'muted', text: toolsSummary })

  const defaultModelName = prefs.defaultBotModel
    ? (models.find(entry => entry.ref === prefs.defaultBotModel)?.name ?? prefs.defaultBotModel)
    : t('Default')

  return h('div', { className: 'bt-guide' },
    inAgentMode ? h('div', { className: 'bt-guide-banner' },
      h('span', { className: 'bt-guide-banner-copy' },
        h('span', { className: 'bt-guide-dot', 'data-tone': 'accent', 'aria-hidden': true }),
        h('span', null, t('Bot mode'))),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: () => actions.setSurface('bot') }, t('Switch'))) : null,
    needsModel ? h('div', { className: 'bt-guide-banner', 'data-tone': 'warn' },
      h('span', { className: 'bt-guide-banner-copy' },
        h('span', { className: 'bt-guide-dot', 'data-tone': 'warn', 'aria-hidden': true }),
        h('span', null, t('Models')),
        h('span', { className: 'bt-guide-meta' }, t('Needs an API key'))),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: () => open('models') }, t('Set up'))) : null,
    h('div', { className: 'bt-guide-grid' },
      h(GuideCard, { icon: SlidersIcon, title: t('Models'), status: modelStatus, target: hasProviders ? 'models' : 'bot-models', onOpen: open },
        h('div', { className: 'bt-guide-chips' },
          hasProviders ? h(Chip, { label: t('Providers'), page: 'models', active: needsModel, onOpen: open }) : null,
          h(Chip, { label: t('Bot models'), page: 'bot-models', onOpen: open }),
          h(Chip, { label: t('Local agents'), page: 'local-agents', onOpen: open }),
          hasServices ? h(Chip, { label: t('DeepSeek services'), page: 'deepseek-services', onOpen: open }) : null)),
      h(GuideCard, { icon: PeopleIcon, title: t('Team'), status: teamStatus, target: 'bots', onOpen: open },
        h('div', { className: 'bt-guide-chips' },
          h(Chip, { label: t('Bots'), page: 'bots', onOpen: open }),
          h(Chip, { label: t('Group chats'), page: 'groups', onOpen: open }),
          h(Chip, { label: t('Scheduled tasks'), page: 'schedules', onOpen: open }))),
      h(GuideCard, { icon: ConnectorIcon, title: t('Connect'), status: connectStatus, target: 'connectors', onOpen: open },
        h('div', { className: 'bt-guide-chips' },
          h(Chip, { label: t('Connectors'), page: 'connectors', active: readyApps > 0, onOpen: open }),
          h(Chip, { label: t('IM'), page: 'im', active: enabledIm > 0, onOpen: open }),
          h(Chip, { label: t('Phone'), page: 'phone', active: phoneOnline, onOpen: open }),
          h(Chip, { label: t('MCP access'), page: 'mcp', active: mcpOn, onOpen: open }))),
      h(GuideCard, { icon: BlocksIcon, title: t('Tools'), status: toolsStatus, target: 'computer', onOpen: open },
        h('div', { className: 'bt-guide-chips' },
          h(Chip, { label: t('Computer use'), page: 'computer', active: computerOn, onOpen: open }),
          h(Chip, { label: t('Browser'), page: 'browser', onOpen: open }),
          h(Chip, { label: t('Capabilities'), page: 'capabilities', onOpen: open }),
          h(Chip, { label: t('Secrets'), page: 'secrets', active: secretsEncrypted, onOpen: open }))),
      h(GuideCard, { icon: PaletteIcon, title: t('Appearance'), status: h('span', { className: 'bt-guide-meta' }, t(themes[currentTheme].label)), target: 'appearance', onOpen: open },
        h('div', { className: 'bt-guide-themes', role: 'group', 'aria-label': t('Theme') },
          Object.entries(themes).slice(0, 4).map(([id, theme]) => {
            const palette = dark ? theme.dark : theme.light
            return h('button', {
              key: id,
              type: 'button',
              className: 'bt-guide-theme-pill',
              'aria-pressed': currentTheme === id,
              onClick: () => { if (currentTheme !== id) run(actions.setPrefs({ theme: id })) },
            },
            h('span', { className: 'bt-guide-theme-swatch', style: { background: palette.bg, borderColor: palette.accent } },
              h('span', { style: { background: palette.accent } })),
            h('span', null, t(theme.label)))
          }))),
      h(GuideCard, { icon: GearIcon, title: t('General'), status: h('span', { className: 'bt-guide-meta bt-guide-ellipsis' }, defaultModelName), target: 'general', onOpen: open },
        h('div', { className: 'bt-guide-chips' },
          h(Chip, { label: t('Basics'), page: 'general', onOpen: open }),
          h(Chip, { label: t('Usage'), page: 'usage', onOpen: open }),
          hasPlugins ? h(Chip, { label: dsh.sections.find(row => row.id === 'plugins').label, page: 'dsh', id: 'plugins', onOpen: open }) : null,
          h(Chip, { label: t('About DS Bot'), page: 'about', onOpen: open })))))
}
