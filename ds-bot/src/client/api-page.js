// Settings → API: local HTTP/SSE/MCP/OpenAI gateway switch, token management, and audit log.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { Switch } from './bot-settings.js'
import { dateLocale, t } from './i18n.js'

const OFF = {
  enabled: false,
  host: '127.0.0.1',
  port: 17830,
  boundPort: null,
  openaiCompat: true,
  lanExposed: false,
  status: 'off',
  baseUrl: null,
  mcpUrl: null,
  openaiUrl: null,
  tokens: [],
}

const SCOPE_ITEMS = [
  { id: 'read', label: 'read', highRisk: false },
  { id: 'message', label: 'message', highRisk: false },
  { id: 'event:ingest', label: 'event:ingest', highRisk: false },
  { id: 'memory:write', label: 'memory:write', highRisk: false },
  { id: 'approval', label: 'approval', highRisk: true },
  { id: 'team:manage', label: 'team:manage', highRisk: true },
]

function isLoopback(host) {
  const clean = String(host ?? '').trim().toLowerCase()
  return clean === '' || clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean.startsWith('127.')
}

function statusHint(api) {
  if (api.status === 'readonly') return t('Read-only window: API is served by the primary window.')
  if (api.status === 'error' && api.error) return api.error
  if (api.status === 'running' && api.baseUrl) return t('Running at {url}', { url: api.baseUrl })
  return t('Off. External apps cannot reach DS Bot.')
}

function targetSummary(token) {
  const parts = []
  if (token.targetScope === 'all_public') {
    parts.push(t('All public'))
  } else {
    const bots = token.botIds?.length ?? 0
    const rooms = token.roomIds?.length ?? 0
    if (bots > 0) parts.push(t('{count} Bots', { count: bots }))
    if (rooms > 0) parts.push(t('{count} groups', { count: rooms }))
    if (bots === 0 && rooms === 0 && !(token.privateBotIds?.length > 0)) parts.push(t('No targets'))
  }
  if (token.privateBotIds?.length > 0) {
    parts.push(t('{count} private', { count: token.privateBotIds.length }))
  }
  return parts.join(' · ')
}

function formatTime(ms) {
  if (!ms) return t('Never used')
  try {
    return new Date(ms).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(ms)
  }
}

function CopySnippetButton({ label, text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }
  return h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, copied ? t('Copied') : label)
}

export function ApiPage({ roster, actions, Section, Row }) {
  const api = roster.api ?? OFF
  const readOnly = api.status === 'readonly' || Boolean(roster.readOnly)
  const [host, setHost] = useState(api.host)
  const [port, setPort] = useState(String(api.port ?? 17830))
  const [confirmLan, setConfirmLan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // New token creation form state
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [targetScope, setTargetScope] = useState('selected')
  const [botIds, setBotIds] = useState([])
  const [roomIds, setRoomIds] = useState([])
  const [privateBotIds, setPrivateBotIds] = useState([])
  const [confirmPrivate, setConfirmPrivate] = useState(false)
  const [scopes, setScopes] = useState(['read', 'message'])
  const [confirmHighRisk, setConfirmHighRisk] = useState(false)
  const [expireDays, setExpireDays] = useState('')
  const [maxConcurrent, setMaxConcurrent] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [createdToken, setCreatedToken] = useState(null)

  // Audit log viewer state
  const [auditOpen, setAuditOpen] = useState(false)
  const [audit, setAudit] = useState({ entries: [], total: 0 })

  useEffect(() => {
    setHost(api.host)
    setPort(String(api.port ?? 17830))
    setConfirmLan(false)
  }, [api.host, api.port])

  const run = task => {
    setBusy(true)
    setError(null)
    return task.catch(failure => {
      setError(failure?.message ?? String(failure))
      return null
    }).finally(() => setBusy(false))
  }

  const loadAudit = useCallback(() => {
    void actions.apiAudit({ limit: 50 }).then(data => {
      if (data) setAudit(data)
    }).catch(() => {})
  }, [actions])

  useEffect(() => {
    if (auditOpen) loadAudit()
  }, [auditOpen, loadAudit])

  const publicBots = (roster.bots ?? []).filter(bot => bot.private !== true)
  const privateBots = (roster.bots ?? []).filter(bot => bot.private === true)
  const rooms = roster.rooms ?? []

  const needsLanConfirm = !isLoopback(host) && host.trim() !== api.host
  const bindDirty = host.trim() !== api.host || Number(port) !== api.port

  const saveBind = () => {
    if (busy || readOnly) return
    const portNum = Number(port)
    if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) {
      setError(t('Port must be a whole number from 0 to 65535'))
      return
    }
    void run(actions.apiSet({
      host: host.trim() || '127.0.0.1',
      port: portNum,
      confirmLan: !isLoopback(host) ? confirmLan : false,
    }))
  }

  const toggleItem = (list, setter, id) => {
    setter(list.includes(id) ? list.filter(x => x !== id) : [...list, id])
  }

  const hasHighRisk = scopes.includes('approval') || scopes.includes('team:manage')

  const submitToken = async () => {
    if (busy || readOnly) return
    const payload = {
      name: name.trim(),
      scopes,
      targetScope,
      botIds,
      roomIds,
      privateBotIds,
      confirmPrivate,
      confirmHighRisk,
      ...(expireDays.trim() !== '' ? { expiresAt: Date.now() + Number(expireDays) * 86_400_000 } : {}),
      ...(maxConcurrent.trim() !== '' ? { maxConcurrentRuns: Number(maxConcurrent) } : {}),
      ...(rateLimit.trim() !== '' ? { rateLimitPerMin: Number(rateLimit) } : {}),
    }
    const res = await run(actions.apiTokenCreate(payload))
    if (res?.token) {
      setCreatedToken({ token: res.token, name: res.meta?.name ?? name.trim() })
      setCreating(false)
      setName('')
      setBotIds([])
      setRoomIds([])
      setPrivateBotIds([])
      setConfirmPrivate(false)
      setScopes(['read', 'message'])
      setConfirmHighRisk(false)
      setExpireDays('')
      setMaxConcurrent('')
      setRateLimit('')
    }
  }

  const baseUrl = api.baseUrl ?? `http://${api.host}:${api.port}`
  const curlSnippet = `curl -H "Authorization: Bearer $DS_BOT_API_TOKEN" ${baseUrl}/v1/bots`
  const mcpSnippet = JSON.stringify({
    mcpServers: {
      'ds-bot': {
        command: 'ds-bot',
        args: ['mcp'],
        env: { DS_BOT_API_TOKEN: 'dsb_live_...' },
      },
    },
  }, null, 2)

  return h('div', { className: 'bt-api' },
    h(Section, { title: t('Local API server') },
      h(Row, {
        label: t('Enable local API server'),
        tour: 'api-switch',
        hint: statusHint(api),
        className: api.status === 'error' ? 'bt-phone-warn' : '',
      },
      h(Switch, {
        on: api.enabled === true,
        label: t('Enable local API server'),
        disabled: busy || readOnly,
        onChange: enabled => void run(actions.apiSet({ enabled })),
      })),
      h(Row, { label: t('OpenAI compatibility'), hint: t('Expose /compat/openai/v1/* endpoints for existing OpenAI clients.') },
        h(Switch, {
          on: api.openaiCompat !== false,
          label: t('OpenAI compatibility'),
          disabled: busy || readOnly,
          onChange: openaiCompat => void run(actions.apiSet({ openaiCompat })),
        })),
      h('div', { className: 'bt-set-row bt-api-bind' },
        h('div', { className: 'bt-api-bind-fields' },
          h('label', { className: 'bt-api-field' },
            h('span', null, t('Listen address')),
            h('input', {
              className: 'bt-input',
              value: host,
              disabled: busy || readOnly,
              placeholder: '127.0.0.1',
              spellCheck: false,
              onChange: e => { setHost(e.target.value); setConfirmLan(false) },
            })),
          h('label', { className: 'bt-api-field bt-api-port' },
            h('span', null, t('Port')),
            h('input', {
              className: 'bt-input bt-set-number',
              type: 'number',
              min: 0,
              max: 65535,
              value: port,
              disabled: busy || readOnly,
              onChange: e => setPort(e.target.value),
            }))),
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          disabled: busy || readOnly || !bindDirty || (needsLanConfirm && !confirmLan),
          onClick: saveBind,
        }, t('Save'))),
      needsLanConfirm
        ? h('label', { className: 'bt-api-warn-check' },
          h('input', { type: 'checkbox', checked: confirmLan, onChange: e => setConfirmLan(e.target.checked) }),
          h('span', null, t('I understand this binds outside 127.0.0.1 and exposes the API on the local network.')))
        : null,
      api.status === 'running' && api.baseUrl
        ? h('div', { className: 'bt-api-endpoints' },
          h('div', { className: 'bt-api-endpoint-row' },
            h('code', null, api.baseUrl),
            h(CopySnippetButton, { label: t('Copy Base URL'), text: api.baseUrl }),
            h(CopySnippetButton, { label: t('Copy MCP URL'), text: api.mcpUrl }),
            h(CopySnippetButton, { label: t('Copy curl'), text: curlSnippet }),
            h(CopySnippetButton, { label: t('Copy MCP config'), text: mcpSnippet })))
        : null),

    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,

    createdToken
      ? h('div', { className: 'bt-api-reveal', role: 'status' },
        h('div', { className: 'bt-api-reveal-head' },
          h('strong', null, t('Token created: {name}', { name: createdToken.name })),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setCreatedToken(null) }, t('Dismiss'))),
        h('p', { className: 'bt-set-hint' }, t('Copy this token now. It will not be shown again.')),
        h('div', { className: 'bt-api-reveal-code' },
          h('code', null, createdToken.token),
          h(CopySnippetButton, { label: t('Copy'), text: createdToken.token })))
      : null,

    h(Section, {
      title: t('Access tokens'),
      tour: 'api-add',
      action: !creating && !readOnly
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setCreating(true) }, t('New token'))
        : null,
    },
    creating
      ? h('div', { className: 'bt-api-form' },
        h('label', { className: 'bt-api-field' },
          h('span', null, t('Token name')),
          h('input', {
            className: 'bt-input',
            value: name,
            placeholder: t('e.g. Claude Code, CI script'),
            onChange: e => setName(e.target.value),
          })),
        h('div', { className: 'bt-api-group' },
          h('span', { className: 'bt-api-group-label' }, t('Target scope')),
          h('div', { className: 'bt-api-radios' },
            h('label', null,
              h('input', { type: 'radio', name: 'api-target', checked: targetScope === 'selected', onChange: () => setTargetScope('selected') }),
              ' ', t('Selected Bots and groups')),
            h('label', null,
              h('input', { type: 'radio', name: 'api-target', checked: targetScope === 'all_public', onChange: () => setTargetScope('all_public') }),
              ' ', t('All non-private Bots and groups')))),
        targetScope === 'selected'
          ? h('div', { className: 'bt-api-targets' },
            publicBots.length > 0
              ? h('div', { className: 'bt-api-checks' },
                h('span', { className: 'bt-set-hint' }, t('Bots')),
                h('div', { className: 'bt-api-chip-grid' }, publicBots.map(bot => h('label', { key: bot.id, className: 'bt-api-chip' },
                  h('input', { type: 'checkbox', checked: botIds.includes(bot.id), onChange: () => toggleItem(botIds, setBotIds, bot.id) }),
                  h('span', null, bot.name)))))
              : null,
            rooms.length > 0
              ? h('div', { className: 'bt-api-checks' },
                h('span', { className: 'bt-set-hint' }, t('Group chats')),
                h('div', { className: 'bt-api-chip-grid' }, rooms.map(room => h('label', { key: room.id, className: 'bt-api-chip' },
                  h('input', { type: 'checkbox', checked: roomIds.includes(room.id), onChange: () => toggleItem(roomIds, setRoomIds, room.id) }),
                  h('span', null, room.name)))))
              : null)
          : null,
        privateBots.length > 0
          ? h('div', { className: 'bt-api-private-box' },
            h('span', { className: 'bt-api-group-label' }, t('Private Bots (excluded by default)')),
            h('div', { className: 'bt-api-chip-grid' }, privateBots.map(bot => h('label', { key: bot.id, className: 'bt-api-chip' },
              h('input', { type: 'checkbox', checked: privateBotIds.includes(bot.id), onChange: () => toggleItem(privateBotIds, setPrivateBotIds, bot.id) }),
              h('span', null, bot.name)))),
            privateBotIds.length > 0
              ? h('label', { className: 'bt-api-warn-check' },
                h('input', { type: 'checkbox', checked: confirmPrivate, onChange: e => setConfirmPrivate(e.target.checked) }),
                h('span', null, t('Confirm granting this token access to selected private Bots.')))
              : null)
          : null,
        h('div', { className: 'bt-api-group' },
          h('span', { className: 'bt-api-group-label' }, t('Scopes')),
          h('div', { className: 'bt-api-chip-grid' }, SCOPE_ITEMS.map(item => h('label', {
            key: item.id,
            className: `bt-api-chip${item.highRisk ? ' bt-api-chip-warn' : ''}`,
          },
          h('input', {
            type: 'checkbox',
            checked: scopes.includes(item.id),
            onChange: () => toggleItem(scopes, setScopes, item.id),
          }),
          h('span', null, item.label)))),
          hasHighRisk
            ? h('label', { className: 'bt-api-warn-check' },
              h('input', { type: 'checkbox', checked: confirmHighRisk, onChange: e => setConfirmHighRisk(e.target.checked) }),
              h('span', null, t('Confirm granting high-risk permissions (approval or team management).')))
            : null),
        h('div', { className: 'bt-api-limits' },
          h('label', { className: 'bt-api-field' },
            h('span', null, t('Expires in days (optional)')),
            h('input', { className: 'bt-input', type: 'number', min: 1, max: 3650, value: expireDays, onChange: e => setExpireDays(e.target.value) })),
          h('label', { className: 'bt-api-field' },
            h('span', null, t('Max concurrent runs')),
            h('input', { className: 'bt-input', type: 'number', min: 1, max: 500, value: maxConcurrent, onChange: e => setMaxConcurrent(e.target.value) })),
          h('label', { className: 'bt-api-field' },
            h('span', null, t('Requests / min')),
            h('input', { className: 'bt-input', type: 'number', min: 1, max: 10000, value: rateLimit, onChange: e => setRateLimit(e.target.value) }))),
        h('div', { className: 'bt-api-form-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setCreating(false) }, t('Cancel')),
          h('button', {
            type: 'button',
            className: 'bt-primary bt-soft-sm',
            disabled: busy || name.trim() === '' || scopes.length === 0 || (privateBotIds.length > 0 && !confirmPrivate) || (hasHighRisk && !confirmHighRisk),
            onClick: () => void submitToken(),
          }, t('Create token'))))
      : null,

    (api.tokens ?? []).length === 0
      ? h(Row, { label: t('No tokens yet') })
      : api.tokens.map(token => h('div', { key: token.keyId, className: 'bt-set-row bt-api-token-row' },
        h('div', { className: 'bt-set-copy' },
          h('div', { className: 'bt-api-token-title' },
            h('span', null, token.name),
            h('code', { className: 'bt-tag' }, `${token.prefix}…`),
            token.paused ? h('span', { className: 'bt-tag' }, t('Paused')) : null),
          h('span', { className: 'bt-set-hint' },
            `${targetSummary(token)} · ${(token.scopes ?? []).join(', ')} · ${formatTime(token.lastUsedAt)}`)),
        h('div', { className: 'bt-set-control bt-api-token-actions' },
          h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm',
            disabled: busy || readOnly,
            onClick: () => void run(actions.apiTokenUpdate(token.keyId, { paused: !token.paused })),
          }, token.paused ? t('Resume') : t('Pause')),
          h('button', {
            type: 'button',
            className: 'bt-soft bt-soft-sm bt-danger',
            disabled: busy || readOnly,
            onClick: () => void run(actions.apiTokenRevoke(token.keyId)),
          }, t('Revoke')))))),

    h(Section, {
      title: t('Recent API activity'),
      action: h('div', { className: 'bt-api-audit-actions' },
        auditOpen ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: loadAudit }, t('Refresh')) : null,
        auditOpen && !readOnly && audit.entries.length > 0
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.apiAuditClear()).then(() => setAudit({ entries: [], total: 0 })) }, t('Clear'))
          : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAuditOpen(v => !v) }, auditOpen ? t('Hide') : t('Show'))),
    },
    !auditOpen
      ? h(Row, { label: t('Audit log records metadata only (never tokens or message text).') })
      : audit.entries.length === 0
        ? h(Row, { label: t('No API requests recorded yet') })
        : audit.entries.map((entry, idx) => h('div', { key: `${entry.time}-${idx}`, className: 'bt-set-row bt-api-audit-row' },
          h('div', { className: 'bt-set-copy' },
            h('span', null, `${entry.method} ${entry.path}${entry.targetName ? ` → ${entry.targetName}` : ''}`),
            h('span', { className: 'bt-set-hint' }, `${entry.tokenName ?? t('Unauthenticated')} · ${formatTime(entry.time)} · ${entry.durationMs}ms`)),
          h('span', { className: `bt-tag${entry.status >= 400 ? ' bt-api-status-err' : ''}` }, String(entry.status))))))
}
