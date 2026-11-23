// Settings → Plugins: unified Bot plugin panel (Installed / Discover / Add custom).
// Displays exclusive team slots (starting with replaceable browser plugins), general
// plugins with per-Bot switches, remote plugin registries, and manual DSH/MCP installation.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { writeClipboard } from './dsh-primitives.js'
import { BotAvatar } from './mark.js'
import { CheckIcon, CopyIcon, GlobeIcon, PlugIcon, PlusIcon, PuzzleIcon, SearchIcon, TrashIcon } from './icons.js'
import { Segmented } from './motion.js'
import { hostText, language, t } from './i18n.js'

const TABS = [
  ['installed', 'Installed'],
  ['discover', 'Discover'],
  ['add', 'Add plugin'],
]

const CATEGORIES = [
  ['all', 'All'],
  ['browser', 'Browser'],
  ['tools', 'Tools'],
  ['productivity', 'Productivity'],
  ['dev', 'Developer'],
  ['data', 'Data'],
  ['other', 'Other'],
]

const CUSTOM_KINDS = [
  ['dsh', 'DSH / Bot package'],
  ['mcp', 'MCP server'],
]

const MCP_TRANSPORTS = [
  ['stdio', 'Command (stdio)'],
  ['streamable-http', 'HTTP (Streamable)'],
]

const SLOT_CHOICES = [
  ['', 'General plugin'],
  ['browser', 'Browser slot'],
]

const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9@._/:+-]+$/

function safeExternalUrl(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function shellQuote(arg) {
  const value = String(arg ?? '').trim()
  if (!value) return "''"
  if (SAFE_SHELL_ARG_RE.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function installCommandFor(plugin) {
  return `dsh plugin add ${shellQuote(plugin.installSpec || plugin.packageName)}`
}

function localizedField(plugin, field) {
  const lang = String(language?.() ?? 'en').toLowerCase()
  const locales = plugin.locales
  if (locales && typeof locales === 'object') {
    const exact = locales[lang]?.[field]
    if (exact) return exact
    const base = lang.split('-')[0]
    const primary = locales[base]?.[field]
    if (primary) return primary
  }
  return plugin[field] ?? ''
}

function pluginKindLabel(kind) {
  if (kind === 'builtin') return t('Built-in')
  if (kind === 'mcp') return 'MCP'
  if (kind === 'provider') return t('Native')
  return 'DSH'
}

function pluginMatches(plugin, query, category) {
  if (category !== 'all' && plugin.category !== category && plugin.slot !== category) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    plugin.id,
    plugin.name,
    plugin.description,
    localizedField(plugin, 'name'),
    localizedField(plugin, 'description'),
    plugin.packageName,
    plugin.author,
    ...(plugin.tags ?? []),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(q)
}

function parseKeyValueLines(text) {
  const out = {}
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const sep = line.indexOf('=')
    const colon = line.indexOf(':')
    const idx = sep !== -1 && (colon === -1 || sep < colon) ? sep : colon
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

function PluginIcon({ plugin }) {
  const Icon = plugin.slot === 'browser' || plugin.category === 'browser'
    ? GlobeIcon
    : plugin.kind === 'mcp' ? PlugIcon : PuzzleIcon
  return h('span', { className: 'bt-plg-icon', 'data-active': plugin.active || plugin.enabled ? '' : undefined, 'aria-hidden': true }, h(Icon))
}

function PluginCard({ plugin, bots, managerAvailable, busyId, readOnly, onActivateSlot, onInstall, onToggle, onUpdate, onRemove, onBotToggle, onCopy }) {
  const [expanded, setExpanded] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const name = localizedField(plugin, 'name') || plugin.name || plugin.id
  const desc = localizedField(plugin, 'description') || plugin.description || ''
  const isBusy = busyId === plugin.id
  const disabled = readOnly || busyId !== null
  const isSlot = Boolean(plugin.slot)
  const offSet = useMemo(() => new Set(plugin.offFor ?? []), [plugin.offFor])
  const homepageUrl = safeExternalUrl(plugin.homepage)
  const repoUrl = safeExternalUrl(plugin.repository)

  const toggleExpand = () => {
    setExpanded((open) => {
      if (open) setConfirmRemove(false)
      return !open
    })
  }

  const statusTag = () => {
    if (plugin.status === 'restart-required') return h('span', { className: 'bt-chip bt-plg-chip-warn' }, t('Restart required'))
    if (plugin.status === 'error') return h('span', { className: 'bt-chip bt-plg-chip-err' }, t('Error'))
    return null
  }

  const primaryAction = () => {
    if (isSlot) {
      if (plugin.active) {
        return h('span', { className: 'bt-plg-active-pill' }, h(CheckIcon), t('Active'))
      }
      if (plugin.installed || plugin.kind === 'mcp') {
        return h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          disabled,
          onClick: () => onActivateSlot(plugin.slot, plugin.id),
        }, isBusy ? t('Switching…') : t('Use'))
      }
      if (!managerAvailable && plugin.kind === 'dsh') {
        const cmd = installCommandFor(plugin)
        return h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm bt-with-icon',
          onClick: () => onCopy(cmd),
        }, h(CopyIcon), t('Copy install command'))
      }
      return h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled,
        onClick: () => onInstall(plugin),
      }, isBusy ? t('Installing…') : t('Install'))
    }

    if (!plugin.installed && plugin.kind === 'dsh') {
      if (!managerAvailable) {
        const cmd = installCommandFor(plugin)
        return h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm bt-with-icon',
          onClick: () => onCopy(cmd),
        }, h(CopyIcon), t('Copy install command'))
      }
      return h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled,
        onClick: () => onInstall(plugin),
      }, isBusy ? t('Installing…') : t('Install'))
    }

    if (!plugin.installed && plugin.kind === 'mcp') {
      return h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled,
        onClick: () => onInstall(plugin),
      }, isBusy ? t('Enabling…') : t('Add'))
    }

    return h(Switch, {
      on: plugin.enabled,
      label: name,
      disabled,
      onChange: next => onToggle(plugin.id, next),
    })
  }

  return h('div', {
    className: 'bt-plg-card',
    'data-active': plugin.active ? '' : undefined,
    'data-error': plugin.status === 'error' ? '' : undefined,
  },
  h('div', { className: 'bt-plg-card-main' },
    h('button', {
      type: 'button',
      className: 'bt-plg-card-body',
      'aria-expanded': expanded,
      onClick: toggleExpand,
    },
    h(PluginIcon, { plugin }),
    h('div', { className: 'bt-plg-card-copy' },
      h('div', { className: 'bt-plg-card-head' },
        h('span', { className: 'bt-plg-card-name' }, name),
        h('span', { className: 'bt-tag' }, pluginKindLabel(plugin.kind)),
        plugin.verified ? h('span', { className: 'bt-chip' }, t('Verified')) : null,
        plugin.version ? h('span', { className: 'bt-plg-ver' }, `v${plugin.version}`) : null,
        statusTag()),
      desc ? h('span', { className: 'bt-plg-card-desc' }, desc) : null,
      plugin.error ? h('span', { className: 'bt-plg-card-err' }, hostText(plugin.error)) : null)),
    h('div', { className: 'bt-plg-card-actions' }, primaryAction())),
  expanded ? h('div', { className: 'bt-plg-card-detail' },
    h('div', { className: 'bt-plg-meta-row' },
      plugin.packageName ? h('span', { className: 'bt-plg-meta' }, `${t('Package')}: `, h('code', null, plugin.packageName)) : null,
      plugin.installSpec && plugin.installSpec !== plugin.packageName ? h('span', { className: 'bt-plg-meta' }, `${t('Source')}: `, h('code', null, plugin.installSpec)) : null,
      plugin.mcp?.url ? h('span', { className: 'bt-plg-meta' }, `${t('URL')}: `, h('code', null, plugin.mcp.url)) : null,
      plugin.mcp?.command ? h('span', { className: 'bt-plg-meta' }, `${t('Command')}: `, h('code', null, [plugin.mcp.command, ...(plugin.mcp.args ?? [])].join(' '))) : null,
      plugin.toolPrefixes?.length ? h('span', { className: 'bt-plg-meta' }, `${t('Tools')}: `, h('code', null, plugin.toolPrefixes.join(', '))) : null,
      homepageUrl ? h('a', { className: 'bt-plg-link', href: homepageUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Homepage')) : null,
      repoUrl && repoUrl !== homepageUrl ? h('a', { className: 'bt-plg-link', href: repoUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Repository')) : null),
    plugin.supportsPerBot && plugin.installed && bots.length > 0 ? h('div', { className: 'bt-plg-bots' },
      h('span', { className: 'bt-plg-bots-label' }, t('Bot access')),
      h('div', { className: 'bt-plg-bots-list' },
        bots.map(bot => {
          const on = !offSet.has(bot.id)
          return h('div', { key: bot.id, className: 'bt-plg-bot-row' },
            h('span', { className: 'bt-plg-bot-who' }, h(BotAvatar, { bot, size: 22, badge: false, live: false }), h('span', null, bot.name)),
            h(Switch, {
              on,
              label: `${bot.name} — ${name}`,
              disabled,
              onChange: next => onBotToggle(plugin.id, bot.id, next),
            }))
        }))) : null,
    h('div', { className: 'bt-plg-detail-foot' },
      plugin.updatable && plugin.installed ? h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled,
        onClick: () => onUpdate(plugin.id),
      }, t('Update')) : null,
      plugin.removable ? (confirmRemove
        ? h('span', { className: 'bt-plg-confirm' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirmRemove(false) }, t('Cancel')),
          h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm bt-danger-btn',
            disabled,
            onClick: () => { setConfirmRemove(false); onRemove(plugin.id) },
          }, t('Confirm remove')))
        : h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm bt-with-icon',
          disabled,
          onClick: () => setConfirmRemove(true),
        }, h(TrashIcon), t('Remove'))) : null)) : null)
}

function AddCustomSection({ view, busy, readOnly, onSaveCustom, onInstallDirect, onSaveSource, onRemoveSource, Section, Row }) {
  const [kind, setKind] = useState('dsh')
  const [name, setName] = useState('')
  const [slot, setSlot] = useState('')
  const [spec, setSpec] = useState('')
  const [prefixes, setPrefixes] = useState('')
  const [transport, setTransport] = useState('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [localError, setLocalError] = useState('')
  const disabled = readOnly || busy

  const submitCustom = async (event) => {
    event.preventDefault()
    if (disabled) return
    setLocalError('')
    try {
      if (kind === 'dsh') {
        const cleanSpec = spec.trim()
        if (!cleanSpec) { setLocalError(t('Enter a package name, GitHub repository, or local path.')); return }
        const needsCustomEntry = !view?.managerAvailable || Boolean(name.trim() || slot || prefixes.trim())
        if (needsCustomEntry) {
          await onSaveCustom({
            kind: 'dsh',
            name: name.trim() || cleanSpec,
            spec: cleanSpec,
            packageName: cleanSpec,
            slot: slot || null,
            toolPrefixes: prefixes,
          })
        }
        if (view?.managerAvailable) {
          await onInstallDirect({ spec: cleanSpec, id: needsCustomEntry ? `dsh:${cleanSpec}` : undefined })
        }
      } else {
        const body = {
          kind: 'mcp',
          name: name.trim(),
          slot: slot || null,
          toolPrefixes: prefixes,
          transport,
          ...(transport === 'stdio'
            ? { command: command.trim(), args, env: parseKeyValueLines(envText) }
            : { url: url.trim(), headers: parseKeyValueLines(headersText) }),
        }
        await onSaveCustom(body)
      }
      setName('')
      setSpec('')
      setPrefixes('')
      setCommand('')
      setArgs('')
      setEnvText('')
      setUrl('')
      setHeadersText('')
    } catch (error) {
      setLocalError(hostText(error?.message ?? String(error)))
    }
  }

  const submitSource = async (event) => {
    event.preventDefault()
    if (disabled) return
    setLocalError('')
    try {
      await onSaveSource({ name: sourceName.trim(), url: sourceUrl.trim() })
      setSourceName('')
      setSourceUrl('')
    } catch (error) {
      setLocalError(hostText(error?.message ?? String(error)))
    }
  }

  return h('div', { className: 'bt-plg-add' },
    localError ? h('div', { className: 'bt-error', role: 'alert' }, localError) : null,
    h(Section, { title: t('Install or add a plugin') },
      h('form', { className: 'bt-plg-form', onSubmit: submitCustom },
        h(Row, { label: t('Type') },
          h(Segmented, { label: t('Type'), value: kind },
            CUSTOM_KINDS.map(([id, label]) => h('button', {
              key: id, type: 'button', 'aria-pressed': kind === id, disabled, onClick: () => setKind(id),
            }, t(label))))),
        h(Row, { label: t('Slot') },
          h(Segmented, { label: t('Slot'), value: slot },
            SLOT_CHOICES.map(([id, label]) => h('button', {
              key: id || 'general', type: 'button', 'aria-pressed': slot === id, disabled, onClick: () => setSlot(id),
            }, t(label))))),
        h(Row, { label: t('Name') },
          h('input', {
            className: 'bt-input bt-plg-field',
            type: 'text',
            'aria-label': t('Name'),
            disabled,
            value: name,
            placeholder: kind === 'dsh' ? t('Optional display name') : t('Plugin name'),
            onChange: e => setName(e.target.value),
          })),
        kind === 'dsh'
          ? h(Row, { label: t('Package or repository') },
            h('input', {
              className: 'bt-input bt-plg-field',
              type: 'text',
              'aria-label': t('Package or repository'),
              disabled,
              value: spec,
              placeholder: 'dsh-ego-browser / github:owner/repo / /path/to/plugin',
              onChange: e => setSpec(e.target.value),
            }))
          : [
            h(Row, { key: 'transport', label: t('Transport') },
              h(Segmented, { label: t('Transport'), value: transport },
                MCP_TRANSPORTS.map(([id, label]) => h('button', {
                  key: id, type: 'button', 'aria-pressed': transport === id, disabled, onClick: () => setTransport(id),
                }, t(label))))),
            ...(transport === 'stdio'
              ? [
                h(Row, { key: 'cmd', label: t('Command') },
                  h('input', { className: 'bt-input bt-plg-field', type: 'text', 'aria-label': t('Command'), disabled, value: command, placeholder: 'npx', onChange: e => setCommand(e.target.value) })),
                h(Row, { key: 'args', label: t('Arguments') },
                  h('input', { className: 'bt-input bt-plg-field', type: 'text', 'aria-label': t('Arguments'), disabled, value: args, placeholder: '-y @playwright/mcp@latest', onChange: e => setArgs(e.target.value) })),
                h(Row, { key: 'env', label: t('Environment') },
                  h('textarea', { className: 'bt-input bt-input-area bt-plg-field', rows: 2, 'aria-label': t('Environment'), disabled, value: envText, placeholder: 'API_TOKEN=$DSH_SECRET_MY_TOKEN', onChange: e => setEnvText(e.target.value) })),
              ]
              : [
                h(Row, { key: 'url', label: t('Server URL') },
                  h('input', { className: 'bt-input bt-plg-field', type: 'url', 'aria-label': t('Server URL'), disabled, value: url, placeholder: 'https://example.com/mcp', onChange: e => setUrl(e.target.value) })),
                h(Row, { key: 'headers', label: t('Headers') },
                  h('textarea', { className: 'bt-input bt-input-area bt-plg-field', rows: 2, 'aria-label': t('Headers'), disabled, value: headersText, placeholder: 'Authorization=Bearer $DSH_SECRET_TOKEN', onChange: e => setHeadersText(e.target.value) })),
              ]),
          ],
        h(Row, { label: t('Tool prefixes') },
          h('input', {
            className: 'bt-input bt-plg-field',
            type: 'text',
            'aria-label': t('Tool prefixes'),
            disabled,
            value: prefixes,
            placeholder: 'ego_, browser_',
            onChange: e => setPrefixes(e.target.value),
          })),
        h('div', { className: 'bt-browser-form-foot' },
          h('button', { type: 'submit', className: 'bt-send bt-soft-sm bt-with-icon', disabled },
            h(PlusIcon), kind === 'dsh' && view?.managerAvailable ? t('Install') : t('Add'))))),
    h(Section, { title: t('Plugin registries') },
      h(Row, { label: t('Official registry'), hint: view?.officialRegistryUrl ?? '' },
        h('span', { className: 'bt-chip' }, t('Built-in'))),
      ...(view?.sources ?? []).map(src => h(Row, { key: src.id, label: src.name, hint: src.url },
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          disabled,
          onClick: () => onRemoveSource(src.id),
        }, t('Remove')))),
      h('form', { className: 'bt-plg-source-form', onSubmit: submitSource },
        h('input', { className: 'bt-input', type: 'text', 'aria-label': t('Registry name'), disabled, value: sourceName, placeholder: t('Registry name'), onChange: e => setSourceName(e.target.value) }),
        h('input', { className: 'bt-input', type: 'url', 'aria-label': t('Server URL'), disabled, value: sourceUrl, placeholder: 'https://example.com/registry.json', onChange: e => setSourceUrl(e.target.value) }),
        h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: disabled || !sourceUrl.trim() }, t('Add source')))))
}

export function PluginsPage({ roster, actions, Section, Row, initialFilter = null }) {
  const [view, setView] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingApproval, setPendingApproval] = useState(null)
  const [tab, setTab] = useState('installed')
  const [category, setCategory] = useState(initialFilter === 'browser' ? 'browser' : 'all')
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  const busySeqRef = useRef(0)
  const hasViewRef = useRef(false)
  const readOnly = Boolean(roster?.readOnly)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    if (initialFilter === 'browser') {
      setCategory('browser')
      setTab('installed')
    }
  }, [initialFilter])

  const load = useCallback((refresh = false) => {
    if (!actions.pluginsList) {
      setLoading(false)
      return Promise.resolve()
    }
    const seq = ++seqRef.current
    if (refresh) setRefreshing(true)
    else if (!hasViewRef.current) setLoading(true)
    setError('')
    return Promise.resolve(refresh && actions.pluginsCatalogRefresh ? actions.pluginsCatalogRefresh() : actions.pluginsList(refresh))
      .then((next) => {
        if (!aliveRef.current || seq !== seqRef.current) return
        if (next) {
          hasViewRef.current = true
          setView(next)
        }
      })
      .catch((failure) => {
        if (!aliveRef.current || seq !== seqRef.current) return
        setError(hostText(failure?.message ?? String(failure)))
      })
      .finally(() => {
        if (!aliveRef.current || seq !== seqRef.current) return
        setLoading(false)
        setRefreshing(false)
      })
  }, [actions])

  useEffect(() => { void load(false) }, [load])

  const exec = (id, promise, { onError } = {}) => {
    const seq = ++seqRef.current
    const busySeq = ++busySeqRef.current
    setBusyId(id)
    setError('')
    return Promise.resolve(promise)
      .then((res) => {
        if (!aliveRef.current || seq !== seqRef.current) return res
        const nextView = res?.view ?? (res?.plugins ? res : null)
        if (nextView) {
          hasViewRef.current = true
          setView(nextView)
        } else {
          return load(false).then(() => res)
        }
        return res
      })
      .catch((failure) => {
        if (!aliveRef.current || seq !== seqRef.current) throw failure
        const handled = onError?.(failure) === true
        if (!handled) setError(hostText(failure?.message ?? String(failure)))
        throw failure
      })
      .finally(() => {
        if (aliveRef.current && busySeq === busySeqRef.current) setBusyId(null)
      })
  }

  const runInstall = (body, busyKey) => exec(busyKey, actions.pluginsInstall(body), {
    onError(failure) {
      const pending = failure?.details?.pendingBuilds
      if (Array.isArray(pending) && pending.length > 0) {
        setPendingApproval({ body, busyKey, packages: pending })
        return true
      }
      return false
    },
  }).then((res) => {
    if (aliveRef.current) setPendingApproval(null)
    return res
  })

  const handleActivateSlot = (slot, id) => { void exec(id, actions.pluginsSlotSet(slot, id)).catch(() => {}) }
  const handleInstall = (plugin) => { void runInstall({ id: plugin.id, spec: plugin.installSpec }, plugin.id).catch(() => {}) }
  const handleApproveBuilds = () => {
    if (!pendingApproval) return
    const { body, busyKey, packages } = pendingApproval
    void runInstall({ ...body, approvedBuilds: packages }, busyKey).catch(() => {})
  }
  const handleToggle = (id, enabled) => { void exec(id, actions.pluginsToggle(id, enabled)).catch(() => {}) }
  const handleUpdate = (id) => { void exec(id, actions.pluginsUpdate(id)).catch(() => {}) }
  const handleRemove = (id) => { void exec(id, actions.pluginsRemove(id)).catch(() => {}) }
  const handleBotToggle = (id, botId, enabled) => { void exec(id, actions.pluginsBotToggle(id, botId, enabled)).catch(() => {}) }
  const handleRetry = () => { void exec('retry', actions.pluginsRetry()).catch(() => {}) }
  const handleCopy = (cmd) => {
    const copy = typeof writeClipboard === 'function'
      ? writeClipboard(cmd)
      : (typeof navigator !== 'undefined' && navigator.clipboard?.writeText ? navigator.clipboard.writeText(cmd).then(() => true, () => false) : Promise.resolve(false))
    void Promise.resolve(copy).then((ok) => {
      if (ok) actions.notice?.(t('Copied command'))
    }, () => {})
  }

  const plugins = view?.plugins ?? []
  const bots = roster?.bots ?? []
  const browserSlot = view?.slots?.browser
  const activeBrowserPlugin = plugins.find(p => p.id === browserSlot?.active)
  const hasPendingRestart = Boolean(
    browserSlot?.status === 'restart-required'
    || roster?.plugins?.pendingRestart
    || plugins.some(p => p.status === 'restart-required'),
  )
  const catalogErrors = (view?.catalog?.errors ?? []).filter(e => e.sourceId !== 'official' || !view?.catalog?.offline)

  const filtered = useMemo(
    () => plugins.filter(p => pluginMatches(p, query, category)),
    [plugins, query, category],
  )

  const browserPlugins = useMemo(
    () => filtered.filter(p => p.slot === 'browser'),
    [filtered],
  )

  const installedBrowser = useMemo(
    () => browserPlugins.filter(p => p.installed || p.kind === 'mcp' || p.active),
    [browserPlugins],
  )
  const discoverBrowser = useMemo(
    () => browserPlugins.filter(p => !p.builtin),
    [browserPlugins],
  )

  const generalInstalled = useMemo(
    () => filtered.filter(p => !p.slot && p.installed),
    [filtered],
  )
  const generalDiscover = useMemo(
    () => filtered.filter(p => !p.slot && !p.builtin),
    [filtered],
  )

  const showBrowserSlot = category === 'all' || category === 'browser'
  const shownBrowser = tab === 'discover' ? discoverBrowser : installedBrowser
  const shownGeneral = tab === 'discover' ? generalDiscover : generalInstalled

  const browserSummaryBadge = activeBrowserPlugin
    ? `${t('Active')}: ${localizedField(activeBrowserPlugin, 'name') || activeBrowserPlugin.name}`
    : null

  return h('div', { className: 'bt-plugins-page' },
    h('div', { className: 'bt-plg-bar' },
      h('div', { className: 'bt-plg-search-wrap' },
        h(SearchIcon),
        h('input', {
          type: 'search',
          className: 'bt-input bt-plg-search',
          value: query,
          placeholder: t('Search plugins'),
          'aria-label': t('Search plugins'),
          onChange: e => setQuery(e.target.value),
        })),
      h(Segmented, { label: t('Plugins'), value: tab, className: 'bt-plg-tabs' },
        TABS.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          'aria-pressed': tab === id,
          onClick: () => setTab(id),
        }, t(label)))),
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled: refreshing || loading || busyId !== null,
        onClick: () => void load(true),
      }, refreshing ? t('Refreshing…') : t('Refresh'))),
    tab !== 'add' ? h('div', { className: 'bt-plg-cats', role: 'group', 'aria-label': t('Categories') },
      CATEGORIES.map(([id, label]) => h('button', {
        key: id,
        type: 'button',
        className: 'bt-plg-cat',
        'aria-pressed': category === id,
        onClick: () => setCategory(id),
      }, t(label)))) : null,
    readOnly ? h('div', { className: 'bt-plg-banner', 'data-tone': 'warn', role: 'status' },
      h('span', null, hostText(roster.readOnly))) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    pendingApproval ? h('div', { className: 'bt-plg-banner', 'data-tone': 'warn', role: 'alert' },
      h('span', null, t('Build scripts require approval for: {packages}', { packages: pendingApproval.packages.join(', ') })),
      h('div', { className: 'bt-plg-banner-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busyId !== null, onClick: () => setPendingApproval(null) }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: readOnly || busyId !== null, onClick: handleApproveBuilds }, t('Approve & install')))) : null,
    browserSlot?.status === 'error' || browserSlot?.status === 'unavailable' ? h('div', { className: 'bt-plg-banner', 'data-tone': 'error' },
      h('span', null, hostText(browserSlot.error || t('Active browser plugin failed to load.'))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busyId !== null, onClick: handleRetry }, t('Try again'))) : null,
    hasPendingRestart ? h('div', { className: 'bt-plg-banner', 'data-tone': 'warn' },
      h('span', null, browserSlot?.status === 'restart-required'
        ? t('Restart DS Bot to finish loading the selected browser plugin.')
        : t('Restart DS Bot to finish applying plugin changes.'))) : null,
    catalogErrors.length > 0 ? h('div', { className: 'bt-plg-banner', 'data-tone': 'warn' },
      h('span', null, t('Catalog sync failed: {details}', { details: catalogErrors.map(e => `${e.sourceId}: ${e.message}`).join('; ') }))) : null,
    tab === 'add'
      ? h(AddCustomSection, {
        view,
        busy: busyId !== null,
        readOnly,
        onSaveCustom: body => exec('custom', actions.pluginsCustomSave(body)),
        onInstallDirect: body => runInstall(body, 'custom'),
        onSaveSource: body => exec('source', actions.pluginsSourceSave(body)),
        onRemoveSource: id => exec('source', actions.pluginsSourceRemove(id)).catch(() => {}),
        Section,
        Row,
      })
      : loading && !view
        ? h('div', { className: 'bt-empty' }, t('Loading…'))
        : [
          showBrowserSlot && shownBrowser.length > 0 ? h('section', { key: 'browser-slot', className: 'bt-plg-section' },
            h('div', { className: 'bt-plg-sec-head' },
              h('h3', null, t('Browser plugins')),
              browserSummaryBadge ? h('span', { className: 'bt-chip bt-plg-chip-ok' }, browserSummaryBadge) : null),
            h('div', { className: 'bt-plg-grid' },
              shownBrowser.map(plugin => h(PluginCard, {
                key: plugin.id,
                plugin,
                bots,
                managerAvailable: view?.managerAvailable === true,
                busyId,
                readOnly,
                onActivateSlot: handleActivateSlot,
                onInstall: handleInstall,
                onToggle: handleToggle,
                onUpdate: handleUpdate,
                onRemove: handleRemove,
                onBotToggle: handleBotToggle,
                onCopy: handleCopy,
              })))) : null,
          shownGeneral.length > 0 ? h('section', { key: 'general', className: 'bt-plg-section' },
            h('div', { className: 'bt-plg-sec-head' },
              h('h3', null, tab === 'discover' ? t('Available plugins') : t('Installed plugins'))),
            h('div', { className: 'bt-plg-grid' },
              shownGeneral.map(plugin => h(PluginCard, {
                key: plugin.id,
                plugin,
                bots,
                managerAvailable: view?.managerAvailable === true,
                busyId,
                readOnly,
                onActivateSlot: handleActivateSlot,
                onInstall: handleInstall,
                onToggle: handleToggle,
                onUpdate: handleUpdate,
                onRemove: handleRemove,
                onBotToggle: handleBotToggle,
                onCopy: handleCopy,
              })))) : null,
          (!showBrowserSlot || shownBrowser.length === 0) && shownGeneral.length === 0
            ? h('div', { key: 'empty', className: 'bt-empty' }, t('No matching plugins'))
            : null,
        ])
}
