// The LlmAdapter that serves every local-agent route. A DS Bot Bot whose model
// is one of these routes answers through a local agent CLI instead of a model
// API: the loop, Sessions, tools and approvals are the ordinary ones; this
// adapter turns each request into a prompt for the CLI session the Session is
// mapped to, and the CLI's output back into stream chunks.
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LlmAdapter, LlmError, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, resolveImageAttachmentAccess, resolveRetryPolicy, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { isClockSource, isContextOnlyMessage, isSnapshotContextSource } from '../context-messages.js'
import { buildCompactDigest, buildReplayPack } from '../context-pack.js'
import { truncateUtf8Bytes, utf8Bytes } from '../handoff-budget.js'
import { GROUP_MEMORY_SOURCE, MEMORY_RECALL_SOURCE, MEMORY_UPDATE_SOURCE, OWN_HEADING, OWN_MEMORY_SOURCE } from '../memory-copy.js'
import { textOf } from '../text.js'
import { engineOf, cliMode, signInFor } from './engines.js'
import { PROBE_FORCE_KILL_AFTER_MS } from './discover.js'
import { LoopbackMcp } from './mcp.js'

async function cleanupProbeDir(dir) {
  if (typeof dir !== 'string' || dir === '') return
  const resolved = resolve(dir)
  if (dirname(resolved) !== resolve(tmpdir()) || !basename(resolved).startsWith('dsb-probe-')) return
  await rm(resolved, { recursive: true, force: true }).catch(() => {})
}

export const DEFAULT_CONTEXT_WINDOW = 200_000
// A window belongs to the model, not to the Session that reported it, and the model
// card reads it from resolveModel rather than from the Session's own figures.
const windowKey = (route, model) => `${route}\u0000${model}`
// The replay window when a CLI session is new or its resume failed: 12 recent user/assistant
// turns (not counting tool results or memory snapshots) within a 24 KB cap, plus a
// dedicated bounded cap for incremental memory updates.
const REPLAY_MESSAGES = 12
const REPLAY_TOTAL_MAX = 36
const REPLAY_BYTES = 24 * 1024
const REPLAY_LINE_MAX = 2_000
const MEMORY_UPDATE_REPLAY_MAX = 4
const MEMORY_UPDATE_REPLAY_BYTES = 8 * 1024
// Events that prove the CLI actually accepted and began working on the dispatched turn.
// Housekeeping notices (effort, status, context, compaction, models) can fire before
// `session/prompt` is sent or trail a finished turn and must not suppress unread rollback.
const TURN_CONFIRMING_EVENTS = new Set(['text', 'thought', 'activity', 'call', 'permission', 'usage', 'done'])

const IDLE_CLOSE_MS = 10 * 60_000
// Brief coalescing window to batch parallel MCP tools/call requests from one CLI step.
const CALL_BATCH_WINDOW_MS = 8
const MEMORY_CONTEXT_KINDS = new Set([OWN_MEMORY_SOURCE, GROUP_MEMORY_SOURCE, MEMORY_UPDATE_SOURCE, MEMORY_RECALL_SOURCE])
const toolSignature = tools => (tools ?? []).map(tool => tool.name).sort().join('\0')
// A local CLI may have already performed actions before its request fails.
const LOCAL_RETRY_POLICY = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'local-agent')
const APPROVE_TOOL = 'approve_agent_action'
// A CLI that answers its compaction command first and condenses after (Devin) says
// that it started within this long, or it is taken to have condensed without a word.
const COMPACT_START_MS = 15_000
// What a request DS Bot makes of the CLI for itself answers to a tool call it tries.
const NO_TOOLS = 'Tools are not available for this request. Answer with text only.'

// A title request never reaches the CLI.
const TITLE_ARRAY_PREFIX = 'Generate the session title from this JSON array of human messages:'
const TITLE_OBJECT_PREFIX = 'Update the session title from this JSON object:'

function firstNonEmptyLine(text) {
  return (String(text ?? '').split('\n').find(line => line.trim() !== '') ?? '').trim()
}

// DSH's session-title-llm wraps human messages in a fixed instruction line followed by
// JSON; unwrap that payload so the fallback title uses the user's message instead of
// the instruction prefix.
function extractSessionTitle(raw) {
  const trimmed = String(raw ?? '').trim()
  let jsonText
  if (trimmed.startsWith(TITLE_ARRAY_PREFIX)) jsonText = trimmed.slice(TITLE_ARRAY_PREFIX.length).trim()
  else if (trimmed.startsWith(TITLE_OBJECT_PREFIX)) jsonText = trimmed.slice(TITLE_OBJECT_PREFIX.length).trim()
  if (jsonText !== undefined) {
    try {
      const parsed = JSON.parse(jsonText)
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.messages) ? parsed.messages : undefined
      if (items !== undefined) {
        for (const item of items) {
          const line = firstNonEmptyLine(typeof item === 'string' ? item : item?.text)
          if (line !== '') return line
        }
      }
      if (typeof parsed?.currentTitle === 'string') {
        const line = firstNonEmptyLine(parsed.currentTitle)
        if (line !== '') return line
      }
    } catch { /* fall through to default */ }
    return 'Chat'
  }
  const line = firstNonEmptyLine(trimmed)
  return line === '' ? 'Chat' : line
}

function titleChunk(text) {
  const title = text.slice(0, 60)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: title },
    { type: 'block-end', index: 0, block: { type: 'text', text: title } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// A compaction request neither: a deterministic digest of the newest messages.
function digestChunks(messages) {
  const text = buildCompactDigest(messages)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// Marks the one retry of a turn whose saved Claude conversation was gone.
const RESUME_RETRIED = Symbol('resume retried')
const positiveInt = value => (Number.isSafeInteger(value) && value > 0 ? value : undefined)
const nonNegativeInt = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined)

export class LocalAgentAdapter extends LlmAdapter {
  // deps: {rt, findExecutable, spawnEngine(kind,route,engine), record(sessionId),
  //        saveRecord, dropRecord, presetFor(sessionId), toolsFor(options), signInHint(route),
  //        usedModels(route), savedWindow(route,model), saveWindow(route,model,size)}
  constructor(deps) {
    super()
    this.deps = deps
    this.engines = new Map()   // route -> engine driver
    this.live = new Map()      // sessionId -> live session
    this.modelCache = new Map()
    this.nextModelEpoch = 0
    this.globalModelEpoch = 0
    this.modelEpochs = new Map() // route -> monotonic epoch for modelCache writes
    this.closingRoutes = new Map() // route -> in-flight closeRoute promise
    this.windows = new Map()   // route\0model -> the window the CLI reported for it
    this.probes = new Map()    // route -> { epoch, promise }
    this.activeProbes = new Set() // active askModels runs, so superseding probes stay protected
    this.sideRequests = new Set()
    this.forkUnsupportedRoutes = new Set()
    this.syncingSecrets = false
    this.disposed = false
  }

  specOf(route) {
    return engineOf(route, this.deps.customAgents?.() ?? [], this.deps.profiles?.() ?? [], { home: this.deps.home ?? this.deps.rt?.home })
  }

  providerInfo(route) {
    const engine = this.specOf(route)
    return { id: route, name: engine?.name ?? route }
  }
  providerRetryPolicy() { return LOCAL_RETRY_POLICY }
  imageRequestPricing() { return undefined }

  engine(route) {
    let driver = this.engines.get(route)
    if (driver === undefined) {
      const spec = this.specOf(route)
      if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'NO_ADAPTER')
      driver = this.deps.spawnEngine(spec.kind, route, spec)
      this.engines.set(route, driver)
    }
    return driver
  }

  // What DS Bot knows of a route without starting its CLI: the CLI's default, what a
  // probe found, and what a Bot runs on. DSH and the catalog ask this for every route.
  async listModels(route) {
    const spec = this.specOf(route)
    if (spec === undefined) return []
    const supportsImage = spec.kind !== 'acp' || this.engines.get(route)?.supportsImages?.() !== false
    const inputModalities = supportsImage ? ['text', 'image'] : ['text']
    const listed = [{ provider: route, id: 'default', name: 'CLI default' }, ...(this.modelCache.get(route) ?? [])]
    const used = (this.deps.usedModels?.(route) ?? []).filter(id => !listed.some(model => model.id === id))
    return [...listed, ...used.map(id => ({ provider: route, id, name: id }))]
      .map(entry => ({ ...entry, inputModalities }))
  }

  modelEpochOf(route) {
    return Math.max(this.globalModelEpoch, this.modelEpochs.get(route) ?? 0)
  }

  bumpModelEpoch(route) {
    const next = ++this.nextModelEpoch
    this.modelEpochs.set(route, next)
    return next
  }

  recordDiscoveredModels(route, models, { epoch } = {}) {
    const current = this.modelEpochOf(route)
    if (epoch !== undefined && epoch !== current) return false
    if (epoch === undefined) {
      this.bumpModelEpoch(route)
      this.probes.delete(route)
    }
    this.modelCache.set(route, (models ?? []).filter(model => model.id !== 'default')
      .map(model => ({ provider: route, id: model.id, name: model.name ?? model.id, ...(model.reasoning ? { reasoning: model.reasoning } : {}) })))
    return true
  }

  // Asks one CLI what it serves, once. A failure is not kept, so the next look tries
  // again. The process it took leaves unless a Session runs on it.
  async probeModels(route) {
    if (this.modelCache.has(route)) return this.listModels(route)
    if (this.specOf(route) === undefined) return []
    const epoch = this.modelEpochOf(route)
    let entry = this.probes.get(route)
    if (entry === undefined || entry.epoch !== epoch) {
      entry = { epoch, promise: undefined }
      entry.promise = this.askModels(route, epoch).finally(() => {
        if (this.probes.get(route) === entry) this.probes.delete(route)
      })
      this.probes.set(route, entry)
    }
    await entry.promise
    while (this.probes.get(route) !== undefined && this.probes.get(route) !== entry) {
      entry = this.probes.get(route)
      await entry.promise
    }
    return this.listModels(route)
  }

  async askModels(route, epoch = this.modelEpochOf(route)) {
    const engine = this.engine(route)
    const token = { route, engine, epoch }
    const cwd = this.deps.probeCwd()
    this.activeProbes.add(token)
    try {
      const models = await engine.listModels({ cwd, mcp: undefined })
      this.recordDiscoveredModels(route, models, { epoch })
    } catch { /* the menu still has the CLI's default */ } finally {
      this.activeProbes.delete(token)
      if (!this.engineInUse(engine, token)) await engine.close?.({ forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS }).catch(() => {})
      await cleanupProbeDir(cwd)
    }
  }

  dropModelCache(route) {
    if (route === undefined) {
      this.globalModelEpoch = ++this.nextModelEpoch
      this.modelCache.clear()
      this.probes.clear()
      for (const engine of this.engines.values()) engine.invalidateListed?.()
    } else {
      this.bumpModelEpoch(route)
      this.modelCache.delete(route)
      this.probes.delete(route)
      this.engines.get(route)?.invalidateListed?.()
    }
  }

  dropWindows(route) {
    if (route === undefined) {
      this.windows.clear()
      return
    }
    const prefix = `${route}\u0000`
    for (const key of this.windows.keys()) {
      if (key.startsWith(prefix)) this.windows.delete(key)
    }
  }

  // The window a CLI last reported for this (route, model), hydrated across restarts
  // so model cards and request/context do not fall back to 200K after restart (#1896).
  windowOf(route, model) {
    const key = windowKey(route, model)
    const cached = this.windows.get(key)
    if (cached !== undefined) return cached
    const saved = positiveInt(this.deps.savedWindow?.(route, model))
    if (saved !== undefined) this.windows.set(key, saved)
    return saved
  }

  async resolveModel(route, model) {
    const spec = this.specOf(route)
    const listed = (await this.listModels(route).catch(() => [])).find(entry => entry.id === model)
    const supportsImage = spec?.kind !== 'acp' || this.engines.get(route)?.supportsImages?.() !== false
    return {
      provider: route,
      id: model,
      name: listed?.name ?? model,
      inputModalities: supportsImage ? ['text', 'image'] : ['text'],
      context: { contextWindow: positiveInt(spec?.contextWindow) ?? this.windowOf(route, model) ?? DEFAULT_CONTEXT_WINDOW },
      // The thinking levels the engine advertises for this model, if any.
      ...(listed?.reasoning ? { reasoning: listed.reasoning } : {}),
    }
  }

  // Tears down a route's engine and live sessions (e.g. after a profile's configDir
  // or env changes, or when a profile is removed) so subsequent turns spawn fresh.
  // Any session with an in-flight turn or waiting reader fails explicitly so an
  // interrupted reply is never reported as completed and unread markers roll back.
  async closeRoute(route, reason = 'the local agent configuration changed', { code = 'LOCAL_AGENT_EXIT' } = {}) {
    const prev = this.closingRoutes.get(route)
    const run = (async () => {
      if (prev !== undefined) await prev.catch(() => {})
      this.dropModelCache(route)
      this.dropWindows(route)
      const matching = [...this.live.values()].filter(live => live.route === route)
      for (const live of matching) {
        const active = !live.started || live.state !== 'idle' || live.waiters.length > 0 || live.pending.size > 0 || live.queue.length > 0
        const error = active
          ? new LlmError(`${live.spec.name} stopped: ${reason}.`, code)
          : undefined
        if (error === undefined) this.stopTurn(live, reason)
        await this.closeLive(live, { idle: true, error }).catch(() => {})
      }
      const engine = this.engines.get(route)
      if (engine !== undefined) {
        this.engines.delete(route)
        await engine.close?.().catch(() => {})
      }
    })()
    this.closingRoutes.set(route, run)
    try {
      await run
    } finally {
      if (this.closingRoutes.get(route) === run) this.closingRoutes.delete(route)
    }
  }

  // ---------------------------------------------------------------------------
  // The live bridge for one DS Bot Session.
  async liveFor(options, preset) {
    const sessionId = String(options.sessionId)
    const route = options.provider
    let spec = this.specOf(route)
    if (spec === undefined) {
      const existing = this.live.get(sessionId)
      if (existing !== undefined) await this.closeLive(existing)
      throw new LlmError(`Unknown local agent ${route}`, 'LOCAL_AGENT_MISSING')
    }
    if (spec.kind === 'codex' && this.deps.prepareSecretEnvForSession !== undefined) {
      await this.deps.prepareSecretEnvForSession(sessionId, options.signal)
      options.signal?.throwIfAborted()
    }
    const closing = this.closingRoutes.get(route)
    if (closing !== undefined) {
      await closing.catch(() => {})
      options.signal?.throwIfAborted()
    }
    spec = this.specOf(route)
    if (spec === undefined) {
      const existing = this.live.get(sessionId)
      if (existing !== undefined) await this.closeLive(existing)
      throw new LlmError(`Unknown local agent ${route}`, 'LOCAL_AGENT_MISSING')
    }
    const resolveSecrets = () => spec.kind === 'codex' ? this.deps.secretEnvForSession?.(sessionId) ?? {} : {}
    let live = this.live.get(sessionId)
    let orphanedPending
    let carriedContext
    if (live !== undefined && !live.dead && live.route === route) {
      // An agent CLI can exit between the spawn and its first message (a failed
      // sign-in, for one): the cached bridge is dead, so the next call starts a
      // new process instead of writing into the one that is gone.
      if (live.engineSession?.dead === true) {
        this.rollbackUnread(live, sessionId)
        live.engineSession = undefined
        live.pumpToken = {}
        // The queue belongs to the process that is gone: the retry starts clean
        // instead of reading its exit as the new turn's failure.
        live.events.length = 0
      }
      // A CLI takes its model and permission mode when its session opens. A
      // changed secret set also requires replacing the Codex process, even mid-turn.
      if (isDeepStrictEqual(live.secrets, resolveSecrets()) && isDeepStrictEqual(live.spec?.env ?? {}, spec.env ?? {})) {
        if ((live.model === options.model && live.preset === preset) || live.state !== 'idle') return live
      } else {
        if (live.pending.size > 0 || live.orphanedPending?.size > 0) {
          orphanedPending = new Map([
            ...(live.orphanedPending?.entries() ?? []),
            ...[...live.pending.entries()].map(([id, entry]) => [id, { name: entry.name }]),
          ])
        }
        if (Array.isArray(live.pendingContext) && live.pendingContext.length > 0) {
          carriedContext = live.pendingContext.map(entry => ({ ...entry }))
        }
        if (live.state !== 'idle') {
          await Promise.resolve(this.stopTurn(live, 'secret access changed for this conversation')).catch(() => {})
        }
      }
      await this.closeLive(live, { idle: true })
    } else if (live !== undefined) await this.closeLive(live)
    const closingBeforeSpawn = this.closingRoutes.get(route)
    if (closingBeforeSpawn !== undefined) {
      await closingBeforeSpawn.catch(() => {})
      options.signal?.throwIfAborted()
    }
    spec = this.specOf(route)
    if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'LOCAL_AGENT_MISSING')
    if (this.disposed) throw new LlmError('the local agents adapter is disposed', 'NO_ADAPTER')
    const record = this.deps.record(sessionId)
    const secrets = resolveSecrets()
    // Codex warm-resumes a loaded thread with its old MCP address (#2110), and all
    // threads in one app-server share its process environment. Each live Session
    // gets its own app-server, with its authorized secrets merged into spec.env.
    const engine = spec.kind === 'codex'
      ? this.deps.spawnEngine(spec.kind, route, Object.keys(secrets).length === 0 ? spec : { ...spec, env: { ...spec.env, ...secrets } })
      : this.engine(route)
    const pendingContext = Array.isArray(record?.pendingContext) ? record.pendingContext.map(entry => ({ ...entry })) : []
    if (carriedContext !== undefined) {
      const seenIds = new Set(pendingContext.map(entry => entry.id).filter(Boolean))
      for (const entry of carriedContext) {
        if (entry.id !== undefined && seenIds.has(entry.id)) continue
        pendingContext.push(entry)
      }
    }
    live = {
      sessionId, route, spec, engine, secrets, dead: false,
      record,
      cliSessionId: record?.cliSessionId,
      handed: record?.handedId,
      promptHash: record?.promptHash,
      defaultEffort: record?.model === options.model ? record?.defaultEffort : undefined,
      effort: record?.effort,
      engineSession: undefined,
      mcp: undefined,
      events: [],
      waiters: [],
      pending: new Map(),   // dshCallId -> {name, mcpCallId?, reply?}
      ...(orphanedPending !== undefined ? { orphanedPending } : {}),
      started: false,
      // 'idle': no CLI turn. 'running': a prompt is in flight. 'suspended': the
      // turn waits on a bridged tool call or a permission answer.
      state: 'idle',
      // Prompts queued while a turn runs (ACP speaks one prompt at a time);
      // the drain sends the next one when the turn ends.
      queue: [],
      // Context-only messages (clock snapshots, silent notices, memory updates)
      // held until the next real prompt or settled continuation goes out.
      pendingContext,
      flushedContext: undefined,
      turnConfirmed: true,
      handedRolledBack: false,
      idle: undefined,
      cwd: record?.cwd,
      model: options.model,
      preset,
      forkFrom: record?.forkFrom === true,
      forkFallbackContext: typeof record?.forkFallbackContext === 'string' && record.forkFallbackContext !== '' ? record.forkFallbackContext : undefined,
      // What the CLI reported of its own context ({used, size, stale}) and how often
      // it condensed in this Session; the parts module decides with them.
      context: record?.context,
      contextDirty: false,
      compactions: record?.compactions ?? 0,
      // Output of a request DS Bot made for itself may trail its end (Devin's
      // "Context compacted"); until the next prompt, text, thoughts and activity drop.
      mute: false,
    }
    const idleCloseMs = this.deps.idleCloseMs ?? IDLE_CLOSE_MS
    live.scheduleIdle = () => {
      clearTimeout(live.idle)
      if (live.dead || !(idleCloseMs > 0)) return
      live.idle = setTimeout(() => {
        if (live.dead) return
        if (live.state === 'suspended') {
          live.scheduleIdle()
          return
        }
        const error = live.state === 'running'
          ? new LlmError(`${live.spec.name} stalled: no activity before the local-agent idle timeout.`, 'LOCAL_AGENT_EXIT')
          : undefined
        void this.closeLive(live, { idle: true, error })
      }, idleCloseMs)
      live.idle.unref?.()
    }
    live.push = (event) => {
      if (live.dead) return
      if (TURN_CONFIRMING_EVENTS.has(event?.type)) {
        const hadFlushed = live.flushedContext !== undefined
        live.turnConfirmed = true
        live.flushedContext = undefined
        if (hadFlushed) {
          live.contextDirty = false
          this.deps.saveRecord(live.sessionId, this.recordOf(live))
        }
      }
      this.observe(live, event)
      if (event?.type === 'models') return
      if (live.mute && live.state === 'idle' && (event?.type === 'text' || event?.type === 'thought' || event?.type === 'activity' || event?.type === 'status')) return
      live.scheduleIdle()
      const waiter = live.waiters.shift()
      if (waiter !== undefined) waiter(event)
      else live.events.push(event)
    }
    live.next = () => (live.events.length > 0 ? Promise.resolve(live.events.shift()) : new Promise(resolve => live.waiters.push(resolve)))
    this.live.set(sessionId, live)
    return live
  }

  // A Session's record: its CLI session, what was handed to it, and what the CLI said
  // about its context.
  recordOf(live, extra = {}) {
    return {
      route: live.route,
      cliSessionId: live.cliSessionId,
      cwd: live.cwd,
      handedId: live.handed,
      promptHash: live.promptHash,
      model: live.model,
      ...(live.defaultEffort === undefined ? {} : { defaultEffort: live.defaultEffort }),
      ...(live.effort === undefined ? {} : { effort: live.effort }),
      ...(live.forkFrom === true ? { forkFrom: true } : {}),
      ...(typeof live.forkFallbackContext === 'string' && live.forkFallbackContext !== '' ? { forkFallbackContext: live.forkFallbackContext } : {}),
      ...(live.context === undefined ? {} : { context: live.context }),
      ...(live.compactions > 0 ? { compactions: live.compactions } : {}),
      ...(Array.isArray(live.pendingContext) && live.pendingContext.length > 0 ? { pendingContext: live.pendingContext.map(entry => ({ ...entry })) } : {}),
      ...extra,
    }
  }

  // The CLI's own word on its context. A size it reports replaces the default
  // window; a compaction makes the last figure stale until the CLI reports again,
  // except where it reported during the compaction itself (Codex).
  observe(live, event) {
    if (event?.type === 'models') {
      if (Array.isArray(event.models) && event.models.length > 0) this.recordDiscoveredModels(live.route, event.models)
      return
    }
    if (event?.type === 'effort') {
      if (event.defaultEffort !== undefined) live.defaultEffort = event.defaultEffort
      live.effort = event.effort
      live.contextDirty = false
      this.deps.saveRecord(live.sessionId, this.recordOf(live))
      return
    }
    if (event?.type === 'context') {
      // A size the CLI reports now, as against one carried by the Session from its
      // record: only the former is this model's window.
      const reported = positiveInt(event.size)
      const size = reported ?? live.context?.size
      const used = nonNegativeInt(event.used)
      live.context = used !== undefined
        ? { used, ...(size === undefined ? {} : { size }) }
        : { ...live.context, ...(size === undefined ? {} : { size }) }
      // The same figure is the model's window: the model card and the percentage it
      // renders read it from resolveModel, so it is kept for the route and model this
      // Session runs, not for this Session alone (#1823). A usage-only report carries
      // no size, and the Session may still hold the size of the model it ran before:
      // publishing that one under this model's key would give the new model a window
      // nothing has reported for it.
      if (reported !== undefined && this.windowOf(live.route, live.model) !== reported) {
        this.windows.set(windowKey(live.route, live.model), reported)
        this.deps.saveWindow?.(live.route, live.model, reported)
      }
      live.contextDirty = true
      this.deps.patchRecord?.(live.sessionId, { context: live.context })
      return
    }
    if (event?.type !== 'compaction') return
    if (event.status === 'started') {
      live.compacting = { before: live.context }
      live.context = { ...live.context, stale: true }
      return
    }
    const during = live.compacting
    live.compacting = undefined
    if (event.status !== 'completed') {
      if (during !== undefined && live.context?.stale === true) live.context = during.before
      return
    }
    live.compactions += 1
    if (during === undefined) live.context = { ...live.context, stale: true }
    // An ACP agent read the team instructions as a prompt, which a compaction may
    // have condensed away: the next prompt carries them again.
    if (live.spec.kind === 'acp') live.promptHash = undefined
    // Drop pre-compaction memory updates/snapshots from pendingContext; the next
    // step in the new epoch injects fresh full own+group memory snapshots.
    if (Array.isArray(live.pendingContext) && live.pendingContext.length > 0) {
      live.pendingContext = live.pendingContext.filter(entry => !MEMORY_CONTEXT_KINDS.has(entry.kind ?? entry.key))
    }
    live.contextDirty = false
    this.deps.saveRecord(live.sessionId, this.recordOf(live))
    this.deps.onCompaction?.(live.sessionId, { compactions: live.compactions, kind: live.spec.kind, reason: 'cli-self-compact' })
  }

  // Persist the latest CLI context sample once a turn settles, suspends for bridged
  // work/approval, or before closing the bridge so patchRecord-only updates survive
  // a restart without saving state on every stream delta.
  flushContext(live) {
    if (!live?.contextDirty || live.context === undefined || live.sessionId === undefined) return
    live.contextDirty = false
    if (this.deps.record(live.sessionId) !== undefined) this.deps.saveRecord(live.sessionId, this.recordOf(live))
  }

  // {used, size, compactions} of a Session's CLI session; `used` is undefined while
  // the CLI has not said how full it is since it last condensed.
  contextOf(sessionId) {
    const live = this.live.get(sessionId)
    const record = live === undefined ? this.deps.record(sessionId) : undefined
    const context = live?.context ?? record?.context
    const compactions = live?.compactions ?? record?.compactions ?? 0
    if (context === undefined && compactions === 0) return undefined
    return {
      ...(context?.stale === true || context?.used === undefined ? {} : { used: context.used }),
      ...(context?.size === undefined ? {} : { size: context.size }),
      compactions,
    }
  }

  engineInUse(engine, except) {
    return [...this.live.values()].some(other => other.engine === engine && !other.dead)
      || [...this.sideRequests].some(request => request !== except && request.engine === engine)
      || [...this.activeProbes].some(probe => probe !== except && probe.engine === engine)
  }

  async closeLive(live, { idle = false, error } = {}) {
    if (live.dead) return
    this.flushContext(live)
    live.dead = true
    clearTimeout(live.idle)
    if (error !== undefined) {
      live.closeFailure = { type: 'error', error }
      void this.stopTurn(live, error.message)
    }
    this.live.delete(live.sessionId)
    live.engine.forget?.(live.sessionId)
    if (error !== undefined && Object.hasOwn(live, 'handedBefore')) this.rollbackUnread(live, live.sessionId)
    live.mcp?.close()
    if (idle) {
      // The CLI session survives on the agent side; the process leaves and the
      // next prompt resumes it.
      live.engineSession = undefined
      live.started = false
    }
    for (const waiter of live.waiters.splice(0)) waiter(live.closeFailure ?? { type: 'done', reason: 'stop' })
    const stillUsed = this.engineInUse(live.engine)
    if (!stillUsed) await live.engine.close?.().catch(() => {})
  }

  // Only driver permission callbacks populate this evidence; MCP/model arguments cannot.
  approvalEvidence(sessionId, callId) {
    const live = this.live.get(String(sessionId))
    if (!live || live.dead || !live.engineSession || live.engineSession.dead) return undefined
    return live.pending.get(callId)?.approvalEvidence
  }

  // The turn under way ends: the CLI stops, and a call it waits on gets an answer.
  stopTurn(live, reason) {
    live.state = 'idle'
    live.stopped = true
    live.queue.length = 0
    const stopped = live.engineSession === undefined ? undefined : live.engine.cancel?.(live.engineSession)
    live.mcp?.failAll(new Error(reason))
    for (const pending of live.pending.values()) pending.resolve({ text: reason, isError: true })
    live.pending.clear()
    return stopped
  }

  // Close idle Codex app-servers whose secret environment changed so revoked or
  // rotated values do not linger in a live process for the idle window. Active
  // or suspended turns replace their process on the next step in liveFor().
  async secretsChanged() {
    if (this.disposed || this.syncingSecrets) return
    this.syncingSecrets = true
    try {
      const closing = []
      for (const live of Array.from(this.live.values())) {
        if (live.dead || live.spec.kind !== 'codex') continue
        if (live.state !== 'idle' || live.pending.size > 0) continue
        const next = this.deps.secretEnvForSession?.(live.sessionId) ?? {}
        if (!isDeepStrictEqual(live.secrets, next)) {
          closing.push(this.closeLive(live, { idle: true }).catch(() => {}))
        }
      }
      if (closing.length > 0) await Promise.all(closing)
    } finally {
      this.syncingSecrets = false
    }
  }

  // The Session left this CLI: its part moved on. Its process leaves; the CLI session
  // and its record stay, so opening that part again resumes it.
  async closeSession(sessionId, reason = 'the conversation moved on') {
    const live = this.live.get(String(sessionId))
    if (live === undefined) return
    this.stopTurn(live, reason)
    await this.closeLive(live, { idle: true })
  }

  isForkUnsupported(route) {
    return this.forkUnsupportedRoutes.has(route) || this.engines.get(route)?.forkSupported === false
  }

  // Forks a local CLI session natively when the engine supports it (Codex `thread/fork`
  // or Claude `--resume <id> --fork-session`) so a background task inherits parent context.
  // Returns `{ cliSessionId }` on success, or `undefined` to fall back to a fresh Session.
  async forkSession(fromSessionId, toSessionId, { cwd, model, fallbackContext } = {}) {
    const fromId = String(fromSessionId ?? '')
    const toId = String(toSessionId ?? '')
    if (fromId === '' || toId === '') return undefined
    const sourceLive = this.live.get(fromId)
    const sourceRecord = this.deps.record(fromId)
    const route = sourceLive?.route ?? sourceRecord?.route
    const sourceCliId = sourceLive?.cliSessionId ?? sourceRecord?.cliSessionId
    if (!route || !sourceCliId) return undefined
    const spec = this.specOf(route)
    if (spec === undefined) return undefined
    if (this.isForkUnsupported(route) || sourceLive?.engine?.forkSupported === false) {
      this.forkUnsupportedRoutes.add(route)
      return undefined
    }
    const resolvedCwd = cwd ?? sourceLive?.cwd ?? sourceRecord?.cwd ?? await this.deps.cwdFor(toId)
    const resolvedModel = model ?? sourceLive?.model ?? sourceRecord?.model
    if (spec.kind === 'codex') {
      // Prefer the live parent session's existing Codex app-server so we neither spawn
      // an extra persistent child process nor miss un-flushed in-memory thread state.
      const engine = sourceLive?.engine ?? this.engine(route)
      if (engine.forkSupported === false || typeof engine.fork !== 'function') {
        if (engine.forkSupported === false) this.forkUnsupportedRoutes.add(route)
        return undefined
      }
      const preset = this.deps.presetFor(toId)
      const mode = cliMode('codex', preset)
      const forked = await engine.fork(sourceCliId, toId, {
        cwd: resolvedCwd,
        mode,
        model: resolvedModel,
        review: this.deps.reviewFor?.(toId) === true,
      })
      if (engine.forkSupported === false) this.forkUnsupportedRoutes.add(route)
      if (!forked?.cliSessionId) return undefined
      this.deps.saveRecord(toId, {
        route,
        cliSessionId: forked.cliSessionId,
        cwd: resolvedCwd,
        model: resolvedModel,
        compactions: 0,
      })
      return forked
    }
    if (spec.kind === 'claude') {
      // Claude forks lazily on first spawn via `--resume <sourceCliId> --fork-session`,
      // receiving a fresh `cliSessionId` on `system/init`. Retain optional `fallbackContext`
      // only until init succeeds so if `--fork-session` is rejected, we fall back to a
      // fresh CLI session with parent context instead of failing or resuming the parent.
      const trimmedFallback = typeof fallbackContext === 'string' ? fallbackContext.trim() : ''
      this.deps.saveRecord(toId, {
        route,
        cliSessionId: sourceCliId,
        forkFrom: true,
        ...(trimmedFallback !== '' ? { forkFallbackContext: trimmedFallback } : {}),
        cwd: resolvedCwd,
        model: resolvedModel,
        compactions: 0,
      })
      return { cliSessionId: sourceCliId, deferred: true }
    }
    return undefined
  }

  // Restores handed cursor, promptHash, and staged context when a turn fails
  // before the CLI confirms or accepts it (pre-init exit on Claude, immediate
  // RPC rejection on Codex/ACP), while never replaying a turn that already ran.
  rollbackUnread(live, sessionId) {
    const restoreContext = () => {
      if (Array.isArray(live.flushedContext) && live.flushedContext.length > 0) {
        const existing = live.pendingContext ?? []
        const seenIds = new Set(existing.map(entry => entry.id).filter(Boolean))
        const restored = live.flushedContext.filter(entry => entry.id === undefined || !seenIds.has(entry.id))
        live.pendingContext = [...restored, ...existing]
        live.flushedContext = undefined
      }
    }
    if (live.spec.kind === 'claude') {
      const session = live.engineSession
      if (session?.dead === true && session.cliSessionId === undefined && session.rolledBack !== true) {
        session.rolledBack = true
        live.handedRolledBack = true
        restoreContext()
        // A deferred Claude fork rejected `--fork-session` or could not find the parent
        // conversation before init: never resume the parent without `--fork-session`;
        // drop the parent id and retry once on a clean fresh session with fallback context.
        if (live.forkFrom === true && (session.forkUnsupported === true || session.resumeMissing === true)) {
          if (session.forkUnsupported === true) this.forkUnsupportedRoutes.add(live.route)
          live.forkFrom = false
          live.cliSessionId = undefined
          live.handed = undefined
          live.promptHash = undefined
          live.pumpToken = undefined
          live.events.length = 0
          live.engine.forget?.(sessionId)
          live.engineSession = undefined
          live.started = false
          live.forkFallbackRetry = true
          live.applyForkFallback = true
          live.contextDirty = false
          this.deps.saveRecord(sessionId, this.recordOf(live))
          return
        }
        if (session.resumeMissing === true) {
          if (this.deps.switchOnResumeLost?.(sessionId) === true) {
            live.handed = live.handedBefore
            if (Object.hasOwn(live, 'promptHashBefore')) live.promptHash = live.promptHashBefore
            live.resumeLost = true
          } else {
            live.cliSessionId = undefined
            live.handed = undefined
            live.context = live.context?.size === undefined ? undefined : { size: live.context.size }
            live.compactions = 0
            live.resumeLost = true
          }
        } else {
          if (session.promptFileUnsupported === true) live.promptFileRetry = true
          live.handed = live.handedBefore
          if (Object.hasOwn(live, 'promptHashBefore')) live.promptHash = live.promptHashBefore
        }
        live.contextDirty = false
        this.deps.saveRecord(sessionId, this.recordOf(live))
        return
      }
    }
    if (live.turnConfirmed === false && Object.hasOwn(live, 'handedBefore') && live.handedRolledBack !== true) {
      live.handedRolledBack = true
      live.handed = live.handedBefore
      if (Object.hasOwn(live, 'promptHashBefore')) live.promptHash = live.promptHashBefore
      restoreContext()
      live.contextDirty = false
      this.deps.saveRecord(sessionId, this.recordOf(live))
    }
  }

  notifyToolsChanged(sessionId) {
    const targets = sessionId !== undefined
      ? [this.live.get(String(sessionId))].filter(Boolean)
      : [...this.live.values()]
    for (const live of targets) {
      if (live.mcp === undefined) continue
      const sig = toolSignature(live.tools?.())
      if (live.toolNamesSig === sig) continue
      live.toolNamesSig = sig
      live.mcp.notifyToolsChanged()
    }
  }

  // The loopback MCP server for one live session; tools/call lands in its event queue.
  // `tools` lists the current turn's tools; the server outlives the turn that
  // started it, so tools/list reads the latest one.
  async ensureMcp(live, tools) {
    live.tools = tools
    const sig = toolSignature(tools?.())
    if (live.mcp !== undefined) {
      if (live.toolNamesSig !== undefined && live.toolNamesSig !== sig) live.mcp.notifyToolsChanged()
      live.toolNamesSig = sig
      return live.mcp
    }
    live.toolNamesSig = sig
    const mcp = new LoopbackMcp(() => live.tools(), ({ name, arguments: args, callId }) => {
      const dshCallId = `dsbot-${callId}`
      return new Promise((resolve) => {
        live.pending.set(dshCallId, { name, mcpCallId: callId, resolve })
        live.push({ type: 'call', name, args, dshCallId })
      })
    })
    await mcp.listen()
    live.mcp = mcp
    return mcp
  }

  // ---------------------------------------------------------------------------
  async *stream(options) {
    if (this.disposed) throw new LlmError('the local agents adapter is disposed', 'NO_ADAPTER')
    if (options.purpose === 'session-title') {
      const first = (options.messages ?? []).find(message => message.role === 'user')
      yield* titleChunk(extractSessionTitle(textOf(first?.content)))
      return
    }
    if (options.purpose === 'compaction') {
      yield* digestChunks(options.messages)
      return
    }
    if (options.purpose === 'aside') {
      throw new LlmError('aside requests must not run on a live local-agent session', 'INVALID_REQUEST')
    }
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new LlmError('a local agent request needs a session', 'INVALID_REQUEST')
    const preset = this.deps.presetFor(sessionId)
    const live = await this.liveFor(options, preset)

    // What the request carries past the last handed message. When the marker is
    // gone the CLI session is stale or new: it gets a replay instead of a delta.
    const messages = options.messages ?? []
    const queuedDelivery = live.queue.at(-1)?.delivery
    const handed = queuedDelivery?.id ?? live.handed
    const at = handed === undefined ? -1 : messages.findIndex(message => message.id === handed)
    const fresh = at === -1
    const delta = fresh ? [] : messages.slice(at + 1)

    // Results of the calls the last step emitted answer the suspended CLI calls.
    // A user message never resolves an approve_agent_action pending: only that
    // tool's own result may. User text may answer a pending bridged MCP call
    // whose DSH tool concluded the turn (a question-type card).
    const settled = []
    for (const message of delta) {
      if (message.role !== 'tool') continue
      const pending = live.pending.get(message.toolCallId)
      if (pending !== undefined) {
        live.pending.delete(message.toolCallId)
        const text = textOf(message.content) || (message.isError ? 'the call failed' : '')
        pending.resolve({ text, isError: message.isError === true })
        settled.push({ name: pending.name, text, isError: message.isError === true })
        continue
      }
      const orphaned = live.orphanedPending?.get(message.toolCallId)
      if (orphaned === undefined) continue
      live.orphanedPending.delete(message.toolCallId)
      const text = textOf(message.content) || (message.isError ? 'the call failed' : '')
      settled.push({ name: orphaned.name, text, isError: message.isError === true })
    }
    // Runtime/time context snapshots, memory context messages, and silent Bot notices
    // are context, not input: keep the latest snapshot per source, fold them into the
    // next real prompt or settled continuation, never start a standalone CLI turn on
    // their own, and never hijack an open ask_user / bridged MCP call.
    const contextMessages = delta.filter(isContextOnlyMessage)
    if (!fresh && contextMessages.length > 0) stagePendingContext(live, contextMessages)
    const users = delta.filter(message => message.role === 'user' && !isContextOnlyMessage(message))
    // The first open bridged call that is not an approval may take the user's
    // next message as its answer; the rest of the input is new.
    const openCall = [...live.pending.entries()].find(([, entry]) => entry.name !== APPROVE_TOOL)
    const remaining = []
    let answered = openCall === undefined
    for (const message of users) {
      if (!answered && openCall !== undefined) {
        const [id, pending] = openCall
        live.pending.delete(id)
        const answer = textOf(message.content)
        pending.resolve({ text: answer })
        // The CLI may have finished while this call waited; the answer is then a
        // settled result the turn below has to carry, like a tool result (#1513).
        settled.push({ name: openCall[1].name, text: answer, isError: false })
        answered = true
      } else {
        remaining.push(message)
      }
    }

    // Idle context-only steps (e.g. periodic clock updates or silent notices with no
    // user input or settled call) never open or wake the CLI on their own; they ride
    // along with the next real user input.
    if (!fresh && remaining.length === 0 && settled.length === 0 && live.state === 'idle' && live.queue.length === 0) {
      const last = messages.at(-1)
      if (last !== undefined && live.closeFailure === undefined) this.markHanded(live, last.id, live.promptHash)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const rawSystem = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n').trim()
    const hasMemoryDelta = messages.some(message => message.source?.kind === OWN_MEMORY_SOURCE || message.source?.kind === MEMORY_UPDATE_SOURCE || message.source?.kind === GROUP_MEMORY_SOURCE)
    const mcp = await this.ensureMcp(live, () => this.deps.toolsFor(options, sessionId))
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd

    const mode = cliMode(live.spec.kind, preset)
    if (live.engineSession === undefined && live.forkFrom === true && (live.engine.forkSupported === false || this.isForkUnsupported(live.route))) {
      // Another task already discovered this CLI rejects `--fork-session`:
      // convert this staged deferred fork directly to a fresh session with its
      // retained fallbackContext instead of throwing in engine.open().
      live.forkFrom = false
      live.cliSessionId = undefined
      live.handed = undefined
      live.promptHash = undefined
      if (typeof live.forkFallbackContext === 'string' && live.forkFallbackContext !== '') {
        live.applyForkFallback = true
      }
      live.contextDirty = false
      this.deps.saveRecord(sessionId, this.recordOf(live))
    }
    const priorCliId = live.cliSessionId
    const freshCli = priorCliId === undefined
    let freshMemory
    let memoryRefreshed = false
    let appliedMemory = { system: rawSystem, note: '' }
    let system = rawSystem
    let promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    let instructions = system === '' ? undefined : system
    const refreshMemory = () => {
      if (memoryRefreshed) return
      memoryRefreshed = true
      freshMemory = this.deps.freshMemoryView?.(sessionId)
      if (freshMemory === undefined) return
      appliedMemory = applyFreshMemory(rawSystem, freshMemory)
      system = appliedMemory.system
      instructions = system === '' ? undefined : system
      promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    }
    // When starting a fresh CLI session that replays history with memory changes
    // (including Claude's post-resumeMissing retry), refresh the authorized memory
    // snapshot before open() so deleted entries never resurrect from an old prompt.
    if ((fresh || options[RESUME_RETRIED] === true) && (options[RESUME_RETRIED] === true || hasMemoryDelta)) {
      refreshMemory()
    }
    const switchOnResumeLost = this.deps.switchOnResumeLost?.(sessionId) === true
    const forkFallback = live.applyForkFallback === true && typeof live.forkFallbackContext === 'string' && live.forkFallbackContext !== ''
      ? live.forkFallbackContext
      : undefined
    let resumeDropped = false
    if (live.engineSession === undefined) {
      const isForkOpen = live.forkFrom === true && priorCliId !== undefined
      const openArgs = {
        cwd,
        mcp,
        resumeId: priorCliId,
        forkSession: isForkOpen,
        resumeOnly: switchOnResumeLost && priorCliId !== undefined && !isForkOpen,
        mode,
        preset,
        review: this.deps.reviewFor?.(sessionId) === true,
        model: options.model,
        defaultEffort: live.defaultEffort,
        effort: live.effort,
        // Codex carries the team instructions as developer config on a new
        // thread (including when thread/resume falls back to thread/start, where
        // the callback refreshes memory before thread/start sends startup config;
        // thread/resume itself ignores `instructions`); Claude gets them
        // appended at spawn; ACP reads them in the first prompt below.
        instructions: live.spec.kind === 'codex'
          ? () => {
              if (!freshCli) refreshMemory()
              return instructions
            }
          : undefined,
        system: live.spec.kind === 'claude' ? instructions : undefined,
      }
      live.engineSession = await live.engine.open(sessionId, openArgs)
        .catch(async error => {
          if (live.spec.kind === 'codex' || error?.code === 'LOCAL_AGENT_SESSION_LOST') await this.closeLive(live)
          throw toLlmError(error, live)
        })
      if (live.dead) {
        const openedSession = live.engineSession
        live.engineSession = undefined
        await live.engine.closeSession?.(openedSession).catch(() => {})
        live.engine.forget?.(sessionId)
        throw toLlmError(live.closeFailure?.error ?? new LlmError(`${live.spec.name} session closed while opening.`, 'LOCAL_AGENT_EXIT'), live)
      }
      // A resumed CLI reports its id only with `system/init`: keep the saved one
      // in the meantime, or a resume that fails would erase it. When DS Bot owns
      // the Bot part, a lost CLI session escalates to a formal `runtime-lost` part
      // switch instead of silently replaying inside the same part.
      const reportedId = live.engineSession.acpSessionId ?? live.engineSession.threadId ?? live.engineSession.cliSessionId
      if (!freshCli && !isForkOpen && (live.engineSession.resumed === false || (reportedId !== undefined && reportedId !== priorCliId))) {
        if (switchOnResumeLost) {
          const opened = live.engineSession
          live.engineSession = undefined
          await live.engine.closeSession?.(opened).catch(() => {})
          live.engine.forget?.(sessionId)
          await this.closeLive(live)
          throw new LlmError('the saved local agent session could not be resumed', 'LOCAL_AGENT_SESSION_LOST')
        }
        resumeDropped = true
        live.context = live.context?.size === undefined ? undefined : { size: live.context.size }
        live.compactions = 0
        live.promptHash = undefined
        refreshMemory()
        this.deps.onCompaction?.(sessionId, { compactions: 0, kind: live.spec.kind, reason: 'resume-dropped' })
        this.deps.rt?.warn?.('local-agents: %s did not resume session %s for %s (opened %s); replaying conversation history', live.spec.kind, priorCliId, sessionId, reportedId ?? 'new')
      }
      if (reportedId !== undefined) {
        live.cliSessionId = reportedId
        if (isForkOpen) live.forkFrom = false
      }
      if (live.spec.kind === 'acp') {
        if (live.engineSession.defaultEffort !== undefined) live.defaultEffort = live.engineSession.defaultEffort
        live.effort = live.engineSession.effort
      }
      const discovered = live.engine.discoveredModels?.(live.engineSession)
      if (Array.isArray(discovered) && discovered.length > 0) this.recordDiscoveredModels(live.route, discovered)
      live.started = true
      // The session's events feed this Session's queue: a call from any engine
      // kind reaches drain() through live.next().
      const session = live.engineSession
      const token = live.pumpToken = {}
      void (async () => {
        while (live.pumpToken === token && !live.dead) {
          const event = await session.next()
          if (live.pumpToken === token && !live.dead) live.push(event)
        }
      })()
      if (live.spec.kind === 'claude' && instructions !== undefined) live.promptHash = promptHash
      else if (live.spec.kind === 'codex' && (freshCli || resumeDropped) && instructions !== undefined) live.promptHash = promptHash
      live.contextDirty = false
      this.deps.saveRecord(sessionId, this.recordOf(live, { cwd, model: options.model }))
      // Claude reports its session id with `system/init`, after start() resolved:
      // the record above has no id yet, so persist it when it lands or the next
      // host has nothing to resume and the conversation starts over.
      const pendingId = session.whenSessionId?.()
      if (pendingId !== undefined) {
        void pendingId.then((id) => {
          if (id === undefined || live.dead) return
          live.turnConfirmed = true
          live.flushedContext = undefined
          live.cliSessionId = id
          live.forkFrom = false
          if (live.applyForkFallback !== true) live.forkFallbackContext = undefined
          live.contextDirty = false
          this.deps.saveRecord(sessionId, this.recordOf(live, { cliSessionId: id, cwd, model: options.model }))
        })
      }
    }

    const startedFreshCli = freshCli || resumeDropped
    const needsReplay = fresh || resumeDropped
    const canSteer = live.engine.canSteer?.(live.engineSession) !== false
    const willDispatchNow = needsReplay || remaining.length > 0 || (settled.length > 0 && !canSteer)
    const supportsImages = live.spec.kind !== 'acp' || live.engine.supportsImages?.(live.engineSession) !== false
    const resolveImage = block => this.resolveImageBlock(block, { supportsImages, signal: options.signal })
    let flushedContext
    let contextText = ''
    if (needsReplay) {
      live.pendingContext.length = 0
    } else if (willDispatchNow) {
      flushedContext = live.pendingContext.splice(0)
      contextText = flushedContext.map(entry => entry.text).join('\n')
    }
    let promptBlocks = needsReplay
      ? await renderReplay(messages, system, resolveImage, {
          preserve: remaining,
          freshMemory,
          memoryNote: appliedMemory.note,
          // Codex receives instructions via developer config and Claude via
          // --append-system-prompt(-file); only ACP needs system instructions in
          // the replay prompt itself.
          includeSystem: live.spec.kind === 'acp',
        })
      : await renderDelta(contextText, remaining, resolveImage)
    if (forkFallback !== undefined) {
      promptBlocks = mergeTextBlocks([{ type: 'text', text: forkFallback }, ...promptBlocks])
      live.applyForkFallback = false
      live.forkFallbackContext = undefined
    }
    let sentInstructions = live.spec.kind !== 'acp' && startedFreshCli && instructions !== undefined
    let nextPromptHash = live.promptHash
    const expectedPromptHash = live.queue.findLast(entry => entry.delivery?.promptHash !== undefined)?.delivery.promptHash ?? live.promptHash
    // A new CLI session gets its instructions in the open args or the replay;
    // the "updated" line is only for a session that saw older ones.
    if (instructions !== undefined && !startedFreshCli && expectedPromptHash !== promptHash) {
      const updated = `Updated team instructions (replace earlier ones):\n\n${instructions}`
      if (live.spec.kind === 'codex') {
        const result = await live.engine.instruct?.(live.engineSession, updated)
        if (result?.ok === true) {
          sentInstructions = true
        } else if (result?.unsupported === true && promptBlocks.length > 0) {
          promptBlocks = mergeTextBlocks([{ type: 'text', text: updated }, ...promptBlocks])
          sentInstructions = true
        } else {
          this.deps.rt?.warn?.('local-agents: codex thread/inject_items failed for %s; will retry instructions on next turn', sessionId)
        }
      } else if (promptBlocks.length > 0 || live.spec.kind === 'acp' || live.spec.kind === 'claude') {
        promptBlocks = mergeTextBlocks([{ type: 'text', text: updated }, ...promptBlocks])
        sentInstructions = true
      }
    }
    if (live.spec.kind === 'codex' && live.dead) {
      throw live.closeFailure?.error ?? new LlmError('the Codex session closed before its prompt was sent', 'LOCAL_AGENT_EXIT')
    }
    // A card can outlive the CLI's turn: the CLI finished — often by timing out on the
    // call it bridged out — while the user was still deciding. The answer then has to
    // start a turn of its own, or the user's decision never reaches the agent and the
    // stream ends by reading the finished turn's old reply (#1513).
    let settledText = ''
    if (settled.length > 0) {
      const answer = settled.map(entry => `${entry.name} → ${entry.text === '' ? (entry.isError ? 'failed' : 'no result') : entry.text}`).join('\n')
      settledText = `The calls that were waiting on the user are settled:\n\n${answer}\n\nContinue from where the turn stopped.`
    }
    if (settledText !== '' && !canSteer) {
      // The turn this answer belongs to is over: it needs a turn of its own, in the same
      // prompt as whatever else this call brought — runtime context, a further user
      // message — because context alone would carry the turn without the decision.
      const blocks = mergeTextBlocks([{ type: 'text', text: settledText }, ...promptBlocks])
      this.discardTurnOutput(live)
      if (sentInstructions) nextPromptHash = promptHash
      promptBlocks = []
      if (flushedContext !== undefined && flushedContext.length > 0) live.flushedContext = flushedContext
      await this.startTurn(live, blocks, options.signal, options.reasoningEffort)
    } else if (settledText !== '') {
      // The turn still looks alive; keep any staged context in `live.pendingContext`
      // until either the fallback continuation actually starts in drain() or a later
      // prompt/steer carries it, so normal tool-continuation replies never drop it.
      live.continuation = settledText
      if (remaining.length === 0) promptBlocks = []
    }
    if (promptBlocks.length > 0) {
      await this.sendInput(live, promptBlocks, options.signal, options.reasoningEffort, settledText, flushedContext)
      if (sentInstructions) nextPromptHash = promptHash
      // ACP only counts instructions once they reach the agent with a prompt.
      if (live.spec.kind === 'acp' && (startedFreshCli || sentInstructions)) nextPromptHash = promptHash
    }
    if (live.spec.kind === 'acp' && startedFreshCli && promptBlocks.length === 0 && instructions !== undefined) {
      await this.sendInput(live, `Follow these instructions from the user's team for everything you do here. They sit on top of your own; when they conflict, these win.\n\n${instructions}`, options.signal, options.reasoningEffort)
      nextPromptHash = promptHash
    }

    // A queued ACP input is not handed until drain sends its prompt.
    const last = messages.at(-1)
    const queued = live.queue.at(-1)
    if (queued !== undefined) {
      if (last !== undefined) queued.delivery = { id: last.id, promptHash: sentInstructions ? nextPromptHash : undefined }
    } else {
      const prevPromptHash = live.promptHash
      live.promptHash = nextPromptHash
      if (last !== undefined && live.closeFailure === undefined) this.markHanded(live, last.id, nextPromptHash ?? promptHash, prevPromptHash)
    }

    if (settled.length > 0 || remaining.length > 0 || needsReplay) live.orphanedPending = undefined

    try {
      if (settled.length > 0 && live.state === 'suspended' && live.pending.size === 0) {
        live.state = 'running'
        live.scheduleIdle()
      }
      yield* this.drain(live, options)
    } catch (error) {
      // The caller sees the failure now: a start that died before accepting its
      // prompt must not count as delivered, in case the host retries or restarts next.
      this.rollbackUnread(live, sessionId)
      if (live.closeFailure === undefined && live.promptFileRetry === true) {
        live.promptFileRetry = false
        yield* this.stream(options)
        return
      }
      if (live.closeFailure === undefined && live.forkFallbackRetry === true) {
        live.forkFallbackRetry = false
        yield* this.stream(options)
        return
      }
      // The saved conversation is gone: inside DS Bot, escalate to a formal
      // `runtime-lost` part switch; in standalone adapter usage, retry once with replay.
      if (live.closeFailure === undefined && live.resumeLost === true) {
        live.resumeLost = false
        if (switchOnResumeLost) {
          await this.closeLive(live)
          throw new LlmError(`${live.spec.name} no longer has this conversation`, 'LOCAL_AGENT_SESSION_LOST')
        }
        if (options[RESUME_RETRIED] !== true) {
          yield* this.stream({ ...options, [RESUME_RETRIED]: true })
          return
        }
      }
      throw error
    }
  }

  markHanded(live, id, promptHash, prevPromptHash = live.promptHash) {
    live.handedBefore = live.handed
    live.promptHashBefore = prevPromptHash
    live.handedRolledBack = false
    live.handed = id
    live.contextDirty = false
    this.deps.saveRecord(live.sessionId, this.recordOf(live, { promptHash }))
  }

  // Input for the CLI: a fresh prompt while it is idle; while a turn runs or
  // waits on a bridged call, steering for Codex and Claude, or a queued prompt
  // for ACP (it speaks one prompt at a time; the drain sends it when the turn
  // ends, inside the same stream). The prompt request itself stays open for
  // the whole turn (ACP session/prompt ends when the agent's turn does), so it
  // is sent but not awaited; a send failure lands in the queue as an error.
  // Resolves once the input is settled: the CLI took the steer, a turn of its own
  // started, or the prompt is away. The caller waits for it before reading the CLI,
  // so a steer that fails after the finished turn's `done` arrived still gets a turn
  // of its own instead of being read as this turn's end (#1513).
  sendInput(live, input, signal, effort, settled, flushedContext) {
    const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    const steerInput = typeof input === 'string' ? input : blocks
    live.mute = false
    // A settled answer rides with the input: if this input cannot land as a steer, the
    // turn that replaces it must still carry what the user decided (#1513).
    const body = settled === undefined || settled === ''
      ? blocks
      : mergeTextBlocks([{ type: 'text', text: settled }, ...blocks])
    if (live.state !== 'idle') {
      if (live.spec.kind === 'acp') {
        live.queue.push({ blocks, ...(flushedContext !== undefined && flushedContext.length > 0 ? { flushedContext } : {}) })
        return Promise.resolve()
      }
      if (flushedContext !== undefined && flushedContext.length > 0) live.flushedContext = flushedContext
      // Steering lands on a turn that is still running. When the CLI finished the
      // turn behind a card — the usual case for an answer that arrives late — the
      // steer has nothing to land on, and dropping it leaves the user's answer
      // without a turn at all. Start a turn of its own instead, without the events
      // the finished turn left behind: they would answer this one with the old reply.
      if (live.engine.canSteer?.(live.engineSession) === false) {
        this.discardTurnOutput(live)
        live.continuation = undefined
        return this.startTurn(live, body, signal, effort)
      }
      // The turn's id has to be known before the stream reads the CLI, or the finished
      // turn's own `done` would be read as this turn's end.
      const recover = () => {
        this.discardTurnOutput(live)
        live.continuation = undefined
        return this.startTurn(live, body, signal, effort)
      }
      try {
        live.turnConfirmed = false
        return Promise.resolve(live.engine.steer?.(live.engineSession, steerInput))
          .then(() => {
            const hadFlushed = live.flushedContext !== undefined
            live.turnConfirmed = true
            live.flushedContext = undefined
            if (hadFlushed) {
          live.contextDirty = false
          this.deps.saveRecord(live.sessionId, this.recordOf(live))
        }
          }, recover)
      } catch {
        return recover()
      }
    }
    if (flushedContext !== undefined && flushedContext.length > 0) live.flushedContext = flushedContext
    this.startTurn(live, blocks, signal, effort)
    return Promise.resolve()
  }

  discardTurnOutput(live) {
    // Requests retain their reply callbacks until surfaced and answered.
    live.events = live.events.filter(event => event.type === 'permission' || event.type === 'call')
  }

  // Codex resolves on acceptance; ACP resolves only when the entire turn ends.
  startTurn(live, input, signal, effort) {
    if (live.dead) return Promise.resolve()
    if (live.stopped) {
      this.discardTurnOutput(live)
      live.stopped = false
    }
    const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    live.state = 'running'
    live.turnConfirmed = false
    live.scheduleIdle()
    // The turn an engine names is the one this stream reads: a finished turn's late
    // events carry another id and are dropped instead of answering this one (#1513).
    live.turnTag = undefined
    try {
      const started = Promise.resolve(live.engine.prompt(live.engineSession, blocks, { signal, effort, onProgress: live.scheduleIdle }))
        .then((turnId) => {
          if (live.spec.kind === 'codex') {
            const hadFlushed = live.flushedContext !== undefined
            live.turnConfirmed = true
            live.flushedContext = undefined
            if (turnId !== undefined) live.turnTag = turnId
            if (hadFlushed) {
          live.contextDirty = false
          this.deps.saveRecord(live.sessionId, this.recordOf(live))
        }
          }
        })
        .catch(error => { if (!signal?.aborted) live.push({ type: 'error', error }) })
      return live.spec.kind === 'acp' ? Promise.resolve() : started
    } catch (error) {
      live.push({ type: 'error', error })
      return Promise.resolve()
    }
  }

  async resolveImageBlock(block, { supportsImages, signal }) {
    const ref = block?.attachment
    if (ref === undefined) return { type: 'text', text: '[image unavailable]' }
    const attachments = this.deps.attachments ?? this.deps.rt?.ctx?.get?.('attachments')
    const fsService = this.deps.fs ?? this.deps.rt?.ctx?.get?.('fs')
    let access
    if (attachments !== undefined) {
      try {
        const mapHostPath = path => (fsService?.processPathFromHostPath ? fsService.processPathFromHostPath(path) : path)
        access = resolveImageAttachmentAccess(attachments, mapHostPath, ref)
      } catch {}
    }
    if (block.offloaded === true) return { type: 'text', text: offloadedImageText(ref, access) }
    if (!supportsImages) {
      const base = textOnlyImageText(ref)
      return { type: 'text', text: access?.readonlyPath ? `${base} (file: ${access.readonlyPath})` : base }
    }
    if (attachments === undefined || typeof attachments.readImage !== 'function') {
      this.deps.rt?.warn?.('local-agents: attachments service unavailable; cannot forward image')
      const base = textOnlyImageText(ref)
      return { type: 'text', text: access?.readonlyPath ? `${base} (file: ${access.readonlyPath})` : base }
    }
    try {
      const got = await attachments.readImage(ref, signal)
      return {
        type: 'image',
        mediaType: got.ref?.mediaType ?? ref.mediaType ?? 'image/png',
        data: Buffer.from(got.data).toString('base64'),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      this.deps.rt?.warn?.(`local-agents: failed to read image ${ref.attachmentId ?? ''}: ${error?.message ?? error}`)
      const base = textOnlyImageText(ref)
      return { type: 'text', text: access?.readonlyPath ? `${base} (file: ${access.readonlyPath})` : base }
    }
  }

  // Consume the CLI's events until the turn ends or a bridged call suspends it.
  async *drain(live, options) {
    let index = 0
    let textBuf = ''
    let textIndex = -1
    let thinkBuf = ''
    let thinkIndex = -1
    // DSH keeps the last usage chunk of a request, and a CLI may report each of its
    // model calls (Codex) or queue prompts in one drain (ACP): carry both the running
    // billed token sum and the accumulated internal call count.
    let usage
    const addUsage = (more) => {
      usage = mergeUsage(usage, more)
      return { type: 'usage', usage }
    }
    // Open text and reasoning stay open in parallel; each closes when it has to.
    const closeBlocks = function* () {
      if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
      if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
    }
    const emitCalls = (calls) => {
      const chunks = []
      calls.forEach((call, offset) => {
        const at = index + offset
        chunks.push(
          { type: 'block-start', index: at, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: at, id: call.dshCallId, name: call.name, argumentsDelta: JSON.stringify(call.args ?? {}) },
          { type: 'block-end', index: at, block: { type: 'tool-call', id: call.dshCallId, name: call.name, arguments: JSON.stringify(call.args ?? {}) } },
        )
      })
      index += calls.length
      return chunks
    }
    // One abort promise for the whole drain: the earlier version added a
    // listener per event and never removed it.
    let abortReject
    const abortPromise = new Promise((_, reject) => { abortReject = reject })
    const onAbort = () => abortReject(options.signal?.reason ?? new Error('aborted'))
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort)
    const report = payload => this.deps.rt?.noteLocalAgentEvent?.(live.sessionId, payload)
    try {
    for (;;) {
      const next = this.take(live)
      const event = await Promise.race([next.event, abortPromise])
        .catch(error => ({ type: 'abort', error }))
        .finally(() => next.drop())
      if (event.type === 'abort') {
        this.stopTurn(live, 'the turn was stopped')
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
        return
      }
      // A finished turn's leftovers must not answer the turn this stream reads.
      if (event.type !== 'permission' && event.type !== 'call' && event.turnId !== undefined && live.turnTag !== undefined && event.turnId !== live.turnTag) continue
      switch (event.type) {
        case 'text': {
          report(event)
          if (textIndex === -1) {
            if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'text' }
            textIndex = index - 1
          }
          textBuf += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
          break
        }
        case 'thought':
        case 'activity': {
          report(event)
          // An activity line stands on its own line of the reasoning, which is
          // how the chat tells it from the thought around it.
          const text = event.type === 'activity' ? `${thinkBuf === '' || thinkBuf.endsWith('\n') ? '' : '\n'}${event.text}\n` : event.text
          if (thinkIndex === -1) {
            if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'reasoning' }
            thinkIndex = index - 1
          }
          thinkBuf += text
          yield { type: 'reasoning-delta', index: thinkIndex, text }
          break
        }
        case 'status':
          report(event)
          break
        case 'usage': yield addUsage(event.usage); break
        case 'call': {
          const batch = [{ name: event.name, args: event.args, dshCallId: event.dshCallId }]
          const drainQueuedCalls = () => {
            let i = 0
            while (i < live.events.length) {
              if (live.events[i]?.type === 'call') {
                const [extra] = live.events.splice(i, 1)
                batch.push({ name: extra.name, args: extra.args, dshCallId: extra.dshCallId })
              } else {
                i += 1
              }
            }
          }
          drainQueuedCalls()
          if (!live.dead && !options.signal?.aborted) {
            await new Promise((resolve) => {
              const onEarlyAbort = () => {
                clearTimeout(timer)
                resolve()
              }
              const timer = setTimeout(() => {
                options.signal?.removeEventListener('abort', onEarlyAbort)
                resolve()
              }, CALL_BATCH_WINDOW_MS)
              options.signal?.addEventListener('abort', onEarlyAbort, { once: true })
            })
            if (options.signal?.aborted) {
              this.stopTurn(live, 'the turn was stopped')
              yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
              return
            }
            drainQueuedCalls()
          }
          yield* closeBlocks()
          live.state = 'suspended'
          this.flushContext(live)
          // Team tools the CLI invoked over the loopback MCP server (coalesced into
          // one DSH tool-calls step when parallel requests arrive together).
          for (const chunk of emitCalls(batch)) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'permission': {
          // The preset answers what it already decides, also on an agent with no
          // matching mode of its own: full access allows, read-only refuses a change.
          const preset = this.deps.presetFor(live.sessionId)
          const answer = this.deps.reviewFor?.(live.sessionId) && preset !== 'read-only' ? undefined : presetAnswer(preset, event)
          if (answer !== undefined) { event.reply(answer); break }
          // Without a single-use grant, Allow once would be reported to the user but
          // cancelled at the CLI. Fail closed instead of converting it to a saved grant.
          if (!event.options?.some(option => option.kind === 'allow_once')) {
            event.reply(optionOf(event.options, 'reject') ?? null)
            break
          }
          yield* closeBlocks()
          live.state = 'suspended'
          this.flushContext(live)
          // The CLI's own permission prompt, bridged as an approval tool call.
          const call = { name: APPROVE_TOOL, args: { action: event.action, ...(event.detail ? { detail: event.detail } : {}), ...(event.evidence ? { evidence: event.evidence } : {}) }, dshCallId: event.id }
          live.pending.set(event.id, {
            name: APPROVE_TOOL,
            approvalEvidence: { kind: 'external-agent', cwd: event.cwd, action: call.args },
            resolve: (result) => event.reply(pickAllowOption(event.options, result)),
          })
          for (const chunk of emitCalls([call])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          // The answer resolved a call this turn never read — it ended while the user
          // was still deciding. Nothing was said after that answer, so start the turn
          // that carries it instead of ending on the finished turn's old reply (#1513).
          if (live.continuation !== undefined && index === 0) {
            const continuation = live.continuation
            live.continuation = undefined
            const staged = live.pendingContext.splice(0)
            const stagedText = staged.map(entry => entry.text).join('\n')
            const body = stagedText !== '' ? `${stagedText}\n\n${continuation}` : continuation
            if (staged.length > 0) live.flushedContext = staged
            this.discardTurnOutput(live)
            await this.startTurn(live, body, options.signal, options.reasoningEffort)
            break
          }
          live.continuation = undefined
          yield* closeBlocks()
          if (event.usage !== undefined) yield addUsage(event.usage)
          live.state = 'idle'
          this.flushContext(live)
          // Input queued while this turn ran goes out as the next prompt
          // inside the same drain (ACP takes one prompt at a time).
          const next = live.queue.shift()
          if (next !== undefined) {
            this.sendInput(live, next.blocks, options.signal, options.reasoningEffort, undefined, next.flushedContext)
            if (next.delivery !== undefined) {
              const prevPromptHash = live.promptHash
              live.promptHash = next.delivery.promptHash ?? live.promptHash
              this.markHanded(live, next.delivery.id, live.promptHash, prevPromptHash)
            }
            break
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        case 'error': {
          live.state = 'idle'
          throw toLlmError(event.error, live)
        }
        default: break
      }
    }
    } finally {
      report({ type: 'idle' })
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  // ---------------------------------------------------------------------------
  // Requests DS Bot makes of a CLI for itself. None of them reaches the conversation.

  // The CLI's own compaction of a Session's CLI session: 'done', or 'unsupported'
  // when the CLI offers no way to ask for one (it then condenses only on its own).
  async compact(sessionId, signal) {
    return this.maintain(sessionId, signal, async (live) => {
      live.state = 'running'
      // Devin says "Context compacted" after the compaction ends, when no prompt runs.
      live.mute = true
      const sent = live.engine.compact?.(live.engineSession) === true
      if (!sent) {
        live.state = 'idle'
        return 'unsupported'
      }
      live.scheduleIdle()
      this.meter(live, await this.collect(live, () => this.take(live), signal, { compaction: true }))
      return 'done'
    })
  }

  // One prompt in a Session's own CLI session, which has the whole conversation in
  // context, answered with text and no tools: the handoff note.
  async note(sessionId, text, signal) {
    let promptDispatched = false
    try {
      return await this.maintain(sessionId, signal, async (live) => {
        await this.sendInput(live, text, signal)
        promptDispatched = true
        return this.meter(live, await this.collect(live, () => this.take(live), signal)).text
      })
    } catch (error) {
      if (error && typeof error === 'object') error.reachedCli = promptDispatched
      throw error
    }
  }

  // Runs `work` on a Session's CLI session while no turn uses it. A CLI session the
  // Session has no process for is opened for it and let go of after, so the next turn
  // opens it again with its own tools and instructions.
  async maintain(sessionId, signal, work) {
    let live = this.live.get(sessionId)
    const record = live === undefined ? this.deps.record(sessionId) : undefined
    if (live === undefined && record?.cliSessionId === undefined) throw new LlmError('this conversation has no session of its local agent yet', 'LOCAL_AGENT_ERROR')
    if (live?.spec.kind === 'codex' && live.state === 'idle' && live.pending.size === 0) {
      live = await this.liveFor({ sessionId, provider: live.route, model: live.model, signal }, this.deps.presetFor(sessionId))
    }
    let opened = false
    if (live === undefined || live.engineSession === undefined || live.engineSession.dead === true) {
      live ??= await this.liveFor({ sessionId, provider: record.route, model: record.model, signal }, this.deps.presetFor(sessionId))
      opened = true
      try {
        await this.openFor(live, sessionId)
      } catch (error) {
        await this.closeLive(live, { idle: true }).catch(() => {})
        throw error
      }
    }
    if (live.state !== 'idle' || live.pending.size > 0) {
      if (opened) await this.closeLive(live, { idle: true }).catch(() => {})
      throw new LlmError('the local agent is in the middle of a turn', 'LOCAL_AGENT_BUSY')
    }
    // What a finished turn left behind is not this request's answer.
    live.events.length = 0
    try {
      signal?.throwIfAborted()
      return await work(live)
    } finally {
      if (live.state !== 'idle') await this.stopTurn(live, 'the request was stopped')
      live.events.length = 0
      live.mute = true
      if (opened) await this.closeLive(live, { idle: true })
    }
  }

  async openFor(live, sessionId) {
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd
    const priorCliId = live.cliSessionId
    live.engineSession = await live.engine.open(sessionId, {
      cwd,
      mcp: undefined,
      resumeId: priorCliId,
      resumeOnly: priorCliId !== undefined,
      mode: cliMode(live.spec.kind, live.preset),
      preset: live.preset,
      review: this.deps.reviewFor?.(sessionId) === true,
      model: live.model,
      defaultEffort: live.record === undefined || live.record.model === live.model ? live.defaultEffort : undefined,
      effort: live.effort,
    })
      .catch(error => { throw toLlmError(error, live) })
    const reportedId = live.engineSession.acpSessionId ?? live.engineSession.threadId ?? live.engineSession.cliSessionId
    if (priorCliId !== undefined && (live.engineSession.resumed === false || (reportedId !== undefined && reportedId !== priorCliId))) {
      const opened = live.engineSession
      live.engineSession = undefined
      await live.engine.closeSession?.(opened).catch(() => {})
      live.engine.forget?.(sessionId)
      throw new LlmError('the saved local agent session could not be resumed for maintenance', 'LOCAL_AGENT_SESSION_LOST')
    }
    if (live.spec.kind === 'acp') {
      if (live.engineSession.defaultEffort !== undefined) live.defaultEffort = live.engineSession.defaultEffort
      live.effort = live.engineSession.effort
    }
    const session = live.engineSession
    const token = live.pumpToken = {}
    void (async () => {
      while (live.pumpToken === token && !live.dead) {
        const event = await session.next()
        if (live.pumpToken === token && !live.dead) live.push(event)
      }
    })()
  }

  // The next event of a live session, as a wait that can be given up: a wait left
  // behind would take the first event of the next turn.
  take(live) {
    if (live.closeFailure !== undefined) return { event: Promise.resolve(live.closeFailure), drop: () => {} }
    if (live.events.length > 0) return { event: Promise.resolve(live.events.shift()), drop: () => {} }
    let resolver
    const event = new Promise((resolve) => { resolver = resolve; live.waiters.push(resolve) })
    return { event, drop: () => { const at = live.waiters.indexOf(resolver); if (at !== -1) live.waiters.splice(at, 1) } }
  }

  // Reads a request's events to its end. Text is the answer; a tool call the CLI
  // tries is refused and a permission it asks for denied. A compaction ends when the
  // CLI says it condensed, which may come after the prompt itself ended.
  async collect(live, take, signal, { compaction = false } = {}) {
    let text = ''
    let usage
    const add = (more) => {
      if (more === undefined) return
      usage = mergeUsage(usage, more)
    }
    let ended = false
    let started = false
    let condensed = false
    let abortReject
    const aborted = new Promise((_, reject) => { abortReject = reject })
    aborted.catch(() => {})
    const onAbort = () => abortReject(signal?.reason ?? new Error('aborted'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort)
    try {
      for (;;) {
        signal?.throwIfAborted()
        if (ended && (!compaction || condensed)) {
          live.state = 'idle'
          this.flushContext(live)
          return { text, usage }
        }
        const next = take()
        const waits = [next.event, aborted]
        // Nothing said it started: the CLI condensed without a word, or not at all.
        let timer
        if (ended && !started) waits.push(new Promise((resolve) => { timer = setTimeout(() => resolve({ type: 'quiet' }), COMPACT_START_MS) }))
        let event
        try {
          event = await Promise.race(waits)
        } finally {
          clearTimeout(timer)
          next.drop()
        }
        switch (event.type) {
          case 'text': text += event.text; break
          case 'call': {
            const pending = live.pending.get(event.dshCallId)
            live.pending.delete(event.dshCallId)
            pending?.resolve({ text: NO_TOOLS, isError: true })
            break
          }
          case 'permission': event.reply(null); break
          case 'compaction':
            if (event.status === 'started') started = true
            else if (event.status === 'completed') condensed = true
            else throw new LlmError('the local agent did not condense its context', 'LOCAL_AGENT_ERROR')
            break
          case 'quiet':
            live.state = 'idle'
            this.flushContext(live)
            return { text, usage }
          case 'usage': add(event.usage); break
          case 'done':
            add(event.usage)
            ended = true
            if (!compaction) live.state = 'idle'
            break
          case 'error':
            live.state = 'idle'
            throw toLlmError(event.error, live)
          default: break
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // What a request DS Bot made for itself spent, on the Session it served.
  meter(live, result, kind = 'compaction') {
    if (result.usage !== undefined) this.deps.recordUsage?.({ sessionId: live.sessionId, kind, provider: live.route, model: live.model, usage: result.usage })
    return result
  }

  // A one-off request on the CLI a Session runs on, in a session of its own with no
  // team tools and read-only access, which is let go of after: the context steward's
  // call, and the memory review's. `route` and `model` name the CLI when the
  // request serves a Bot rather than one of its conversations.
  async ask(sessionId, { system, prompt, signal, route: named, model: namedModel, kind }) {
    if (this.disposed) throw new LlmError('the local agents adapter is disposed', 'NO_ADAPTER')
    const record = named !== undefined ? { route: named, model: namedModel } : this.live.get(sessionId) ?? this.deps.record(sessionId)
    const route = record?.route
    const spec = route === undefined ? undefined : this.specOf(route)
    if (spec === undefined) throw new LlmError('this conversation has no local agent', 'LOCAL_AGENT_MISSING')
    const isolated = spec.kind === 'codex'
    const engine = isolated ? this.deps.spawnEngine(spec.kind, route, spec) : this.engine(route)
    const request = { controller: new AbortController(), done: Promise.withResolvers(), engine, isolated }
    this.sideRequests.add(request)
    signal = AbortSignal.any([request.controller.signal, ...(signal === undefined ? [] : [signal])])
    const sideId = `dsbot-side-${randomUUID()}`
    let session
    let probeDir
    try {
      signal.throwIfAborted()
      probeDir = this.deps.probeCwd()
      session = await engine.open(sideId, {
        cwd: probeDir, mcp: undefined, mode: cliMode(spec.kind, 'read-only'), preset: 'read-only', model: record.model, ephemeral: true,
        instructions: spec.kind === 'codex' ? system : undefined,
        system: spec.kind === 'claude' ? system : undefined,
      }).catch(error => { throw toLlmError(error, { spec }) })
      signal.throwIfAborted()
      const side = { state: 'running', pending: new Map(), spec }
      // A decision needs no long thinking: the least the model offers, when it lists any.
      const efforts = (this.modelCache.get(route) ?? []).find(model => model.id === record.model)?.reasoning?.efforts ?? []
      const effort = efforts.some(entry => entry.id === 'off') ? 'off' : efforts[0]?.id
      // An ACP prompt resolves only when its turn ends, and its events wait in the
      // queue; a prompt the CLI refuses ends the request at once.
      const refused = Promise.resolve(engine.prompt(session, [{ type: 'text', text: spec.kind === 'acp' ? `${system}\n\n${prompt}` : prompt }], { signal, effort }))
        .then(() => new Promise(() => {}), error => ({ type: 'error', error }))
      const result = await this.collect(side, () => ({ event: Promise.race([session.next(), refused]), drop: () => {} }), signal)
      return this.meter({ sessionId, route, model: record.model }, result, kind).text
    } finally {
      try {
        if (session !== undefined) {
          if (signal.aborted) await engine.cancel?.(session)
          await engine.closeSession?.(session)
        }
      } finally {
        engine.forget?.(sideId)
        if (isolated || !this.engineInUse(engine, request)) await engine.close?.().catch(() => {})
        await cleanupProbeDir(probeDir)
        this.sideRequests.delete(request)
        request.done.resolve()
      }
    }
  }

  async dispose() {
    this.disposed = true
    const requests = [...this.sideRequests]
    for (const request of requests) request.controller.abort(new LlmError('the local agents adapter is disposed', 'NO_ADAPTER'))
    await Promise.all([...new Set(requests.map(request => request.engine))].map(engine => engine.close?.().catch(() => {})))
    await Promise.all(requests.map(request => request.done.promise))
    for (const live of Array.from(this.live.values())) await this.closeLive(live)
    for (const engine of Array.from(this.engines.values())) await engine.close?.().catch(() => {})
    this.engines.clear()
  }
}

// The result DSH gives approve_agent_action decides the agent's option: only
// the structured {"decision":"allow"} the tool returns on approval counts;
// free text, a parse failure, an error or a denial rejects the action.
function pickAllowOption(options, result) {
  if (result.isError === true) return null
  let decision
  try { decision = JSON.parse(result.text ?? '')?.decision } catch { decision = undefined }
  if (decision !== 'allow') return null
  return (options ?? []).find(entry => entry.kind === 'allow_once')?.optionId ?? null
}

// The agent's one-time option of a kind ('allow' or 'reject'), else any of it.
// A one-time allow leaves the agent's own saved rules as they were.
const optionOf = (options, kind) => ((options ?? []).find(entry => entry.kind === `${kind}_once`)
  ?? (options ?? []).find(entry => (entry.kind ?? '').startsWith(kind)))?.optionId

// What the preset answers without asking: an option id, null to refuse, or
// undefined to ask the user.
function presetAnswer(preset, event) {
  if (preset === 'danger-full-access') return optionOf(event.options, 'allow')
  if (preset === 'read-only' && event.changes === true) return optionOf(event.options, 'reject') ?? null
  return undefined
}

// Collapse consecutive text blocks with paragraph breaks while keeping non-text blocks in place.
function mergeTextBlocks(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text === '') continue
      const prev = out.at(-1)
      if (prev?.type === 'text') prev.text = `${prev.text}\n\n${block.text}`
      else out.push({ type: 'text', text: block.text })
    } else {
      out.push(block)
    }
  }
  return out
}

const REPLAY_ARG_KEYS = ['path', 'file_path', 'file', 'command', 'cmd', 'query', 'pattern', 'url', 'to', 'task', 'topic']

function briefToolCall(block) {
  const name = typeof block?.name === 'string' ? block.name : 'tool'
  let args = block?.arguments ?? block?.input
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = undefined }
  }
  if (args !== null && typeof args === 'object') {
    for (const key of REPLAY_ARG_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') {
        const clean = value.replace(/\s+/g, ' ').trim()
        return `[tool: ${name}(${clean.length > 100 ? `${clean.slice(0, 100)}…` : clean})]`
      }
    }
  }
  return `[tool: ${name}]`
}

async function blocksOfMessage(message, { maxBytes, maxText, resolveImage, includeToolCalls = false }) {
  const raw = Array.isArray(message.content) ? message.content : []
  const out = []
  let textParts = []
  const byteCap = maxBytes ?? maxText ?? Infinity
  let bytesLeft = byteCap
  const flushText = () => {
    const text = textParts.join('\n').trim()
    textParts = []
    if (text !== '') out.push({ type: 'text', text })
  }
  for (const block of raw) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const piece = bytesLeft === Infinity ? block.text : truncateUtf8Bytes(block.text, bytesLeft, '')
      if (bytesLeft !== Infinity) bytesLeft = Math.max(0, bytesLeft - utf8Bytes(piece))
      textParts.push(piece)
    } else if (includeToolCalls && block?.type === 'tool-call') {
      const note = briefToolCall(block)
      const piece = bytesLeft === Infinity ? note : truncateUtf8Bytes(note, bytesLeft, '')
      if (bytesLeft !== Infinity) bytesLeft = Math.max(0, bytesLeft - utf8Bytes(piece))
      if (piece !== '') textParts.push(piece)
    } else if (block?.type === 'image') {
      flushText()
      out.push(await resolveImage(block))
    }
  }
  flushText()
  return out
}

// Stages context-only delta messages on `live.pendingContext`: snapshot-style
// context (clock updates, group memory snapshots) keeps only the latest entry per
// source kind, while notices and incremental updates stay ordered.
function stagePendingContext(live, messages) {
  live.pendingContext ??= []
  for (const message of messages) {
    const text = textOf(message.content)
    if (text === '') continue
    const id = message.id
    const kind = message.source?.kind
    if (isSnapshotContextSource(message.source)) {
      const key = kind ?? 'snapshot'
      live.pendingContext = live.pendingContext.filter(entry => entry.key !== key && (id === undefined || entry.id !== id))
      live.pendingContext.push({ ...(id === undefined ? {} : { id }), key, ...(kind === undefined ? {} : { kind }), text })
    } else {
      if (id !== undefined && live.pendingContext.some(entry => entry.id === id)) continue
      live.pendingContext.push({ ...(id === undefined ? {} : { id }), ...(kind === undefined ? {} : { kind }), text })
    }
  }
}

async function renderDelta(contextText, remaining, resolveImage) {
  const parts = []
  if (contextText !== '') parts.push({ type: 'text', text: contextText })
  for (const message of remaining) {
    parts.push(...await blocksOfMessage(message, { resolveImage }))
  }
  return mergeTextBlocks(parts)
}

function applyFreshMemory(system, freshMemory) {
  if (freshMemory === undefined) return { system, note: '' }
  if (freshMemory.previous !== undefined && system.includes(freshMemory.previous)) {
    const updated = system.replace(freshMemory.previous, () => freshMemory.own)
    return {
      system: updated,
      note: updated === system ? '' : 'Note: The "# Your memory" section above reflects current memory and supersedes any earlier memory snapshot or updates.',
    }
  }
  if (!system.includes(OWN_HEADING)) {
    // Dynamic resident memory lives in part-opening snapshot messages rather than
    // the system prompt; renderReplay places freshMemory.own directly in the replay.
    return { system, note: '' }
  }
  if (system.includes(freshMemory.own)) return { system, note: '' }
  return {
    system,
    note: `Current memory (supersedes any earlier memory section or updates):\n${freshMemory.own}`,
  }
}

// The replay a fresh CLI session stands up on: optional team instructions (for ACP),
// then the recent messages rendered as text and images, newest first, always keeping
// the current unread input, the latest memory snapshots, and the latest handoff word
// for word while bounding historical messages and incremental memory updates.
async function renderReplay(messages, system, resolveImage, { preserve = [], freshMemory, memoryNote = '', includeSystem = true } = {}) {
  return buildReplayPack({
    messages,
    system,
    resolveImage,
    blocksOfMessage,
    mergeTextBlocks,
    preserve,
    freshMemory,
    memoryNote,
    includeSystem,
    isClockSource,
    ownMemorySource: OWN_MEMORY_SOURCE,
    groupMemorySource: GROUP_MEMORY_SOURCE,
    memoryUpdateSource: MEMORY_UPDATE_SOURCE,
    ownHeading: OWN_HEADING,
    limits: {
      messages: REPLAY_MESSAGES,
      totalMax: REPLAY_TOTAL_MAX,
      bytes: REPLAY_BYTES,
      lineMax: REPLAY_LINE_MAX,
      memoryUpdateMax: MEMORY_UPDATE_REPLAY_MAX,
      memoryUpdateBytes: MEMORY_UPDATE_REPLAY_BYTES,
    },
  })
}

// Process exits, missing CLIs, quota and sign-in failures get typed codes so DS
// Bot's repair card can act on them.
function toLlmError(error, live) {
  if (error instanceof LlmError) return error
  const upstream = [error?.data?.error, error?.data].filter(value => value !== null && typeof value === 'object' && !Array.isArray(value))
  const text = [...new Set([errorText(error), ...upstream.flatMap(value => [value.message, value.detail]).filter(nonEmptyString)])].join('\n')
  const upstreamCode = upstream.map(value => value?.code).find(nonEmptyString)
  const status = [...upstream, error].map(value => value?.status).find(value => Number.isInteger(value) && value >= 100 && value <= 599)
  // Classify auth and explicit rate-limit/quota (including TPM "too many tokens per minute")
  // BEFORE context-window overflow so rate limits never trigger an unnecessary part switch.
  const rateLimitOrQuota = status === 429
    || /\brate[\s_-]?limit\b|too many requests|tokens per minute|\btpm\b|\brpm\b|requests per minute|\bquota\b|usage limit|insufficient[\s_-]?balance|credit balance|\bbilling\b/i.test(text)
    || isQuotaExceededError(text)
  // Reuse DSH's canonical overflow matcher without the ambiguous "too many tokens" clause.
  const overflow = isContextWindowExceededError(text)
    || /prompt is too long|context.?(?:window|length).?(?:exceeded|is full)|context_length_exceeded|exceeds the (?:model's )?(?:maximum )?context/i.test(text)
  const code = error?.code === 'NO_ADAPTER' ? 'LOCAL_AGENT_MISSING'
    : upstreamCode !== undefined ? repairCode(upstreamCode) ?? upstreamCode
      : repairCode(error?.code) ?? (
        /not signed in|not logged in|login required|unauthorized|authentication|auth failed/i.test(text) ? 'LOCAL_AGENT_SIGNIN'
          : rateLimitOrQuota ? 'LOCAL_AGENT_QUOTA'
            : overflow ? 'CONTEXT_WINDOW_EXCEEDED'
              : /exited|spawn|ENOENT/i.test(text) ? 'LOCAL_AGENT_EXIT'
                : nonEmptyString(error?.code) ? error.code : 'LOCAL_AGENT_ERROR')
  const hint = code === 'LOCAL_AGENT_SIGNIN' ? ` Sign in with: ${signInFor(live?.spec, live?.engine?.bin) ?? `${live?.spec?.command ?? 'the CLI'} login`}.` : ''
  const rpcCode = code === 'LOCAL_AGENT_ERROR' && typeof error?.code === 'number' ? ` (JSON-RPC ${error.code})` : ''
  return new LlmError(`${text}${rpcCode}${hint}`, code, status === undefined ? {} : { status })
}

function repairCode(code) {
  switch (typeof code === 'string' ? code.toLowerCase().replace(/-/g, '_') : undefined) {
    case 'auth_failed':
    case 'unauthorized':
    case 'unauthenticated':
    case 'authentication_failed':
    case 'not_logged_in':
      return 'LOCAL_AGENT_SIGNIN'
    case 'rate_limit':
    case 'rate_limit_exceeded':
    case 'too_many_requests':
    case 'quota_exceeded':
    case 'insufficient_quota':
    case 'usage_limit_exceeded':
      return 'LOCAL_AGENT_QUOTA'
    case 'context_length_exceeded':
    case 'context_window_exceeded':
      return 'CONTEXT_WINDOW_EXCEEDED'
    case 'local_agent_session_lost':
      return 'LOCAL_AGENT_SESSION_LOST'
    default:
      return undefined
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

// JSON-RPC errors carry numeric codes and may arrive as plain objects; LlmError
// needs a non-empty string message and code, or it throws and hides the cause.
function errorText(error) {
  const message = error?.message
  if (typeof message === 'string' && message !== '') return message
  if (typeof error === 'string' && error !== '') return error
  if (message !== undefined && message !== null && typeof message !== 'string') return safeJson(message)
  if (error !== null && typeof error === 'object' && !(error instanceof Error)) return safeJson(error)
  if (error !== undefined && error !== null && typeof error !== 'object' && error !== '') return String(error)
  return 'The local agent failed without an error message.'
}

function safeJson(value) {
  try { return JSON.stringify(value) || String(value) } catch { return String(value) }
}

const USAGE_ADDITIVE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const usageCallCount = usage => (Number.isSafeInteger(usage?.calls) && usage.calls > 0 ? usage.calls : 1)

// Sums billed token fields and internal model call counts across multiple usage
// chunks in one DSH step (Codex multi-step turns, ACP queued prompts). Single-call
// records omit `calls` so existing single-step consumers see the exact same shape.
export function mergeUsage(prev, more) {
  if (more === undefined || more === null) return prev
  if (prev === undefined || prev === null) {
    const calls = usageCallCount(more)
    const next = { ...more }
    if (calls <= 1) delete next.calls
    else next.calls = calls
    return next
  }
  const next = {}
  for (const key of USAGE_ADDITIVE_KEYS) {
    if (prev[key] !== undefined || more[key] !== undefined) next[key] = (prev[key] ?? 0) + (more[key] ?? 0)
  }
  if (prev.totalTokens !== undefined && more.totalTokens !== undefined) next.totalTokens = prev.totalTokens + more.totalTokens
  const calls = usageCallCount(prev) + usageCallCount(more)
  if (calls > 1) next.calls = calls
  return next
}
