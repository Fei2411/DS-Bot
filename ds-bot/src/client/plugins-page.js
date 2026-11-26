// Settings → Plugins: unified Bot plugin catalog & manager.
// Browser control gets its own live viewport stage + hot-swappable engine deck;
// general plugins use additive switches. Every plugin uses a custom multi-color
// mark that sits in refined grayscale when inactive and blooms into full brand
// color with a light sweep (matching Connectors) when activated or enabled.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { writeClipboard } from './dsh-primitives.js'
import { BotAvatar } from './mark.js'
import { ExtensionsClusterMark, PluginMark, browserMetaFor } from './plugin-marks.js'
import {
  CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon,
  PlusIcon, SearchIcon, SpinnerIcon, TrashIcon,
} from './icons.js'
import { Segmented } from './motion.js'
import { hostText, language, t } from './i18n.js'

const PREVIEW_COUNT = 6

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

// Allow only safe npm / GitHub / plain path specs without spaces or shell metacharacters
// (safe across POSIX shells, PowerShell, and Windows Command Prompt).
const SAFE_CLI_SPEC_RE = /^[A-Za-z0-9@._/:#+-]+$/

// Internal DSH profiles, experimental engine bundles, and subagent/agent-team bundles
// belong only to Engine plugins (or are disallowed in DS Bot) and must never leak into
// DS Bot's Plugins catalog or Discover section.
const HIDDEN_ENGINE_BUNDLES = new Set([
  'dsbot-engine',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
])

function isHiddenEngineBundle(plugin) {
  if (plugin.slot) return false
  if (plugin.sourceId === 'installed' && !plugin.installed) return true
  const pkg = String(plugin.packageName ?? (String(plugin.id ?? '').startsWith('dsh:') ? String(plugin.id).slice(4) : '')).trim()
  if (!pkg) return false
  return HIDDEN_ENGINE_BUNDLES.has(pkg) || pkg.startsWith('@deepseek-ai/dsh-subagent-')
}

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

function installCommandFor(plugin) {
  const value = String(plugin.installSpec || plugin.packageName || '').trim()
  if (!value || !SAFE_CLI_SPEC_RE.test(value)) return null
  return `dsh plugin add ${value}`
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

// Plays one sweep + icon pop when a plugin transitions from inactive → active,
// matching Connectors' useJustConnected. Plugins that load already active stay still.
function useJustActivated(active) {
  const last = useRef(active)
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    const was = last.current
    last.current = active
    if (!active) {
      setFresh(false)
      return undefined
    }
    if (was) return undefined
    setFresh(true)
    const timer = setTimeout(() => setFresh(false), 1100)
    if (typeof timer === 'object' && timer?.unref) timer.unref()
    return () => clearTimeout(timer)
  }, [active])
  return fresh
}

// Plays one cross-color sweep on the Browser Control Stage when the active engine changes.
function useJustSwitched(key) {
  const last = useRef(key)
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    const was = last.current
    last.current = key
    if (!key) {
      setFresh(false)
      return undefined
    }
    if (!was || was === key) return undefined
    setFresh(true)
    const timer = setTimeout(() => setFresh(false), 1100)
    if (typeof timer === 'object' && timer?.unref) timer.unref()
    return () => clearTimeout(timer)
  }, [key])
  return fresh
}

function PluginIcon({ plugin, size = 36 }) {
  return h('span', {
    className: 'bt-plg-icon',
    style: size === 36 ? undefined : { width: size, height: size },
    'aria-hidden': true,
  }, h(PluginMark, { plugin }))
}

function BrowserStage({ plugin, slotStatus, onOpen }) {
  const fresh = useJustSwitched(plugin?.id ?? '')
  if (!plugin) return null
  const name = localizedField(plugin, 'name') || plugin.name || plugin.id
  const desc = localizedField(plugin, 'description') || plugin.description || ''
  const meta = browserMetaFor(plugin)
  const statusTone = slotStatus === 'error' || slotStatus === 'unavailable' || plugin.error
    ? 'error'
    : slotStatus === 'restart-required' || plugin.status === 'restart-required'
      ? 'warn'
      : 'ready'
  const statusLabel = statusTone === 'error'
    ? t('Unavailable')
    : statusTone === 'warn'
      ? t('Restart required')
      : t('In use')

  return h('div', {
    className: 'bt-plg-stage',
    'data-tone': statusTone,
    'data-fresh': fresh ? '' : undefined,
  },
  h('div', { className: 'bt-plg-stage-bar' },
    h('span', { className: 'bt-plg-stage-dots', 'aria-hidden': true },
      h('i', null), h('i', null), h('i', null)),
    h('span', { className: 'bt-plg-stage-url', title: meta.url }, meta.url),
    h('span', { className: 'bt-plg-stage-status' },
      h('span', { className: 'bt-plg-stage-dot', 'aria-hidden': true }),
      statusLabel)),
  h('div', { className: 'bt-plg-stage-body' },
    h('button', {
      type: 'button',
      className: 'bt-plg-stage-main',
      onClick: () => onOpen(plugin.id),
    },
    h(PluginIcon, { plugin, size: 44 }),
    h('div', { className: 'bt-plg-stage-copy' },
      h('span', { className: 'bt-plg-stage-name' }, name),
      desc ? h('span', { className: 'bt-plg-stage-desc' }, desc) : null,
      meta.traits.length > 0 ? h('span', { className: 'bt-plg-stage-traits' },
        meta.traits.map(tr => t(tr)).join(' · ')) : null)),
    h('button', {
      type: 'button',
      className: 'bt-plg-stage-btn',
      onClick: () => onOpen(plugin.id),
    }, t('Details'), h(ChevronRightIcon))))
}

function RefreshGlyph({ spinning }) {
  if (spinning) return h(SpinnerIcon)
  return h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M16 10a6 6 0 1 1-1.76-4.24L16 7.5' }),
    h('path', { d: 'M16 3.5v4h-4' }))
}

function Subview({ title, onBack, end = null, children }) {
  return h('div', { className: 'bt-plg-subview' },
    h('div', { className: 'bt-plg-sub-head' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: onBack }, h(ChevronLeftIcon)),
      h('h3', null, title),
      end ? h('div', { className: 'bt-plg-sub-end' }, end) : null),
    children)
}

function PluginAction({ plugin, managerAvailable, busyId, readOnly, onActivateSlot, onInstall, onToggle, onCopy, onConsent }) {
  const name = localizedField(plugin, 'name') || plugin.name || plugin.id
  const isBusy = busyId === plugin.id
  const disabled = readOnly || busyId !== null
  const isSlot = Boolean(plugin.slot)

  // A killed plugin is stopped by the security kill list, and unverifiable bytes are a
  // security failure: neither is a toggleable preference, so there is no control — the
  // name-row badge already says why, and a dead switch would promise control that the
  // gate has deliberately withdrawn.
  if (plugin.killed || plugin.status === 'unverifiable') return null
  // Changed code, capabilities, execution tier, entry, or placement invalidates the
  // stored approval; an explicit Approve is the only path that re-consents, bound
  // server-side to the plugin exactly as it is now.
  if (plugin.consentRequired) {
    return h('button', {
      type: 'button',
      className: 'bt-plg-btn bt-plg-btn-approve',
      disabled,
      onClick: () => onConsent(plugin.id),
    }, isBusy ? t('Approving…') : t('Approve'))
  }

  if (isSlot) {
    if (plugin.active && plugin.desired !== false) {
      return h('span', { className: 'bt-plg-btn bt-plg-btn-done' }, h(CheckIcon), t('In use'))
    }
    if (plugin.installed || plugin.kind === 'mcp') {
      return h('button', {
        type: 'button',
        className: 'bt-plg-btn',
        disabled,
        onClick: () => onActivateSlot(plugin.slot, plugin.id),
      }, isBusy ? t('Switching…') : t('Use'))
    }
    if (!managerAvailable && plugin.kind === 'dsh') {
      const cmd = installCommandFor(plugin)
      if (!cmd) return null
      return h('button', {
        type: 'button',
        className: 'bt-plg-btn',
        onClick: () => onCopy(cmd),
      }, h(CopyIcon), t('Copy install command'))
    }
    return h('button', {
      type: 'button',
      className: 'bt-plg-btn',
      disabled,
      onClick: () => onInstall(plugin),
    }, isBusy ? t('Installing…') : t('Install'))
  }

  if (!plugin.installed && plugin.kind === 'dsh') {
    if (!managerAvailable) {
      const cmd = installCommandFor(plugin)
      if (!cmd) return null
      return h('button', {
        type: 'button',
        className: 'bt-plg-btn',
        onClick: () => onCopy(cmd),
      }, h(CopyIcon), t('Copy install command'))
    }
    return h('button', {
      type: 'button',
      className: 'bt-plg-btn',
      disabled,
      onClick: () => onInstall(plugin),
    }, isBusy ? t('Installing…') : t('Install'))
  }

  if (!plugin.installed && plugin.kind === 'mcp') {
    return h('button', {
      type: 'button',
      className: 'bt-plg-btn',
      disabled,
      onClick: () => onInstall(plugin),
    }, isBusy ? t('Enabling…') : t('Add'))
  }

  return h(Switch, {
    on: plugin.kind === 'mcp' ? (plugin.desired ?? plugin.enabled) : plugin.enabled,
    label: name,
    disabled,
    onChange: next => onToggle(plugin.id, next),
  })
}

function PluginTile({ plugin, managerAvailable, busyId, readOnly, onOpen, onActivateSlot, onInstall, onToggle, onCopy, onConsent }) {
  const name = localizedField(plugin, 'name') || plugin.name || plugin.id
  const desc = localizedField(plugin, 'description') || plugin.description || ''
  const isActive = Boolean(plugin.slot ? (plugin.active && plugin.desired !== false) : (plugin.installed && plugin.enabled))
  const fresh = useJustActivated(isActive)
  const subtitle = plugin.error
    ? hostText(plugin.error)
    : plugin.status === 'restart-required'
      ? t('Restart required')
      : desc
  const tone = plugin.status === 'error' || plugin.killed || plugin.status === 'unverifiable' || (plugin.error && !plugin.consentRequired)
    ? 'error'
    : plugin.status === 'restart-required' || plugin.consentRequired ? 'warn' : undefined

  return h('div', {
    className: 'bt-plg-tile',
    'data-active': isActive ? '' : undefined,
    'data-fresh': fresh ? '' : undefined,
    'data-error': tone === 'error' ? '' : undefined,
    'data-warn': tone === 'warn' ? '' : undefined,
  },
  h('button', {
    type: 'button',
    className: 'bt-plg-main',
    onClick: () => onOpen(plugin.id),
  },
  h(PluginIcon, { plugin }),
  h('span', { className: 'bt-plg-text' },
    h('span', { className: 'bt-plg-name' },
      h('span', { className: 'bt-plg-label' }, name),
      plugin.custom && !plugin.killed && !plugin.consentRequired && plugin.status !== 'unverifiable'
        ? h('span', { className: 'bt-tag' }, t('Added')) : null,
      plugin.killed ? h('span', { className: 'bt-tag', 'data-tone': 'error' }, t('Stopped')) : null,
      plugin.consentRequired ? h('span', { className: 'bt-tag', 'data-tone': 'warn' }, t('Approval needed')) : null,
      plugin.status === 'unverifiable' ? h('span', { className: 'bt-tag', 'data-tone': 'error' }, t('Unverifiable')) : null),
    subtitle ? h('span', { className: 'bt-plg-sub' }, subtitle) : null)),
  h(PluginAction, { plugin, managerAvailable, busyId, readOnly, onActivateSlot, onInstall, onToggle, onCopy, onConsent }))
}

function PluginDetailView({ plugin, bots, managerAvailable, busyId, readOnly, onBack, onActivateSlot, onInstall, onToggle, onUpdate, onRemove, onBotToggle, onCopy, onConsent, Section, Row }) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const name = localizedField(plugin, 'name') || plugin.name || plugin.id
  const desc = localizedField(plugin, 'description') || plugin.description || ''
  const disabled = readOnly || busyId !== null
  const offSet = useMemo(() => new Set(plugin.offFor ?? []), [plugin.offFor])
  const homepageUrl = safeExternalUrl(plugin.homepage)
  const repoUrl = safeExternalUrl(plugin.repository)

  const metaParts = [
    pluginKindLabel(plugin.kind),
    plugin.version ? `v${plugin.version}` : null,
    plugin.verified ? t('Verified') : null,
    plugin.author || null,
  ].filter(Boolean).join(' · ')

  const hasDetailRows = Boolean(
    plugin.packageName
    || (plugin.installSpec && plugin.installSpec !== plugin.packageName)
    || plugin.mcp?.url
    || plugin.mcp?.command
    || plugin.toolPrefixes?.length
    || homepageUrl
    || repoUrl
    || (plugin.updatable && plugin.installed)
    || plugin.removable,
  )

  const isActive = Boolean(plugin.slot ? (plugin.active && plugin.desired !== false) : (plugin.installed && plugin.enabled))

  return h(Subview, { title: name, onBack },
    h('div', { className: 'bt-set-card bt-plg-detail-hero' },
      h('div', { className: 'bt-plg-detail-top', 'data-active': isActive ? '' : undefined },
        h(PluginIcon, { plugin, size: 44 }),
        h('div', { className: 'bt-plg-detail-title' },
          h('span', { className: 'bt-plg-detail-name' }, name),
          metaParts ? h('span', { className: 'bt-plg-detail-meta' }, metaParts) : null),
        plugin.consentRequired
          ? null
          : h(PluginAction, { plugin, managerAvailable, busyId, readOnly, onActivateSlot, onInstall, onToggle, onCopy, onConsent })),
      plugin.error && !plugin.consentRequired ? h('div', { className: 'bt-plg-detail-err', role: 'alert' }, hostText(plugin.error)) : null),
    plugin.consentRequired ? h('div', { className: 'bt-plg-banner', 'data-tone': 'warn', role: 'alert' },
      h('span', null, t('This plugin changed since it was approved — its capabilities, execution tier, executable entry, content, or placement. It stays stopped until you approve the plugin exactly as it is now.')),
      h('div', { className: 'bt-plg-banner-actions' },
        h('button', {
          type: 'button',
          className: 'bt-send bt-soft-sm',
          disabled,
          onClick: () => onConsent(plugin.id),
        }, busyId === plugin.id ? t('Approving…') : t('Approve')))) : null,
    desc ? h('p', { className: 'bt-plg-about' }, desc) : null,
    plugin.unpinnedSpec ? h('p', { className: 'bt-plg-note' },
      t('Runs the latest published version at start time; approval does not pin exact bytes.')) : null,
    plugin.supportsPerBot && plugin.installed && bots.length > 0
      ? h(Section, { title: t('Bot access') },
        bots.map(bot => {
          const on = !offSet.has(bot.id)
          return h('div', { key: bot.id, className: 'bt-set-row bt-plg-bot-row' },
            h('span', { className: 'bt-plg-bot-who' }, h(BotAvatar, { bot, size: 24, badge: false, live: false }), h('span', null, bot.name)),
            h(Switch, {
              on,
              label: `${bot.name} — ${name}`,
              disabled,
              onChange: next => onBotToggle(plugin.id, bot.id, next),
            }))
        }))
      : null,
    hasDetailRows
      ? h(Section, { title: t('Details') },
        plugin.packageName ? h(Row, { label: t('Package') }, h('code', { className: 'bt-plg-code' }, plugin.packageName)) : null,
        plugin.installSpec && plugin.installSpec !== plugin.packageName ? h(Row, { label: t('Source') }, h('code', { className: 'bt-plg-code' }, plugin.installSpec)) : null,
        plugin.mcp?.url ? h(Row, { label: t('URL') }, h('code', { className: 'bt-plg-code' }, plugin.mcp.url)) : null,
        plugin.mcp?.command ? h(Row, { label: t('Command') }, h('code', { className: 'bt-plg-code' }, [plugin.mcp.command, ...(plugin.mcp.args ?? [])].join(' '))) : null,
        plugin.toolPrefixes?.length ? h(Row, { label: t('Tools') }, h('code', { className: 'bt-plg-code' }, plugin.toolPrefixes.join(', '))) : null,
        plugin.execution ? h(Row, { label: t('Execution tier') }, h('span', { className: 'bt-chip' }, plugin.execution)) : null,
        homepageUrl ? h(Row, { label: t('Homepage') }, h('a', { className: 'bt-plg-link', href: homepageUrl, target: '_blank', rel: 'noopener noreferrer' }, homepageUrl)) : null,
        repoUrl && repoUrl !== homepageUrl ? h(Row, { label: t('Repository') }, h('a', { className: 'bt-plg-link', href: repoUrl, target: '_blank', rel: 'noopener noreferrer' }, repoUrl)) : null,
        (plugin.updatable && plugin.installed) || plugin.removable
          ? h('div', { className: 'bt-plg-detail-foot' },
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
              }, h(TrashIcon), t('Remove'))) : null)
          : null)
      : null)
}

function AddCustomSection({ view, busy, readOnly, onBack, onSaveCustom, onInstallDirect, onSaveSource, onRemoveSource, Section, Row }) {
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
  const disabled = readOnly || busy || !view

  const submitCustom = async (event) => {
    event.preventDefault()
    if (disabled) return
    setLocalError('')
    try {
      if (kind === 'dsh') {
        const cleanSpec = spec.trim()
        if (!cleanSpec) { setLocalError(t('Enter a package name, GitHub repository, or local path.')); return }
        const hasMeta = Boolean(name.trim() || slot || prefixes.trim())
        if (view?.managerAvailable) {
          await onInstallDirect({
            spec: cleanSpec,
            ...(hasMeta ? {
              customMeta: {
                name: name.trim() || cleanSpec,
                slot: slot || null,
                toolPrefixes: prefixes,
              },
            } : {}),
          })
        } else {
          await onSaveCustom({
            kind: 'dsh',
            name: name.trim() || cleanSpec,
            spec: cleanSpec,
            packageName: cleanSpec,
            slot: slot || null,
            toolPrefixes: prefixes,
          })
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

  return h(Subview, { title: t('Add plugin'), onBack },
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

function InstalledSummary({ plugins, count, onClick }) {
  if (count === 0) return null
  return h('button', { type: 'button', className: 'bt-plg-summary', onClick },
    h('span', { className: 'bt-plg-stack', 'aria-hidden': true },
      plugins.slice(0, 3).map(p => h(PluginIcon, { key: p.id, plugin: p, size: 22 }))),
    t('{count} installed', { count }),
    h(ChevronRightIcon))
}

export function PluginsPage({ roster, actions, Section, Row, initialFilter = null, openEnginePlugins = null }) {
  const [view, setView] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingApproval, setPendingApproval] = useState(null)
  const [subview, setSubview] = useState(null) // null | 'add' | 'installed' | { plugin: id }
  const [category, setCategory] = useState(initialFilter === 'browser' ? 'browser' : 'all')
  const [showAllDiscover, setShowAllDiscover] = useState(false)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const aliveRef = useRef(true)
  const seqRef = useRef(0)
  const busySeqRef = useRef(0)
  const hasViewRef = useRef(false)
  const busyRef = useRef(false)
  busyRef.current = busyId !== null
  const readOnly = Boolean(roster?.readOnly)
  const livePluginsKey = JSON.stringify(roster?.plugins ?? null)
  const lastLiveKeyRef = useRef(livePluginsKey)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    if (initialFilter === 'browser') {
      setCategory('browser')
      setSubview(null)
    }
  }, [initialFilter])

  const load = useCallback((refresh = false, { keepError = false } = {}) => {
    if (!actions.pluginsList) {
      setLoading(false)
      return Promise.resolve()
    }
    const seq = ++seqRef.current
    if (refresh) setRefreshing(true)
    else if (!hasViewRef.current) setLoading(true)
    if (!keepError) setError('')
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

  // Refresh the detailed plugin view if another window updates live plugin state while open.
  useEffect(() => {
    if (lastLiveKeyRef.current === livePluginsKey) return
    lastLiveKeyRef.current = livePluginsKey
    if (hasViewRef.current && !busyRef.current) void load(false)
  }, [livePluginsKey, load])

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

  const handleActivateSlot = (slot, id) => {
    void exec(id, actions.pluginsSlotSet(slot, id)).catch(() => { void load(false, { keepError: true }) })
  }
  const handleInstall = (plugin) => { void runInstall({ id: plugin.id, spec: plugin.installSpec }, plugin.id).catch(() => {}) }
  const handleApproveBuilds = () => {
    if (!pendingApproval) return
    const { body, busyKey, packages } = pendingApproval
    void runInstall({ ...body, approvedBuilds: packages }, busyKey).catch(() => {})
  }
  const handleToggle = (id, enabled) => {
    void exec(id, actions.pluginsToggle(id, enabled)).catch(() => { void load(false, { keepError: true }) })
  }
  const handleConsent = (id) => { void exec(id, actions.pluginsConsent(id)).catch(() => {}) }
  const handleUpdate = (id) => { void exec(id, actions.pluginsUpdate(id)).catch(() => {}) }
  const handleRemove = (id) => {
    void exec(id, actions.pluginsRemove(id)).then(() => {
      if (aliveRef.current && subview?.plugin === id) setSubview(null)
    }, () => {})
  }
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

  const plugins = useMemo(
    () => (view?.plugins ?? []).filter(p => !isHiddenEngineBundle(p)),
    [view],
  )
  const bots = roster?.bots ?? []
  const browserSlot = view?.slots?.browser
  const activeBrowserPlugin = plugins.find(p => p.id === browserSlot?.active)
  const hasPendingRestart = Boolean(
    browserSlot?.status === 'restart-required'
    || roster?.plugins?.pendingRestart
    || plugins.some(p => p.status === 'restart-required'),
  )
  const catalogErrors = (view?.catalog?.errors ?? []).filter(e => e.sourceId !== 'official' || !view?.catalog?.offline)

  // Only show categories that actually have plugins (plus All and Browser).
  const availableCategories = useMemo(() => {
    const present = new Set(['all', 'browser'])
    for (const p of plugins) {
      if (p.slot) present.add(p.slot)
      if (p.category) present.add(p.category)
    }
    return CATEGORIES.filter(([id]) => present.has(id))
  }, [plugins])

  const installedAll = useMemo(
    () => plugins.filter(p => p.installed || p.active),
    [plugins],
  )
  const activeInstalledIcons = useMemo(
    () => installedAll.filter(p => p.active || (!p.slot && p.enabled)).concat(installedAll.filter(p => !p.active && (p.slot || !p.enabled))),
    [installedAll],
  )

  const filtered = useMemo(
    () => plugins.filter(p => pluginMatches(p, query, category)),
    [plugins, query, category],
  )

  const browserList = useMemo(
    () => filtered.filter(p => p.slot === 'browser'),
    [filtered],
  )
  const generalInstalled = useMemo(
    () => filtered.filter(p => !p.slot && p.installed),
    [filtered],
  )
  const generalDiscover = useMemo(
    () => filtered.filter(p => !p.slot && !p.installed && !p.builtin),
    [filtered],
  )

  const banners = [
    readOnly ? h('div', { key: 'ro', className: 'bt-plg-banner', 'data-tone': 'warn', role: 'status' },
      h('span', null, hostText(roster.readOnly))) : null,
    error ? h('div', { key: 'err', className: 'bt-error', role: 'alert' }, error) : null,
    pendingApproval ? h('div', { key: 'approval', className: 'bt-plg-banner', 'data-tone': 'warn', role: 'alert' },
      h('span', null, t('Build scripts require approval for: {packages}', { packages: pendingApproval.packages.join(', ') })),
      h('div', { className: 'bt-plg-banner-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busyId !== null, onClick: () => setPendingApproval(null) }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: readOnly || busyId !== null, onClick: handleApproveBuilds }, t('Approve & install')))) : null,
    browserSlot?.status === 'error' || browserSlot?.status === 'unavailable' ? h('div', { key: 'slot-err', className: 'bt-plg-banner', 'data-tone': 'error' },
      h('span', null, hostText(browserSlot.error || t('Active browser plugin failed to load.'))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busyId !== null, onClick: handleRetry }, t('Try again'))) : null,
    hasPendingRestart ? h('div', { key: 'restart', className: 'bt-plg-banner', 'data-tone': 'warn' },
      h('span', null, browserSlot?.status === 'restart-required'
        ? t('Restart DS Bot to finish loading the selected browser plugin.')
        : t('Restart DS Bot to finish applying plugin changes.'))) : null,
    catalogErrors.length > 0 ? h('div', { key: 'cat-err', className: 'bt-plg-banner', 'data-tone': 'warn' },
      h('span', null, t('Catalog sync failed: {details}', { details: catalogErrors.map(e => `${e.sourceId}: ${e.message}`).join('; ') }))) : null,
  ].filter(Boolean)

  // Subview: Plugin detail
  const detailPlugin = subview?.plugin ? plugins.find(p => p.id === subview.plugin) : null
  if (detailPlugin) {
    return h('div', { className: 'bt-plugins-page' },
      banners,
      h(PluginDetailView, {
        key: detailPlugin.id,
        plugin: detailPlugin,
        bots,
        managerAvailable: view?.managerAvailable === true,
        busyId,
        readOnly,
        onBack: () => setSubview(null),
        onActivateSlot: handleActivateSlot,
        onInstall: handleInstall,
        onToggle: handleToggle,
        onUpdate: handleUpdate,
        onRemove: handleRemove,
        onBotToggle: handleBotToggle,
        onCopy: handleCopy,
        onConsent: handleConsent,
        Section,
        Row,
      }))
  }

  // Subview: Add custom plugin & registries
  if (subview === 'add') {
    return h('div', { className: 'bt-plugins-page' },
      banners,
      h(AddCustomSection, {
        key: 'add-custom',
        view,
        busy: busyId !== null,
        readOnly,
        onBack: () => setSubview(null),
        onSaveCustom: body => exec('custom', actions.pluginsCustomSave(body)),
        onInstallDirect: body => runInstall(body, 'custom'),
        onSaveSource: body => exec('source', actions.pluginsSourceSave(body)),
        onRemoveSource: id => exec('source', actions.pluginsSourceRemove(id)).catch(() => {}),
        Section,
        Row,
      }))
  }

  // Subview: Installed plugins summary
  if (subview === 'installed') {
    const installedBrowser = installedAll.filter(p => p.slot === 'browser')
    const installedOther = installedAll.filter(p => !p.slot)
    return h('div', { className: 'bt-plugins-page' },
      banners,
      h(Subview, { title: t('Installed'), onBack: () => setSubview(null) },
        installedBrowser.length > 0 ? h('section', { className: 'bt-plg-section' },
          h('div', { className: 'bt-plg-sec-head' },
            h('h3', null, t('Browser plugins')),
            activeBrowserPlugin ? h('span', { className: 'bt-plg-sec-meta' }, `${t('In use')}: ${localizedField(activeBrowserPlugin, 'name') || activeBrowserPlugin.name}`) : null),
          h('div', { className: 'bt-plg-grid' },
            installedBrowser.map(plugin => h(PluginTile, {
              key: plugin.id,
              plugin,
              managerAvailable: view?.managerAvailable === true,
              busyId,
              readOnly,
              onOpen: id => setSubview({ plugin: id }),
              onActivateSlot: handleActivateSlot,
              onInstall: handleInstall,
              onToggle: handleToggle,
              onCopy: handleCopy,
              onConsent: handleConsent,
            })))) : null,
        installedOther.length > 0 ? h('section', { className: 'bt-plg-section' },
          h('div', { className: 'bt-plg-sec-head' }, h('h3', null, t('Installed plugins'))),
          h('div', { className: 'bt-plg-grid' },
            installedOther.map(plugin => h(PluginTile, {
              key: plugin.id,
              plugin,
              managerAvailable: view?.managerAvailable === true,
              busyId,
              readOnly,
              onOpen: id => setSubview({ plugin: id }),
              onActivateSlot: handleActivateSlot,
              onInstall: handleInstall,
              onToggle: handleToggle,
              onCopy: handleCopy,
              onConsent: handleConsent,
            })))) : null))
  }

  const showBrowserSection = (category === 'all' || category === 'browser') && browserList.length > 0
  const searching = query.trim() !== ''
  const visibleDiscover = searching || category !== 'all' || showAllDiscover
    ? generalDiscover
    : generalDiscover.slice(0, PREVIEW_COUNT)
  const hasMoreDiscover = !searching && category === 'all' && !showAllDiscover && generalDiscover.length > PREVIEW_COUNT

  return h('div', { className: 'bt-plugins-page' },
    banners,
    h('div', { className: 'bt-plg-bar' },
      h('label', { className: 'bt-plg-search' },
        h(SearchIcon),
        h('input', {
          type: 'search',
          value: query,
          placeholder: t('Search plugins'),
          'aria-label': t('Search plugins'),
          onChange: e => setQuery(e.target.value),
        })),
      h('button', {
        type: 'button',
        className: 'bt-plg-pill',
        onClick: () => setSubview('add'),
      }, h(PlusIcon), t('Add plugin')),
      h(InstalledSummary, {
        plugins: activeInstalledIcons,
        count: installedAll.length,
        onClick: () => setSubview('installed'),
      }),
      h('button', {
        type: 'button',
        className: 'bt-plg-refresh',
        'aria-label': t('Refresh'),
        title: t('Refresh'),
        'data-spinning': refreshing ? '' : undefined,
        disabled: refreshing || loading || busyId !== null,
        onClick: () => void load(true),
      }, h(RefreshGlyph, { spinning: refreshing }))),
    h('div', { className: 'bt-plg-cats-row' },
      h('div', { className: 'bt-plg-cats', role: 'group', 'aria-label': t('Categories') },
        availableCategories.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          'aria-pressed': category === id,
          onClick: () => { setCategory(id); setShowAllDiscover(false) },
        }, t(label)))),
      openEnginePlugins ? h('button', {
        type: 'button',
        className: 'bt-plg-engine-link',
        onClick: openEnginePlugins,
      }, t('Engine plugins'), h(ChevronRightIcon)) : null),
    loading && !view
      ? h('p', { className: 'bt-plg-empty' }, t('Loading…'))
      : [
        showBrowserSection ? h('section', { key: 'browser-slot', className: 'bt-plg-section bt-plg-browser-sec' },
          h('div', { className: 'bt-plg-sec-head' },
            h('h3', null, t('Browser control'))),
          !searching && activeBrowserPlugin ? h(BrowserStage, {
            plugin: activeBrowserPlugin,
            slotStatus: browserSlot?.status,
            onOpen: id => setSubview({ plugin: id }),
          }) : null,
          h('div', { className: 'bt-plg-grid' },
            browserList.map(plugin => h(PluginTile, {
              key: plugin.id,
              plugin,
              managerAvailable: view?.managerAvailable === true,
              busyId,
              readOnly,
              onOpen: id => setSubview({ plugin: id }),
              onActivateSlot: handleActivateSlot,
              onInstall: handleInstall,
              onToggle: handleToggle,
              onCopy: handleCopy,
              onConsent: handleConsent,
            })))) : null,
        generalInstalled.length > 0 ? h('section', { key: 'installed-general', className: 'bt-plg-section' },
          h('div', { className: 'bt-plg-sec-head' },
            h('h3', null, t('Installed plugins'))),
          h('div', { className: 'bt-plg-grid' },
            generalInstalled.map(plugin => h(PluginTile, {
              key: plugin.id,
              plugin,
              managerAvailable: view?.managerAvailable === true,
              busyId,
              readOnly,
              onOpen: id => setSubview({ plugin: id }),
              onActivateSlot: handleActivateSlot,
              onInstall: handleInstall,
              onToggle: handleToggle,
              onCopy: handleCopy,
              onConsent: handleConsent,
            })))) : null,
        visibleDiscover.length > 0 ? h('section', { key: 'discover', className: 'bt-plg-section' },
          h('div', { className: 'bt-plg-sec-head' },
            h('h3', null, t('Discover')),
            hasMoreDiscover ? h('button', { type: 'button', className: 'bt-plg-all', onClick: () => setShowAllDiscover(true) }, t('See all')) : null),
          h('div', { className: 'bt-plg-grid' },
            visibleDiscover.map(plugin => h(PluginTile, {
              key: plugin.id,
              plugin,
              managerAvailable: view?.managerAvailable === true,
              busyId,
              readOnly,
              onOpen: id => setSubview({ plugin: id }),
              onActivateSlot: handleActivateSlot,
              onInstall: handleInstall,
              onToggle: handleToggle,
              onCopy: handleCopy,
              onConsent: handleConsent,
            })))) : null,
        !searching && category === 'all' && generalInstalled.length === 0 && visibleDiscover.length === 0
          ? h('section', { key: 'extensions-invite', className: 'bt-plg-section' },
            h('div', { className: 'bt-plg-sec-head' },
              h('h3', null, t('Other plugins'))),
            h('div', { className: 'bt-plg-ext-card' },
              h('span', { className: 'bt-plg-ext-mark', 'aria-hidden': true }, h(ExtensionsClusterMark)),
              h('div', { className: 'bt-plg-ext-copy' },
                h('span', { className: 'bt-plg-ext-title' }, t('Extend Bots with more capabilities')),
                h('span', { className: 'bt-plg-ext-sub' }, t('Add DSH packages, MCP servers, or third-party plugin registries'))),
              h('button', {
                type: 'button',
                className: 'bt-plg-btn',
                onClick: () => setSubview('add'),
              }, h(PlusIcon), t('Add plugin'))))
          : null,
        !showBrowserSection && generalInstalled.length === 0 && visibleDiscover.length === 0
          ? h('p', { key: 'empty', className: 'bt-plg-empty' }, t('No matching plugins'))
          : null,
      ])
}
