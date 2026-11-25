import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotAvatar } from './mark.js'
import { PlusIcon } from './icons.js'
import { Segmented, useMorph } from './motion.js'
import { ImportCard, ImportMenu, useCookieImportFlow } from './cookie-import-ui.js'
import { dateLocale, t } from './i18n.js'

const ACTIONS = [['post', 'Post'], ['upload', 'Upload'], ['download', 'Download'], ['delete', 'Delete']]
const DURATIONS = [['hour', '1 hour'], ['today', 'Today'], ['week', '7 days'], ['permanent', 'Permanent']]
const expired = grant => Number.isFinite(grant.until) && grant.until <= Date.now()

function siteValue(value) {
  return value.trim().toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/:\d+$/, '') || '*'
}

function grantTime(grant) {
  if (!Number.isFinite(grant.until)) return t('Permanent')
  if (grant.until <= Date.now()) return t('Expired')
  const time = new Date(grant.until).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  return t('Until {time}', { time })
}

function grantKinds(grant) {
  if (grant.kinds.includes('*')) return [t('All four')]
  return ACTIONS.filter(([kind]) => grant.kinds.includes(kind)).map(([, label]) => t(label))
}

export function BrowserPage({ roster, actions, run, Section, Row }) {
  const bots = roster.bots ?? []
  const [botId, setBotId] = useState(bots[0]?.id ?? '')
  const [importBotId, setImportBotId] = useState(bots[0]?.id ?? '')
  const [site, setSite] = useState('')
  const [kinds, setKinds] = useState(['post'])
  const [duration, setDuration] = useState('hour')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const selectedBot = bots.find(bot => bot.id === botId)
  const importBot = bots.find(bot => bot.id === importBotId) ?? bots[0] ?? null
  const imports = importBot ? (actions.browserImport ?? null) : null
  const importFlow = useCookieImportFlow({
    imports,
    botId: importBot?.id ?? null,
    resetKey: 'settings',
    idleFlow: 'menu',
  })
  const importBoxRef = useRef(null)
  const importStageKey = importFlow.flow === 'menu' ? 'menu' : (importFlow.flow?.stage ?? 'menu')
  useMorph(importBoxRef, importStageKey)

  useEffect(() => {
    if (!bots.some(bot => bot.id === botId)) setBotId(bots[0]?.id ?? '')
    if (!bots.some(bot => bot.id === importBotId)) setImportBotId(bots[0]?.id ?? '')
  }, [bots, botId, importBotId])

  const grants = bots.flatMap(bot => (bot.browserGrants ?? []).map((grant, index) => ({
    bot, grant, index, expired: expired(grant),
  })))
  const remove = (bot, index) => {
    const next = (bot.browserGrants ?? []).filter((grant, position) => position !== index && !expired(grant))
    void run(actions.updateBot(bot.id, { browserGrants: next.length ? next : null }))
  }
  const resetForm = () => {
    setBotId(bots[0]?.id ?? '')
    setSite('')
    setKinds(['post'])
    setDuration('hour')
    setAdding(false)
  }
  const add = event => {
    event.preventDefault()
    if (!selectedBot || kinds.length === 0 || busy) return
    const now = Date.now()
    let until
    if (duration === 'hour') until = now + 60 * 60 * 1000
    else if (duration === 'today') {
      const end = new Date(now)
      end.setHours(23, 59, 59, 999)
      until = end.getTime()
    } else if (duration === 'week') until = now + 7 * 24 * 60 * 60 * 1000
    const grant = { site: siteValue(site), kinds: [...kinds], ...(until !== undefined ? { until } : {}) }
    setBusy(true)
    void Promise.resolve(run(actions.updateBot(selectedBot.id, {
      browserGrants: [...(selectedBot.browserGrants ?? []).filter(entry => !expired(entry)), grant],
    }))).then((ok) => {
      if (ok !== false) resetForm()
    }, () => {}).finally(() => setBusy(false))
  }
  const toggleKind = (kind, checked) => {
    setKinds(current => checked
      ? (current.includes(kind) ? current : [...current, kind])
      : current.filter(value => value !== kind))
  }

  const addBtn = adding || bots.length === 0 ? null
    : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'data-tour': 'browser-allow', onClick: () => setAdding(true) }, h(PlusIcon), t('Allow action'))
  const activeBrowserId = roster.plugins?.slots?.browser?.active ?? 'builtin:readonly'
  const KNOWN_BROWSER_LABELS = {
    'builtin:readonly': t('Read-only Browser'),
    'builtin:refs': t('Playwright (Refs)'),
    'builtin:script': t('Playwright (Script)'),
    'builtin:task': t('Playwright (Task)'),
    'dsh:dsh-ego-browser': 'Ego Lite Browser',
    'mcp:playwright-mcp': 'Playwright MCP',
    'mcp:chrome-devtools-mcp': 'Chrome DevTools MCP',
  }
  const activeBrowserLabel = KNOWN_BROWSER_LABELS[activeBrowserId]
    ?? activeBrowserId.replace(/^(builtin|dsh|mcp|provider):/, '')

  return h('div', { className: 'bt-browser-settings' },
    h(Section, { title: t('Browser access') },
      h('p', { className: 'bt-browser-note' }, t('A Bot can read the page you have open: its title, address and visible text. By default it cannot click, type, scroll or open pages.')),
      h(Row, {
        label: t('Browser plugin'),
        hint: activeBrowserLabel,
      },
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => actions.openSettings?.('plugins', 'browser'),
      }, t('Switch browser plugin'))),
      activeBrowserId === 'builtin:readonly' ? h(Row, {
        label: t('How to enable interactive browsing'),
        hint: t('In this DSH profile, set browserPlugin to refs, script or task, then restart DS Bot.'),
      }) : null,
      h('p', { className: 'bt-browser-note' }, activeBrowserId.startsWith('builtin:')
        ? t('With an interactive plugin, Bots browse, click and fill in forms. Posting, uploading, downloading and deleting ask you first unless you allow them here. Payments are always yours: the Bot hands the page to you.')
        : t('External browser plugins (DSH / MCP) manage their own browser actions and approvals; the action grants below apply only to built-in Playwright plugins.'))),
    imports ? h(Section, { title: t('Import cookies') },
      bots.length > 0 ? h(Row, { label: t('Bot') },
        h('div', { className: 'bt-browser-import-bot' },
          importBot ? h(BotAvatar, { bot: importBot, size: 22 }) : null,
          h('select', {
            className: 'bt-select',
            value: importBot?.id ?? '',
            disabled: importFlow.busy || bots.length === 0,
            onChange: event => {
              setImportBotId(event.target.value)
              if (importFlow.flow?.stage === 'result') importFlow.doneImport()
            },
          }, bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))))) : null,
      h('div', { ref: importBoxRef, className: 'bt-browser-import-body' },
        importFlow.flow === 'menu' || !importFlow.flow
          ? h(ImportMenu, {
            sources: importFlow.sources,
            lastSourceId: importFlow.lastSourceId,
            loading: importFlow.loadingSources,
            busy: importFlow.busy || !importBot,
            canPaste: Boolean(imports.paste),
            inline: true,
            onFile: importFlow.pickFile,
            onPaste: importFlow.openPaste,
            onSource: importFlow.pickSource,
          })
          : h(ImportCard, {
            flow: importFlow.flow,
            busy: importFlow.busy,
            imports,
            inline: true,
            onApply: importFlow.applyImport,
            onCancel: importFlow.cancelImport,
            onBack: importFlow.openImport,
            onCloseAndImport: importFlow.closeAndImport,
            onRetrySource: importFlow.retrySource,
            onLaunchSource: importFlow.launchSource,
            onOpenPermission: importFlow.openPermission,
            onFile: importFlow.pickFile,
            onSubmitPaste: importFlow.submitPaste,
            onDone: importFlow.doneImport,
          }))) : null,
    adding ? h(Section, { title: t('Allow an action') },
      h('form', { className: 'bt-browser-form', onSubmit: add },
        h(Row, { label: t('Bot') },
          h('select', { className: 'bt-select', value: botId, onChange: event => setBotId(event.target.value), disabled: bots.length === 0 },
            bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
        h(Row, { label: t('Site') },
          h('input', {
            className: 'bt-input bt-browser-site',
            type: 'text',
            value: site,
            placeholder: t('example.com — leave empty for all sites'),
            onChange: event => setSite(event.target.value),
          })),
        h(Row, { label: t('Actions') },
          h('div', { className: 'bt-browser-action-list' },
            ACTIONS.map(([kind, label]) => h('label', { key: kind, className: 'bt-browser-action-choice' },
              h('input', {
                type: 'checkbox',
                checked: kinds.includes(kind),
                onChange: event => toggleKind(kind, event.target.checked),
              }),
              t(label))))),
        h(Row, { label: t('Duration') },
          h(Segmented, { label: t('Duration'), value: duration, className: 'bt-browser-seg' },
            DURATIONS.map(([key, label]) => h('button', {
              key,
              type: 'button',
              'aria-pressed': duration === key,
              onClick: () => setDuration(key),
            }, t(label))))),
        h('div', { className: 'bt-browser-form-foot' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: resetForm }, t('Cancel')),
          h('button', {
            type: 'submit',
            className: 'bt-send bt-soft-sm',
            disabled: busy || !selectedBot || kinds.length === 0,
          }, busy ? t('Saving…') : t('Add'))))) : null,
    h(Section, { title: t('Allowed actions'), action: addBtn },
      h('p', { className: 'bt-browser-note' }, t('These grants apply only after an interactive browser plugin is enabled.')),
      grants.length === 0
        ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('Nothing allowed yet.')))
        : grants.map(({ bot, grant, index, expired }) => h('div', {
          key: `${bot.id}:${index}`,
          className: `bt-browser-grant${expired ? ' bt-browser-grant-expired' : ''}`,
        },
        h('div', { className: 'bt-browser-grant-who' },
          h(BotAvatar, { bot, size: 28 }),
          h('span', null, bot.name)),
        h('div', { className: 'bt-browser-grant-meta' },
          h('span', { className: 'bt-browser-grant-site' }, grant.site === '*' ? t('All sites') : grant.site),
          h('div', { className: 'bt-browser-grant-kinds' }, grantKinds(grant).map(label => h('span', { key: label, className: 'bt-chip' }, label))),
          h('span', { className: 'bt-set-hint' }, grantTime(grant))),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => remove(bot, index),
          'aria-label': t('Remove grant'),
        }, t('Remove grant'))))))
}
