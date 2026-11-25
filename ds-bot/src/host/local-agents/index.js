// Local agents: ordinary Bots whose model route is a local agent CLI (Devin
// CLI, Claude Code, Codex, ACP agents). install() scans for the CLIs, registers
// one DSH LLM adapter for the routes it found, keeps the custom agents and the
// Session→CLI-session map in state, and serves the Settings page.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serviceOf } from '../services.js'
import { splitRef } from '../text.js'
import { output } from '../tools.js'
import { LocalAgentAdapter } from './adapter.js'
import { AcpEngine } from './acp.js'
import { CodexEngine } from './codex.js'
import { ClaudeEngine } from './claude.js'
import {
  ENGINES,
  customRoute,
  defaultProfileDir,
  engineOf as engineSpecOf,
  ensureProfileDir,
  isLocalAgentRoute,
  isValidProfileId,
  profileRoute,
  signInFor,
  signedInFor,
  splitProfileRoute,
  supportsProfiles,
  validateCustom,
  validateProfile,
  validateProfileDirUnique,
} from './engines.js'
import { findEngineExecutable, findExecutable, probeEnv, probeSignIn, probeVersion, refreshSearchDirs } from './discover.js'

const SIGNED_IN_TTL_MS = 60_000
const SIGNED_IN_RETRY_MS = 20_000
const VERSION_FAIL_TTL_MS = 30_000
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const FORBIDDEN_WINDOW_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const safeWindowKey = value => typeof value === 'string' && value !== '' && !FORBIDDEN_WINDOW_KEYS.has(value)

export function parseCliSemver(raw) {
  if (typeof raw !== 'string') return undefined
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

// Capability detection for native CLI session fork based on probed CLI version:
// - Codex app-server v2 supports `thread/fork` (>= 0.80.0)
// - Claude Code supports `--resume <id> --fork-session` (>= 2.0.0)
// - ACP has no standard session fork RPC
export function versionSupportsFork(kind, version) {
  const semver = parseCliSemver(version)
  if (semver === undefined) return false
  if (kind === 'codex') return semver.major > 0 || semver.minor >= 80
  if (kind === 'claude') return semver.major >= 2
  return false
}

// The preset a Session runs on: its group's, else its Bot's, else DSH's default — the one
// a Bot without a preset of its own is shown with (permissions.js keeps it applied to the
// Session). A hard-coded workspace-write made a local agent open in a stricter mode than
// the setting the user saw, so its tool calls went through the CLI's permission prompt
// instead of the mode they asked for (#1539).
export function presetOf(rt, sessionId) {
  const bot = rt.botOf(rt.selfOf(sessionId))
  const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId ?? rt.taskOwners?.get(sessionId)?.roomId)
  // Approval review is DS Bot's own policy, not a sandbox preset: the Session
  // runs on workspace-write while the review policy does the asking.
  const permission = room?.permission ?? bot?.permission ?? rt.permissionCatalog?.()?.defaultPreset ?? 'workspace-write'
  return permission === 'review' ? 'workspace-write' : permission
}

const spawnEngine = (kind, route, spec) => (kind === 'acp' ? new AcpEngine(route, spec, { findExecutable })
  : kind === 'codex' ? new CodexEngine(route, spec, { findExecutable })
    : new ClaudeEngine(route, spec, { findExecutable }))

export function install(rt, { probeSignIn: checkSignIn = probeSignIn, probeVersion: checkVersion = probeVersion, now = Date.now } = {}) {
  const { ctx, state } = rt
  const ownOf = (object, key) => (typeof rt.own === 'function'
    ? rt.own(object, key)
    : (object != null && Object.hasOwn(object, key) ? object[key] : undefined))
  // state.localAgents is replaced by the state load after install; read it
  // each time instead of holding the pre-load object.
  const store = () => {
    const live = state.localAgents ??= { custom: [], profiles: [], retiredProfiles: [], sessions: {}, windows: {} }
    live.custom ??= []
    live.profiles ??= []
    live.retiredProfiles ??= []
    live.sessions ??= {}
    if (!live.windows || typeof live.windows !== 'object' || Array.isArray(live.windows)) live.windows = {}
    return live
  }
  const dropPersistedWindows = (route) => {
    if (!safeWindowKey(route)) return
    const windows = store().windows
    if (Object.hasOwn(windows, route)) delete windows[route]
  }

  const customAgents = () => store().custom
  const profiles = () => store().profiles
  const customRouteId = () => store().custom.map(agent => customRoute(agent.id))
  const profileRouteId = () => store().profiles
    .filter(profile => ENGINES[profile?.baseRoute] !== undefined && supportsProfiles(profile.baseRoute) && isValidProfileId(profile?.id))
    .map(profile => profileRoute(profile.baseRoute, profile.id))
  const allRoutes = () => [...Object.keys(ENGINES), ...profileRouteId(), ...customRouteId()]

  // Only CLIs found on this machine get a route; the scan result feeds the page.
  const found = new Map()
  // Isolated probe state per profile route (`route -> { signedIn, signedInAt, signInProbe, signInEpoch, signInAbort }`).
  const profileProbes = new Map()
  let nextProbeEpoch = 0
  let disposed = false
  const clearProfileProbe = (route) => {
    const pState = profileProbes.get(route)
    pState?.signInAbort?.abort()
    profileProbes.delete(route)
  }
  const clearEngineProfileProbes = (baseRoute) => {
    for (const route of profileProbes.keys()) {
      if (splitProfileRoute(route)?.baseRoute === baseRoute) clearProfileProbe(route)
    }
  }
  async function scan() {
    await refreshSearchDirs()
    if (disposed) return []
    for (const route of Object.keys(ENGINES)) {
      const spec = ENGINES[route]
      const path = findEngineExecutable(spec, findExecutable)
      if (path === undefined) {
        const prev = found.get(route)
        prev?.versionAbort?.abort()
        prev?.signInAbort?.abort()
        found.delete(route)
        clearEngineProfileProbes(route)
      } else if (found.get(route)?.path !== path) {
        found.set(route, { route, name: spec.name, path, version: undefined, signIn: signInFor(spec, path) })
      }
    }
    applyRoutes()
    return [...found.values()]
  }
  async function probeEntryVersion(entry, { force = false } = {}) {
    if (entry === undefined) return
    if (!force && entry.version !== undefined) return
    if (!force && entry.versionFailedAt !== undefined && now() - entry.versionFailedAt < VERSION_FAIL_TTL_MS) return
    if (force || entry.versionProbe === undefined) {
      const epoch = ++nextProbeEpoch
      entry.versionEpoch = epoch
      entry.versionAbort?.abort()
      const controller = new AbortController()
      entry.versionAbort = controller
      const spec = ENGINES[entry.route]
      const probe = Promise.resolve()
        .then(() => checkVersion(entry.path, spec.version ?? ['--version'], probeEnv(spec.env ?? {}), { signal: controller.signal }))
        .catch(() => undefined)
        .then((result) => {
          if (entry.versionEpoch !== epoch || entry.versionProbe !== probe || found.get(entry.route) !== entry) return
          if (result?.version !== undefined) {
            entry.version = result.version
            entry.supportsFork = versionSupportsFork(spec.kind, result.version)
            delete entry.versionFailedAt
          } else {
            if (force) {
              entry.version = undefined
              entry.supportsFork = false
            }
            entry.versionFailedAt = now()
          }
        })
        .finally(() => {
          if (entry.versionProbe === probe) {
            delete entry.versionProbe
            delete entry.versionAbort
          }
        })
      entry.versionProbe = probe
    }
    while (entry.versionProbe !== undefined) {
      await entry.versionProbe
    }
  }
  async function probeVersions({ force = false } = {}) {
    await Promise.all([...found.values()].map(entry => probeEntryVersion(entry, { force })))
  }
  async function probeProfileSignIn(profile, { force = false } = {}) {
    if (ENGINES[profile?.baseRoute] === undefined || !isValidProfileId(profile?.id)) return
    const route = profileRoute(profile.baseRoute, profile.id)
    const baseFound = found.get(profile.baseRoute)
    if (baseFound === undefined || !supportsProfiles(profile.baseRoute)) {
      clearProfileProbe(route)
      return
    }
    const spec = engineSpecOf(route, [], store().profiles, { home: rt.home })
    let entry = profileProbes.get(route)
    if (entry === undefined) {
      entry = {}
      profileProbes.set(route, entry)
    }
    const check = signedInFor(spec, baseFound.path)
    if (check === undefined) {
      entry.signedIn = null
      return
    }
    if (!force) {
      const ttl = entry.signedIn === null ? SIGNED_IN_RETRY_MS : SIGNED_IN_TTL_MS
      if (entry.signedIn !== undefined && now() - entry.signedInAt < ttl) return
    }
    if (force || entry.signInProbe === undefined) {
      const epoch = ++nextProbeEpoch
      entry.signInEpoch = epoch
      entry.signInAbort?.abort()
      const controller = new AbortController()
      entry.signInAbort = controller
      const probe = Promise.resolve()
        .then(() => checkSignIn(baseFound.path, check, { extraEnv: spec.env, isolated: true, signal: controller.signal }))
        .catch(() => null)
        .then((result) => {
          if (entry.signInEpoch !== epoch || entry.signInProbe !== probe || profileProbes.get(route) !== entry) return
          entry.signedIn = result
          entry.signedInAt = now()
        })
        .finally(() => {
          if (entry.signInProbe === probe) {
            delete entry.signInProbe
            delete entry.signInAbort
          }
        })
      entry.signInProbe = probe
    }
    while (entry.signInProbe !== undefined) {
      await entry.signInProbe
    }
  }

  // Asked only when the list of CLIs is about to show, never at start or for a menu.
  async function probeSignIns({ force = false } = {}) {
    await Promise.all([
      ...[...found.values()].map(async (entry) => {
        const check = signedInFor(ENGINES[entry.route], entry.path)
        if (check === undefined) {
          entry.signedIn = null
          return
        }
        if (!force) {
          const ttl = entry.signedIn === null ? SIGNED_IN_RETRY_MS : SIGNED_IN_TTL_MS
          if (entry.signedIn !== undefined && now() - entry.signedInAt < ttl) return
        }
        if (force || entry.signInProbe === undefined) {
          const epoch = ++nextProbeEpoch
          entry.signInEpoch = epoch
          entry.signInAbort?.abort()
          const controller = new AbortController()
          entry.signInAbort = controller
          const probe = Promise.resolve()
            .then(() => checkSignIn(entry.path, check, { signal: controller.signal }))
            .catch(() => null)
            .then((result) => {
              if (entry.signInEpoch !== epoch || entry.signInProbe !== probe || found.get(entry.route) !== entry) return
              entry.signedIn = result
              entry.signedInAt = now()
            })
            .finally(() => {
              if (entry.signInProbe === probe) {
                delete entry.signInProbe
                delete entry.signInAbort
              }
            })
          entry.signInProbe = probe
        }
        while (entry.signInProbe !== undefined) {
          await entry.signInProbe
        }
      }),
      ...store().profiles.map(profile => probeProfileSignIn(profile, { force })),
    ])
  }
  // A signed-out CLI or a slow one never holds back the list for long: each check is bounded.
  async function freshList({ forceSignIn = false, forceVersion = forceSignIn } = {}) {
    await Promise.all([probeVersions({ force: forceVersion }), probeSignIns({ force: forceSignIn })])
    return { available: supported(), detected: detected(), profiles: profilesView(), custom: customView() }
  }

  const adapter = new LocalAgentAdapter({
    rt,
    home: rt.home,
    customAgents,
    profiles,
    findExecutable,
    spawnEngine,
    prepareSecretEnvForSession: (sessionId, signal) => rt.prepareSecretEnvForSession?.(sessionId, signal),
    secretEnvForSession: sessionId => rt.secretEnvForSession?.(sessionId),
    usedModels: route => usedRefs().map(ref => splitRef(ref)).filter(used => used?.provider === route).map(used => used.model),
    record: sessionId => store().sessions[sessionId],
    saveRecord: (sessionId, record) => {
      store().sessions[sessionId] = record
      void rt.save().catch(() => {})
    },
    recordUsage: entry => rt.recordUsage?.(entry),
    savedWindow: (route, model) => {
      if (!safeWindowKey(route) || !safeWindowKey(model)) return undefined
      const byRoute = ownOf(store().windows, route)
      if (!byRoute || typeof byRoute !== 'object' || Array.isArray(byRoute)) return undefined
      return ownOf(byRoute, model)
    },
    saveWindow: (route, model, size) => {
      if (!safeWindowKey(route) || !safeWindowKey(model)) return
      const windows = store().windows
      let byRoute = ownOf(windows, route)
      if (!byRoute || typeof byRoute !== 'object' || Array.isArray(byRoute)) {
        byRoute = Object.create(null)
        windows[route] = byRoute
      }
      if (ownOf(byRoute, model) === size) return
      byRoute[model] = size
      rt.contextRuntime?.clearWindowCache?.()
      void rt.save().catch(() => {})
    },
    // A change that rides along with the next save: the CLI reports its context on
    // every model call.
    patchRecord: (sessionId, patch) => {
      const record = store().sessions[sessionId]
      if (record !== undefined) Object.assign(record, patch)
    },
    presetFor: sessionId => presetOf(rt, sessionId),
    freshMemoryView: sessionId => rt.freshMemoryView?.(sessionId),
    onCompaction: (sessionId, info) => {
      rt.contextRuntime?.bumpEpoch(sessionId, info?.reason ?? 'cli-compaction')
      if (info?.reason === 'resume-dropped' && Number.isInteger(info?.compactions)) {
        rt.contextRuntime?.setCliCompactions(sessionId, info.compactions)
      }
      rt.renewMemory?.(sessionId)
    },
    switchOnResumeLost: sessionId => rt.isBotSession?.(sessionId) === true && rt.readOnly?.() === undefined,
    cwdFor: async (sessionId) => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        return agent.session.header?.cwd ?? rt.workDirOf?.({ botId: rt.selfOf(sessionId), roomId: rt.groupOwners.get(sessionId)?.roomId ?? rt.taskOwners?.get(sessionId)?.roomId }) ?? rt.teamFolder?.() ?? tmpdir()
      } catch {
        return rt.teamFolder?.() ?? tmpdir()
      }
    },
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: (options, sessionId = options?.sessionId) => {
      // Only DS Bot's own team tools cross the bridge; the CLI keeps its own.
      // Read live scoped schemas from the active Agent when available so
      // `notifications/tools/list_changed` immediately serves fresh tools/list
      // without waiting for the next adapter.stream() turn.
      const names = new Set([...rt.teamTools.map(def => def.name), 'approve_agent_action'])
      const liveAgent = sessionId === undefined ? undefined : ctx.get?.('agents')?.get?.(sessionId)
      const schemas = liveAgent !== undefined && typeof ctx.tools?.schemas === 'function'
        ? ctx.tools.schemas(liveAgent)
        : (options?.tools ?? [])
      return schemas.filter(tool => names.has(tool.name))
    },
  })

  let registration
  let registeredRoutes = new Set()
  const llm = () => serviceOf(ctx, 'llm')
  const supported = () => typeof llm()?.registerAdapter === 'function'
  const usedRefs = () => [...new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel]).filter(Boolean))]
  // A route a Bot runs on stays registered when its CLI goes away: the turn then fails
  // with the repair card, and nothing moves the Bot to another run mode by itself.
  const activeProfileRoutes = () => profileRouteId().filter(route => found.has(splitProfileRoute(route).baseRoute))
  const servedRoutes = () => [...new Set([...found.keys(), ...activeProfileRoutes(), ...customRouteId(), ...usedRefs().map(ref => splitRef(ref)?.provider).filter(isLocalAgentRoute)])]
  function applyRoutes() {
    if (!supported()) return
    const candidates = servedRoutes()
    if (registration === undefined && candidates.length === 0) return
    const taken = new Set(llm().listProviders().map(provider => provider.id).filter(route => !registeredRoutes.has(route)))
    const routes = candidates.filter(route => {
      if (!taken.has(route)) return true
      rt.warn?.('ds-bot: skipping local agent route "%s": another adapter is registered', route)
      return false
    })
    // The initial registration needs at least one provider; an empty replace
    // is legal and keeps the adapter registered with zero routes.
    if (registration === undefined) {
      if (routes.length === 0) return
      registration = llm().registerAdapter(routes, adapter)
    } else registration.replace(routes)
    registeredRoutes = new Set(routes)
  }
  // Custom agents hold a route whether or not their command resolves yet; a
  // missing one fails at prompt time with a typed error.
  try { applyRoutes() } catch (error) { rt.warn?.('ds-bot: initial local agent registration failed: %s', error) }
  const initialScan = scan().catch(error => rt.warn?.('ds-bot: initial local agent scan failed: %s', error))
  // Custom agents arrive with the state load; their routes register then too.
  void rt.load?.().then(() => { if (!disposed) applyRoutes() }).catch(() => {})
  const prevSecretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    prevSecretsChanged?.()
    if (!disposed) void adapter.secretsChanged?.().catch(() => {})
  }
  const offAdopted = rt.onAdopted?.(() => {
    adapter.dropWindows()
    rt.contextRuntime?.clearWindowCache?.()
  })
  // The callback returns the disposer: running adapter.dispose() inside the
  // setup would leave the adapter disposed from the moment it installs.
  ctx.effect(() => async () => {
    disposed = true
    offAdopted?.()
    for (const entry of found.values()) {
      entry.versionAbort?.abort()
      entry.signInAbort?.abort()
    }
    for (const entry of profileProbes.values()) {
      entry.signInAbort?.abort()
    }
    profileProbes.clear()
    registration?.()
    await Promise.all([initialScan, adapter.dispose()])
  }, 'ds-bot: local agents')

  // ---------------------------------------------------------------------------
  // Helpers the rest of the host asks.

  const isLocalAgentRef = ref => isLocalAgentRoute(splitRef(ref)?.provider ?? '')
  // What a ref runs on: the local agent's route, or 'model' for DS Bot's own models.
  // Two refs with the same answer share a conversation; two with different ones never do.
  const engineOf = (ref) => {
    if (!ref) return undefined
    return isLocalAgentRef(ref) ? splitRef(ref).provider : 'model'
  }
  // The model the Bot asked for decides, not the one last applied, which lags behind it.
  const engineOfBot = bot => engineOf(bot?.model ?? bot?.appliedModel)
  const localAgentOf = (bot) => {
    const ref = bot?.model ?? bot?.appliedModel
    return ref !== undefined && isLocalAgentRef(ref) ? ref : undefined
  }
  const isLocalAgentSession = (sessionId) => {
    const bot = rt.botOf(rt.selfOf(sessionId))
    return bot !== undefined && localAgentOf(bot) !== undefined
  }

  // ---------------------------------------------------------------------------
  // approve_agent_action: served only to abot sessions; the CLI's permission
  // prompts arrive through it as an ordinary approval card. It stays off
  // rt.teamTools (the catalog every Bot gets) and joins the scope only for a
  // local-agent Bot.

  rt.localAgentTools = [defineTool({
    name: 'approve_agent_action',
    description: 'Ask the user to approve an action you want to take: running a command, changing files, or reaching the network. The agent runtime asks this on your behalf when its own permission system wants a decision.',
    parameters: {
      action: { type: 'string', required: true, description: 'What the action does, in one line' },
      detail: { type: 'string', description: 'The exact command, paths, or arguments, when it helps the decision' },
    },
    output,
    localAgentOnly: true,
    async execute(args, exec) {
      const approval = ctx.get?.('approval')
      if (approval === undefined || exec.agent?.session === undefined) return 'denied: approvals are not available here'
      const text = `${args.action}${args.detail ? `\n${args.detail}` : ''}`
      const request = {
        agent: exec.agent,
        toolName: exec.name,
        ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
        reason: text.slice(0, 500),
        displayReason: { en: text.slice(0, 500) },
        ...(exec.signal ? { signal: exec.signal } : {}),
      }
      const evidence = adapter.approvalEvidence(exec.agent.session.id, exec.callId)
      const outcome = await (rt.requestActionApproval
        ? rt.requestActionApproval(request, evidence)
        : approval.request(request))
      // The adapter decides the CLI's option from this structured result;
      // only an explicit {"decision":"allow"} counts.
      return JSON.stringify({ decision: outcome === 'allowed-once' ? 'allow' : 'deny' })
    },
  })]

  // ---------------------------------------------------------------------------
  // The Settings page's endpoints.

  const detected = () => [...found.values()].filter(entry => registeredRoutes.has(entry.route)).map(entry => ({ route: entry.route, name: entry.name, path: entry.path, version: entry.version ?? null, signIn: entry.signIn, signedIn: entry.signedIn ?? null, supportsProfiles: supportsProfiles(entry.route) }))
  const profileViewOf = (profile) => {
    const route = profileRoute(profile.baseRoute, profile.id)
    const baseFound = found.get(profile.baseRoute)
    const spec = engineSpecOf(route, [], store().profiles, { home: rt.home })
    const pState = profileProbes.get(route)
    return {
      id: profile.id,
      baseRoute: profile.baseRoute,
      route,
      name: profile.name,
      displayName: spec?.name ?? `${ENGINES[profile.baseRoute]?.name ?? profile.baseRoute} (${profile.name})`,
      configDir: spec?.profileDir ?? profile.configDir ?? null,
      customConfigDir: profile.configDir ?? null,
      env: profile.env ?? {},
      available: Boolean(baseFound && registeredRoutes.has(route)),
      path: baseFound?.path ?? null,
      version: baseFound?.version ?? null,
      signIn: signInFor(spec, baseFound?.path),
      signedIn: baseFound ? (pState?.signedIn ?? null) : null,
    }
  }
  const profilesView = () => store().profiles
    .filter(profile => ENGINES[profile?.baseRoute] !== undefined && isValidProfileId(profile?.id))
    .map(profileViewOf)
  const customView = () => store().custom.map(agent => ({ ...agent, route: customRoute(agent.id), available: registeredRoutes.has(customRoute(agent.id)) }))

  const findProfile = (body) => {
    if (typeof body?.route === 'string' && body.route.trim() !== '') {
      const split = splitProfileRoute(body.route.trim())
      if (split === null) return { index: -1, entry: undefined }
      const index = store().profiles.findIndex(profile => profile?.baseRoute === split.baseRoute && profile?.id === split.profileId)
      return { index, entry: index === -1 ? undefined : store().profiles[index] }
    }
    const baseRoute = typeof body?.baseRoute === 'string' ? body.baseRoute.trim() : ''
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (baseRoute === '' || id === '') return { index: -1, entry: undefined }
    const index = store().profiles.findIndex(profile => profile?.baseRoute === baseRoute && profile?.id === id)
    return { index, entry: index === -1 ? undefined : store().profiles[index] }
  }

  const clearRouteSessions = (route) => {
    const sessions = store().sessions
    for (const [sessionId, record] of Object.entries(sessions)) {
      if (record?.route === route) delete sessions[sessionId]
    }
  }

  // Collects active, retired, and Bot-referenced profile IDs for a base CLI route
  // so removing and recreating a profile never silently rebinds an existing Bot.
  const reservedProfileIds = (baseRoute) => {
    const activeIds = new Set(
      store().profiles
        .filter(profile => profile?.baseRoute === baseRoute && typeof profile.id === 'string')
        .map(profile => profile.id),
    )
    const retiredOrReferencedIds = new Set()
    for (const route of store().retiredProfiles) {
      const split = splitProfileRoute(route)
      if (split?.baseRoute === baseRoute) retiredOrReferencedIds.add(split.profileId)
    }
    for (const ref of usedRefs()) {
      const split = splitProfileRoute(splitRef(ref)?.provider)
      if (split?.baseRoute === baseRoute) retiredOrReferencedIds.add(split.profileId)
    }
    const allIds = new Set([...activeIds, ...retiredOrReferencedIds])
    return { activeIds, retiredOrReferencedIds, allIds }
  }

  // One CLI's models: the first look starts that CLI, later ones read what it said.
  const localAgentModels = route => (registeredRoutes.has(route) ? adapter.probeModels(route) : Promise.resolve([]))

  async function localAgentsEndpoint(endpoint, body) {
    switch (endpoint) {
      case 'local-agents': {
        await scan()
        return freshList()
      }
      case 'local-agent-refresh': {
        adapter.dropModelCache()
        await scan()
        await rt.catalog?.({ fresh: true })
        return freshList({ forceSignIn: true, forceVersion: true })
      }
      case 'local-agent-models': {
        const models = await localAgentModels(String(body.route ?? ''))
        await rt.catalog?.({ fresh: true })
        return models
      }
      case 'local-agent-add': {
        const clean = validateCustom(body)
        await refreshSearchDirs()
        if (findExecutable(clean.command) === undefined && !clean.command.includes('/') && !clean.command.includes('\\')) {
          throw new Error(`No program named ${clean.command} was found`)
        }
        const entry = { id: `agent-${Date.now().toString(36)}`, ...clean }
        store().custom.push(entry)
        applyRoutes()
        await rt.save()
        return { ...entry, route: customRoute(entry.id) }
      }
      case 'local-agent-update': {
        const entry = store().custom.find(agent => agent.id === body.id)
        if (entry === undefined) throw new Error('Unknown agent')
        const clean = validateCustom({ name: body.name ?? entry.name, command: body.command ?? entry.command, args: body.args ?? entry.args })
        const route = customRoute(entry.id)
        const launchChanged = clean.command !== entry.command || JSON.stringify(clean.args) !== JSON.stringify(entry.args)
        Object.assign(entry, clean)
        adapter.dropModelCache(route)
        if (launchChanged) {
          dropPersistedWindows(route)
          adapter.dropWindows(route)
          rt.contextRuntime?.clearWindowCache?.()
        }
        await rt.save()
        return { ...entry, route }
      }
      case 'local-agent-remove': {
        const at = store().custom.findIndex(agent => agent.id === body.id)
        if (at === -1) throw new Error('Unknown agent')
        const [removed] = store().custom.splice(at, 1)
        const route = customRoute(removed.id)
        dropPersistedWindows(route)
        adapter.dropModelCache(route)
        adapter.dropWindows(route)
        rt.contextRuntime?.clearWindowCache?.()
        applyRoutes()
        await rt.save()
        return customView()
      }
      case 'local-agent-profile-add': {
        const baseRoute = String(body?.baseRoute ?? '').trim()
        const { activeIds, retiredOrReferencedIds, allIds } = reservedProfileIds(baseRoute)
        const clean = validateProfile(body ?? {}, { existingIds: allIds })
        if (activeIds.has(clean.id)) throw invalid(`A profile with ID "${clean.id}" already exists for ${ENGINES[clean.baseRoute].name}`)
        if (retiredOrReferencedIds.has(clean.id)) {
          throw invalid(`Profile ID "${clean.id}" for ${ENGINES[clean.baseRoute].name} was previously removed or is still referenced by a Bot; choose a different ID`)
        }
        const managed = clean.configDir === undefined
        const dir = clean.configDir ?? defaultProfileDir(rt.home, clean.baseRoute, clean.id)
        validateProfileDirUnique(clean.baseRoute, dir, store().profiles, { home: rt.home })
        ensureProfileDir(dir, { managed })
        store().profiles.push(clean)
        if (!found.has(clean.baseRoute)) await scan()
        applyRoutes()
        await Promise.all([probeVersions(), probeProfileSignIn(clean, { force: true })])
        await rt.catalog?.({ fresh: true })
        await rt.save()
        return profileViewOf(clean)
      }
      case 'local-agent-profile-update': {
        const { entry } = findProfile(body)
        if (entry === undefined) throw new Error('Unknown profile')
        const route = profileRoute(entry.baseRoute, entry.id)
        const prevDir = entry.configDir ?? defaultProfileDir(rt.home, entry.baseRoute, entry.id)
        const prevEnv = JSON.stringify(entry.env ?? {})
        const nextConfigDir = body?.configDir === undefined ? entry.configDir : body.configDir
        const nextEnv = body?.env === undefined ? entry.env : body.env
        const clean = validateProfile({
          id: entry.id,
          baseRoute: entry.baseRoute,
          name: body?.name ?? entry.name,
          configDir: nextConfigDir,
          env: nextEnv,
        })
        const managed = clean.configDir === undefined
        const newDir = clean.configDir ?? defaultProfileDir(rt.home, clean.baseRoute, clean.id)
        validateProfileDirUnique(clean.baseRoute, newDir, store().profiles, { home: rt.home, ignoreId: entry.id })
        const dirChanged = newDir !== prevDir
        const configChanged = dirChanged || JSON.stringify(clean.env ?? {}) !== prevEnv
        ensureProfileDir(newDir, { managed })
        entry.name = clean.name
        if (clean.configDir !== undefined) entry.configDir = clean.configDir
        else delete entry.configDir
        if (clean.env !== undefined && Object.keys(clean.env).length > 0) entry.env = clean.env
        else delete entry.env
        if (configChanged) {
          dropPersistedWindows(route)
          adapter.dropWindows(route)
          rt.contextRuntime?.clearWindowCache?.()
          await adapter.closeRoute(route, 'the local agent configuration changed', { code: 'LOCAL_AGENT_EXIT' })
          if (dirChanged) clearRouteSessions(route)
          clearProfileProbe(route)
          await probeProfileSignIn(entry, { force: true })
        }
        await rt.catalog?.({ fresh: true })
        await rt.save()
        return profileViewOf(entry)
      }
      case 'local-agent-profile-remove': {
        const { index, entry } = findProfile(body)
        if (index === -1 || entry === undefined) throw new Error('Unknown profile')
        const route = profileRoute(entry.baseRoute, entry.id)
        store().profiles.splice(index, 1)
        const retired = store().retiredProfiles
        if (!retired.includes(route)) retired.push(route)
        dropPersistedWindows(route)
        adapter.dropWindows(route)
        rt.contextRuntime?.clearWindowCache?.()
        clearProfileProbe(route)
        await adapter.closeRoute(route, 'the local agent profile was removed', { code: 'LOCAL_AGENT_MISSING' })
        clearRouteSessions(route)
        applyRoutes()
        await rt.catalog?.({ fresh: true })
        await rt.save()
        return profilesView()
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  // Cleans up a forgotten or archived session's live CLI handle and persisted record.
  function forgetLocalAgentSession(sessionId, { persist = true } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    void adapter.closeSession(sessionId, 'session forgotten').catch(() => {})
    const sessions = store().sessions
    if (!Object.hasOwn(sessions, sessionId)) return false
    delete sessions[sessionId]
    if (persist && rt.readOnly?.() === undefined) void rt.save().catch(() => {})
    return true
  }

  // Prunes orphaned `state.localAgents.sessions` entries whose DS Bot sessions are no
  // longer active (archived parts, deleted Bots, left groups, or settled tasks).
  function pruneLocalAgentSessions(liveIds) {
    if (!(liveIds instanceof Set)) return 0
    const sessions = store().sessions
    let removed = 0
    for (const sid of Object.keys(sessions)) {
      if (!liveIds.has(sid)) {
        void adapter.closeSession(sid, 'session pruned').catch(() => {})
        delete sessions[sid]
        removed += 1
      }
    }
    if (removed > 0 && rt.readOnly?.() === undefined) void rt.save().catch(() => {})
    return removed
  }

  const localAgentSupportsFork = (route) => {
    if (typeof route !== 'string' || route === '') return false
    if (adapter.isForkUnsupported(route)) return false
    return found.get(route)?.supportsFork === true
  }

  // On-demand version probe for one route when starting a fork-eligible task,
  // reusing the cached/in-flight probe so native forks work immediately after restart
  // without waiting for Settings -> Local agents to be opened.
  async function ensureLocalAgentForkCapability(route) {
    if (typeof route !== 'string' || route === '' || adapter.isForkUnsupported(route)) return false
    await initialScan.catch(() => {})
    const entry = found.get(route)
    if (entry === undefined) return false
    if (entry.supportsFork !== undefined) return entry.supportsFork === true
    await probeEntryVersion(entry).catch(() => {})
    return !adapter.isForkUnsupported(route) && entry.supportsFork === true
  }

  Object.assign(rt, {
    isLocalAgentRoute, isLocalAgentRef, engineOf, engineOfBot, localAgentOf, isLocalAgentSession,
    localAgentRoutes: allRoutes, localAgentsEndpoint, localAgentModels,
    isLocalAgentAvailable: route => registeredRoutes.has(route),
    localAgentSupportsFork,
    ensureLocalAgentForkCapability,
    forkLocalAgentSession: (fromSessionId, toSessionId, options) => adapter.forkSession(fromSessionId, toSessionId, options),
    forgetLocalAgentSession,
    pruneLocalAgentSessions,
    engineNameOf: ref => (isLocalAgentRef(ref) ? adapter.providerInfo(splitRef(ref).provider).name : `the model ${ref}`),
    closeLocalAgentSession: (sessionId, reason) => adapter.closeSession(sessionId, reason),
    localAgentLaunchPreset: sessionId => adapter.live.get(String(sessionId))?.preset,
    // The parts module's view of a CLI session's context, and the requests it makes of
    // the CLI when the conversation grows long: condense, write the handoff note, and
    // answer the context steward when the team has no model of its own.
    localAgentContext: sessionId => adapter.contextOf(String(sessionId)),
    localAgentCompact: (sessionId, signal) => adapter.compact(String(sessionId), signal),
    localAgentNote: (sessionId, text, signal) => adapter.note(String(sessionId), text, signal),
    localAgentAsk: (sessionId, request) => adapter.ask(String(sessionId), request),
    notifyLocalAgentToolsChanged: sessionId => adapter.notifyToolsChanged(sessionId),
    localAgentBadge: (ref) => {
      const provider = splitRef(ref)?.provider
      return provider !== undefined && isLocalAgentRoute(provider) ? provider : undefined
    },
  })
}
