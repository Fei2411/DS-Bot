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
import { ENGINES, customRoute, isLocalAgentRoute, signInFor, validateCustom } from './engines.js'
import { cleanEnv, findEngineExecutable, findExecutable, probeSignIn, probeVersion, refreshSearchDirs } from './discover.js'

const SIGNED_IN_TTL_MS = 60_000

// The preset a Session runs on: its group's, else its Bot's, else DSH's default — the one
// a Bot without a preset of its own is shown with (permissions.js keeps it applied to the
// Session). A hard-coded workspace-write made a local agent open in a stricter mode than
// the setting the user saw, so its tool calls went through the CLI's permission prompt
// instead of the mode they asked for (#1539).
export function presetOf(rt, sessionId) {
  const bot = rt.botOf(rt.selfOf(sessionId))
  const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId ?? rt.taskOwners?.get(sessionId)?.roomId)
  return room?.permission ?? bot?.permission ?? rt.permissionCatalog?.()?.defaultPreset ?? 'workspace-write'
}

const spawnEngine = (kind, route, spec) => (kind === 'acp' ? new AcpEngine(route, spec, { findExecutable })
  : kind === 'codex' ? new CodexEngine(route, spec, { findExecutable })
    : new ClaudeEngine(route, spec, { findExecutable }))

export function install(rt) {
  const { ctx, state } = rt
  // state.localAgents is replaced by the state load after install; read it
  // each time instead of holding the pre-load object.
  const store = () => {
    const live = state.localAgents ??= { custom: [], sessions: {} }
    live.custom ??= []
    live.sessions ??= {}
    return live
  }

  const customAgents = () => store().custom
  const customRouteId = () => store().custom.map(agent => customRoute(agent.id))
  const allRoutes = () => [...Object.keys(ENGINES), ...customRouteId()]

  // Only CLIs found on this machine get a route; the scan result feeds the page.
  const found = new Map()
  let disposed = false
  async function scan() {
    await refreshSearchDirs()
    if (disposed) return []
    for (const route of Object.keys(ENGINES)) {
      const spec = ENGINES[route]
      const path = findEngineExecutable(spec, findExecutable)
      if (path === undefined) found.delete(route)
      else if (found.get(route)?.path !== path) found.set(route, { route, name: spec.name, path, version: undefined, signIn: signInFor(spec, path) })
    }
    applyRoutes()
    return [...found.values()]
  }
  async function probeVersions() {
    await Promise.all([...found.values()].map(async (entry) => {
      if (entry.version !== undefined) return
      const spec = ENGINES[entry.route]
      const result = await probeVersion(entry.path, spec.version ?? ['--version'], cleanEnv(spec.env ?? {})).catch(() => undefined)
      entry.version = result?.version
    }))
  }
  // Asked only when the list of CLIs is about to show, never at start or for a menu.
  async function probeSignIns() {
    await Promise.all([...found.values()].map(async (entry) => {
      if (entry.signedIn !== undefined && Date.now() - entry.signedInAt < SIGNED_IN_TTL_MS) return
      entry.signedIn = await probeSignIn(entry.path, ENGINES[entry.route].signedIn)
      entry.signedInAt = Date.now()
    }))
  }
  // A signed-out CLI or a slow one never holds back the list for long: each check is bounded.
  async function freshList() {
    await Promise.all([probeVersions(), probeSignIns()])
    return { available: supported(), detected: detected(), custom: customView() }
  }

  const adapter = new LocalAgentAdapter({
    rt,
    customAgents,
    findExecutable,
    spawnEngine,
    usedModels: route => usedRefs().map(ref => splitRef(ref)).filter(used => used?.provider === route).map(used => used.model),
    record: sessionId => store().sessions[sessionId],
    saveRecord: (sessionId, record) => {
      store().sessions[sessionId] = record
      void rt.save().catch(() => {})
    },
    recordUsage: entry => rt.recordUsage?.(entry),
    // A change that rides along with the next save: the CLI reports its context on
    // every model call.
    patchRecord: (sessionId, patch) => {
      const record = store().sessions[sessionId]
      if (record !== undefined) Object.assign(record, patch)
    },
    presetFor: sessionId => presetOf(rt, sessionId),
    cwdFor: async (sessionId) => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        return agent.session.header?.cwd ?? rt.workDirOf?.({ botId: rt.selfOf(sessionId), roomId: rt.groupOwners.get(sessionId)?.roomId ?? rt.taskOwners?.get(sessionId)?.roomId }) ?? rt.teamFolder?.() ?? tmpdir()
      } catch {
        return rt.teamFolder?.() ?? tmpdir()
      }
    },
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: (options) => {
      // Only DS Bot's own team tools cross the bridge; the CLI keeps its own.
      const names = new Set([...rt.teamTools.map(def => def.name), 'approve_agent_action'])
      return (options.tools ?? []).filter(tool => names.has(tool.name))
    },
  })

  let registration
  let registeredRoutes = new Set()
  const llm = () => serviceOf(ctx, 'llm')
  const supported = () => typeof llm()?.registerAdapter === 'function'
  const usedRefs = () => [...new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel]).filter(Boolean))]
  // A route a Bot runs on stays registered when its CLI goes away: the turn then fails
  // with the repair card, and nothing moves the Bot to another run mode by itself.
  const servedRoutes = () => [...new Set([...found.keys(), ...customRouteId(), ...usedRefs().map(ref => splitRef(ref)?.provider).filter(isLocalAgentRoute)])]
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
  // The callback returns the disposer: running adapter.dispose() inside the
  // setup would leave the adapter disposed from the moment it installs.
  ctx.effect(() => async () => {
    disposed = true
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
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
        reason: text.slice(0, 500),
        displayReason: { en: text.slice(0, 500) },
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      // The adapter decides the CLI's option from this structured result;
      // only an explicit {"decision":"allow"} counts.
      return JSON.stringify({ decision: outcome === 'allowed-once' ? 'allow' : 'deny' })
    },
  })]

  // ---------------------------------------------------------------------------
  // The Settings page's endpoints.

  const detected = () => [...found.values()].filter(entry => registeredRoutes.has(entry.route)).map(entry => ({ route: entry.route, name: entry.name, path: entry.path, version: entry.version ?? null, signIn: entry.signIn, signedIn: entry.signedIn ?? null }))
  const customView = () => store().custom.map(agent => ({ ...agent, route: customRoute(agent.id), available: registeredRoutes.has(customRoute(agent.id)) }))

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
        for (const entry of found.values()) delete entry.signedIn
        await scan()
        await rt.catalog?.({ fresh: true })
        return freshList()
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
        Object.assign(entry, clean)
        adapter.dropModelCache(customRoute(entry.id))
        await rt.save()
        return { ...entry, route: customRoute(entry.id) }
      }
      case 'local-agent-remove': {
        const at = store().custom.findIndex(agent => agent.id === body.id)
        if (at === -1) throw new Error('Unknown agent')
        store().custom.splice(at, 1)
        applyRoutes()
        await rt.save()
        return customView()
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, {
    isLocalAgentRoute, isLocalAgentRef, engineOf, engineOfBot, localAgentOf, isLocalAgentSession,
    localAgentRoutes: allRoutes, localAgentsEndpoint, localAgentModels,
    isLocalAgentAvailable: route => registeredRoutes.has(route),
    engineNameOf: ref => (isLocalAgentRef(ref) ? adapter.providerInfo(splitRef(ref).provider).name : `the model ${ref}`),
    closeLocalAgentSession: (sessionId, reason) => adapter.closeSession(sessionId, reason),
    // The parts module's view of a CLI session's context, and the requests it makes of
    // the CLI when the conversation grows long: condense, write the handoff note, and
    // answer the context steward when the team has no model of its own.
    localAgentContext: sessionId => adapter.contextOf(String(sessionId)),
    localAgentCompact: (sessionId, signal) => adapter.compact(String(sessionId), signal),
    localAgentNote: (sessionId, text, signal) => adapter.note(String(sessionId), text, signal),
    localAgentAsk: (sessionId, request) => adapter.ask(String(sessionId), request),
    localAgentBadge: (ref) => {
      const provider = splitRef(ref)?.provider
      return provider !== undefined && isLocalAgentRoute(provider) ? provider : undefined
    },
  })
}
