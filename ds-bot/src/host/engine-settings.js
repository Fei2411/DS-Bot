// Computer-only engine settings & Classic Agent metadata bridge (`engine-*` endpoints).
// Keeps the desktop window talking solely to `api/bot`, never calling DSH services directly.

const MAX_OPS = 64
const MAX_PATH_DEPTH = 16
const MAX_SPEC_LENGTH = 500
const AGENT_PRESET_SETTINGS_NS = 'agent-preset-registry'
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const notFound = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const stale = message => Object.assign(new Error(message), { code: 'bot/stale' })

function plainSchema(schema) {
  if (schema !== null && (typeof schema === 'object' || typeof schema === 'function') && typeof schema.toJSON === 'function') {
    try { return schema.toJSON() } catch { /* fall through */ }
  }
  return schema ?? null
}

function namespaceView(descriptor) {
  return {
    ns: String(descriptor.ns),
    autoGenerate: descriptor.autoGenerate !== false,
    schema: plainSchema(descriptor.schema),
    value: descriptor.value ?? null,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    applies: descriptor.applies ?? 'live',
    secrets: Array.isArray(descriptor.secrets)
      ? descriptor.secrets.map(secret => ({
        path: Array.isArray(secret.path) ? secret.path.map(String) : [],
        set: Boolean(secret.set),
      }))
      : [],
    revision: Number.isInteger(descriptor.revision) ? descriptor.revision : 0,
  }
}

function validateOps(rawOps) {
  if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > MAX_OPS) {
    throw invalid('Settings mutation requires 1 to 64 operations')
  }
  return rawOps.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalid('Invalid settings operation')
    }
    const op = raw.op
    if (op !== 'set' && op !== 'unset') throw invalid(`Unsupported settings operation: ${String(op)}`)
    if (!Array.isArray(raw.path) || raw.path.length === 0 || raw.path.length > MAX_PATH_DEPTH) {
      throw invalid('Settings operation path must be a non-empty array of keys')
    }
    const path = raw.path.map((segment) => {
      if (typeof segment !== 'string' || segment === '' || segment.length > 128 || FORBIDDEN_SEGMENTS.has(segment)) {
        throw invalid('Invalid settings path segment')
      }
      return segment
    })
    if (op === 'set' && raw.value === undefined) throw invalid('Settings set operation requires a value')
    return op === 'set' ? { op: 'set', path, value: raw.value } : { op: 'unset', path }
  })
}

function validateCallbackOrigin(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('A loopback callback origin is required')
  let parsed
  try { parsed = new URL(raw) } catch { throw invalid('Invalid callback origin') }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username !== '' || parsed.password !== '') {
    throw refused('Sign-in callback must use a local loopback HTTP origin')
  }
  return parsed.origin
}

function accountClientOf(body, rt) {
  const locale = typeof body?.locale === 'string' && /^[a-z]{2,3}(-[\w-]+)?$/i.test(body.locale)
    ? body.locale
    : 'en-US'
  const offset = Number.isFinite(body?.timezoneOffsetSeconds)
    ? Math.trunc(body.timezoneOffsetSeconds)
    : -new Date().getTimezoneOffset() * 60
  const version = typeof rt.config?.version === 'string' && rt.config.version !== ''
    ? rt.config.version
    : '0.4.0'
  return { version, locale, timezoneOffsetSeconds: offset }
}

function titleFromItem(item) {
  const projected = item?.projections?.values?.title
  if (typeof projected === 'string') return projected
  if (typeof projected?.title === 'string') return projected.title
  if (typeof item?.displayTitle === 'string') return item.displayTitle
  if (typeof item?.title === 'string') return item.title
  return ''
}

function cleanBundle(bundle) {
  return {
    name: String(bundle.name ?? ''),
    official: Boolean(bundle.official),
    availability: bundle.availability ?? 'missing',
    ...(bundle.version === undefined ? {} : { version: String(bundle.version) }),
    ...(bundle.description === undefined ? {} : { description: String(bundle.description) }),
    ...(bundle.meta === undefined ? {} : { meta: bundle.meta }),
    enabled: Boolean(bundle.enabled),
    installed: Boolean(bundle.installed),
    optional: Boolean(bundle.optional),
    removable: Boolean(bundle.removable),
    updatable: Boolean(bundle.updatable),
    ...(bundle.listedByDefault === undefined ? {} : { listedByDefault: Boolean(bundle.listedByDefault) }),
    ...(bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason }),
    ...(bundle.error === undefined ? {} : { error: bundle.error }),
    rows: Array.isArray(bundle.rows)
      ? bundle.rows.map(row => ({
        rowId: String(row.rowId ?? ''),
        moduleName: String(row.moduleName ?? ''),
        ...(row.entryId === undefined ? {} : { entryId: String(row.entryId) }),
        ...(row.meta === undefined ? {} : { meta: row.meta }),
      }))
      : [],
  }
}

function cleanPlugin(plugin) {
  return {
    id: String(plugin.id ?? ''),
    moduleName: String(plugin.moduleName ?? ''),
    ...(plugin.name === undefined ? {} : { name: String(plugin.name) }),
    enabled: plugin.enabled !== false,
    status: plugin.status ?? 'active',
    ...(plugin.patchId === undefined ? {} : { patchId: String(plugin.patchId) }),
    ...(plugin.readOnlyReason === undefined ? {} : { readOnlyReason: plugin.readOnlyReason }),
    ...(plugin.meta === undefined ? {} : { meta: plugin.meta }),
    ...(plugin.error === undefined ? {} : { error: plugin.error }),
  }
}

function cleanPresetRow(row) {
  return {
    id: String(row.id ?? ''),
    isDefault: Boolean(row.isDefault),
    ...(row.name === undefined ? {} : { name: String(row.name) }),
    ...(row.description === undefined ? {} : { description: String(row.description) }),
    ...(row.broken === undefined ? {} : { broken: String(row.broken) }),
  }
}

export function install(rt) {
  const { ctx, state } = rt

  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw Object.assign(new Error(readOnly), { code: 'bot/read-only' })
  }

  async function passiveSessionMap(signal) {
    const byId = new Map()
    if (typeof ctx.sessionController?.list === 'function') {
      try {
        const listed = await ctx.sessionController.list({}, signal ?? AbortSignal.timeout(15_000))
        const items = Array.isArray(listed?.items) ? listed.items : (Array.isArray(listed) ? listed : [])
        for (const item of items) {
          const id = item?.sessionId ?? item?.id
          if (typeof id !== 'string' || id === '') continue
          byId.set(id, {
            id,
            title: titleFromItem(item),
            updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
            running: item.running === true,
            blank: item.blank === true,
            cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          })
        }
        return byId
      } catch { /* fall back to persistence list */ }
    }
    const persistence = ctx.get?.('sessionPersistence')
    if (typeof persistence?.list === 'function') {
      try {
        const snaps = await persistence.list({ signal: signal ?? AbortSignal.timeout(15_000) })
        for (const snap of snaps ?? []) {
          const id = snap?.header?.id
          if (typeof id !== 'string' || id === '') continue
          byId.set(id, {
            id,
            title: '',
            updatedAt: Number.isFinite(snap.header.createdAt) ? snap.header.createdAt : 0,
            running: false,
            blank: (snap.eventCount ?? 0) === 0,
            cwd: typeof snap.header.cwd === 'string' ? snap.header.cwd : undefined,
          })
        }
      } catch { /* best-effort metadata */ }
    }
    return byId
  }

  function workspaceIdBySession() {
    const map = new Map()
    const workspaces = typeof ctx.workspaceRegistry?.list === 'function' ? ctx.workspaceRegistry.list() : []
    for (const ws of workspaces ?? []) {
      for (const sid of ws?.sessionIds ?? []) map.set(sid, ws.id)
    }
    return map
  }

  function settingsService() {
    return ctx.get?.('settings') ?? ctx.settings
  }

  function accountService() {
    return ctx.get?.('deepseekAccount') ?? ctx.deepseekAccount
  }

  function pluginManagerService() {
    return ctx.get?.('pluginManager') ?? ctx.pluginManager
  }

  function agentPresetsService() {
    return ctx.get?.('agentPresets') ?? ctx.agentPresets
  }

  function webService() {
    return ctx.get?.('web') ?? ctx.web
  }

  function llmService() {
    return ctx.get?.('llm') ?? ctx.llm
  }

  function cleanWebProvider(provider) {
    return {
      id: String(provider?.id ?? ''),
      ...(typeof provider?.title === 'string' && provider.title !== '' ? { title: provider.title } : {}),
      ...(typeof provider?.description === 'string' && provider.description !== '' ? { description: provider.description } : {}),
    }
  }

  async function readPresetsRoster() {
    const presets = agentPresetsService()
    if (presets === undefined) return { available: false, writable: false, revision: null, presets: [] }
    const raw = typeof presets.remoteExportList === 'function'
      ? await presets.remoteExportList()
      : (typeof presets.list === 'function' ? await presets.list() : { presets: [] })
    const list = Array.isArray(raw?.presets) ? raw.presets.map(cleanPresetRow) : []
    const settings = settingsService()
    let revision = null
    let writable = false
    if (settings !== undefined) {
      writable = Boolean(settings.writable)
      const descriptor = settings.describe({ redactSecrets: true }).find(entry => String(entry.ns) === AGENT_PRESET_SETTINGS_NS)
      if (descriptor && Number.isInteger(descriptor.revision)) revision = descriptor.revision
    }
    return { available: true, writable, revision, presets: list }
  }

  rt.engineEndpoint = async (name, body = {}, signal, meta = {}) => {
    switch (name) {
      case 'settings-list': {
        const settings = settingsService()
        if (settings === undefined) return { available: false, writable: false, namespaces: [] }
        const descriptors = settings.describe({ redactSecrets: true })
        return {
          available: true,
          writable: Boolean(settings.writable),
          namespaces: Array.isArray(descriptors) ? descriptors.map(namespaceView) : [],
        }
      }
      case 'settings-mutate': {
        writeCheck()
        const settings = settingsService()
        if (settings === undefined) throw refused('Engine settings are not available on this host')
        if (!settings.writable) throw refused('Engine settings are read-only in this profile')
        const ns = typeof body.ns === 'string' ? body.ns.trim() : ''
        if (ns === '' || ns.length > 128) throw invalid('A settings namespace is required')
        const ops = validateOps(body.ops)
        const expectedRevision = body.expectedRevision === undefined || body.expectedRevision === null
          ? undefined
          : body.expectedRevision
        if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
          throw invalid('expectedRevision must be a non-negative integer')
        }
        try {
          await settings.mutate(ns, ops, expectedRevision)
        } catch (error) {
          if (error?.code === 'SETTINGS_CONFLICT') {
            throw stale(error.message || 'Settings changed elsewhere; reload and try again')
          }
          throw error
        }
        const updated = settings.describe({ redactSecrets: true }).find(entry => String(entry.ns) === ns)
        if (updated === undefined) throw notFound(`Settings namespace "${ns}" is no longer available`)
        return namespaceView(updated)
      }
      case 'account-state': {
        const account = accountService()
        if (account === undefined) return { available: false, view: null, profile: null, balance: null }
        const view = await account.getState()
        let profile = null
        let balance = null
        if (view?.status === 'credential-stored' && body.details !== false) {
          const client = accountClientOf(body, rt)
          const [prof, bal] = await Promise.all([
            typeof account.getProfile === 'function' ? account.getProfile(client).catch(() => ({ status: 'failed' })) : null,
            typeof account.getBalance === 'function' ? account.getBalance(client).catch(() => ({ status: 'failed' })) : null,
          ])
          profile = prof
          balance = bal
        }
        return { available: true, view, profile, balance }
      }
      case 'account-signin': {
        writeCheck()
        const account = accountService()
        if (account === undefined) throw refused('DeepSeek account is not available on this host')
        const rawOrigin = body.callbackOrigin !== undefined && body.callbackOrigin !== null && body.callbackOrigin !== ''
          ? body.callbackOrigin
          : meta?.requestOrigin
        const callbackOrigin = validateCallbackOrigin(rawOrigin)
        const loginSource = body.loginSource === 'web' ? 'web' : 'desktop'
        const view = await account.startSignIn(accountClientOf(body, rt), callbackOrigin, loginSource)
        return { available: true, view }
      }
      case 'account-cancel': {
        writeCheck()
        const account = accountService()
        if (account === undefined) throw refused('DeepSeek account is not available on this host')
        const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : ''
        if (attemptId === '') throw invalid('An attempt id is required')
        const view = await account.cancelSignIn(attemptId)
        return { available: true, view }
      }
      case 'account-signout': {
        writeCheck()
        const account = accountService()
        if (account === undefined) throw refused('DeepSeek account is not available on this host')
        const view = await account.signOut(accountClientOf(body, rt))
        return { available: true, view }
      }
      case 'plugins-list': {
        const pm = pluginManagerService()
        if (pm === undefined) return { available: false, bundles: [], plugins: [] }
        const [bundles, plugins] = await Promise.all([
          typeof pm.listBundles === 'function' ? pm.listBundles() : [],
          typeof pm.listPlugins === 'function' ? pm.listPlugins() : [],
        ])
        return {
          available: true,
          bundles: Array.isArray(bundles) ? bundles.map(cleanBundle) : [],
          plugins: Array.isArray(plugins) ? plugins.map(cleanPlugin) : [],
        }
      }
      case 'plugins-toggle-bundle': {
        writeCheck()
        const pm = pluginManagerService()
        if (pm === undefined) throw refused('Plugin manager is not available on this host')
        const bundleName = typeof body.name === 'string' ? body.name.trim() : ''
        if (bundleName === '' || typeof body.enabled !== 'boolean') throw invalid('Bundle name and enabled flag are required')
        return await pm.setBundleEnabled(bundleName, body.enabled)
      }
      case 'plugins-toggle-plugin': {
        writeCheck()
        const pm = pluginManagerService()
        if (pm === undefined) throw refused('Plugin manager is not available on this host')
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id === '' || typeof body.enabled !== 'boolean') throw invalid('Plugin id and enabled flag are required')
        return await pm.setPluginEnabled(id, body.enabled)
      }
      case 'plugins-install': {
        writeCheck()
        const pm = pluginManagerService()
        if (pm === undefined) throw refused('Plugin manager is not available on this host')
        const spec = typeof body.spec === 'string' ? body.spec.trim() : ''
        // eslint-disable-next-line no-control-regex
        if (spec === '' || spec.length > MAX_SPEC_LENGTH || /[\x00-\x1f\x7f]/.test(spec)) {
          throw invalid('A valid plugin package spec is required')
        }
        return await pm.installBundle(spec, { enabled: body.enabled !== false })
      }
      case 'plugins-remove': {
        writeCheck()
        const pm = pluginManagerService()
        if (pm === undefined) throw refused('Plugin manager is not available on this host')
        const bundleName = typeof body.name === 'string' ? body.name.trim() : ''
        if (bundleName === '') throw invalid('Bundle name is required')
        return await pm.removeBundle(bundleName)
      }
      case 'presets-list':
        return await readPresetsRoster()
      case 'presets-read': {
        const presets = agentPresetsService()
        if (presets === undefined || typeof presets.readDocument !== 'function') {
          throw refused('Agent presets are not available on this host')
        }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id === '' || id.length > 128) throw invalid('A preset id is required')
        try {
          const doc = await presets.readDocument(id)
          return {
            id: String(doc?.agentPreset ?? id),
            content: typeof doc?.content === 'string' ? doc.content : '',
            ...(typeof doc?.name === 'string' && doc.name !== '' ? { name: doc.name } : {}),
            ...(typeof doc?.description === 'string' && doc.description !== '' ? { description: doc.description } : {}),
          }
        } catch (error) {
          if (error?.code === 'agent-preset/not-found') {
            throw notFound(error.message || `Unknown agent preset "${id}"`)
          }
          throw error
        }
      }
      case 'presets-default': {
        writeCheck()
        const settings = settingsService()
        const presets = agentPresetsService()
        if (settings === undefined || presets === undefined) {
          throw refused('Agent presets cannot be updated on this host')
        }
        if (!settings.writable) throw refused('Engine settings are read-only in this profile')
        const target = body.id === null ? null : (typeof body.id === 'string' ? body.id.trim() : '')
        if (target === '') throw invalid('A preset id or null is required')
        let current = null
        if (target !== null) {
          current = await readPresetsRoster()
          const match = current.presets.find(entry => entry.id === target)
          if (match === undefined) throw notFound(`Unknown agent preset "${target}"`)
          if (match.broken !== undefined) throw refused(`Agent preset "${target}" cannot be selected: ${match.broken}`)
        }
        const expectedRevision = Number.isInteger(body.expectedRevision) ? body.expectedRevision : undefined
        const ops = target === null
          ? [{ op: 'unset', path: ['selectedDefault'] }]
          : [{ op: 'set', path: ['selectedDefault'], value: target }]
        try {
          await settings.mutate(AGENT_PRESET_SETTINGS_NS, ops, expectedRevision)
        } catch (error) {
          if (error?.code === 'SETTINGS_CONFLICT') {
            throw stale(error.message || 'Preset settings changed elsewhere; reload and try again')
          }
          throw error
        }
        if (current !== null) {
          const descriptor = settings.describe({ redactSecrets: true }).find(entry => String(entry.ns) === AGENT_PRESET_SETTINGS_NS)
          const revision = descriptor && Number.isInteger(descriptor.revision) ? descriptor.revision : current.revision
          return {
            available: true,
            writable: Boolean(settings.writable),
            revision,
            presets: current.presets.map(entry => ({ ...entry, isDefault: entry.id === target })),
          }
        }
        return await readPresetsRoster()
      }
      case 'archived-list': {
        await rt.load()
        const ids = Array.isArray(ctx.workspaceRegistry?.archivedSessionIds)
          ? [...ctx.workspaceRegistry.archivedSessionIds]
          : []
        const ownedByTeam = id => (typeof rt.isTeamSession === 'function'
          ? rt.isTeamSession(id)
          : rt.selfOf?.(id) !== undefined
            || rt.botOf?.(id) !== undefined
            || rt.roomOf?.(id) !== undefined
            || rt.pastOwners?.has?.(id) === true)
        const restorableIds = ids.reverse().filter(id => !ownedByTeam(id))
        const byId = restorableIds.length > 0 ? await passiveSessionMap(signal) : new Map()
        const sessions = restorableIds.map((id) => {
          const meta = byId.get(id)
          return {
            id,
            title: meta?.title || '',
            updatedAt: meta?.updatedAt ?? 0,
            kind: 'classic',
            ...(meta?.cwd ? { cwd: meta.cwd } : {}),
          }
        })
        return { sessions }
      }
      case 'archived-unarchive': {
        writeCheck()
        await rt.load()
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '') throw invalid('A session id is required')
        const archived = Array.isArray(ctx.workspaceRegistry?.archivedSessionIds)
          ? ctx.workspaceRegistry.archivedSessionIds
          : []
        if (!archived.includes(sessionId)) throw notFound('This session is not archived')
        const ownedByTeam = typeof rt.isTeamSession === 'function'
          ? rt.isTeamSession(sessionId)
          : rt.selfOf?.(sessionId) !== undefined
            || rt.botOf?.(sessionId) !== undefined
            || rt.roomOf?.(sessionId) !== undefined
            || rt.pastOwners?.has?.(sessionId) === true
        if (ownedByTeam) throw refused('Bot and group conversation segments cannot be restored into Classic mode')
        await ctx.workspaceRegistry.unarchiveSession(sessionId)
        let adoptedAgentId = null
        const ownedByAgent = rt.agentOf?.(sessionId) !== undefined
        if (!ownedByAgent && body.adopt !== false) {
          const agent = Object.values(state.agents ?? {})[0]
          if (agent !== undefined && typeof rt.adoptAgentSession === 'function') {
            try {
              await rt.adoptAgentSession(agent.id, sessionId)
              adoptedAgentId = agent.id
            } catch { /* keep unarchived even if adoption declines */ }
          }
        }
        return { sessionId, restored: true, ...(adoptedAgentId ? { adoptedAgentId } : {}) }
      }
      case 'web-providers': {
        const web = webService()
        if (web === undefined || typeof web.listProviders !== 'function') {
          return { available: false, search: [], fetch: [] }
        }
        const raw = await web.listProviders()
        return {
          available: true,
          search: Array.isArray(raw?.search) ? raw.search.map(cleanWebProvider).filter(p => p.id !== '') : [],
          fetch: Array.isArray(raw?.fetch) ? raw.fetch.map(cleanWebProvider).filter(p => p.id !== '') : [],
        }
      }
      case 'model-catalog': {
        const llm = llmService()
        if (llm !== undefined && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
          const providers = llm.listProviders() ?? []
          let partial = false
          const groups = []
          for (const provider of providers) {
            if (!provider?.id) continue
            try {
              const rawModels = await llm.listModels(provider.id)
              const models = Array.isArray(rawModels)
                ? rawModels
                  .filter(model => typeof model?.id === 'string' && model.id !== '')
                  .map(model => ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }))
                : []
              if (models.length > 0) {
                groups.push({
                  id: String(provider.id),
                  name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : String(provider.id),
                  models,
                })
              }
            } catch {
              partial = true
            }
          }
          return { available: true, partial, groups }
        }
        const cached = typeof rt.cachedCatalog === 'function' ? rt.cachedCatalog() : []
        const byProvider = new Map()
        for (const entry of cached ?? []) {
          const provider = typeof entry?.provider === 'string' ? entry.provider : ''
          const modelId = typeof entry?.id === 'string' && entry.id !== ''
            ? entry.id
            : (typeof entry?.ref === 'string' && provider && entry.ref.startsWith(`${provider}/`) ? entry.ref.slice(provider.length + 1) : '')
          if (!provider || !modelId) continue
          let group = byProvider.get(provider)
          if (!group) {
            group = { id: provider, name: String(entry.providerName ?? provider), models: [] }
            byProvider.set(provider, group)
          }
          group.models.push({ id: modelId, name: String(entry.name ?? modelId) })
        }
        return { available: byProvider.size > 0, partial: false, groups: [...byProvider.values()] }
      }
      case 'classic-sessions': {
        await rt.load()
        const agentIds = new Set()
        for (const agent of Object.values(state.agents ?? {})) {
          for (const sid of agent.sessions ?? []) agentIds.add(sid)
        }
        if (agentIds.size === 0) return { sessions: [] }
        const [byId, wsBySession] = await Promise.all([
          passiveSessionMap(signal),
          Promise.resolve(workspaceIdBySession()),
        ])
        const sessions = [...agentIds].map((id) => {
          const meta = byId.get(id)
          return {
            id,
            title: meta?.title ?? '',
            updatedAt: meta?.updatedAt ?? 0,
            running: meta?.running === true,
            blank: meta?.blank === true,
            ...(wsBySession.has(id) ? { workspaceId: wsBySession.get(id) } : {}),
          }
        })
        return { sessions }
      }
      default:
        throw notFound(`Unknown endpoint engine-${name}`)
    }
  }
}
