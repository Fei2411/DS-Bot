import { createElement as h, useEffect, useState } from 'react'
import { BotAvatar } from './mark.js'
import { dateLocale, t } from './i18n.js'

const ACTIONS = [['post', 'Post'], ['upload', 'Upload'], ['download', 'Download'], ['delete', 'Delete']]
const DURATIONS = [['hour', '1 hour'], ['today', 'Today'], ['week', '7 days'], ['permanent', 'Permanent']]
const expired = grant => Number.isFinite(grant.until) && grant.until <= Date.now()

const FALLBACK_BACKEND = {
  active: 'readonly',
  status: {
    id: 'readonly',
    kind: 'readonly',
    name: 'Read-only (Built-in panel)',
    mode: 'readonly',
    state: 'ready',
    supportsGrants: true,
    message: null,
    installCommand: null,
  },
  canInstall: false,
  builtins: [
    { id: 'builtin:refs', name: 'DS Bot Playwright · ARIA refs', description: 'Step-by-step snapshots and numbered refs in each Bot’s isolated browser panel.' },
    { id: 'builtin:script', name: 'DS Bot Playwright · Script', description: 'Batch multiple actions into one JavaScript step in each Bot’s browser.' },
    { id: 'builtin:task', name: 'DS Bot Playwright · Whole task', description: 'Hand a web goal to a browser loop and return the answer and steps.' },
  ],
  dshPlugins: [],
  mcpServers: [],
  providers: [],
}

const STATUS_LABELS = {
  ready: 'Ready',
  loading: 'Loading…',
  'not-installed': 'Not installed',
  'restart-needed': 'Restart required',
  error: 'Error',
}

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

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
    }, () => {})
  }
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, copied ? t('Copied') : t('Copy command'))
}

function StatusChip({ state }) {
  const label = STATUS_LABELS[state] ?? 'Error'
  return h('span', { className: 'bt-chip bt-browser-status-chip', 'data-state': state }, t(label))
}

export function BrowserPage({ roster, actions, run, Section, Row }) {
  const bots = roster.bots ?? []
  const [fresh, setFresh] = useState(null)
  const [switching, setSwitching] = useState(null)
  const [installing, setInstalling] = useState(null)
  const [addingCustom, setAddingCustom] = useState(false)
  const [customKind, setCustomKind] = useState('dsh-plugin')
  const [customName, setCustomName] = useState('')
  const [customSpec, setCustomSpec] = useState('')
  const [customPrefixes, setCustomPrefixes] = useState('')
  const [customTransport, setCustomTransport] = useState('stdio')
  const [customCommand, setCustomCommand] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [customUrl, setCustomUrl] = useState('')

  const [botId, setBotId] = useState(bots[0]?.id ?? '')
  const [site, setSite] = useState('')
  const [kinds, setKinds] = useState(['post'])
  const [duration, setDuration] = useState('hour')
  const [busy, setBusy] = useState(false)
  const selectedBot = bots.find(bot => bot.id === botId)

  useEffect(() => {
    if (!bots.some(bot => bot.id === botId)) setBotId(bots[0]?.id ?? '')
  }, [bots, botId])

  const refreshBackends = () => {
    if (!actions.browserBackends) return
    void Promise.resolve(actions.browserBackends()).then(view => { if (view) setFresh(view) }, () => {})
  }
  useEffect(() => {
    refreshBackends()
  }, [])
  useEffect(() => {
    setFresh(null)
  }, [roster.browserBackend])

  const backend = fresh ?? roster.browserBackend ?? FALLBACK_BACKEND
  const activeId = backend.active ?? 'readonly'
  const liveStatus = roster.browserStatus?.id === activeId ? roster.browserStatus : null
  const status = liveStatus ?? backend.status ?? FALLBACK_BACKEND.status
  const supportsGrants = status.supportsGrants !== false

  const pickBackend = (id) => {
    if (!actions.browserSetBackend || switching !== null) return
    setSwitching(id)
    void run(Promise.resolve(actions.browserSetBackend(id)).then(view => {
      if (view) setFresh(view)
    })).finally(() => setSwitching(null))
  }

  const installPlugin = (item) => {
    if (!actions.browserInstallPlugin || installing !== null) return
    setInstalling(item.id)
    void run(Promise.resolve(actions.browserInstallPlugin({ id: item.id, spec: item.installSpec || item.packageName })).then(view => {
      if (view) setFresh(view)
    })).finally(() => setInstalling(null))
  }

  const retryBackend = () => {
    if (!actions.browserRetry || switching !== null) return
    setSwitching('retry')
    void run(Promise.resolve(actions.browserRetry()).then(view => {
      if (view) setFresh(view)
    })).finally(() => setSwitching(null))
  }

  const removeCustom = (id) => {
    if (!actions.browserCustomRemove || switching !== null) return
    setSwitching(id)
    void run(Promise.resolve(actions.browserCustomRemove(id)).then(view => {
      if (view) setFresh(view)
    })).finally(() => setSwitching(null))
  }

  const saveCustom = (event) => {
    event.preventDefault()
    if (!actions.browserCustomSave || switching !== null) return
    const payload = customKind === 'dsh-plugin'
      ? {
          kind: 'dsh-plugin',
          name: customName,
          installSpec: customSpec,
          toolPrefixes: customPrefixes,
        }
      : {
          kind: 'mcp',
          name: customName,
          transport: customTransport,
          ...(customTransport === 'stdio'
            ? { command: customCommand, args: customArgs }
            : { url: customUrl }),
        }
    setSwitching('custom')
    void run(Promise.resolve(actions.browserCustomSave(payload)).then(view => {
      if (view) setFresh(view)
      setCustomName('')
      setCustomSpec('')
      setCustomPrefixes('')
      setCustomCommand('')
      setCustomArgs('')
      setCustomUrl('')
      setAddingCustom(false)
    })).finally(() => setSwitching(null))
  }

  const grants = bots.flatMap(bot => (bot.browserGrants ?? []).map((grant, index) => ({
    bot, grant, index, expired: expired(grant),
  })))
  const remove = (bot, index) => {
    const next = (bot.browserGrants ?? []).filter((grant, position) => position !== index && !expired(grant))
    void run(actions.updateBot(bot.id, { browserGrants: next.length ? next : null }))
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
    void run(actions.updateBot(selectedBot.id, {
      browserGrants: [...(selectedBot.browserGrants ?? []).filter(grant => !expired(grant)), grant],
    })).finally(() => setBusy(false))
  }
  const toggleKind = (kind, checked) => {
    setKinds(current => checked
      ? (current.includes(kind) ? current : [...current, kind])
      : current.filter(value => value !== kind))
  }

  const actionButton = (id, disabled = false) => activeId === id
    ? h('span', { className: 'bt-chip bt-browser-active-chip' }, t('Active'))
    : h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled: disabled || switching !== null || !actions.browserSetBackend,
        onClick: () => pickBackend(id),
      }, switching === id ? t('Loading…') : t('Use'))

  const dshPlugins = backend.dshPlugins ?? []
  const mcpServers = backend.mcpServers ?? []
  const providers = backend.providers ?? []

  return h('div', { className: 'bt-browser-settings' },
    h(Section, {
      title: t('Browser backend'),
      action: actions.browserBackends
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: refreshBackends }, t('Refresh'))
        : null,
    },
    h('p', { className: 'bt-browser-note' }, t('Choose which browser engine the whole team uses. Switching takes effect right away without restarting DS Bot.')),
    h(Row, {
      label: status.id === 'readonly' ? t('Read-only') : status.name,
      hint: status.message || (status.id === 'readonly'
        ? t('A Bot can read the page you have open: its title, address and visible text. By default it cannot click, type, scroll or open pages.')
        : undefined),
    },
    h(StatusChip, { state: status.state }),
    status.installCommand ? h(CopyButton, { text: status.installCommand }) : null,
    ['error', 'not-installed'].includes(status.state) && actions.browserRetry
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: switching !== null, onClick: retryBackend }, t('Retry'))
      : null),
    h(Row, {
      label: t('Read-only'),
      hint: t('Bots only read the page open in their browser panel.'),
    }, actionButton('readonly')),
    (backend.builtins ?? []).map(item => h(Row, {
      key: item.id,
      label: item.name,
      hint: item.description,
    }, actionButton(item.id)))),

    h(Section, { title: t('DSH browser plugins') },
      h('p', { className: 'bt-browser-note' }, t('Replace the built-in browser with a DSH browser plugin such as ego lite. While an external plugin is active, built-in browser tools are hidden so Bots use only that plugin.')),
      dshPlugins.length === 0
        ? h(Row, { label: t('No DSH browser plugins listed yet.') })
        : dshPlugins.map(item => h(Row, {
            key: item.id,
            label: h('span', { className: 'bt-browser-item-title' },
              h('span', null, item.name),
              item.installed
                ? h('span', { className: 'bt-chip' }, item.version ? `${t('Installed')} · ${item.version}` : t('Installed'))
                : h('span', { className: 'bt-chip' }, t('Not installed'))),
            hint: item.installed
              ? item.description
              : `${item.description}${item.installCommand ? ` (${item.installCommand})` : ''}`,
          },
          item.installed
            ? actionButton(item.id)
            : backend.canInstall
              ? h('button', {
                  type: 'button',
                  className: 'bt-send bt-soft-sm',
                  disabled: installing !== null || !actions.browserInstallPlugin,
                  onClick: () => installPlugin(item),
                }, installing === item.id ? t('Loading…') : t('Install'))
              : [
                  item.installCommand ? h(CopyButton, { key: 'copy', text: item.installCommand }) : null,
                  actionButton(item.id),
                ],
          item.custom && actions.browserCustomRemove
            ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: switching !== null, onClick: () => removeCustom(item.id) }, t('Remove'))
            : null))),

    h(Section, { title: t('MCP browser servers') },
      h('p', { className: 'bt-browser-note' }, t('Run a browser automation MCP server in place of the built-in browser.')),
      mcpServers.map(item => h(Row, {
        key: item.id,
        label: h('span', { className: 'bt-browser-item-title' },
          h('span', null, item.name),
          h('span', { className: 'bt-chip' }, item.transport === 'streamable-http' ? 'HTTP' : 'stdio')),
        hint: item.description || (item.transport === 'streamable-http' ? item.url : [item.command, ...(item.args ?? [])].join(' ')),
      },
      actionButton(item.id),
      item.custom && actions.browserCustomRemove
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: switching !== null, onClick: () => removeCustom(item.id) }, t('Remove'))
        : null))),

    providers.length > 0 ? h(Section, { title: t('Registered providers') },
      providers.map(item => h(Row, {
        key: item.id,
        label: item.name,
        hint: item.description || item.packageName || item.id,
      }, actionButton(item.id)))) : null,

    actions.browserCustomSave ? h(Section, {
      title: t('Add custom browser plugin'),
      action: h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => setAddingCustom(open => !open),
      }, addingCustom ? t('Cancel') : t('Add')),
    },
    addingCustom
      ? h('form', { className: 'bt-browser-form', onSubmit: saveCustom },
          h(Row, { label: t('Plugin type') },
            h('div', { className: 'bt-browser-duration', role: 'group', 'aria-label': t('Plugin type') },
              [['dsh-plugin', 'DSH plugin'], ['mcp', 'MCP server']].map(([key, label]) => h('button', {
                key,
                type: 'button',
                className: 'bt-browser-duration-choice',
                'aria-pressed': customKind === key,
                onClick: () => setCustomKind(key),
              }, t(label))))),
          h(Row, { label: t('Name') },
            h('input', {
              className: 'bt-input bt-browser-site',
              type: 'text',
              required: true,
              value: customName,
              placeholder: customKind === 'dsh-plugin' ? 'Ego Browser' : 'My Browser MCP',
              onChange: event => setCustomName(event.target.value),
            })),
          customKind === 'dsh-plugin'
            ? [
                h(Row, { key: 'spec', label: t('Package or GitHub spec') },
                  h('input', {
                    className: 'bt-input bt-browser-site',
                    type: 'text',
                    required: true,
                    value: customSpec,
                    placeholder: 'dsh-ego-browser or github:owner/repo',
                    onChange: event => setCustomSpec(event.target.value),
                  })),
                h(Row, { key: 'prefixes', label: t('Tool prefixes'), hint: t('Optional, comma-separated, used to hide inactive plugin tools.') },
                  h('input', {
                    className: 'bt-input bt-browser-site',
                    type: 'text',
                    value: customPrefixes,
                    placeholder: 'ego_',
                    onChange: event => setCustomPrefixes(event.target.value),
                  })),
              ]
            : [
                h(Row, { key: 'transport', label: t('Transport') },
                  h('select', {
                    className: 'bt-select',
                    value: customTransport,
                    onChange: event => setCustomTransport(event.target.value),
                  },
                  h('option', { value: 'stdio' }, 'stdio'),
                  h('option', { value: 'streamable-http' }, 'Streamable HTTP'))),
                customTransport === 'stdio'
                  ? [
                      h(Row, { key: 'cmd', label: t('Command') },
                        h('input', {
                          className: 'bt-input bt-browser-site',
                          type: 'text',
                          required: true,
                          value: customCommand,
                          placeholder: 'npx',
                          onChange: event => setCustomCommand(event.target.value),
                        })),
                      h(Row, { key: 'args', label: t('Arguments') },
                        h('input', {
                          className: 'bt-input bt-browser-site',
                          type: 'text',
                          value: customArgs,
                          placeholder: '-y @playwright/mcp@latest',
                          onChange: event => setCustomArgs(event.target.value),
                        })),
                    ]
                  : h(Row, { key: 'url', label: t('URL') },
                      h('input', {
                        className: 'bt-input bt-browser-site',
                        type: 'url',
                        required: true,
                        value: customUrl,
                        placeholder: 'http://127.0.0.1:8931/mcp',
                        onChange: event => setCustomUrl(event.target.value),
                      })),
              ],
          h('div', { className: 'bt-browser-form-foot' },
            h('button', {
              type: 'submit',
              className: 'bt-send bt-soft-sm',
              disabled: switching !== null || customName.trim() === '',
            }, switching === 'custom' ? t('Saving…') : t('Add'))))
      : h('p', { className: 'bt-browser-note' }, t('Register another DSH browser plugin package or a custom MCP browser server.'))) : null,

    h(Section, { title: t('Allowed actions') },
      h('p', { className: 'bt-browser-note' }, supportsGrants
        ? t('With an interactive plugin, Bots browse, click and fill in forms. Posting, uploading, downloading and deleting ask you first unless you allow them here. Payments are always yours: the Bot hands the page to you.')
        : t('These grants apply to DS Bot’s built-in Playwright backend. The active external browser plugin handles its own permissions.')),
      grants.length === 0
        ? h(Row, { label: t('Nothing allowed yet.') })
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
        }, t('Remove grant'))))),

    h(Section, { title: t('Allow an action') },
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
          h('div', { className: 'bt-browser-duration', role: 'group', 'aria-label': t('Duration') },
            DURATIONS.map(([key, label]) => h('button', {
              key,
              type: 'button',
              className: 'bt-browser-duration-choice',
              'aria-pressed': duration === key,
              onClick: () => setDuration(key),
            }, t(label))))),
        h('div', { className: 'bt-browser-form-foot' },
          h('button', {
            type: 'submit',
            className: 'bt-send bt-soft-sm',
            disabled: busy || !selectedBot || kinds.length === 0,
          }, busy ? t('Saving…') : t('Add'))))))
}
