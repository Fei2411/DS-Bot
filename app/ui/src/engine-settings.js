// Lazy-loaded Engine settings pages for the desktop app's own interface:
// Account, Plugins (with in-page built-in plugin settings), Agent presets,
// Archived sessions, and Session log upload.
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { Switch } from '../../../ds-bot/src/client/bot-settings.js'
import { MAIN_LOOK } from '../../../ds-bot/src/client/characters.js'
import { hostText, language, t } from '../../../ds-bot/src/client/i18n.js'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  GlobeIcon,
  LayersIcon,
  PlusIcon,
  PuzzleIcon,
  SlidersIcon,
  TerminalIcon,
} from '../../../ds-bot/src/client/icons.js'
import { toTraditional } from '../../../ds-bot/src/client/locales/zh-tw.js'
import { BotMark } from '../../../ds-bot/src/client/mark.js'
import { ESCAPE_PRIORITY, useEscape, useModalFocusTrap } from '../../../ds-bot/src/client/overlay-hooks.js'
import { SelectMenu } from '../../../ds-bot/src/client/select-menu.js'
import { relativeShort } from '../../../ds-bot/src/client/text.js'
import { pluginRuntime, usePlugins } from './plugin-runtime.js'
import { writeClipboard } from './primitives.js'

// Module-level stale-while-revalidate caches so reopening Engine settings tabs never flashes "Loading…".
let accountCache = null
let pluginsCache = null
let settingsCache = null
let presetsCache = null
let archivedCache = null

const SAFE_EXTERNAL_URL = /^https?:\/\//i
const safeExternalUrl = (value) => (typeof value === 'string' && SAFE_EXTERNAL_URL.test(value.trim()) ? value.trim() : null)

const SAFE_PLUGIN_ICON_URI = /^data:image\/(svg\+xml|png|webp);base64,/i
export const safePluginIconUri = (value) => (typeof value === 'string' && SAFE_PLUGIN_ICON_URI.test(value.trim()) ? value.trim() : null)

// Known DSH engine namespaces grouped in a readable order.
const ENGINE_NAMESPACE_META = {
  'agent-loop': { titleKey: 'Agent loop', order: 10 },
  'web-search-deepseek': { titleKey: 'Web search', order: 20 },
  'web-deepseek-api': { titleKey: 'Web search API', order: 21 },
  web: { titleKey: 'Web', order: 22 },
  'bash-sandbox': { titleKey: 'Shell (Bash)', order: 30 },
  'bash-local': { titleKey: 'Shell (Bash)', order: 30 },
  'pwsh-sandbox': { titleKey: 'Shell (PowerShell)', order: 31 },
  'pwsh-local': { titleKey: 'Shell (PowerShell)', order: 31 },
}

// Namespaces handled by dedicated settings sections rather than the generic schema editor.
const DEDICATED_NAMESPACES = new Set([
  'agent-preset-registry',
  'session-log-deepseek',
  'ds-bot',
  'ui-settings',
  'ui-chat',
])

// DS Bot bans DSH subagent/delegation tools (see ds-bot/src/host/tools.js); never surface their config or bundles.
const BANNED_NAMESPACES = new Set([
  'subagent',
  'subagent-model-selection-settings',
])

const HIDDEN_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsbot-engine',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
])

const BANNED_BUNDLES = new Set([
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
])

const EXTENSION_BUNDLES = [
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
]

const MORE_BUNDLES = [
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-cua-bundle',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
]

const MORE_BUNDLE_SET = new Set(MORE_BUNDLES)

const EXPERIMENTAL_BUNDLES = new Set([
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-cua-bundle',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-forge-bundle',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-liveshare',
])

const BUILTIN_CONFIG_GROUPS = [
  {
    id: 'web-search',
    titleKey: 'Web search',
    icon: GlobeIcon,
    namespaces: ['web-search-deepseek', 'web-deepseek-api', 'web'],
  },
  {
    id: 'shell',
    titleKey: 'Shell',
    icon: TerminalIcon,
    namespaces: ['bash-sandbox', 'bash-local', 'pwsh-sandbox', 'pwsh-local'],
  },
  {
    id: 'agent-loop',
    titleKey: 'Agent loop',
    icon: SlidersIcon,
    namespaces: ['agent-loop'],
  },
]

// Subagents stay off by policy in Bot mode, and are exposed only in Classic Agent mode.
const SUBAGENT_CONFIG_GROUP = {
  id: 'subagent',
  titleKey: 'Subagents',
  icon: LayersIcon,
  namespaces: ['subagent', 'subagent-model-selection-settings'],
}

const CLASSIC_SUBAGENT_NAMESPACES = new Set(SUBAGENT_CONFIG_GROUP.namespaces)

const configGroupsForSurface = (surfaceMode = 'bot') => (
  surfaceMode === 'agent' ? [...BUILTIN_CONFIG_GROUPS, SUBAGENT_CONFIG_GROUP] : BUILTIN_CONFIG_GROUPS
)

const BUILTIN_GROUP_BY_NS = new Map(
  [...BUILTIN_CONFIG_GROUPS, SUBAGENT_CONFIG_GROUP].flatMap(group => group.namespaces.map(ns => [ns, group.id])),
)

export function isBannedNamespace(ns, surfaceMode = 'bot') {
  if (typeof ns !== 'string') return false
  if (surfaceMode === 'agent' && CLASSIC_SUBAGENT_NAMESPACES.has(ns)) return false
  return BANNED_NAMESPACES.has(ns) || /subagent/i.test(ns)
}

export function isExcludedBundle(bundle) {
  const name = typeof bundle === 'string' ? bundle : bundle?.name
  if (typeof name !== 'string' || name === '') return true
  return HIDDEN_BUNDLES.has(name) || BANNED_BUNDLES.has(name) || /subagent/i.test(name)
}

const CORE_DS_BOT_IDS = new Set(['ds-bot', '@deepseek-ai/ds-bot'])

export function isCoreDsBotEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  const candidates = [entry.name, entry.pkg, entry.id, entry.moduleName]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
  if (candidates.some(value => CORE_DS_BOT_IDS.has(value))) return true
  if (Array.isArray(entry.rows) && entry.rows.some(row => CORE_DS_BOT_IDS.has(String(row?.moduleName ?? '').trim().toLowerCase()))) {
    return true
  }
  return false
}

const UPPERCASE_ACRONYMS = new Set([
  'api', 'url', 'id', 'http', 'https', 'json', 'mcp', 'cli', 'ssh', 'tls', 'ws', 'wss', 'yaml', 'ui',
])

// Namespace-specific overrides when a generic schema key has sharper meaning in context.
const ENGINE_NS_FIELD_LABELS = {
  'web-search-deepseek:maxUses': 'Max searches per request',
  'web-deepseek-api:count': 'Results per search',
}

// Known DSH engine schema field keys -> English i18n source strings translated via `t()`.
const ENGINE_FIELD_LABELS = {
  maxParallelToolCalls: 'Max parallel tool calls',
  apiKey: 'API key',
  apiKeyEnv: 'API key env var',
  baseURL: 'Base URL',
  baseUrl: 'Base URL',
  model: 'Model',
  apiVersion: 'API version',
  maxTokens: 'Max tokens',
  maxUses: 'Max uses',
  count: 'Max results',
  maxResults: 'Max results',
  sendOriginalQuestion: 'Send original question',
  searchProvider: 'Search provider',
  fetchProvider: 'Fetch provider',
  searchBilling: 'Search billing',
  fetchBilling: 'Fetch billing',
  searchRequestsPerSecond: 'Search requests per second',
  cwd: 'Working directory',
  timeout: 'Timeout',
  timeoutMs: 'Timeout (ms)',
  maxTimeoutMs: 'Max timeout (ms)',
  maxOutputBytes: 'Max output bytes',
  maxSpillBytes: 'Max spill bytes',
  graceMs: 'Shutdown grace (ms)',
  pwshPath: 'PowerShell path',
  maxDepth: 'Max depth',
  maxActiveSubagents: 'Max active subagents',
  enabled: 'Enabled',
  defaultProvider: 'Default provider',
  defaultPreset: 'Default preset',
  provider: 'Provider',
  reasoningEffort: 'Reasoning effort',
  language: 'Language',
  targetLanguage: 'Target language',
  maxTurns: 'Max turns',
  workspaceRoot: 'Workspace root',
  mode: 'Mode',
}

function formatSegment(segment) {
  const raw = String(segment ?? '').trim()
  if (raw === '') return ''
  const words = raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return raw
  return words.map((word, index) => {
    const lower = word.toLowerCase()
    if (UPPERCASE_ACRONYMS.has(lower)) return lower.toUpperCase()
    if (index === 0) return lower[0].toUpperCase() + lower.slice(1)
    return lower
  }).join(' ')
}

export function formatFieldLabel(path) {
  const segments = Array.isArray(path) ? path : [path]
  const leaf = segments[segments.length - 1] ?? ''
  const formattedLeaf = formatSegment(leaf)
  if (segments.length <= 1) return formattedLeaf
  const prefix = segments.slice(0, -1).map(formatSegment).filter(Boolean).join(' / ')
  return prefix ? `${prefix} · ${formattedLeaf}` : formattedLeaf
}

function fieldLabelKey(path, ns = '') {
  const joined = path.join('.')
  if (ns && Object.hasOwn(ENGINE_NS_FIELD_LABELS, `${ns}:${joined}`)) {
    return ENGINE_NS_FIELD_LABELS[`${ns}:${joined}`]
  }
  if (Object.hasOwn(ENGINE_FIELD_LABELS, joined)) {
    return ENGINE_FIELD_LABELS[joined]
  }
  return null
}

export function resolveFieldLabel(path, ns = '') {
  const key = fieldLabelKey(path, ns)
  if (key) return t(key)
  const leaf = path[path.length - 1] ?? ''
  if (path.length > 1 && Object.hasOwn(ENGINE_FIELD_LABELS, leaf)) {
    const prefix = path.slice(0, -1).map(formatSegment).filter(Boolean).join(' / ')
    const leafText = t(ENGINE_FIELD_LABELS[leaf])
    return prefix ? `${prefix} · ${leafText}` : leafText
  }
  return formatFieldLabel(path)
}

function resolveRef(refs, target, seen = new Set()) {
  if (target === null || target === undefined) return null
  if (typeof target === 'number' || typeof target === 'string') {
    const key = String(target)
    if (seen.has(key)) return null
    const next = new Set(seen)
    next.add(key)
    const node = refs?.[key]
    return node ? { node, seen: next } : null
  }
  if (typeof target === 'object') return { node: target, seen }
  return null
}

function readPath(obj, path) {
  let cursor = obj
  for (const segment of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

function isHiddenNode(node) {
  return node?.meta?.hidden === true
}

/**
 * Extracts editable leaf fields from a serialized Schemastery schema (`schema.toJSON()`).
 * Preserves redacted secret paths (`meta.role === 'secret'`) without revealing values.
 */
export function extractSchemaFields(schema, value, secrets = [], ns = '') {
  if (schema === null || schema === undefined || typeof schema !== 'object') return []
  const refs = schema.refs && typeof schema.refs === 'object' ? schema.refs : null
  const rootTarget = refs && schema.uid !== undefined ? schema.uid : schema
  const secretSet = new Set(
    (Array.isArray(secrets) ? secrets : [])
      .filter(entry => entry && Array.isArray(entry.path))
      .map(entry => entry.path.join('\0')),
  )
  const secretConfigured = new Map(
    (Array.isArray(secrets) ? secrets : [])
      .filter(entry => entry && Array.isArray(entry.path))
      .map(entry => [entry.path.join('\0'), Boolean(entry.set)]),
  )
  const fields = []

  const unwrapNullableUnion = (node, seen) => {
    if (node.type !== 'union' || !Array.isArray(node.list)) return null
    const resolved = node.list.map(item => resolveRef(refs, item, seen)).filter(Boolean)
    const nonEmpty = resolved.filter(({ node: child }) => !(child.type === 'const' && (child.value === null || child.value === undefined)))
    if (nonEmpty.length === 1 && nonEmpty.length < resolved.length) return nonEmpty[0]
    return null
  }

  const enumValuesOf = (node, seen) => {
    if (node.type !== 'union' || !Array.isArray(node.list) || node.list.length === 0) return null
    const values = []
    for (const item of node.list) {
      const resolved = resolveRef(refs, item, seen)
      if (!resolved) return null
      if (resolved.node.type !== 'const') return null
      if (resolved.node.value === null || resolved.node.value === undefined) continue
      values.push({
        value: resolved.node.value,
        label: typeof resolved.node.meta?.description === 'string' && resolved.node.meta.description !== ''
          ? resolved.node.meta.description
          : String(resolved.node.value),
      })
    }
    return values.length > 0 ? values : null
  }

  const walk = (target, path, seen, depth) => {
    if (depth > 4) return
    const resolved = resolveRef(refs, target, seen)
    if (!resolved) return
    const { node, seen: nextSeen } = resolved
    if (isHiddenNode(node)) return

    if (node.type === 'intersect' && Array.isArray(node.list)) {
      for (const item of node.list) walk(item, path, nextSeen, depth)
      return
    }
    if (node.type === 'object' && node.dict && typeof node.dict === 'object') {
      for (const [key, childTarget] of Object.entries(node.dict)) {
        walk(childTarget, [...path, key], nextSeen, depth + 1)
      }
      return
    }
    if (path.length === 0) return

    const unwrapped = unwrapNullableUnion(node, nextSeen)
    if (unwrapped) {
      const mergedMeta = { ...node.meta, ...unwrapped.node.meta }
      walk({ ...unwrapped.node, meta: mergedMeta }, path, unwrapped.seen, depth)
      return
    }

    const pathKey = path.join('\0')
    const isSecret = node.meta?.role === 'secret' || secretSet.has(pathKey)
    const current = readPath(value, path)
    const fallbackDefault = node.meta?.default
    const label = resolveFieldLabel(path, ns)
    const description = typeof node.meta?.description === 'string' ? node.meta.description : ''

    if (isSecret) {
      fields.push({
        path,
        key: pathKey,
        kind: 'secret',
        label,
        description,
        isSet: secretConfigured.get(pathKey) === true,
      })
      return
    }

    const enumOptions = enumValuesOf(node, nextSeen)
    if (enumOptions) {
      fields.push({
        path,
        key: pathKey,
        kind: 'select',
        label,
        description,
        options: enumOptions,
        defaultValue: fallbackDefault,
        value: current ?? fallbackDefault ?? enumOptions[0]?.value ?? '',
      })
      return
    }

    if (node.type === 'boolean') {
      fields.push({
        path,
        key: pathKey,
        kind: 'boolean',
        label,
        description,
        defaultValue: fallbackDefault,
        value: typeof current === 'boolean' ? current : Boolean(fallbackDefault),
      })
      return
    }

    if (node.type === 'number' || node.type === 'natural' || node.type === 'percent') {
      fields.push({
        path,
        key: pathKey,
        kind: 'number',
        label,
        description,
        min: Number.isFinite(node.meta?.min) ? node.meta.min : (node.type === 'natural' ? 0 : undefined),
        max: Number.isFinite(node.meta?.max) ? node.meta.max : undefined,
        step: Number.isFinite(node.meta?.step) ? node.meta.step : (node.type === 'natural' ? 1 : undefined),
        defaultValue: fallbackDefault,
        value: typeof current === 'number' ? current : (typeof fallbackDefault === 'number' ? fallbackDefault : ''),
      })
      return
    }

    if (node.type === 'string' || node.type === 'path') {
      fields.push({
        path,
        key: pathKey,
        kind: 'string',
        label,
        description,
        defaultValue: fallbackDefault,
        value: typeof current === 'string' ? current : (typeof fallbackDefault === 'string' ? fallbackDefault : ''),
      })
    }
  }

  walk(rootTarget, [], new Set(), 0)
  return fields
}

function EngineSection({ title, action, children }) {
  return h('section', { className: 'bt-set-section' },
    action ? h('div', { className: 'bt-la-sec-head' }, h('h3', null, title), action) : (title ? h('h3', null, title) : null),
    h('div', { className: 'bt-set-card' }, children))
}

function EngineRow({ label, hint, children }) {
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, label),
      hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)
}

function StatusAlert({ error, notice }) {
  return h(Fragment, null,
    error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
    notice ? h('div', { className: 'dsb-engine-notice', role: 'status' }, notice) : null)
}

function formatWallets(wallets) {
  if (!Array.isArray(wallets) || wallets.length === 0) return null
  return wallets
    .filter(item => item && typeof item.balance === 'string')
    .map(item => `${item.currency === 'CNY' ? '¥' : '$'}${item.balance}`)
    .join(' · ')
}

export function AccountSettingsPage({ readOnly = false }) {
  const [data, setData] = useState(() => accountCache)
  const [loading, setLoading] = useState(() => !accountCache)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!accountCache) setLoading(true)
    setError('')
    try {
      const next = await call('engine-account-state', {
        locale: language(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      accountCache = next
      if (mounted.current) setData(next)
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const attemptPhase = data?.view?.attempt?.phase
  const signingIn = attemptPhase === 'initializing' || attemptPhase === 'waiting-browser' || attemptPhase === 'exchanging' || attemptPhase === 'committing'

  useEffect(() => {
    if (!signingIn) return undefined
    const timer = setInterval(() => { void load() }, 2500)
    return () => clearInterval(timer)
  }, [signingIn, load])

  const startSignIn = async () => {
    if (busy || readOnly) return
    setBusy(true)
    setError('')
    try {
      const loopback = typeof window !== 'undefined' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(window.location.origin)
        ? window.location.origin
        : undefined
      const result = await call('engine-account-signin', {
        ...(loopback ? { callbackOrigin: loopback } : {}),
        loginSource: 'desktop',
        locale: language(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      const authorizeUrl = safeExternalUrl(result?.view?.attempt?.authorizeUrl)
      if (authorizeUrl && typeof window !== 'undefined') window.open?.(authorizeUrl, '_blank', 'noopener,noreferrer')
      await load()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const cancelSignIn = async () => {
    const attemptId = data?.view?.attempt?.id
    if (busy || readOnly || !attemptId) return
    setBusy(true)
    setError('')
    try {
      await call('engine-account-cancel', { attemptId })
      await load()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const signOut = async () => {
    if (busy || readOnly) return
    setBusy(true)
    setError('')
    try {
      await call('engine-account-signout', {
        locale: language(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      await load()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (loading && !data) {
    return h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))
  }
  if (data && data.available === false) {
    return h('div', { className: 'dsb-engine-empty' }, t('Account management is not available on this host.'))
  }

  const signedIn = data?.view?.status === 'credential-stored'
  const profile = data?.profile?.status === 'ready' ? data.profile.value : null
  const balanceText = data?.balance?.status === 'ready' ? formatWallets(data.balance.value) : null
  const bonusText = data?.balance?.status === 'ready' ? formatWallets(data.balance.bonusWallets) : null
  const usageUrl = safeExternalUrl(data?.view?.links?.usageUrl)
  const topUpUrl = safeExternalUrl(data?.view?.links?.topUpUrl)
  const authorizeUrl = safeExternalUrl(data?.view?.attempt?.authorizeUrl)

  return h('div', { className: 'dsb-engine-page', 'data-engine-section': 'account' },
    h(StatusAlert, { error }),
    h(EngineSection, {},
      h(EngineRow, {
        label: signedIn ? (profile?.name || profile?.contact || t('Signed in')) : t('Not signed in'),
        hint: signedIn && profile?.name && profile?.contact ? profile.contact : undefined,
      },
      signedIn
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || readOnly, onClick: signOut }, t('Sign out'))
        : signingIn
          ? h('div', { className: 'dsb-engine-inline' },
            authorizeUrl ? h('a', { className: 'bt-soft bt-soft-sm dsb-engine-link', href: authorizeUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open sign-in')) : null,
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || readOnly, onClick: cancelSignIn }, t('Cancel')))
          : h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || readOnly, onClick: startSignIn }, t('Sign in'))),
      signedIn && balanceText ? h(EngineRow, { label: t('Balance') }, h('span', { className: 'dsb-engine-val' }, balanceText)) : null,
      signedIn && bonusText ? h(EngineRow, { label: t('Bonus balance') }, h('span', { className: 'dsb-engine-val' }, bonusText)) : null),
    (usageUrl || topUpUrl) ? h(EngineSection, { title: t('Billing') },
      usageUrl ? h(EngineRow, { label: t('Usage details') },
        h('a', { className: 'bt-soft bt-soft-sm dsb-engine-link', href: usageUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open'))) : null,
      topUpUrl ? h(EngineRow, { label: t('Top up') },
        h('a', { className: 'bt-soft bt-soft-sm dsb-engine-link', href: topUpUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open'))) : null) : null)
}

export function resolveLocalizedMetaText(value, lang = language()) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  const active = String(lang || 'en').trim()
  const lower = active.toLowerCase()
  const base = lower.split('-')[0]
  const pick = (key) => {
    if (!key) return ''
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === key && typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    return ''
  }
  const direct = pick(lower)
  if (direct) return direct
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') {
    const zh = pick('zh') || pick('zh-cn')
    if (zh) return toTraditional(zh)
  }
  const byBase = pick(base)
  if (byBase) return byBase
  const en = pick('en')
  if (en) return en
  for (const v of Object.values(value)) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

function shortBundleName(name) {
  const raw = String(name ?? '')
  const unscoped = raw.startsWith('@') && raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw
  return unscoped.replace(/^dsh-(?:experimental-|host-|client-)?/, '').replace(/-bundle$/, '')
}

function bundleDisplayMeta(bundle, lang) {
  if (isCoreDsBotEntry(bundle)) {
    return {
      title: 'DS Bot',
      description: t('Multi-Bot team chat, scheduled tasks, and group collaboration.'),
    }
  }
  if (bundle?.name === '@deepseek-ai/dsh-cua-bundle') {
    return {
      title: t('Computer use'),
      description: t('Control macOS desktop apps with Accessibility and Screen Recording permissions.'),
    }
  }
  const metaTitle = resolveLocalizedMetaText(bundle.meta?.title, lang)
  const metaName = typeof bundle.meta?.name === 'string' ? bundle.meta.name.trim() : ''
  const title = metaTitle || metaName || formatSegment(shortBundleName(bundle.name)) || bundle.name
  const metaDesc = resolveLocalizedMetaText(bundle.meta?.description, lang)
  const description = metaDesc || (typeof bundle.description === 'string' ? bundle.description.trim() : '')
  return { title, description }
}

function hasPath(obj, path) {
  let cursor = obj
  for (let i = 0; i < path.length; i += 1) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return false
    const key = path[i]
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return false
    cursor = cursor[key]
  }
  return cursor !== undefined
}

function defaultForField(descriptor, field) {
  const fromBase = readPath(descriptor?.base, field.path)
  if (fromBase !== undefined) return fromBase
  if (field.defaultValue !== undefined) return field.defaultValue
  if (field.kind === 'boolean') return false
  return ''
}

function fieldInputString(value) {
  return value === undefined || value === null ? '' : String(value)
}

function validateNumberText(text, { min, max, integer = false } = {}) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { ok: true, empty: true, value: undefined }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return { ok: false, error: t('Enter a valid number') }
  if (integer && !Number.isInteger(parsed)) return { ok: false, error: t('Enter a whole number') }
  if (min !== undefined && parsed < min) return { ok: false, error: t('Must be at least {min}', { min }) }
  if (max !== undefined && parsed > max) return { ok: false, error: t('Must be at most {max}', { max }) }
  return { ok: true, empty: false, value: parsed }
}

function EngineFormBar({ dirty, invalid, saving, saved, disabled, onSave, onDiscard }) {
  return h('div', { className: 'dsb-engine-form-bar' },
    saved ? h('span', { className: 'dsb-engine-saved', role: 'status' }, t('Saved')) : null,
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm',
      disabled: !dirty || saving,
      onClick: onDiscard,
    }, t('Discard')),
    h('button', {
      type: 'button',
      className: 'bt-send bt-soft-sm',
      disabled: !dirty || invalid || saving || disabled,
      onClick: onSave,
    }, saving ? t('Saving…') : t('Save')))
}

function dropNamespacesFromMap(map, nsSet) {
  if (!nsSet || nsSet.size === 0) return map
  let changed = false
  const next = {}
  for (const [compound, val] of Object.entries(map)) {
    const colon = compound.indexOf(':')
    const ns = colon >= 0 ? compound.slice(0, colon) : compound
    if (nsSet.has(ns)) {
      changed = true
    } else {
      next[compound] = val
    }
  }
  return changed ? next : map
}

function StagedSchemaGroupForm({ groupKey = '', entries, detailTitle, disabled, onSaveNamespaces, onSecretMutate }) {
  const [overrides, setOverrides] = useState({})
  const [resets, setResets] = useState({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef(0)
  const prevGroupRef = useRef(groupKey)

  useEffect(() => {
    if (prevGroupRef.current !== groupKey) {
      prevGroupRef.current = groupKey
      setOverrides({})
      setResets({})
      setSaved(false)
    }
  }, [groupKey])
  useEffect(() => () => clearTimeout(savedTimer.current), [])

  const setFieldDraft = (ns, key, val) => {
    const compound = `${ns}:${key}`
    setSaved(false)
    setOverrides(prev => ({ ...prev, [compound]: val }))
    setResets((prev) => {
      if (!prev[compound]) return prev
      const next = { ...prev }
      delete next[compound]
      return next
    })
  }

  const stageReset = (descriptor, field) => {
    const compound = `${descriptor.ns}:${field.key}`
    setSaved(false)
    setOverrides((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, compound)) return prev
      const next = { ...prev }
      delete next[compound]
      return next
    })
    setResets(prev => ({ ...prev, [compound]: true }))
  }

  const errorsByKey = {}
  const displayValues = {}
  const pendingByNs = []
  let invalid = false
  let dirty = false

  for (const { descriptor, fields } of entries) {
    const ops = []
    for (const field of fields) {
      if (field.kind === 'secret') continue
      const compound = `${descriptor.ns}:${field.key}`
      const curRaw = readPath(descriptor.value, field.path)
      const defVal = defaultForField(descriptor, field)
      const userSet = hasPath(descriptor.user, field.path)
      const serverDisplay = field.kind === 'boolean'
        ? (typeof curRaw === 'boolean' ? curRaw : Boolean(field.value))
        : fieldInputString(curRaw ?? field.value)
      const hasOverride = Object.prototype.hasOwnProperty.call(overrides, compound)
      const draftVal = resets[compound]
        ? (field.kind === 'boolean' ? Boolean(defVal) : fieldInputString(defVal))
        : (hasOverride ? overrides[compound] : serverDisplay)
      displayValues[compound] = draftVal

      if (resets[compound]) {
        if (userSet || curRaw !== defVal) {
          dirty = true
          ops.push({ op: 'unset', path: field.path })
        }
        continue
      }
      if (field.kind === 'number') {
        const check = validateNumberText(draftVal, { min: field.min, max: field.max, integer: field.step === 1 })
        if (!check.ok) {
          invalid = true
          errorsByKey[compound] = check.error
          dirty = true
          continue
        }
        if (check.empty) {
          if (curRaw !== undefined && curRaw !== '') {
            dirty = true
            ops.push({ op: 'unset', path: field.path })
          }
        } else if (check.value !== curRaw) {
          dirty = true
          ops.push({ op: 'set', path: field.path, value: check.value })
        }
      } else if (field.kind === 'boolean') {
        const effective = typeof curRaw === 'boolean' ? curRaw : Boolean(field.value)
        if (Boolean(draftVal) !== effective) {
          dirty = true
          ops.push({ op: 'set', path: field.path, value: Boolean(draftVal) })
        }
      } else if (field.kind === 'select') {
        const effective = fieldInputString(curRaw ?? field.value)
        if (String(draftVal ?? '') !== effective) {
          const chosen = field.options.find(opt => String(opt.value) === String(draftVal ?? ''))
          dirty = true
          ops.push({ op: 'set', path: field.path, value: chosen ? chosen.value : draftVal })
        }
      } else {
        const effective = fieldInputString(curRaw ?? field.value)
        const nextStr = String(draftVal ?? '')
        if (nextStr !== effective) {
          dirty = true
          ops.push(nextStr === '' ? { op: 'unset', path: field.path } : { op: 'set', path: field.path, value: nextStr })
        }
      }
    }
    if (ops.length > 0) pendingByNs.push({ descriptor, ops })
  }

  const handleDiscard = () => {
    setOverrides({})
    setResets({})
    setSaved(false)
  }

  const handleSave = async () => {
    if (!dirty || invalid || saving || disabled || pendingByNs.length === 0) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await onSaveNamespaces(pendingByNs)
      const ok = res === true || res?.ok === true
      const savedList = Array.isArray(res?.saved) ? res.saved : (ok ? pendingByNs.map(item => item.descriptor.ns) : [])
      if (ok) {
        setOverrides({})
        setResets({})
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2200)
      } else if (savedList.length > 0) {
        const savedNs = new Set(savedList)
        setOverrides(prev => dropNamespacesFromMap(prev, savedNs))
        setResets(prev => dropNamespacesFromMap(prev, savedNs))
      }
    } finally {
      setSaving(false)
    }
  }

  return h(Fragment, null,
    entries.map(({ descriptor, fields }) => {
      const nsTitle = entries.length > 1 ? namespaceTitle(descriptor.ns) : undefined
      return h(EngineSection, {
        key: descriptor.ns,
        title: nsTitle && nsTitle !== detailTitle ? nsTitle : undefined,
      },
      fields.map((field) => {
        const compound = `${descriptor.ns}:${field.key}`
        if (field.kind === 'secret') {
          return h('div', { key: field.key, className: 'dsb-engine-field-wrap' },
            h(EngineRow, { label: field.label },
              h(SchemaSecretField, { field, disabled: disabled || saving, onSave: op => onSecretMutate(descriptor, op) })))
        }
        const err = errorsByKey[compound]
        const defVal = defaultForField(descriptor, field)
        const curVal = displayValues[compound]
        const isOverridden = hasPath(descriptor.user, field.path)
        const differsFromDefault = field.kind === 'boolean'
          ? Boolean(curVal) !== Boolean(defVal)
          : String(curVal ?? '') !== fieldInputString(defVal)
        const showReset = !resets[compound] && (isOverridden || differsFromDefault)
        const resetBtn = showReset
          ? h('button', {
            type: 'button',
            className: 'bt-mini',
            disabled: disabled || saving,
            onClick: () => stageReset(descriptor, field),
          }, t('Reset'))
          : null

        let control
        if (field.kind === 'boolean') {
          control = h(Switch, {
            label: field.label,
            on: Boolean(curVal),
            disabled: disabled || saving,
            onChange: next => setFieldDraft(descriptor.ns, field.key, next),
          })
        } else if (field.kind === 'select') {
          control = h(SelectMenu, {
            'aria-label': field.label,
            value: String(curVal ?? ''),
            disabled: disabled || saving,
            options: field.options.map(opt => ({ value: String(opt.value), label: opt.label })),
            onChange: next => setFieldDraft(descriptor.ns, field.key, next),
          })
        } else if (field.kind === 'number') {
          control = h('input', {
            className: 'bt-input bt-set-number',
            type: 'number',
            min: field.min,
            max: field.max,
            step: field.step,
            disabled: disabled || saving,
            'aria-label': field.label,
            'aria-invalid': err ? true : undefined,
            value: String(curVal ?? ''),
            onChange: event => setFieldDraft(descriptor.ns, field.key, event.target.value),
          })
        } else {
          control = h('input', {
            className: 'bt-input dsb-engine-text',
            type: 'text',
            disabled: disabled || saving,
            'aria-label': field.label,
            value: String(curVal ?? ''),
            onChange: event => setFieldDraft(descriptor.ns, field.key, event.target.value),
          })
        }

        return h('div', { key: field.key, className: 'dsb-engine-field-wrap' },
          h(EngineRow, { label: field.label },
            h('div', { className: 'dsb-engine-inline' }, resetBtn, control)),
          err ? h('div', { className: 'dsb-engine-field-err', role: 'alert' }, err) : null)
      }))
    }),
    h(EngineFormBar, {
      dirty,
      invalid,
      saving,
      saved,
      disabled,
      onSave: () => { void handleSave() },
      onDiscard: handleDiscard,
    }))
}

const SEARCH_PROVIDER_ORDER = ['deepseek-search-api', 'deepseek-official']
const FETCH_PROVIDER_ORDER = ['http', 'deepseek-fetch-api']

function webProviderLabel(kind, id, provider) {
  if (id === '') return t('Automatic')
  if (kind === 'search') {
    if (id === 'auto') return provider?.title || t('Automatic')
    if (id === 'deepseek-search-api') return t('DeepSeek Search API')
    if (id === 'deepseek-official') return t('DeepSeek Messages search')
  }
  if (kind === 'fetch') {
    if (id === 'http') return t('Direct HTTP')
    if (id === 'deepseek-fetch-api') return t('DeepSeek Fetch API')
  }
  return provider?.title || id
}

function buildWebProviderOptions(kind, registered, currentId, baseId = '') {
  const list = Array.isArray(registered) ? registered : []
  const order = kind === 'search' ? SEARCH_PROVIDER_ORDER : FETCH_PROVIDER_ORDER
  const rank = id => {
    const idx = order.indexOf(id)
    return idx === -1 ? order.length : idx
  }
  const sorted = [...list].sort((a, b) => (rank(a.id) - rank(b.id)) || a.id.localeCompare(b.id))
  const hasAutoProvider = kind === 'search' && list.some(item => item?.id === 'auto')
  const includeUnsetAuto = (!baseId && !hasAutoProvider) || currentId === ''
  const options = includeUnsetAuto ? [{ value: '', label: t('Automatic') }] : []
  const seen = new Set(includeUnsetAuto ? [''] : [])
  for (const item of sorted) {
    if (!item?.id || seen.has(item.id)) continue
    seen.add(item.id)
    options.push({ value: item.id, label: webProviderLabel(kind, item.id, item) })
  }
  if (currentId && !seen.has(currentId)) {
    options.push({ value: currentId, label: `${webProviderLabel(kind, currentId, null)} (${t('Unavailable')})` })
  }
  return options
}

function billingOptions() {
  return [
    { value: 'auto', label: t('Automatic') },
    { value: 'account', label: t('DeepSeek account') },
    { value: 'api-key', label: t('API key') },
  ]
}

function dropKeysFromMap(map, keys) {
  if (!keys || keys.size === 0) return map
  let changed = false
  const next = {}
  for (const [key, val] of Object.entries(map)) {
    if (keys.has(key)) { changed = true; continue }
    next[key] = val
  }
  return changed ? next : map
}

function WebSearchDetailForm({ entries, disabled, onSaveNamespaces, onSecretMutate }) {
  const byNs = useMemo(() => new Map(entries.map(e => [e.descriptor.ns, e])), [entries])
  const webEntry = byNs.get('web')
  const apiEntry = byNs.get('web-deepseek-api')
  const legacyEntry = byNs.get('web-search-deepseek')

  const [providers, setProviders] = useState({ loaded: false, available: false, search: [], fetch: [], error: '' })
  const loadProviders = useCallback(async () => {
    try {
      const res = await call('engine-web-providers')
      setProviders({
        loaded: true,
        available: res?.available === true,
        search: Array.isArray(res?.search) ? res.search : [],
        fetch: Array.isArray(res?.fetch) ? res.fetch : [],
        error: '',
      })
    } catch (failure) {
      setProviders(prev => ({
        ...prev,
        loaded: true,
        error: hostText(failure?.message ?? String(failure)),
      }))
    }
  }, [])
  useEffect(() => { void loadProviders() }, [loadProviders])

  const storedSearchProvider = typeof webEntry?.descriptor?.value?.searchProvider === 'string'
    ? webEntry.descriptor.value.searchProvider
    : ''
  const storedFetchProvider = typeof webEntry?.descriptor?.value?.fetchProvider === 'string'
    ? webEntry.descriptor.value.fetchProvider
    : ''
  const storedCount = apiEntry?.descriptor?.value?.count
  const baseCount = readPath(apiEntry?.descriptor?.base, ['count']) ?? 10
  const storedSearchBilling = apiEntry?.descriptor?.value?.searchBilling ?? 'auto'
  const baseSearchBilling = readPath(apiEntry?.descriptor?.base, ['searchBilling']) ?? 'auto'
  const storedFetchBilling = apiEntry?.descriptor?.value?.fetchBilling ?? 'auto'
  const baseFetchBilling = readPath(apiEntry?.descriptor?.base, ['fetchBilling']) ?? 'auto'
  const storedMaxUses = legacyEntry?.descriptor?.value?.maxUses
  const baseMaxUses = readPath(legacyEntry?.descriptor?.base, ['maxUses']) ?? 5
  const storedBaseUrl = legacyEntry?.descriptor?.value?.baseURL ?? ''
  const baseBaseUrl = readPath(legacyEntry?.descriptor?.base, ['baseURL']) ?? ''

  const hasCustomSearchEndpoint = Boolean(
    (typeof apiEntry?.descriptor?.value?.searchBaseURL === 'string' && apiEntry.descriptor.value.searchBaseURL.trim() !== '')
    || (typeof apiEntry?.descriptor?.value?.searchApiKeyEnv === 'string' && apiEntry.descriptor.value.searchApiKeyEnv.trim() !== ''),
  )
  const hasCustomFetchEndpoint = Boolean(
    (typeof apiEntry?.descriptor?.value?.fetchBaseURL === 'string' && apiEntry.descriptor.value.fetchBaseURL.trim() !== '')
    || (typeof apiEntry?.descriptor?.value?.fetchApiKeyEnv === 'string' && apiEntry.descriptor.value.fetchApiKeyEnv.trim() !== ''),
  )

  const [overrides, setOverrides] = useState({})
  const [resetFlags, setResetFlags] = useState({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef(0)

  useEffect(() => () => clearTimeout(savedTimer.current), [])

  const hasOv = key => Object.prototype.hasOwnProperty.call(overrides, key)
  const setField = (key, value) => {
    setSaved(false)
    setOverrides(prev => ({ ...prev, [key]: value }))
    setResetFlags((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }
  const stageFieldReset = (key) => {
    setSaved(false)
    setOverrides((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setResetFlags(prev => ({ ...prev, [key]: true }))
  }

  const searchProvider = hasOv('web:searchProvider') ? overrides['web:searchProvider'] : storedSearchProvider
  const fetchProvider = hasOv('web:fetchProvider') ? overrides['web:fetchProvider'] : storedFetchProvider
  const countText = resetFlags['web-deepseek-api:count']
    ? String(baseCount)
    : hasOv('web-deepseek-api:count') ? overrides['web-deepseek-api:count'] : fieldInputString(storedCount ?? 10)
  const searchBilling = resetFlags['web-deepseek-api:searchBilling']
    ? baseSearchBilling
    : hasOv('web-deepseek-api:searchBilling') ? overrides['web-deepseek-api:searchBilling'] : storedSearchBilling
  const fetchBilling = resetFlags['web-deepseek-api:fetchBilling']
    ? baseFetchBilling
    : hasOv('web-deepseek-api:fetchBilling') ? overrides['web-deepseek-api:fetchBilling'] : storedFetchBilling
  const maxUsesText = resetFlags['web-search-deepseek:maxUses']
    ? String(baseMaxUses)
    : hasOv('web-search-deepseek:maxUses') ? overrides['web-search-deepseek:maxUses'] : fieldInputString(storedMaxUses ?? 5)
  const baseUrlText = resetFlags['web-search-deepseek:baseURL']
    ? String(baseBaseUrl)
    : hasOv('web-search-deepseek:baseURL') ? overrides['web-search-deepseek:baseURL'] : storedBaseUrl

  const resetDraft = useCallback(() => {
    setOverrides({})
    setResetFlags({})
  }, [])

  const baseSearchProvider = typeof webEntry?.descriptor?.base?.searchProvider === 'string'
    ? webEntry.descriptor.base.searchProvider
    : ''
  const baseFetchProvider = typeof webEntry?.descriptor?.base?.fetchProvider === 'string'
    ? webEntry.descriptor.base.fetchProvider
    : ''
  const searchOptions = useMemo(
    () => buildWebProviderOptions('search', providers.search, searchProvider, baseSearchProvider),
    [providers.search, searchProvider, baseSearchProvider],
  )
  const fetchOptions = useMemo(
    () => buildWebProviderOptions('fetch', providers.fetch, fetchProvider, baseFetchProvider),
    [providers.fetch, fetchProvider, baseFetchProvider],
  )

  const showSearchApiFields = Boolean(apiEntry) && (searchProvider === 'deepseek-search-api' || searchProvider === '' || !providers.available)
  const showLegacyFields = Boolean(legacyEntry) && (searchProvider === 'deepseek-official' || searchProvider === '' || !providers.available)
  const showFetchApiFields = Boolean(apiEntry) && (fetchProvider === 'deepseek-fetch-api' || fetchProvider === '' || !providers.available)

  // Only validate and commit fields belonging to currently visible provider sections,
  // so switching away from a provider cannot leave Save blocked by a hidden error.
  const countCheck = showSearchApiFields ? validateNumberText(countText, { min: 1, max: 50, integer: true }) : { ok: true, empty: true }
  const maxUsesCheck = showLegacyFields ? validateNumberText(maxUsesText, { min: 1, integer: true }) : { ok: true, empty: true }
  const invalid = !countCheck.ok || !maxUsesCheck.ok

  // Build ordered mutations: provider config namespaces first, then `web` selection last.
  // Track exact field keys per namespace so saving visible fields never discards unsaved edits
  // under hidden providers (or unrelated keys in a shared namespace).
  const pendingByNs = []
  const visibleKeys = new Set()
  if (apiEntry) {
    const ops = []
    const keys = []
    if (showSearchApiFields) {
      keys.push('web-deepseek-api:count')
      visibleKeys.add('web-deepseek-api:count')
      if (resetFlags['web-deepseek-api:count']) {
        if (hasPath(apiEntry.descriptor.user, ['count']) || storedCount !== baseCount) {
          ops.push({ op: 'unset', path: ['count'] })
        }
      } else if (countCheck.ok) {
        if (countCheck.empty && storedCount !== undefined) ops.push({ op: 'unset', path: ['count'] })
        else if (!countCheck.empty && countCheck.value !== storedCount) ops.push({ op: 'set', path: ['count'], value: countCheck.value })
      }
      if (!hasCustomSearchEndpoint) {
        keys.push('web-deepseek-api:searchBilling')
        visibleKeys.add('web-deepseek-api:searchBilling')
        if (resetFlags['web-deepseek-api:searchBilling']) {
          if (hasPath(apiEntry.descriptor.user, ['searchBilling']) || storedSearchBilling !== baseSearchBilling) {
            ops.push({ op: 'unset', path: ['searchBilling'] })
          }
        } else if (searchBilling !== storedSearchBilling) {
          ops.push({ op: 'set', path: ['searchBilling'], value: searchBilling })
        }
      }
    }
    if (showFetchApiFields && !hasCustomFetchEndpoint) {
      keys.push('web-deepseek-api:fetchBilling')
      visibleKeys.add('web-deepseek-api:fetchBilling')
      if (resetFlags['web-deepseek-api:fetchBilling']) {
        if (hasPath(apiEntry.descriptor.user, ['fetchBilling']) || storedFetchBilling !== baseFetchBilling) {
          ops.push({ op: 'unset', path: ['fetchBilling'] })
        }
      } else if (fetchBilling !== storedFetchBilling) {
        ops.push({ op: 'set', path: ['fetchBilling'], value: fetchBilling })
      }
    }
    if (ops.length > 0) pendingByNs.push({ descriptor: apiEntry.descriptor, ops, keys })
  }

  if (legacyEntry && showLegacyFields) {
    const ops = []
    const keys = ['web-search-deepseek:maxUses', 'web-search-deepseek:baseURL']
    visibleKeys.add('web-search-deepseek:maxUses')
    visibleKeys.add('web-search-deepseek:baseURL')
    if (resetFlags['web-search-deepseek:maxUses']) {
      if (hasPath(legacyEntry.descriptor.user, ['maxUses']) || storedMaxUses !== baseMaxUses) {
        ops.push({ op: 'unset', path: ['maxUses'] })
      }
    } else if (maxUsesCheck.ok) {
      if (maxUsesCheck.empty && storedMaxUses !== undefined) ops.push({ op: 'unset', path: ['maxUses'] })
      else if (!maxUsesCheck.empty && maxUsesCheck.value !== storedMaxUses) ops.push({ op: 'set', path: ['maxUses'], value: maxUsesCheck.value })
    }
    if (resetFlags['web-search-deepseek:baseURL']) {
      if (hasPath(legacyEntry.descriptor.user, ['baseURL']) || storedBaseUrl !== baseBaseUrl) {
        ops.push({ op: 'unset', path: ['baseURL'] })
      }
    } else if (baseUrlText !== storedBaseUrl) {
      ops.push(baseUrlText.trim() === '' ? { op: 'unset', path: ['baseURL'] } : { op: 'set', path: ['baseURL'], value: baseUrlText.trim() })
    }
    if (ops.length > 0) pendingByNs.push({ descriptor: legacyEntry.descriptor, ops, keys })
  }

  if (webEntry) {
    const ops = []
    const keys = ['web:searchProvider', 'web:fetchProvider']
    visibleKeys.add('web:searchProvider')
    visibleKeys.add('web:fetchProvider')
    if (searchProvider !== storedSearchProvider) {
      ops.push(searchProvider === '' || searchProvider === baseSearchProvider
        ? { op: 'unset', path: ['searchProvider'] }
        : { op: 'set', path: ['searchProvider'], value: searchProvider })
    }
    if (fetchProvider !== storedFetchProvider) {
      ops.push(fetchProvider === '' || fetchProvider === baseFetchProvider
        ? { op: 'unset', path: ['fetchProvider'] }
        : { op: 'set', path: ['fetchProvider'], value: fetchProvider })
    }
    if (ops.length > 0) pendingByNs.push({ descriptor: webEntry.descriptor, ops, keys })
  }

  const dirty = pendingByNs.length > 0 || invalid

  const handleSave = async () => {
    if (!dirty || invalid || saving || disabled || pendingByNs.length === 0) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await onSaveNamespaces(pendingByNs)
      const ok = res === true || res?.ok === true
      const savedList = Array.isArray(res?.saved) ? res.saved : (ok ? pendingByNs.map(item => item.descriptor.ns) : [])
      const savedNs = new Set(savedList)
      const keysToClear = new Set()
      for (const item of pendingByNs) {
        if (!savedNs.has(item.descriptor.ns)) continue
        for (const key of item.keys ?? []) keysToClear.add(key)
      }
      if (ok) {
        for (const key of visibleKeys) keysToClear.add(key)
        if (keysToClear.size > 0) {
          setOverrides(prev => dropKeysFromMap(prev, keysToClear))
          setResetFlags(prev => dropKeysFromMap(prev, keysToClear))
        }
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2200)
      } else if (keysToClear.size > 0) {
        setOverrides(prev => dropKeysFromMap(prev, keysToClear))
        setResetFlags(prev => dropKeysFromMap(prev, keysToClear))
      }
    } finally {
      setSaving(false)
    }
  }

  const legacySecretField = legacyEntry?.fields?.find(f => f.kind === 'secret') ?? null
  const billingChoices = billingOptions()

  return h(Fragment, null,
    providers.error ? h('div', { className: 'dsb-slot-error', role: 'alert' },
      h('span', null, providers.error),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void loadProviders() } }, t('Retry'))) : null,
    h(EngineSection, { title: t('Search') },
      webEntry ? h('div', { className: 'dsb-engine-field-wrap' },
        h(EngineRow, { label: t('Search provider') },
          h(SelectMenu, {
            'aria-label': t('Search provider'),
            value: searchProvider,
            disabled: disabled || saving,
            options: searchOptions,
            onChange: next => setField('web:searchProvider', next),
          }))) : null,
      showSearchApiFields ? h(Fragment, null,
        h('div', { className: 'dsb-engine-field-wrap' },
          h(EngineRow, { label: t('Results per search') },
            h('div', { className: 'dsb-engine-inline' },
              (!resetFlags['web-deepseek-api:count'] && (hasPath(apiEntry.descriptor.user, ['count']) || countText !== String(baseCount)))
                ? h('button', {
                  type: 'button',
                  className: 'bt-mini',
                  disabled: disabled || saving,
                  onClick: () => stageFieldReset('web-deepseek-api:count'),
                }, t('Reset'))
                : null,
              h('input', {
                className: 'bt-input bt-set-number',
                type: 'number',
                min: 1,
                max: 50,
                step: 1,
                disabled: disabled || saving,
                'aria-label': t('Results per search'),
                'aria-invalid': !countCheck.ok ? true : undefined,
                value: countText,
                onChange: event => setField('web-deepseek-api:count', event.target.value),
              }))),
          !countCheck.ok ? h('div', { className: 'dsb-engine-field-err', role: 'alert' }, countCheck.error) : null),
        h('div', { className: 'dsb-engine-field-wrap' },
          h(EngineRow, { label: t('Search billing') },
            h(SelectMenu, {
              'aria-label': t('Search billing'),
              value: searchBilling,
              disabled: disabled || saving || hasCustomSearchEndpoint,
              options: billingChoices,
              onChange: next => setField('web-deepseek-api:searchBilling', next),
            })))) : null,
      showLegacyFields ? h(Fragment, null,
        h('div', { className: 'dsb-engine-field-wrap' },
          h(EngineRow, { label: t('Max searches per request') },
            h('div', { className: 'dsb-engine-inline' },
              (!resetFlags['web-search-deepseek:maxUses'] && (hasPath(legacyEntry.descriptor.user, ['maxUses']) || maxUsesText !== String(baseMaxUses)))
                ? h('button', {
                  type: 'button',
                  className: 'bt-mini',
                  disabled: disabled || saving,
                  onClick: () => stageFieldReset('web-search-deepseek:maxUses'),
                }, t('Reset'))
                : null,
              h('input', {
                className: 'bt-input bt-set-number',
                type: 'number',
                min: 1,
                step: 1,
                disabled: disabled || saving,
                'aria-label': t('Max searches per request'),
                'aria-invalid': !maxUsesCheck.ok ? true : undefined,
                value: maxUsesText,
                onChange: event => setField('web-search-deepseek:maxUses', event.target.value),
              }))),
          !maxUsesCheck.ok ? h('div', { className: 'dsb-engine-field-err', role: 'alert' }, maxUsesCheck.error) : null),
        h('div', { className: 'dsb-engine-field-wrap' },
          h(EngineRow, { label: t('Base URL') },
            h('div', { className: 'dsb-engine-inline' },
              (!resetFlags['web-search-deepseek:baseURL'] && (hasPath(legacyEntry.descriptor.user, ['baseURL']) || baseUrlText !== String(baseBaseUrl)))
                ? h('button', {
                  type: 'button',
                  className: 'bt-mini',
                  disabled: disabled || saving,
                  onClick: () => stageFieldReset('web-search-deepseek:baseURL'),
                }, t('Reset'))
                : null,
              h('input', {
                className: 'bt-input dsb-engine-text',
                type: 'text',
                disabled: disabled || saving,
                'aria-label': t('Base URL'),
                value: baseUrlText,
                onChange: event => setField('web-search-deepseek:baseURL', event.target.value),
              })))),
        legacySecretField ? h('div', { className: 'dsb-engine-field-wrap' },
          h(EngineRow, { label: legacySecretField.label },
            h(SchemaSecretField, { field: legacySecretField, disabled: disabled || saving, onSave: op => onSecretMutate(legacyEntry.descriptor, op) }))) : null) : null),
    (webEntry || showFetchApiFields) ? h(EngineSection, { title: t('Web fetch') },
      webEntry ? h('div', { className: 'dsb-engine-field-wrap' },
        h(EngineRow, { label: t('Fetch provider') },
          h(SelectMenu, {
            'aria-label': t('Fetch provider'),
            value: fetchProvider,
            disabled: disabled || saving,
            options: fetchOptions,
            onChange: next => setField('web:fetchProvider', next),
          }))) : null,
      showFetchApiFields ? h('div', { className: 'dsb-engine-field-wrap' },
        h(EngineRow, { label: t('Fetch billing') },
          h(SelectMenu, {
            'aria-label': t('Fetch billing'),
            value: fetchBilling,
            disabled: disabled || saving || hasCustomFetchEndpoint,
            options: billingChoices,
            onChange: next => setField('web-deepseek-api:fetchBilling', next),
          }))) : null) : null,
    h(EngineFormBar, {
      dirty,
      invalid,
      saving,
      saved,
      disabled,
      onSave: () => { void handleSave() },
      onDiscard: () => { resetDraft(); setSaved(false) },
    }))
}

const routeKeyOf = route => `${route.provider}\0${route.model}`

function normalizeStoredRoutes(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item.provider !== 'string' || typeof item.model !== 'string') continue
    if (!item.provider || !item.model) continue
    const key = routeKeyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider: item.provider, model: item.model })
  }
  return out
}

function sameRouteLists(a, b) {
  if (a.length !== b.length) return false
  const setA = new Set(a.map(routeKeyOf))
  for (const item of b) if (!setA.has(routeKeyOf(item))) return false
  return true
}

function SubagentDetailForm({ entries, disabled, onSaveNamespaces }) {
  const byNs = useMemo(() => new Map(entries.map(e => [e.descriptor.ns, e])), [entries])
  const limitsEntry = byNs.get('subagent')
  const modelEntry = byNs.get('subagent-model-selection-settings')

  const storedMaxDepth = limitsEntry?.descriptor?.value?.maxDepth
  const baseMaxDepth = readPath(limitsEntry?.descriptor?.base, ['maxDepth']) ?? 2
  const storedMaxActive = limitsEntry?.descriptor?.value?.maxActiveSubagents
  const baseMaxActive = readPath(limitsEntry?.descriptor?.base, ['maxActiveSubagents']) ?? 8
  const storedEnabled = modelEntry?.descriptor?.value?.enabled === true
  const storedRoutes = useMemo(
    () => normalizeStoredRoutes(modelEntry?.descriptor?.value?.allowedModels),
    [modelEntry],
  )
  const storedRouteKeys = useMemo(() => new Set(storedRoutes.map(routeKeyOf)), [storedRoutes])

  const [overrides, setOverrides] = useState({})
  const [resetFlags, setResetFlags] = useState({})
  const [catalog, setCatalog] = useState({ status: 'idle', partial: false, groups: [], error: '' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef(0)

  useEffect(() => () => clearTimeout(savedTimer.current), [])

  const hasOv = key => Object.prototype.hasOwnProperty.call(overrides, key)
  const setField = (key, value) => {
    setSaved(false)
    setOverrides(prev => ({ ...prev, [key]: value }))
    setResetFlags((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }
  const stageFieldReset = (key) => {
    setSaved(false)
    setOverrides((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setResetFlags(prev => ({ ...prev, [key]: true }))
  }

  const maxDepthText = resetFlags['subagent:maxDepth']
    ? String(baseMaxDepth)
    : hasOv('subagent:maxDepth') ? overrides['subagent:maxDepth'] : fieldInputString(storedMaxDepth ?? baseMaxDepth)
  const maxActiveText = resetFlags['subagent:maxActive']
    ? String(baseMaxActive)
    : hasOv('subagent:maxActive') ? overrides['subagent:maxActive'] : fieldInputString(storedMaxActive ?? baseMaxActive)
  const selectionEnabled = hasOv('subagent-model-selection-settings:enabled')
    ? overrides['subagent-model-selection-settings:enabled']
    : storedEnabled
  const selectedKeys = hasOv('subagent-model-selection-settings:selectedKeys')
    ? overrides['subagent-model-selection-settings:selectedKeys']
    : storedRouteKeys

  const resetDraft = useCallback(() => {
    setOverrides({})
    setResetFlags({})
  }, [])

  const loadCatalog = useCallback(async () => {
    setCatalog(prev => ({ ...prev, status: 'loading', error: '' }))
    try {
      const res = await call('engine-model-catalog')
      setCatalog({
        status: 'ready',
        partial: res?.partial === true,
        groups: Array.isArray(res?.groups) ? res.groups : [],
        error: '',
      })
    } catch (failure) {
      setCatalog(prev => ({
        ...prev,
        status: 'error',
        error: hostText(failure?.message ?? String(failure)),
      }))
    }
  }, [])

  useEffect(() => {
    if (modelEntry && selectionEnabled && catalog.status === 'idle') {
      void loadCatalog()
    }
  }, [modelEntry, selectionEnabled, catalog.status, loadCatalog])

  const depthCheck = limitsEntry ? validateNumberText(maxDepthText, { min: 0, integer: true }) : { ok: true, empty: true }
  const activeCheck = limitsEntry ? validateNumberText(maxActiveText, { min: 1, integer: true }) : { ok: true, empty: true }

  const { groupsWithRows, routeByKey } = useMemo(() => {
    const map = new Map()
    const storedMap = new Map(storedRoutes.map(r => [routeKeyOf(r), r]))
    const grouped = []
    for (const group of catalog.groups) {
      const rows = []
      for (const model of group.models ?? []) {
        const route = { provider: group.id, model: model.id }
        const key = routeKeyOf(route)
        map.set(key, route)
        storedMap.delete(key)
        rows.push({ key, label: model.name || model.id, available: true })
      }
      if (rows.length > 0) grouped.push({ id: group.id, title: group.name || group.id, rows })
    }
    if (storedMap.size > 0) {
      const unavailable = []
      for (const [key, route] of storedMap) {
        map.set(key, route)
        unavailable.push({ key, label: `${route.provider} / ${route.model}`, available: false })
      }
      grouped.push({ id: '__unavailable__', title: t('Unavailable'), rows: unavailable })
    }
    return { groupsWithRows: grouped, routeByKey: map }
  }, [catalog.groups, storedRoutes])

  const nextRoutes = useMemo(() => {
    const out = []
    for (const key of selectedKeys) {
      const route = routeByKey.get(key)
      if (route) out.push(route)
    }
    return out
  }, [selectedKeys, routeByKey])

  const missingSelection = Boolean(modelEntry && selectionEnabled && nextRoutes.length === 0)
  const invalid = !depthCheck.ok || !activeCheck.ok || missingSelection

  const pendingByNs = []
  if (limitsEntry) {
    const ops = []
    if (resetFlags['subagent:maxDepth']) {
      if (hasPath(limitsEntry.descriptor.user, ['maxDepth']) || storedMaxDepth !== baseMaxDepth) {
        ops.push({ op: 'unset', path: ['maxDepth'] })
      }
    } else if (depthCheck.ok) {
      if (depthCheck.empty && storedMaxDepth !== undefined) ops.push({ op: 'unset', path: ['maxDepth'] })
      else if (!depthCheck.empty && depthCheck.value !== storedMaxDepth) ops.push({ op: 'set', path: ['maxDepth'], value: depthCheck.value })
    }
    if (resetFlags['subagent:maxActive']) {
      if (hasPath(limitsEntry.descriptor.user, ['maxActiveSubagents']) || storedMaxActive !== baseMaxActive) {
        ops.push({ op: 'unset', path: ['maxActiveSubagents'] })
      }
    } else if (activeCheck.ok) {
      if (activeCheck.empty && storedMaxActive !== undefined) ops.push({ op: 'unset', path: ['maxActiveSubagents'] })
      else if (!activeCheck.empty && activeCheck.value !== storedMaxActive) ops.push({ op: 'set', path: ['maxActiveSubagents'], value: activeCheck.value })
    }
    if (ops.length > 0) pendingByNs.push({ descriptor: limitsEntry.descriptor, ops })
  }

  if (modelEntry) {
    const ops = []
    if (selectionEnabled !== storedEnabled) ops.push({ op: 'set', path: ['enabled'], value: selectionEnabled })
    if (!sameRouteLists(nextRoutes, storedRoutes)) ops.push({ op: 'set', path: ['allowedModels'], value: nextRoutes })
    if (ops.length > 0) pendingByNs.push({ descriptor: modelEntry.descriptor, ops })
  }

  const dirty = pendingByNs.length > 0 || invalid

  const handleSave = async () => {
    if (!dirty || invalid || saving || disabled || pendingByNs.length === 0) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await onSaveNamespaces(pendingByNs)
      const ok = res === true || res?.ok === true
      const savedList = Array.isArray(res?.saved) ? res.saved : (ok ? pendingByNs.map(item => item.descriptor.ns) : [])
      if (ok) {
        setOverrides({})
        setResetFlags({})
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2200)
      } else if (savedList.length > 0) {
        const savedNs = new Set(savedList)
        setOverrides(prev => dropNamespacesFromMap(prev, savedNs))
        setResetFlags(prev => dropNamespacesFromMap(prev, savedNs))
      }
    } finally {
      setSaving(false)
    }
  }

  const toggleRoute = (key) => {
    setSaved(false)
    setOverrides((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, 'subagent-model-selection-settings:selectedKeys')
        ? prev['subagent-model-selection-settings:selectedKeys']
        : storedRouteKeys
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...prev, 'subagent-model-selection-settings:selectedKeys': next }
    })
  }

  return h(Fragment, null,
    limitsEntry ? h(EngineSection, { title: t('Limits') },
      h('div', { className: 'dsb-engine-field-wrap' },
        h(EngineRow, { label: t('Max depth') },
          h('div', { className: 'dsb-engine-inline' },
            (!resetFlags['subagent:maxDepth'] && (hasPath(limitsEntry.descriptor.user, ['maxDepth']) || maxDepthText !== String(baseMaxDepth)))
              ? h('button', {
                type: 'button',
                className: 'bt-mini',
                disabled: disabled || saving,
                onClick: () => stageFieldReset('subagent:maxDepth'),
              }, t('Reset'))
              : null,
            h('input', {
              className: 'bt-input bt-set-number',
              type: 'number',
              min: 0,
              step: 1,
              disabled: disabled || saving,
              'aria-label': t('Max depth'),
              'aria-invalid': !depthCheck.ok ? true : undefined,
              value: maxDepthText,
              onChange: event => setField('subagent:maxDepth', event.target.value),
            }))),
        !depthCheck.ok ? h('div', { className: 'dsb-engine-field-err', role: 'alert' }, depthCheck.error) : null),
      h('div', { className: 'dsb-engine-field-wrap' },
        h(EngineRow, { label: t('Max active subagents') },
          h('div', { className: 'dsb-engine-inline' },
            (!resetFlags['subagent:maxActive'] && (hasPath(limitsEntry.descriptor.user, ['maxActiveSubagents']) || maxActiveText !== String(baseMaxActive)))
              ? h('button', {
                type: 'button',
                className: 'bt-mini',
                disabled: disabled || saving,
                onClick: () => stageFieldReset('subagent:maxActive'),
              }, t('Reset'))
              : null,
            h('input', {
              className: 'bt-input bt-set-number',
              type: 'number',
              min: 1,
              step: 1,
              disabled: disabled || saving,
              'aria-label': t('Max active subagents'),
              'aria-invalid': !activeCheck.ok ? true : undefined,
              value: maxActiveText,
              onChange: event => setField('subagent:maxActive', event.target.value),
            }))),
        !activeCheck.ok ? h('div', { className: 'dsb-engine-field-err', role: 'alert' }, activeCheck.error) : null)) : null,
    modelEntry ? h(EngineSection, { title: t('Subagent models') },
      h('div', { className: 'dsb-engine-field-wrap' },
        h(EngineRow, { label: t('Allow agents to choose models for subagents') },
          h(Switch, {
            label: t('Allow agents to choose models for subagents'),
            on: selectionEnabled,
            disabled: disabled || saving,
            onChange: next => setField('subagent-model-selection-settings:enabled', next),
          }))),
      selectionEnabled ? h('div', { className: 'dsb-subagent-models' },
        catalog.status === 'loading'
          ? h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))
          : catalog.status === 'error'
            ? h('div', { className: 'dsb-slot-error', role: 'alert' },
              h('span', null, catalog.error || t('Could not load models.')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void loadCatalog() } }, t('Retry')))
            : groupsWithRows.length === 0
              ? h('div', { className: 'dsb-engine-empty' }, t('No models available.'))
              : h(Fragment, null,
                catalog.partial ? h('div', { className: 'dsb-engine-notice', role: 'status' }, t('Some model providers could not be loaded.')) : null,
                groupsWithRows.map(group => h('div', { key: group.id, className: 'dsb-subagent-group' },
                  h('div', { className: 'dsb-subagent-group-title' }, group.title),
                  h('div', { className: 'dsb-subagent-list' },
                    group.rows.map(row => h('label', {
                      key: row.key,
                      className: 'dsb-subagent-opt',
                      'data-disabled': (disabled || saving) ? '' : undefined,
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: selectedKeys.has(row.key),
                      disabled: disabled || saving,
                      onChange: () => toggleRoute(row.key),
                    }),
                    h('span', { className: 'dsb-subagent-opt-name' }, row.label),
                    !row.available ? h('span', { className: 'dsb-subagent-opt-tag' }, t('Unavailable')) : null)))))),
        missingSelection ? h('div', { className: 'dsb-engine-field-err', 'data-inline': '', role: 'alert' }, t('Select at least one model before saving.')) : null) : null) : null,
    h(EngineFormBar, {
      dirty,
      invalid,
      saving,
      saved,
      disabled,
      onSave: () => { void handleSave() },
      onDiscard: () => { resetDraft(); setSaved(false) },
    }))
}

function normalizeDetailTarget(subTarget, surfaceMode = 'bot') {
  if (typeof subTarget !== 'string') return ''
  const trimmed = subTarget.trim()
  if (!trimmed || isBannedNamespace(trimmed, surfaceMode)) return ''
  const groups = configGroupsForSurface(surfaceMode)
  if (groups.some(group => group.id === trimmed)) return trimmed
  if (BUILTIN_GROUP_BY_NS.has(trimmed)) {
    const groupId = BUILTIN_GROUP_BY_NS.get(trimmed)
    if (groups.some(group => group.id === groupId)) return groupId
  }
  return trimmed
}

function PluginIconBox({ src, fallback, accent = false }) {
  const [failedSrc, setFailedSrc] = useState('')
  const safeSrc = safePluginIconUri(src)
  return h('span', {
    className: 'dsb-plug-icon',
    'data-core': accent ? '' : undefined,
    'aria-hidden': true,
  },
  safeSrc && safeSrc !== failedSrc
    ? h('img', { src: safeSrc, alt: '', onError: () => setFailedSrc(safeSrc) })
    : (fallback || h(PuzzleIcon)))
}

export function PluginsSettingsPage({ readOnly = false, subTarget = null, surfaceMode = 'bot', runtime = pluginRuntime }) {
  const uiPlugins = usePlugins(runtime)
  const [data, setData] = useState(() => pluginsCache)
  const [settingsData, setSettingsData] = useState(() => settingsCache)
  const [loading, setLoading] = useState(() => !pluginsCache && !settingsCache)
  const [installOpen, setInstallOpen] = useState(false)
  const [spec, setSpec] = useState('')
  const [showMoreOptional, setShowMoreOptional] = useState(false)
  const [detailId, setDetailId] = useState(() => normalizeDetailTarget(subTarget, surfaceMode))
  const [busyKey, setBusyKey] = useState('')
  const [armedRemove, setArmedRemove] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const activeLang = language()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const next = normalizeDetailTarget(subTarget, surfaceMode)
    if (next) setDetailId(next)
  }, [subTarget, surfaceMode])

  useEscape(() => setArmedRemove(''), Boolean(armedRemove), { priority: ESCAPE_PRIORITY.INLINE_ACTION })

  const load = useCallback(async () => {
    if (!pluginsCache && !settingsCache) setLoading(true)
    setError('')
    try {
      const [pluginsRes, settingsRes] = await Promise.allSettled([
        call('engine-plugins-list'),
        call('engine-settings-list'),
      ])
      if (pluginsRes.status === 'fulfilled') pluginsCache = pluginsRes.value
      if (settingsRes.status === 'fulfilled') settingsCache = settingsRes.value
      if (!mounted.current) return
      if (pluginsRes.status === 'fulfilled') {
        setData(pluginsRes.value)
      } else {
        setError(hostText(pluginsRes.reason?.message ?? String(pluginsRes.reason)))
      }
      if (settingsRes.status === 'fulfilled') {
        setSettingsData(settingsRes.value)
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const noteOutcome = (res) => {
    if (res?.application === 'restart-required') setNotice(t('Restart required for this plugin change to take effect.'))
    else if (res?.error?.diagnostic) setError(res.error.diagnostic)
    else setNotice('')
  }

  const toggleBundle = async (bundle, enabled) => {
    if (busyKey || readOnly || isCoreDsBotEntry(bundle)) return
    setArmedRemove('')
    setBusyKey(`bundle:${bundle.name}`)
    setError('')
    try {
      const res = await call('engine-plugins-toggle-bundle', { name: bundle.name, enabled })
      if (mounted.current) noteOutcome(res)
      await load()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusyKey('')
    }
  }

  const installBundle = async (event) => {
    event?.preventDefault?.()
    const clean = spec.trim()
    if (!clean || busyKey || readOnly) return
    setArmedRemove('')
    setBusyKey('install')
    setError('')
    setNotice('')
    try {
      const res = await call('engine-plugins-install', { spec: clean, enabled: true })
      if (mounted.current) {
        setSpec('')
        setInstallOpen(false)
        noteOutcome(res)
      }
      await load()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusyKey('')
    }
  }

  const removeBundle = async (bundle) => {
    if (busyKey || readOnly || !bundle.removable || isCoreDsBotEntry(bundle)) return
    setBusyKey(`remove:${bundle.name}`)
    setError('')
    try {
      const res = await call('engine-plugins-remove', { name: bundle.name })
      if (mounted.current) {
        setArmedRemove('')
        noteOutcome(res)
      }
      await load()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusyKey('')
    }
  }

  const mutateField = async (descriptor, op) => {
    if (busyKey || readOnly || !settingsData?.writable) return
    const key = `cfg:${descriptor.ns}:${op.path.join('.')}`
    setBusyKey(key)
    setError('')
    try {
      const updated = await call('engine-settings-mutate', {
        ns: descriptor.ns,
        ops: [op],
        expectedRevision: descriptor.revision,
      })
      if (settingsCache) {
        settingsCache = {
          ...settingsCache,
          namespaces: settingsCache.namespaces.map(entry => (entry.ns === updated.ns ? updated : entry)),
        }
      }
      if (mounted.current) {
        setSettingsData(prev => (prev ? {
          ...prev,
          namespaces: prev.namespaces.map(entry => (entry.ns === updated.ns ? updated : entry)),
        } : prev))
      }
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
      if (failure?.code === 'bot/stale') await load()
    } finally {
      if (mounted.current) setBusyKey('')
    }
  }

  const saveNamespaces = async (batch) => {
    if (busyKey || readOnly || !settingsData?.writable || !Array.isArray(batch) || batch.length === 0) return { ok: false, saved: [] }
    setBusyKey('cfg:batch')
    setError('')
    const saved = []
    try {
      for (const { descriptor, ops } of batch) {
        if (!Array.isArray(ops) || ops.length === 0) continue
        const updated = await call('engine-settings-mutate', {
          ns: descriptor.ns,
          ops,
          expectedRevision: descriptor.revision,
        })
        saved.push(descriptor.ns)
        if (settingsCache) {
          settingsCache = {
            ...settingsCache,
            namespaces: settingsCache.namespaces.map(entry => (entry.ns === updated.ns ? updated : entry)),
          }
        }
        if (mounted.current) {
          setSettingsData(prev => (prev ? {
            ...prev,
            namespaces: prev.namespaces.map(entry => (entry.ns === updated.ns ? updated : entry)),
          } : prev))
        }
      }
      return { ok: true, saved }
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
      if (failure?.code === 'bot/stale') await load()
      return { ok: false, saved }
    } finally {
      if (mounted.current) setBusyKey('')
    }
  }

  const configItems = useMemo(() => {
    void activeLang
    const activeGroups = configGroupsForSurface(surfaceMode)
    const namespaces = (settingsData?.namespaces ?? []).filter(entry =>
      entry && !DEDICATED_NAMESPACES.has(entry.ns) && !isBannedNamespace(entry.ns, surfaceMode))
    const byNs = new Map(namespaces.map(entry => [entry.ns, entry]))
    const usedNs = new Set()
    const items = []

    for (const group of activeGroups) {
      const entries = []
      for (const ns of group.namespaces) {
        const descriptor = byNs.get(ns)
        if (!descriptor) continue
        usedNs.add(ns)
        const fields = extractSchemaFields(descriptor.schema, descriptor.value, descriptor.secrets, descriptor.ns)
        if (fields.length > 0 || group.id === 'subagent' || group.id === 'web-search') {
          entries.push({ descriptor, fields })
        }
      }
      if (entries.length > 0) {
        items.push({ id: group.id, title: t(group.titleKey), icon: group.icon, entries })
      }
    }

    const extra = namespaces
      .filter(entry => !usedNs.has(entry.ns) && entry.autoGenerate !== false)
      .map(descriptor => ({
        descriptor,
        fields: extractSchemaFields(descriptor.schema, descriptor.value, descriptor.secrets, descriptor.ns),
      }))
      .filter(entry => entry.fields.length > 0)
      .sort((a, b) => a.descriptor.ns.localeCompare(b.descriptor.ns))

    for (const entry of extra) {
      items.push({
        id: entry.descriptor.ns,
        title: namespaceTitle(entry.descriptor.ns),
        icon: CodeIcon,
        entries: [entry],
      })
    }
    return items
  }, [settingsData, activeLang, surfaceMode])

  const { installedBundles, primaryOptional, moreOptional } = useMemo(() => {
    void activeLang
    const eligible = (data?.bundles ?? []).filter(entry => !isExcludedBundle(entry))
    const installed = []
    const optional = []
    for (const bundle of eligible) {
      const core = isCoreDsBotEntry(bundle)
      if (core || bundle.enabled || (!bundle.official && bundle.installed)) {
        installed.push(bundle)
      } else if (bundle.official || EXTENSION_BUNDLES.includes(bundle.name) || MORE_BUNDLE_SET.has(bundle.name)) {
        if (bundle.listedByDefault !== false || EXTENSION_BUNDLES.includes(bundle.name) || MORE_BUNDLE_SET.has(bundle.name)) {
          optional.push(bundle)
        }
      }
    }
    installed.sort((a, b) => {
      const coreDiff = Number(isCoreDsBotEntry(b)) - Number(isCoreDsBotEntry(a))
      if (coreDiff !== 0) return coreDiff
      return bundleDisplayMeta(a, activeLang).title.localeCompare(bundleDisplayMeta(b, activeLang).title)
    })

    const primary = []
    const more = []
    for (const bundle of optional) {
      if (MORE_BUNDLE_SET.has(bundle.name)) more.push(bundle)
      else primary.push(bundle)
    }
    const rankIn = (list, name) => {
      const idx = list.indexOf(name)
      return idx === -1 ? list.length : idx
    }
    primary.sort((a, b) => {
      const diff = rankIn(EXTENSION_BUNDLES, a.name) - rankIn(EXTENSION_BUNDLES, b.name)
      if (diff !== 0) return diff
      return bundleDisplayMeta(a, activeLang).title.localeCompare(bundleDisplayMeta(b, activeLang).title)
    })
    more.sort((a, b) => rankIn(MORE_BUNDLES, a.name) - rankIn(MORE_BUNDLES, b.name))
    return { installedBundles: installed, primaryOptional: primary, moreOptional: more }
  }, [data, activeLang])

  if (loading && !data && !settingsData) {
    return h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))
  }

  // In-page built-in / plugin schema config drill-down view.
  if (detailId) {
    const activeItem = configItems.find(item => item.id === detailId)
    const fallbackGroup = configGroupsForSurface(surfaceMode).find(group => group.id === detailId)
    const detailTitle = activeItem?.title ?? (fallbackGroup ? t(fallbackGroup.titleKey) : namespaceTitle(detailId))
    const detailIcon = activeItem?.icon ?? fallbackGroup?.icon ?? CodeIcon
    const cfgDisabled = Boolean(busyKey) || readOnly || !settingsData?.writable
    return h('div', { className: 'dsb-engine-page', 'data-engine-section': 'plugins', 'data-plugin-detail': detailId },
      h('div', { className: 'dsb-plug-detail-sticky' },
        h('button', {
          type: 'button',
          className: 'dsb-plug-back',
          onClick: () => setDetailId(''),
        }, h(ChevronLeftIcon), t('Back to plugins')),
        h('span', { 'aria-hidden': true, style: { width: '1px', height: '16px', background: 'var(--bt-line-2)', flex: 'none' } }),
        h('div', { className: 'dsb-plug-detail-head' },
          h(PluginIconBox, { fallback: h(detailIcon) }),
          h('h3', { className: 'dsb-plug-detail-title' }, detailTitle))),
      h(StatusAlert, { error, notice }),
      loading && !settingsData
        ? h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))
        : !activeItem || activeItem.entries.length === 0
          ? h('div', { className: 'dsb-engine-empty' }, t('No engine configuration options available.'))
          : detailId === 'web-search'
            ? h(WebSearchDetailForm, {
              entries: activeItem.entries,
              disabled: cfgDisabled,
              onSaveNamespaces: saveNamespaces,
              onSecretMutate: (descriptor, op) => { void mutateField(descriptor, op) },
            })
            : detailId === 'subagent' && surfaceMode === 'agent'
              ? h(SubagentDetailForm, {
                entries: activeItem.entries,
                disabled: cfgDisabled,
                onSaveNamespaces: saveNamespaces,
              })
              : h(StagedSchemaGroupForm, {
                key: detailId,
                groupKey: detailId,
                entries: activeItem.entries,
                detailTitle,
                disabled: cfgDisabled,
                onSaveNamespaces: saveNamespaces,
                onSecretMutate: (descriptor, op) => { void mutateField(descriptor, op) },
              }))
  }

  const failedUiPlugins = uiPlugins.filter(entry => entry.status === 'error')
  if (data && data.available === false && configItems.length === 0 && failedUiPlugins.length === 0) {
    return h('div', { className: 'dsb-engine-empty' }, t('Plugin management is not available on this host.'))
  }

  const renderBundleRow = (bundle, { showExperimentalBadge = false } = {}) => {
    const core = isCoreDsBotEntry(bundle)
    const { title, description } = bundleDisplayMeta(bundle, activeLang)
    const armed = armedRemove === bundle.name
    const removing = busyKey === `remove:${bundle.name}`
    const unsupported = bundle.error?.code === 'unsupported-platform'
    const experimental = EXPERIMENTAL_BUNDLES.has(bundle.name)
    return h('div', { key: bundle.name, className: 'dsb-plug-row', 'data-plugin-bundle': bundle.name },
      h(PluginIconBox, {
        src: core ? null : bundle.meta?.icon,
        accent: core,
        fallback: core ? h(BotMark, { look: MAIN_LOOK, size: 20, live: false }) : h(PuzzleIcon),
      }),
      h('div', { className: 'dsb-plug-copy' },
        h('div', { className: 'dsb-plug-title-row' },
          h('span', { className: 'dsb-plug-name' }, title),
          bundle.version ? h('span', { className: 'dsb-plug-ver' }, `v${bundle.version}`) : null,
          experimental && !core && showExperimentalBadge ? h('span', { className: 'dsb-preset-badge' }, t('Experimental')) : null),
        description ? h('span', { className: 'dsb-plug-desc' }, description) : null),
      h('div', { className: 'bt-set-control' },
        core
          ? h('span', { className: 'dsb-preset-badge', 'data-core-plugin': '' }, t('Core'))
          : h('div', { className: 'dsb-engine-inline' },
            bundle.removable
              ? (armed
                ? h(Fragment, null,
                  h('button', {
                    type: 'button',
                    className: 'bt-soft bt-soft-sm bt-danger',
                    'data-armed': '',
                    style: { background: 'var(--bt-danger-soft)' },
                    disabled: Boolean(busyKey) || readOnly,
                    onClick: () => { void removeBundle(bundle) },
                  }, removing ? t('Removing…') : t('Confirm remove')),
                  h('button', {
                    type: 'button',
                    className: 'bt-soft bt-soft-sm',
                    disabled: Boolean(busyKey) || readOnly,
                    onClick: () => setArmedRemove(''),
                  }, t('Cancel')))
                : h('button', {
                  type: 'button',
                  className: 'bt-soft bt-soft-sm bt-danger',
                  disabled: Boolean(busyKey) || readOnly,
                  onClick: () => setArmedRemove(bundle.name),
                }, t('Remove')))
              : null,
            h(Switch, {
              label: title,
              on: bundle.enabled,
              disabled: Boolean(busyKey) || readOnly || Boolean(bundle.readOnlyReason) || unsupported,
              onChange: next => { void toggleBundle(bundle, next) },
            }))))
  }

  const visibleOptional = primaryOptional.length === 0
    ? moreOptional
    : (showMoreOptional ? [...primaryOptional, ...moreOptional] : primaryOptional)
  const hasMoreToggle = primaryOptional.length > 0 && moreOptional.length > 0

  const uiPluginStatusLabel = (status) => {
    if (status === 'active') return t('Active')
    if (status === 'error') return t('Failed to load')
    if (status === 'loading') return t('Loading…')
    if (status === 'idle') return t('Idle')
    return t('Waiting')
  }

  return h('div', { className: 'dsb-engine-page', 'data-engine-section': 'plugins' },
    h(StatusAlert, { error, notice }),
    failedUiPlugins.length > 0 ? h(EngineSection, { title: t('Window plugins') },
      failedUiPlugins.map(entry => h('div', { key: entry.id, className: 'dsb-plug-row', 'data-ui-plugin': entry.id, 'data-ui-plugin-status': entry.status },
        h(PluginIconBox, { fallback: h(PuzzleIcon) }),
        h('div', { className: 'dsb-plug-copy' },
          h('div', { className: 'dsb-plug-title-row' },
            h('span', { className: 'dsb-plug-name' }, entry.name || entry.id),
            h('span', { className: 'dsb-ui-plug-status', 'data-status': entry.status }, uiPluginStatusLabel(entry.status))),
          entry.error ? h('span', { className: 'dsb-plug-desc', role: 'alert' }, entry.error) : null),
        h('div', { className: 'bt-set-control' },
          h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm',
            onClick: () => { runtime.retry(entry.id) },
          }, t('Retry')))))) : null,
    data?.available !== false ? h(EngineSection, {
      title: t('Installed plugins'),
      action: !readOnly ? h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm bt-with-icon',
        'aria-expanded': installOpen,
        onClick: () => setInstallOpen(open => !open),
      }, h(PlusIcon), t('Add plugin')) : null,
    },
    installOpen ? h('form', { className: 'dsb-engine-install', onSubmit: installBundle },
      h('input', {
        className: 'bt-input',
        type: 'text',
        value: spec,
        disabled: Boolean(busyKey) || readOnly,
        placeholder: t('Package name or path…'),
        'aria-label': t('Package name or path…'),
        onChange: event => setSpec(event.target.value),
      }),
      h('button', {
        type: 'submit',
        className: 'bt-send bt-soft-sm',
        disabled: Boolean(busyKey) || readOnly || spec.trim() === '',
      }, busyKey === 'install' ? t('Installing…') : t('Install')),
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled: Boolean(busyKey),
        onClick: () => { setInstallOpen(false); setSpec('') },
      }, t('Cancel'))) : null,
    installedBundles.length > 0
      ? installedBundles.map(bundle => renderBundleRow(bundle, { showExperimentalBadge: true }))
      : (!installOpen ? h('div', { className: 'dsb-engine-empty' }, t('No engine plugins installed.')) : null)) : null,
    configItems.length > 0 ? h(EngineSection, { title: t('Built-in plugin settings') },
      configItems.map(item => h('button', {
        key: item.id,
        type: 'button',
        className: 'dsb-plug-row',
        'data-builtin-config': item.id,
        onClick: () => setDetailId(item.id),
      },
      h(PluginIconBox, { fallback: h(item.icon) }),
      h('div', { className: 'dsb-plug-copy' },
        h('div', { className: 'dsb-plug-title-row' },
          h('span', { className: 'dsb-plug-name' }, item.title))),
      h('span', { className: 'dsb-plug-chev', 'aria-hidden': true }, h(ChevronRightIcon))))) : null,
    visibleOptional.length > 0 ? h(EngineSection, { title: t('Experimental plugins') },
      visibleOptional.map(bundle => renderBundleRow(bundle, { showExperimentalBadge: false })),
      hasMoreToggle ? h('button', {
        type: 'button',
        className: 'dsb-plug-more-btn',
        'aria-expanded': showMoreOptional,
        onClick: () => setShowMoreOptional(open => !open),
      },
      showMoreOptional ? t('Show fewer') : t('More'),
      showMoreOptional ? h(ChevronUpIcon) : h(ChevronDownIcon)) : null) : null)
}

// Localized display metadata for DSH's shipped presets (when a preset omits custom copy).
const BUILTIN_PRESET_COPY = {
  standard: {
    name: 'Standard mode',
    description: 'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  },
  ptc: {
    name: 'PTC mode',
    description: 'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  },
  minimal: {
    name: 'Minimal mode',
    description: 'The agent uses a terminal and image reading, with context compaction. Useful for testing and comparing its basic performance.',
  },
  cordis: {
    name: 'Creator mode',
    description: 'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',
  },
}

const isBuiltInPreset = preset => !preset.name && Object.prototype.hasOwnProperty.call(BUILTIN_PRESET_COPY, preset.id)

function presetDisplayCopy(preset) {
  if (isBuiltInPreset(preset)) {
    const copy = BUILTIN_PRESET_COPY[preset.id]
    return { name: t(copy.name), description: t(copy.description) }
  }
  return {
    name: preset.name || preset.id,
    description: preset.description || t('No description.'),
  }
}

function PresetConfigModal({ doc, onClose }) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(0)
  const modalRef = useRef(null)
  const closeBtnRef = useRef(null)
  useEscape(onClose, true, { priority: ESCAPE_PRIORITY.MODAL_CHILD })
  useModalFocusTrap(modalRef, true, { initialFocusRef: closeBtnRef })
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const copyYaml = async () => {
    if (await writeClipboard(doc.content)) {
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1200)
    }
  }

  const modal = h('div', { ref: modalRef, tabIndex: -1, className: 'dsb-preset-modal-layer', role: 'dialog', 'aria-modal': true, 'aria-label': `${t('View configuration')} · ${doc.title}` },
    h('div', { className: 'dsb-preset-modal-scrim', onMouseDown: onClose }),
    h('div', { className: 'dsb-preset-modal' },
      h('div', { className: 'dsb-preset-modal-head' },
        h('div', { className: 'dsb-preset-modal-titles' },
          h('h3', null, doc.title),
          h('code', { className: 'dsb-preset-id' }, doc.id)),
        h('div', { className: 'dsb-preset-modal-acts' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => { void copyYaml() } },
            copied ? h(CheckIcon) : h(CopyIcon),
            copied ? t('Copied') : t('Copy')),
          h('button', { ref: closeBtnRef, type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: onClose }, h(CloseIcon)))),
      h('pre', { className: 'dsb-preset-code' }, doc.content || t('No configuration content.'))))
  const target = typeof document !== 'undefined' && document.body ? document.body : null
  return target ? createPortal(modal, target) : modal
}

export function AgentPresetsSettingsPage({ readOnly = false, close, onStartPresetCreator }) {
  const [data, setData] = useState(() => presetsCache)
  const [loading, setLoading] = useState(() => !presetsCache)
  const [readingId, setReadingId] = useState('')
  const [creating, setCreating] = useState(false)
  const [viewed, setViewed] = useState(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const selectSeq = useRef(0)
  const inFlightSelects = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async ({ clearError = true } = {}) => {
    if (!presetsCache) setLoading(true)
    if (clearError) setError('')
    try {
      const next = await call('engine-presets-list')
      presetsCache = next
      if (mounted.current) setData(next)
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const selectDefault = async (presetId) => {
    if (readOnly || !data?.writable) return
    const target = (data.presets ?? []).find(entry => entry.id === presetId)
    if (!target || target.isDefault || target.broken) return
    const seq = ++selectSeq.current
    const prevData = data
    const expectedRevision = inFlightSelects.current === 0 ? data.revision : undefined
    inFlightSelects.current += 1
    setError('')
    const optimistic = {
      ...data,
      presets: (data.presets ?? []).map(entry => ({ ...entry, isDefault: entry.id === presetId })),
    }
    presetsCache = optimistic
    setData(optimistic)
    try {
      const next = await call('engine-presets-default', expectedRevision === undefined ? { id: presetId } : { id: presetId, expectedRevision })
      if (selectSeq.current === seq) {
        presetsCache = next
        if (mounted.current) setData(next)
      }
    } catch (failure) {
      if (selectSeq.current === seq) {
        presetsCache = prevData
        if (mounted.current) {
          setData(prevData)
          setError(hostText(failure?.message ?? String(failure)))
          await load({ clearError: false })
        }
      }
    } finally {
      inFlightSelects.current = Math.max(0, inFlightSelects.current - 1)
    }
  }

  const openConfig = async (preset) => {
    if (readingId) return
    setReadingId(preset.id)
    setError('')
    try {
      const doc = await call('engine-presets-read', { id: preset.id })
      if (mounted.current) {
        const display = presetDisplayCopy(preset)
        setViewed({ id: preset.id, title: display.name, content: doc?.content ?? '' })
      }
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setReadingId('')
    }
  }

  const startCreator = async () => {
    if (creating || readOnly || !onStartPresetCreator) return
    setCreating(true)
    setError('')
    try {
      await onStartPresetCreator()
      close?.()
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setCreating(false)
    }
  }

  if (loading && !data) {
    return h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))
  }
  if (data && data.available === false) {
    return h('div', { className: 'dsb-engine-empty' }, t('Agent presets are not available on this host.'))
  }

  const presets = data?.presets ?? []
  const builtIn = presets.filter(isBuiltInPreset)
  const custom = presets.filter(preset => !isBuiltInPreset(preset))
  const canCreate = !readOnly && typeof onStartPresetCreator === 'function' && presets.some(preset => preset.id === 'cordis' && !preset.broken)

  const renderCard = (preset) => {
    const display = presetDisplayCopy(preset)
    const broken = Boolean(preset.broken)
    const canSelect = !preset.isDefault && !broken && !readOnly && Boolean(data?.writable)
    return h('li', {
      key: preset.id,
      className: 'dsb-preset-card',
      'data-preset-id': preset.id,
      'data-active': preset.isDefault ? '' : undefined,
      'data-broken': broken ? '' : undefined,
      'data-selectable': canSelect ? '' : undefined,
      onClick: canSelect ? () => { void selectDefault(preset.id) } : undefined,
    },
    h('div', { className: 'dsb-preset-body' },
      h('div', { className: 'dsb-preset-head' },
        h('div', { className: 'dsb-preset-identity' },
          h('span', { className: 'dsb-preset-name' }, display.name),
          broken ? h('span', { className: 'dsb-preset-badge is-broken' }, t('Failed to load')) : null)),
      h('p', { className: 'dsb-preset-desc' }, display.description),
      broken ? h('p', { className: 'dsb-preset-err', role: 'alert' }, preset.broken) : null),
    h('div', { className: 'dsb-preset-foot' },
      preset.isDefault
        ? h('span', { className: 'dsb-preset-state' }, h(CheckIcon), t('New task default'))
        : broken
          ? h('span', { className: 'dsb-preset-state' }, t('Failed to load'))
          : canSelect
            ? h('button', {
              type: 'button',
              className: 'dsb-preset-state dsb-preset-state-btn',
              'aria-pressed': false,
              onClick: (event) => {
                event.stopPropagation()
                void selectDefault(preset.id)
              },
            }, t('Set as new task default'))
            : h('span', { className: 'dsb-preset-state' }),
      h('button', {
        type: 'button',
        className: 'bt-mini dsb-preset-view',
        disabled: Boolean(readingId),
        onClick: (event) => {
          event.stopPropagation()
          void openConfig(preset)
        },
      }, h(CodeIcon), readingId === preset.id ? t('Loading…') : t('View configuration'))))
  }

  return h('div', { className: 'dsb-engine-page dsb-presets', 'data-engine-section': 'agent-presets' },
    h(StatusAlert, { error }),
    presets.length === 0
      ? h('div', { className: 'dsb-engine-empty' }, t('No agent presets found.'))
      : h(Fragment, null,
        builtIn.length > 0 ? h('section', { className: 'dsb-preset-group' },
          h('h3', { className: 'dsb-preset-group-title' }, t('Built-in')),
          h('ul', { className: 'dsb-preset-grid' }, builtIn.map(renderCard))) : null,
        (custom.length > 0 || canCreate) ? h('section', { className: 'dsb-preset-group' },
          h('h3', { className: 'dsb-preset-group-title' }, t('Custom')),
          custom.length > 0 ? h('ul', { className: 'dsb-preset-grid' }, custom.map(renderCard)) : null,
          canCreate ? h('button', {
            type: 'button',
            className: 'dsb-preset-creator',
            disabled: creating,
            onClick: () => { void startCreator() },
          }, h(PlusIcon), creating ? t('Loading…') : t('Let the agent help me create a preset')) : null) : null),
    viewed ? h(PresetConfigModal, { doc: viewed, onClose: () => setViewed(null) }) : null)
}

function shortFolderName(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export function ArchivedSessionsPage({ readOnly = false, onRestoredSession }) {
  const [sessions, setSessions] = useState(() => archivedCache)
  const [loading, setLoading] = useState(() => archivedCache === null)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    if (archivedCache === null) setLoading(true)
    setError('')
    try {
      const next = await call('engine-archived-list')
      archivedCache = next?.sessions ?? []
      if (mounted.current) setSessions(archivedCache)
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const restore = async (sessionId) => {
    if (busyId || readOnly) return
    setBusyId(sessionId)
    setError('')
    try {
      await call('engine-archived-unarchive', { sessionId })
      await load()
      await onRestoredSession?.(sessionId)
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mounted.current) setBusyId('')
    }
  }

  if (loading && sessions === null) {
    return h('div', { className: 'dsb-engine-loading', role: 'status' }, t('Loading…'))
  }

  const list = sessions ?? []
  return h('div', { className: 'dsb-engine-page', 'data-engine-section': 'archived-sessions' },
    h(StatusAlert, { error }),
    list.length === 0
      ? h('div', { className: 'dsb-engine-empty' }, t('No archived sessions.'))
      : h(EngineSection, {},
        list.map(entry => h(EngineRow, {
          key: entry.id,
          label: entry.title || t('New session'),
          hint: [entry.updatedAt > 0 ? relativeShort(entry.updatedAt) : '', shortFolderName(entry.cwd)].filter(Boolean).join(' · ') || undefined,
        },
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          disabled: Boolean(busyId) || readOnly,
          onClick: () => { void restore(entry.id) },
        }, t('Restore'))))))
}

function SchemaSecretField({ field, disabled, onSave }) {
  const [text, setText] = useState('')
  const save = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSave({ op: 'set', path: field.path, value: trimmed })
    setText('')
  }
  return h('div', { className: 'dsb-engine-inline' },
    h('input', {
      className: 'bt-input dsb-engine-secret',
      type: 'password',
      autoComplete: 'off',
      disabled,
      placeholder: field.isSet ? t('Configured') : t('Not set'),
      'aria-label': field.label,
      value: text,
      onChange: event => setText(event.target.value),
      onKeyDown: event => { if (event.key === 'Enter') save() },
    }),
    text.trim() !== '' ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled, onClick: save }, t('Save')) : null,
    field.isSet ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => onSave({ op: 'unset', path: field.path }) }, t('Clear')) : null)
}

function namespaceTitle(ns) {
  const known = ENGINE_NAMESPACE_META[ns]
  if (known) return t(known.titleKey)
  return formatSegment(ns)
}

export function SessionLogGeneralItem({ readOnly = false }) {
  const [descriptor, setDescriptor] = useState(null)
  const [writable, setWritable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const savedTimer = useRef(0)

  const reload = useCallback(async () => {
    try {
      const res = await call('engine-settings-list')
      if (!mounted.current || !res?.available) return
      setWritable(Boolean(res.writable))
      const found = (res.namespaces ?? []).find(entry => entry.ns === 'session-log-deepseek')
      setDescriptor(found ?? null)
    } catch { /* host unavailable leaves item absent */ }
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => {
      mounted.current = false
      clearTimeout(savedTimer.current)
    }
  }, [reload])

  if (!descriptor) return null
  const enabled = descriptor.value?.enabled === true
  const toggle = async (next) => {
    if (busy || readOnly || !writable) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const updated = await call('engine-settings-mutate', {
        ns: 'session-log-deepseek',
        ops: [{ op: 'set', path: ['enabled'], value: next }],
        expectedRevision: descriptor.revision,
      })
      if (mounted.current) {
        setDescriptor(updated)
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => { if (mounted.current) setSaved(false) }, 2200)
      }
    } catch (failure) {
      if (mounted.current) setError(hostText(failure?.message ?? String(failure)))
      if (failure?.code === 'bot/stale') await reload()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return h('div', { className: 'dsb-session-log-wrap' },
    h('div', { className: 'bt-set-row' },
      h('div', { className: 'bt-set-copy' }, h('span', null, t('Session log upload'))),
      h('div', { className: 'bt-set-control' },
        h('div', { className: 'dsb-engine-inline' },
          saved ? h('span', { className: 'dsb-session-log-status', role: 'status' }, t('Saved')) : null,
          h(Switch, {
            label: t('Session log upload'),
            on: enabled,
            disabled: busy || readOnly || !writable,
            onChange: next => { void toggle(next) },
          })))),
    error ? h('div', { className: 'dsb-session-log-err', role: 'alert' }, error) : null)
}
