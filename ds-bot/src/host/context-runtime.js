// ContextRuntime: the single host boundary for context capabilities, window
// resolution, working-vs-log token measurement, and persisted per-part context
// generation state (epoch, partBase, cliCompactions, group boilerplate metadata).
//
// Both model-backed (DSH LLM) parts and local CLI (ACP / Codex / Claude) parts
// are read and managed through this module so parts.js, memory.js, groups.js,
// channel.js, tools.js, and local-agents/ share one source of truth.
import { linesFor } from './steward.js'
import { splitRef } from './text.js'
import { engineOf, isLocalAgentRoute } from './local-agents/engines.js'

const PREFIX_WARN_RATIO = 0.4
const DEFAULT_CACHE_MS = 0

export function capabilitiesForKind(kind) {
  const normalized = kind === 'codex' || kind === 'claude' || kind === 'acp' ? kind : 'model'
  const isLocal = normalized !== 'model'
  return {
    kind: normalized,
    isLocal,
    midTurnHook: !isLocal,
    compactionMode: !isLocal ? 'checkpoint' : normalized === 'acp' ? 'self' : 'command',
    selfCompacts: isLocal,
    canFork: !isLocal,
    canMoveToBackground: true,
    instructionChannel: normalized === 'codex' ? 'developer' : normalized === 'acp' ? 'prompt' : 'system',
    prunesToolResults: !isLocal,
    sessionCanBeLost: isLocal,
  }
}

export function install(rt) {
  if (rt.contextRuntime !== undefined) return rt.contextRuntime
  const { ctx, config = {}, state } = rt

  const store = () => {
    if (state === undefined) return {}
    if (state.contextParts === null || typeof state.contextParts !== 'object' || Array.isArray(state.contextParts)) {
      state.contextParts = {}
    }
    return state.contextParts
  }

  const readOnly = () => rt.readOnly?.() !== undefined
  const saveSoon = () => {
    if (readOnly()) return
    void rt.save?.().catch(() => {})
  }

  const windowCache = new Map()
  const prefixWarned = new Set()

  const sessionIdOf = (target) => {
    if (typeof target === 'string') return target || undefined
    if (target === null || target === undefined) return undefined
    if (typeof target.sessionId === 'string' && target.sessionId !== '') return target.sessionId
    if (typeof target.session?.id === 'string' && target.session.id !== '') return target.session.id
    if (typeof target.id === 'string' && target.id !== '') return target.id
    return undefined
  }

  const routeFromSession = (session) => {
    const cfg = session?.requestHeader?.()?.config
    return cfg?.provider ? cfg : undefined
  }

  const providerOf = (target, explicitRoute) => {
    if (explicitRoute?.provider) return explicitRoute.provider
    if (target !== null && typeof target === 'object') {
      if (typeof target.provider === 'string' && target.provider !== '') return target.provider
      const fromHeader = target.session?.requestHeader?.()?.config?.provider ?? target.requestHeader?.()?.config?.provider
      if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
      if (target.route?.provider) return target.route.provider
      if (target.bot !== undefined) {
        const ref = target.bot.model ?? target.bot.appliedModel
        const parsed = splitRef(ref)
        if (parsed?.provider) return parsed.provider
      }
    }
    const sid = sessionIdOf(target)
    if (sid !== undefined) {
      const bot = rt.botOf?.(rt.selfOf?.(sid))
      const ref = bot?.model ?? bot?.appliedModel
      const parsed = splitRef(ref)
      if (parsed?.provider) return parsed.provider
    }
    return undefined
  }

  const isLocalProvider = (provider) => {
    if (typeof provider !== 'string' || provider === '') return false
    return rt.isLocalAgentRoute?.(provider) === true || isLocalAgentRoute(provider)
  }

  function capabilitiesFor(target, route) {
    const provider = providerOf(target, route)
    if (provider !== undefined && isLocalProvider(provider)) {
      const spec = engineOf(provider, state?.localAgents?.custom)
      const base = capabilitiesForKind(spec?.kind ?? 'acp')
      return { ...base, canFork: rt.localAgentSupportsFork?.(provider) === true }
    }
    if (provider === undefined) {
      const sid = sessionIdOf(target)
      if (sid !== undefined && rt.isLocalAgentSession?.(sid) === true) {
        const bot = rt.botOf?.(rt.selfOf?.(sid))
        const ref = rt.localAgentOf?.(bot) ?? bot?.model ?? bot?.appliedModel
        const parsed = splitRef(ref)
        const spec = parsed?.provider ? engineOf(parsed.provider, state?.localAgents?.custom) : undefined
        const base = capabilitiesForKind(spec?.kind ?? 'acp')
        return { ...base, canFork: parsed?.provider ? rt.localAgentSupportsFork?.(parsed.provider) === true : false }
      }
    }
    return capabilitiesForKind('model')
  }

  const isLocal = (target, route) => capabilitiesFor(target, route).isLocal

  async function resolveRoute(target, explicitRoute) {
    if (explicitRoute?.provider && explicitRoute?.model) return explicitRoute
    if (target !== null && typeof target === 'object') {
      const fromSession = routeFromSession(target.session ?? target)
      if (fromSession?.provider && fromSession?.model) return fromSession
      if (target.route?.provider && target.route?.model) return target.route
      if (target.bot !== undefined) {
        const desired = await rt.desiredModel?.(target.bot).catch(() => undefined)
        const parsed = splitRef(desired ?? target.bot.model ?? target.bot.appliedModel)
        if (parsed?.provider && parsed?.model) return parsed
      }
    }
    const sid = sessionIdOf(target)
    if (sid !== undefined) {
      const bot = rt.botOf?.(rt.selfOf?.(sid))
      if (bot !== undefined) {
        const desired = await rt.desiredModel?.(bot).catch(() => undefined)
        const parsed = splitRef(desired ?? bot.model ?? bot.appliedModel)
        if (parsed?.provider && parsed?.model) return parsed
      }
    }
    return undefined
  }

  async function resolveModelInfoCached(provider, model, { cacheMs = DEFAULT_CACHE_MS } = {}) {
    if (typeof ctx?.llm?.resolveModelInfo !== 'function') return undefined
    const key = `${provider}/${model}`
    if (cacheMs > 0) {
      const hit = windowCache.get(key)
      if (hit !== undefined && Date.now() - hit.at < cacheMs) return hit.info
    }
    const info = await ctx.llm.resolveModelInfo(provider, model).catch(() => undefined)
    if (cacheMs > 0) windowCache.set(key, { at: Date.now(), info })
    return info
  }

  // Canonical window resolution across parts.js, memory.js, and channel.js.
  // Explicitly distinguishes CLI-reported windows, model-declared windows, and
  // unknown windows (source: 'default'), without ever letting a stale local
  // CLI context override a served API model route.
  async function resolveWindow(target, { route: explicitRoute, info: explicitInfo, cacheMs = DEFAULT_CACHE_MS } = {}) {
    const sid = sessionIdOf(target)
    const route = await resolveRoute(target, explicitRoute)
    if (!route?.provider || !route?.model) return undefined
    const local = isLocalProvider(route.provider)
    if (local) {
      const localContext = sid === undefined ? undefined : rt.localAgentContext?.(sid)
      const reported = Number.isFinite(localContext?.size) && localContext.size > 0 ? localContext.size : undefined
      if (reported !== undefined) {
        return { window: reported, reserve: 0, source: 'cli-reported', reported: true, localContext }
      }
      const info = explicitInfo ?? await resolveModelInfoCached(route.provider, route.model, { cacheMs })
      const declared = info?.context?.contextWindow
      if (Number.isInteger(declared) && declared > 0) {
        return { window: declared, reserve: 0, source: 'model-declared', reported: false, localContext }
      }
      return { window: undefined, reserve: 0, source: 'default', reported: false, localContext }
    }
    const info = explicitInfo ?? await resolveModelInfoCached(route.provider, route.model, { cacheMs })
    const declared = info?.context?.contextWindow
    const reserve = route.maxTokens ?? info?.defaultMaxTokens
    const validReserve = Number.isInteger(reserve) && reserve > 0 ? reserve : 0
    if (Number.isInteger(declared) && declared > 0) {
      return { window: declared, reserve: validReserve, source: 'model-declared', reported: false }
    }
    return { window: undefined, reserve: validReserve, source: 'default', reported: false }
  }

  async function linesForSession(session, { route, info, checkRatio = config.checkRatio, checkTokens = config.checkTokens, cacheMs = DEFAULT_CACHE_MS } = {}) {
    const resolved = await resolveWindow(session, { route, info, cacheMs })
    if (resolved === undefined) return undefined
    const lines = linesFor({
      window: resolved.window,
      reserve: resolved.reserve,
      checkRatio,
      checkTokens,
    })
    return { ...lines, source: resolved.source, reported: resolved.reported, localContext: resolved.localContext }
  }

  // Separates working-context tokens (what the active model/CLI actually holds)
  // from DSH persistent log tokens (what read_own_chat archives).
  function measure(session, { logTokens, route } = {}) {
    const sid = sessionIdOf(session)
    const caps = capabilitiesFor(session, route)
    const log = logTokens !== undefined ? logTokens : (session && typeof session === 'object' ? rt.sessionTokens?.(session) : undefined)
    if (caps.isLocal) {
      const localContext = sid === undefined ? undefined : rt.localAgentContext?.(sid)
      return {
        kind: caps.kind,
        isLocal: true,
        workingTokens: localContext?.used,
        logTokens: log,
        stale: localContext?.stale === true,
        reportedWindow: localContext?.size,
        compactions: localContext?.compactions ?? 0,
        epoch: epochOf(sid),
      }
    }
    return {
      kind: 'model',
      isLocal: false,
      workingTokens: log,
      logTokens: log,
      stale: false,
      reportedWindow: undefined,
      compactions: undefined,
      epoch: epochOf(sid),
    }
  }

  function checkPrefixShare(sessionId, { prefixTokens, usable } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    if (!Number.isFinite(prefixTokens) || prefixTokens <= 0 || !Number.isFinite(usable) || usable <= 0) return undefined
    const share = prefixTokens / usable
    if (share >= PREFIX_WARN_RATIO && !prefixWarned.has(sessionId)) {
      prefixWarned.add(sessionId)
      rt.warn?.(
        'ds-bot: fixed prefix for %s uses %d%% of the usable context window (%d / %d tokens)',
        sessionId,
        Math.round(share * 100),
        Math.round(prefixTokens),
        Math.round(usable),
      )
    }
    return share
  }

  // ---------------------------------------------------------------------------
  // Persisted per-part context generation state (`state.contextParts`).

  const entryOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const table = store()
    return Object.hasOwn(table, sessionId) ? table[sessionId] : undefined
  }

  const ensureEntry = (sessionId) => {
    const table = store()
    if (!Object.hasOwn(table, sessionId) || table[sessionId] === null || typeof table[sessionId] !== 'object') {
      table[sessionId] = { epoch: 0 }
    }
    return table[sessionId]
  }

  const epochOf = (sessionId) => {
    const raw = entryOf(sessionId)?.epoch
    return Number.isInteger(raw) && raw >= 0 ? raw : 0
  }

  function bumpEpoch(sessionId, reason) {
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    const entry = ensureEntry(sessionId)
    const next = (Number.isInteger(entry.epoch) && entry.epoch >= 0 ? entry.epoch : 0) + 1
    entry.epoch = next
    if (typeof reason === 'string' && reason !== '') entry.lastBumpReason = reason
    delete entry.groupMeta
    saveSoon()
    return next
  }

  const partBaseOf = (sessionId) => {
    const raw = entryOf(sessionId)?.partBase
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }

  function setPartBase(sessionId, value) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Number.isFinite(value)) return
    const entry = ensureEntry(sessionId)
    if (entry.partBase === value) return
    entry.partBase = value
    saveSoon()
  }

  function lowerPartBase(sessionId, tokens) {
    if (!Number.isFinite(tokens)) return
    const current = partBaseOf(sessionId)
    if (current !== undefined && tokens < current) setPartBase(sessionId, tokens)
  }

  const cliCompactionsOf = (sessionId) => {
    const raw = entryOf(sessionId)?.cliCompactions
    return Number.isInteger(raw) && raw >= 0 ? raw : 0
  }

  function setCliCompactions(sessionId, count) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Number.isInteger(count) || count < 0) return
    if (cliCompactionsOf(sessionId) === count) return
    const entry = ensureEntry(sessionId)
    entry.cliCompactions = count
    saveSoon()
  }

  const groupMetaOf = (sessionId) => {
    const meta = entryOf(sessionId)?.groupMeta
    return meta && typeof meta === 'object' ? meta : undefined
  }

  function setGroupMeta(sessionId, meta, { persist = true } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '' || !meta || typeof meta !== 'object') return
    const entry = ensureEntry(sessionId)
    entry.groupMeta = meta
    if (persist) saveSoon()
  }

  function forget(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    prefixWarned.delete(sessionId)
    const table = store()
    if (Object.hasOwn(table, sessionId)) {
      delete table[sessionId]
      saveSoon()
    }
  }

  function prune(liveIds) {
    if (!(liveIds instanceof Set)) return 0
    const table = store()
    let removed = 0
    for (const sid of Object.keys(table)) {
      if (!liveIds.has(sid)) {
        delete table[sid]
        prefixWarned.delete(sid)
        removed += 1
      }
    }
    if (removed > 0) saveSoon()
    return removed
  }

  function clearWindowCache() {
    windowCache.clear()
  }

  const contextRuntime = {
    capabilitiesFor,
    capabilitiesForKind,
    isLocal,
    resolveWindow,
    linesForSession,
    measure,
    checkPrefixShare,
    epochOf,
    bumpEpoch,
    partBaseOf,
    setPartBase,
    lowerPartBase,
    cliCompactionsOf,
    setCliCompactions,
    groupMetaOf,
    setGroupMeta,
    forget,
    prune,
    clearWindowCache,
  }

  rt.contextRuntime = contextRuntime
  return contextRuntime
}
