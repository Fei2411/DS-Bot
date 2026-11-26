// The Agent Client Protocol engine: one child process per route (or per working
// folder when the CLI pins shell commands to its process cwd), ACP over stdio.
// A process multiplexes sessions: each DS Bot Session maps to one ACP session,
// created or resumed with our loopback MCP server attached.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { PROBE_FORCE_KILL_AFTER_MS, cleanEnv, findEngineExecutable, launchOf, probeEnv, runProbeCommand, spawnAgent, terminateChild } from './discover.js'
import { acpMode } from './engines.js'

const CLIENT = { name: 'ds-bot', version: '1' }
// DS Bot's loopback MCP server, which carries the Bot's team tools.
const MCP_SERVER = 'dsbot'
const AUTH_ERROR = /not signed in|not logged in|login required|unauthorized|authentication/i
const TIMEOUT_ERROR = /timed out|timeout/i
const CANCEL_ACK_TIMEOUT_MS = 3_000
const BUNDLED_MCP_STDIO = join(dirname(fileURLToPath(import.meta.url)), 'mcp-stdio.js')

const extractedBridges = new Map()
// Electron's ASAR reader does not span external CLI processes spawned by Node:
// extract the bridge once per process into a private 0700 temp directory.
export function stdioBridgePath(source = BUNDLED_MCP_STDIO) {
  if (!/\.asar[\\/]/u.test(source)) return source
  const cached = extractedBridges.get(source)
  if (cached !== undefined && existsSync(cached)) return cached
  const dir = mkdtempSync(join(tmpdir(), 'dsb-mcp-'))
  try { chmodSync(dir, 0o700) } catch {}
  const target = join(dir, 'mcp-stdio.mjs')
  writeFileSync(target, readFileSync(source), { flag: 'wx', mode: 0o600 })
  extractedBridges.set(source, target)
  process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  return target
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const TOOL_CALL_CACHE_MAX = 100
const REPORTED_TOOL_CALLS_MAX = 1_000

// Events a driver reports, normalized for the adapter:
// {type:'text'|'thought',text} | {type:'activity',text} (one compact line of the
// agent's own work) | {type:'permission',id,action,detail,options,changes,reply} |
// {type:'done',reason,usage?} | {type:'error',error} | {type:'usage',usage} |
// {type:'context',used?,size?} (how full the CLI's own context is) |
// {type:'compaction',status:'started'|'completed'|'failed'}
export class AcpEngine {
  constructor(route, engine, { findExecutable, defaultEfforts = new Map(), sessionEfforts, cancelAckTimeoutMs = CANCEL_ACK_TIMEOUT_MS, onListedUpdate, catalog } = {}) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.defaultEfforts = defaultEfforts
    this.ownsSessionEfforts = sessionEfforts === undefined
    this.sessionEfforts = sessionEfforts ?? new Map()
    this.cancelAckTimeoutMs = cancelAckTimeoutMs
    this.onListedUpdate = onListedUpdate
    this.hasModelConfig = false
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    this.sessions = new Map()
    this.caps = {}
    // What the CLI listed: its modes, config options and model variants. None of it
    // is per-process state — every worker of a cwdPerProcess engine runs the same
    // CLI — so the workers of one family share one catalog object, and a partial
    // or bare answer from one process cannot erase what another already listed
    // (#2145). A probe's temporary worker gets no catalog: its evidence reaches
    // the family only through the guarded sync in listModels().
    this.catalog = catalog ?? { listed: { modes: [], configOptions: [], models: [] }, writeEpoch: 0, invalidateEpoch: 0 }
    this.listed = this.catalog.listed
    // The commands each agent session lists, by the agent's session id.
    this.commands = new Map()
    // For CLIs whose commands follow their process cwd (`cwdPerProcess`): one
    // worker AcpEngine per resolved workspace folder.
    this.workers = new Map()
    this.sessionWorkers = new Map()
    this.pendingOpens = new Map()
    this.probeWorkers = new Set()
    // Lifecycle state for a child worker owned by a `cwdPerProcess` coordinator:
    // a worker stays alive iff !retired && (inFlight > 0 || committed.size > 0 || keepWarm).
    this.committed = new Map()
    this.inFlight = 0
    this.keepWarm = false
    this.retired = false
  }

  activeWorker() {
    let fallback
    for (const worker of this.workers.values()) {
      if (worker.retired || worker.peer === undefined) continue
      if (worker.keepWarm) return worker
      fallback ??= worker
    }
    return fallback
  }

  hasPersistentSession(worker) {
    for (const entry of worker.committed.values()) if (!entry.ephemeral) return true
    return false
  }

  detachWorker(worker) {
    if (worker.retired) return false
    worker.retired = true
    for (const [key, entry] of this.workers) if (entry === worker) this.workers.delete(key)
    return true
  }

  maybeRetireWorker(worker) {
    if (worker.retired || worker.inFlight > 0 || worker.committed.size > 0 || worker.keepWarm) return false
    return this.detachWorker(worker)
  }

  uncommitSession(worker, dshSessionId, { forget = false, expectedSession } = {}) {
    const entry = worker.committed.get(dshSessionId)
    if (entry !== undefined && (expectedSession === undefined || entry.session === expectedSession)) {
      worker.committed.delete(dshSessionId)
      if (this.sessionWorkers.get(dshSessionId) === worker) this.sessionWorkers.delete(dshSessionId)
      if (forget && !entry.ephemeral && !this.hasPersistentSession(worker)) worker.keepWarm = false
    }
    if (expectedSession === undefined || worker.sessions.get(dshSessionId) === expectedSession) {
      worker.forget(dshSessionId)
    }
    return this.maybeRetireWorker(worker) ? worker : undefined
  }

  spawnWorker(cwd, { isolated = false } = {}) {
    return new AcpEngine(
      this.route,
      { ...this.engine, cwdPerProcess: false, ...(cwd ? { spawnCwd: cwd } : {}) },
      {
        findExecutable: this.findExecutable,
        defaultEfforts: new Map(this.defaultEfforts),
        sessionEfforts: this.sessionEfforts,
        cancelAckTimeoutMs: this.cancelAckTimeoutMs,
        onListedUpdate: update => this.remember(update),
        ...(isolated ? {} : { catalog: this.catalog }),
      },
    )
  }

  catalogEpoch() {
    return { write: this.catalog.writeEpoch, invalidate: this.catalog.invalidateEpoch }
  }

  catalogEpochMatches(epoch) {
    return epoch.write === this.catalog.writeEpoch && epoch.invalidate === this.catalog.invalidateEpoch
  }

  workerOf(session, dshSessionId = session?.dshSessionId) {
    return session?._worker ?? (dshSessionId !== undefined ? this.sessionWorkers.get(dshSessionId) : undefined)
  }

  async ensure({ probe = false } = {}) {
    if (this.retired) throw Object.assign(new Error(`${this.engine.name} worker is closed`), { code: 'LOCAL_AGENT_EXIT' })
    // A peer exists before its handshake has finished; other callers wait for it.
    if (this.starting !== undefined) return this.starting
    if (this.peer !== undefined) return this.peer
    const starting = this.startPeer({ probe })
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  async startPeer({ probe = false } = {}) {
    const bin = findEngineExecutable(this.engine, name => this.findExecutable(name))
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    this.bin = bin
    const spawnCwd = this.engine.spawnCwd && existsSync(this.engine.spawnCwd) ? this.engine.spawnCwd : undefined
    const child = spawnAgent(bin, this.engine.args ?? [], {
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
      env: (probe ? probeEnv : cleanEnv)(this.engine.env ?? {}),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    this.child = child
    const peer = this.peer = new JsonRpcPeer(line => child.stdin.write(`${JSON.stringify(line)}\n`))
    wireProcess(child, peer)
    const gone = (error) => {
      peer.close(error)
      // A process close() let go of must not take the one that replaced it along.
      if (this.child !== child) return
      this.child = undefined
      this.peer = undefined
      for (const session of this.sessions.values()) {
        session.dead = true
        session.push({ type: 'error', error })
      }
    }
    child.on('exit', (code, signal) => gone(new Error(`${this.engine.name} exited${signal ? ` (${signal})` : code !== null ? ` (${code})` : ''}`)))
    // A CLI that cannot start at all (a broken install, a missing interpreter)
    // raises 'error', never 'exit'; unheard it takes the host down.
    child.on('error', error => gone(Object.assign(new Error(`${this.engine.name} could not start: ${error.message}`), { code: 'LOCAL_AGENT_EXIT' })))
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    try {
      const reply = await peer.request('initialize', {
        protocolVersion: 1,
        // `session.compaction` asks for compaction_update notices, so DS Bot hears when
        // the agent condenses its own context.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
        clientInfo: CLIENT,
      }, { timeout: 30_000 })
      if (this.child !== child) {
        throw Object.assign(new Error(`${this.engine.name} closed while starting`), { code: 'LOCAL_AGENT_EXIT' })
      }
      const agentCaps = reply?.agentCapabilities ?? {}
      const mcpCaps = agentCaps.mcpCapabilities ?? agentCaps.mcp_capabilities
      const sessionCaps = agentCaps.sessionCapabilities ?? agentCaps.session_capabilities
      const promptCaps = agentCaps.promptCapabilities ?? agentCaps.prompt_capabilities
      const mcpHttp = mcpCaps?.http
      this.caps = {
        // Prefer Streamable HTTP MCP when declared, bridge via stdio MCP when HTTP is
        // false, or probe HTTP -> stdio -> plain when mcpCapabilities is omitted.
        mcpMode: mcpHttp === true ? 'http' : mcpHttp === false ? 'stdio' : undefined,
        mcpSse: mcpCaps?.sse === true,
        close: sessionCaps?.close != null,
        image: promptCaps?.image === true,
      }
      return peer
    } catch (error) {
      peer.close(error)
      if (this.child === child) {
        this.child = undefined
        this.peer = undefined
        terminateChild(child, probe ? { forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS } : undefined)
      }
      throw error
    }
  }

  createSession(dshSessionId) {
    const queue = new EventQueue()
    return {
      dshSessionId,
      acpSessionId: undefined,
      dead: false,
      modes: [],
      toolCalls: new Map(),
      reportedToolCalls: new Set(),
      failedToolCalls: new Set(),
      push: event => queue.push(event),
      next: () => queue.next(),
    }
  }

  sessionFor(dshSessionId) {
    // Each open owns its queue. A forgotten attempt may finish after its replacement;
    // sharing this object would let the stale cleanup unregister the replacement.
    const session = this.createSession(dshSessionId)
    this.sessions.set(dshSessionId, session)
    return session
  }

  onNotice(method, params) {
    // Devin lists a session's commands before it answers session/new, so they are
    // kept by the agent's session id rather than on a session not known yet.
    if (params?.update?.sessionUpdate === 'available_commands_update') {
      this.commands.set(params.sessionId, (params.update.availableCommands ?? []).map(command => command?.name).filter(Boolean))
    }
    const session = [...this.sessions.values()].find(entry => entry.acpSessionId === params?.sessionId)
    if (session === undefined) return
    if (session.promptTurn?.cancelled) return
    // Devin CLI 3000.12 reports its compaction this way, not as compaction_update.
    if (method === '_cognition.ai/compaction') {
      if (session.running) session.promptTurn?.onProgress?.()
      session.push({ type: 'compaction', status: compactionStatus(params?.status) })
      return
    }
    if (method !== 'session/update') return
    const update = params?.update ?? {}
    if (session.running && typeof update.sessionUpdate === 'string') session.promptTurn?.onProgress?.()
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (session.promptTurn !== undefined) session.promptTurn.sawStepWork = true
        session.push({ type: 'text', text: textOf(update.content) })
        break
      case 'agent_thought_chunk':
        if (session.promptTurn !== undefined) session.promptTurn.sawStepWork = true
        session.push({ type: 'thought', text: textOf(update.content) })
        break
      case 'tool_call':
      case 'tool_call_update': {
        if (session.promptTurn !== undefined) session.promptTurn.sawStepWork = true
        // A permission request names the call only by id; its title, kind and
        // input came with the call's own updates, so they are kept here.
        const id = update.toolCallId
        const known = id === undefined ? undefined : session.toolCalls.get(id)
        const call = mergeCall(known, update)
        const alreadyFailed = id !== undefined && (known?.status === 'failed' || session.failedToolCalls.has(id))
        const terminal = update.status === 'completed' || update.status === 'failed'
        if (id !== undefined) {
          if (terminal) {
            session.toolCalls.delete(id)
            if (update.status === 'failed') {
              session.failedToolCalls.delete(id)
              session.failedToolCalls.add(id)
              if (session.failedToolCalls.size > REPORTED_TOOL_CALLS_MAX) {
                session.failedToolCalls.delete(session.failedToolCalls.values().next().value)
              }
            }
          } else {
            session.toolCalls.delete(id)
            session.toolCalls.set(id, call)
            if (session.toolCalls.size > TOOL_CALL_CACHE_MAX) {
              session.toolCalls.delete(session.toolCalls.keys().next().value)
            }
          }
        }
        if (call.status !== 'pending' && !['read', 'search', 'think'].includes(call.kind)) session.cwd = undefined
        const team = ownToolCall(call)
        const described = describeCall(call)
        const reported = id !== undefined && session.reportedToolCalls.has(id)
        const markReported = () => {
          if (id === undefined) return
          session.reportedToolCalls.delete(id)
          session.reportedToolCalls.add(id)
          if (session.reportedToolCalls.size > REPORTED_TOOL_CALLS_MAX) {
            session.reportedToolCalls.delete(session.reportedToolCalls.values().next().value)
          }
        }
        if (!reported) {
          if (update.status === 'failed' && !alreadyFailed) {
            markReported()
            session.push({ type: 'activity', text: `▸ ${described} — failed`, failed: true, ...(team ? { team: true } : {}) })
          } else if (id === undefined || !isAnonymousMcpPlaceholder(call)) {
            markReported()
            session.push({ type: 'activity', text: `▸ ${described}`, ...(team ? { team: true } : {}) })
          }
        } else if (update.status === 'failed' && !alreadyFailed) {
          session.push({ type: 'activity', text: `▸ ${described} — failed`, failed: true, ...(team ? { team: true } : {}) })
        } else if (update.status !== 'completed' && known !== undefined && described !== describeCall(known)) {
          session.push({ type: 'status', text: described, ...(team ? { team: true } : {}) })
        }
        break
      }
      case 'plan':
        if (session.promptTurn !== undefined) session.promptTurn.sawStepWork = true
        session.push({ type: 'thought', text: planText(update.entries) })
        break
      case 'usage_update': {
        // Devin sends each one twice, the second marked as a subagent's; a real
        // subagent's context is not the session's.
        if (update._meta?.['cognition.ai/subagent_context'] !== undefined) break
        if (typeof update.used === 'number') {
          session.push({ type: 'context', used: update.used, ...(typeof update.size === 'number' ? { size: update.size } : {}) })
          // Count internal LLM steps during an active prompt turn (ignoring session/load
          // replays, zero-token placeholders, and back-to-back duplicate snapshots).
          const turn = session.promptTurn
          if (turn !== undefined && session.running === true && update.used > 0
            && (turn.steps === 0 || update.used !== turn.lastUsed || turn.sawStepWork)) {
            turn.steps += 1
            turn.lastUsed = update.used
            turn.sawStepWork = false
          }
        }
        break
      }
      case 'config_option_update': {
        if (Array.isArray(update.configOptions)) {
          session.configOptions = update.configOptions
          session.modes = update.modes?.availableModes ?? configOptionsOf(update.configOptions, 'mode')?.options ?? session.modes
          if (update.configOptions.length > 0) {
            this.remember(update)
            this.onListedUpdate?.(update)
            // Notices carry the config but no model variants, so the catalog is
            // parsed from what the CLI has listed so far, not this update alone:
            // parsing it bare would drop the per-model thinking tiers (#2145).
            const discovered = modelsFromProbe({ configOptions: update.configOptions, models: { availableModels: this.listed.models } })
            if (discovered.length > 0) session.push({ type: 'models', models: discovered })
          }
        }
        break
      }
      case 'compaction_update': session.push({ type: 'compaction', status: compactionStatus(update.status) }); break
      default: break
    }
  }

  // Agent → client requests: permission prompts bridge to the approval tool;
  // the rest are refused — we hold no editor or terminal of our own.
  onRequest(method, params) {
    if (method === 'session/request_permission') {
      const session = [...this.sessions.values()].find(entry => entry.acpSessionId === params?.sessionId)
      if (session === undefined) return Promise.reject({ code: -32603, message: 'unknown session' })
      if (session.running && !session.promptTurn?.cancelled) session.promptTurn?.onProgress?.()
      const options = (params?.options ?? []).map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
      const call = callOf(session, params?.toolCall)
      // Cursor, Devin and Antigravity ask before MCP tool calls. A call to DS Bot's
      // own server is approved once here: toolsFor() already narrowed what the Bot
      // may call. Other tools, and an agent that offers no one-time allow, still ask.
      const once = ownToolCall(call) ? options.find(option => option.kind === 'allow_once') : undefined
      if (once !== undefined) return Promise.resolve({ outcome: { outcome: 'selected', optionId: once.optionId } })
      const action = describeCall(call)
      const evidence = JSON.stringify(call)
      return new Promise((resolve) => {
        const id = `perm-${Math.random().toString(36).slice(2)}`
        const reply = (optionId) => {
          if (optionId === null) resolve({ outcome: { outcome: 'cancelled' } })
          else {
            if (options.some(option => option.optionId === optionId && option.kind?.startsWith('allow'))
              && !['read', 'search', 'think'].includes(call.kind)) session.cwd = undefined
            resolve({ outcome: { outcome: 'selected', optionId } })
          }
        }
        session.push({
          type: 'permission', id, reply, cwd: session.cwd,
          action,
          detail: detailText(call, action),
          evidence,
          options,
          changes: CHANGE_KINDS.has(call.kind),
        })
      })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async openInWorker(dshSessionId, openArgs) {
    const ephemeral = openArgs.ephemeral === true
    const existing = ephemeral ? this.activeWorker() : undefined
    const key = openArgs.cwd ? resolve(openArgs.cwd) : ''
    let worker = existing ?? this.workers.get(key)
    if (worker === undefined) {
      worker = this.spawnWorker(key)
      this.workers.set(key, worker)
    }
    const openToken = { forgotten: false }
    let pending = this.pendingOpens.get(dshSessionId)
    if (pending === undefined) {
      pending = new Set()
      this.pendingOpens.set(dshSessionId, pending)
    }
    pending.add(openToken)
    worker.inFlight += 1
    try {
      const session = await worker.open(dshSessionId, openArgs)
      if (openToken.forgotten || worker.retired) {
        if (worker.sessions.get(dshSessionId) === session) worker.forget(dshSessionId)
        // Skip session/close if this worker will shut down right after in finally.
        if (openToken.forgotten && !worker.retired && (worker.committed.size > 0 || worker.inFlight > 1 || worker.keepWarm)) {
          await worker.closeSession(session).catch(() => {})
        }
        throw Object.assign(new Error(`${this.engine.name} session closed while opening`), { code: 'LOCAL_AGENT_EXIT' })
      }
      const prevWorker = this.sessionWorkers.get(dshSessionId)
      const retiredPrev = prevWorker !== undefined && prevWorker !== worker
        ? this.uncommitSession(prevWorker, dshSessionId, { forget: true })
        : undefined
      worker.committed.set(dshSessionId, { session, ephemeral })
      if (!ephemeral) worker.keepWarm = true
      session._worker = worker
      this.sessionWorkers.set(dshSessionId, worker)
      this.caps.image = worker.caps.image
      // A family worker shares the catalog object, so what it listed is already
      // here; only a legacy isolated worker would need the copy.
      if (worker.catalog !== this.catalog) {
        this.remember({
          configOptions: worker.listed.configOptions,
          modes: { availableModes: worker.listed.modes },
          models: { availableModels: worker.listed.models },
        })
      }
      if (retiredPrev !== undefined) void retiredPrev.close().catch(() => {})
      return session
    } finally {
      pending.delete(openToken)
      if (pending.size === 0) this.pendingOpens.delete(dshSessionId)
      worker.inFlight -= 1
      if (this.maybeRetireWorker(worker)) await worker.close().catch(() => {})
    }
  }

  mcpModes(mcp) {
    if (mcp === undefined || this.caps.mcpMode === 'none') return ['none']
    if (this.caps.mcpMode === 'stdio') return ['stdio', 'none']
    return ['http', 'stdio', 'none']
  }

  recordDefaultEffort(reply, modelKey = '') {
    const effort = configOptionsOf(reply?.configOptions ?? [], 'thought_level')?.currentValue
    if (effort !== undefined && !this.defaultEfforts.has(modelKey)) this.defaultEfforts.set(modelKey, effort)
  }

  setSessionEffort(acpSessionId, effort) {
    if (acpSessionId === undefined) return
    if (effort === undefined) this.sessionEfforts.delete(acpSessionId)
    else this.sessionEfforts.set(acpSessionId, effort)
  }

  // Starts an ACP session using Streamable HTTP MCP when supported, falling back
  // to the stdio MCP bridge and finally to a plain session (#1073, #1463).
  async newSession(peer, { cwd, mcp }) {
    const modes = this.mcpModes(mcp)
    let lastError
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i]
      try {
        const reply = await peer.request('session/new', { cwd, mcpServers: serversFor(mcp, mode) }, { timeout: 60_000 })
        if (mcp !== undefined) this.caps.mcpMode = mode
        this.recordDefaultEffort(reply, '')
        return reply
      } catch (error) {
        lastError = error
        const text = String(error?.message ?? error)
        if (mcp === undefined || AUTH_ERROR.test(text) || TIMEOUT_ERROR.test(text) || i === modes.length - 1) throw error
      }
    }
    throw lastError
  }

  // Resumes an ACP session across the same MCP transport fallback ladder as newSession.
  async loadSession(peer, { cwd, mcp, resumeId, resumeOnly = false }) {
    const modes = this.mcpModes(mcp)
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i]
      try {
        const reply = await peer.request('session/load', { cwd, mcpServers: serversFor(mcp, mode), sessionId: resumeId }, { timeout: 30_000 })
        if (mcp !== undefined) this.caps.mcpMode = mode
        return { reply, loaded: true }
      } catch (error) {
        const text = String(error?.message ?? error)
        if (AUTH_ERROR.test(text) || TIMEOUT_ERROR.test(text)) throw error
        if (i === modes.length - 1) {
          if (resumeOnly) throw Object.assign(new Error('the saved local agent session could not be resumed'), { code: 'LOCAL_AGENT_SESSION_LOST' })
          return { reply: await this.newSession(peer, { cwd, mcp }), loaded: false }
        }
      }
    }
  }

  // A new or resumed ACP session for one DS Bot Session.
  async open(dshSessionId, openArgs) {
    if (this.engine.cwdPerProcess) return this.openInWorker(dshSessionId, openArgs)
    const { cwd, mcp, resumeId, resumeOnly = false, preset, model } = openArgs
    const peer = await this.ensure()
    const session = this.sessionFor(dshSessionId)
    try {
      const { reply, loaded } = resumeId !== undefined
        ? await this.loadSession(peer, { cwd, mcp, resumeId, resumeOnly })
        : { reply: await this.newSession(peer, { cwd, mcp }), loaded: false }
      session.acpSessionId = reply?.sessionId ?? resumeId
      session.cwd = cwd
      session.resumed = loaded
      const loadedEffort = configOptionsOf(reply?.configOptions ?? [], 'thought_level')?.currentValue
      // Some agents list nothing on session/load: the session reads what this CLI
      // listed before rather than guessing a mode or model list.
      const listed = this.remember(reply)
      session.configOptions = listed.configOptions
      session.modes = listed.modes
      session.models = listed.models
      // The preset maps to a mode only once the agent has listed its own.
      const mode = acpMode(preset, session.modes, this.engine.modes)
      if (mode !== undefined) await this.setOption(session, 'mode', mode).catch(() => {})
      // A model the agent does not take fails the turn: going on would answer with a
      // model the user did not pick.
      const modelKey = model !== undefined && model !== 'default' ? model : ''
      let modelReply
      if (modelKey !== '') {
        modelReply = await this.setOption(session, 'model', modelKey).catch((error) => {
          throw Object.assign(new Error(`${this.engine.name} did not switch to the model ${modelKey}: ${error?.message ?? error}. Pick another model in the Bot's settings.`), { code: 'LOCAL_AGENT_MODEL' })
        })
      }
      const switchedEffort = configOptionsOf(modelReply?.configOptions ?? [], 'thought_level')?.currentValue
      if (!loaded) {
        const freshDefault = switchedEffort ?? configOptionsOf(session.configOptions ?? [], 'thought_level')?.currentValue
        if (freshDefault !== undefined && modelKey !== '') this.defaultEfforts.set(modelKey, freshDefault)
        session.defaultEffort = freshDefault ?? this.defaultEfforts.get(modelKey) ?? this.defaultEfforts.get('')
        session.effort = undefined
        this.setSessionEffort(session.acpSessionId, undefined)
      } else {
        const priorEffort = loadedEffort ?? openArgs.effort ?? this.sessionEfforts.get(session.acpSessionId)
        const resetDefault = switchedEffort !== undefined && (priorEffort === undefined || switchedEffort !== priorEffort) ? switchedEffort : undefined
        if (resetDefault !== undefined && modelKey !== '') this.defaultEfforts.set(modelKey, resetDefault)
        session.defaultEffort = resetDefault ?? openArgs.defaultEffort ?? this.defaultEfforts.get(modelKey) ?? this.defaultEfforts.get('') ?? loadedEffort
        const currentEffort = switchedEffort ?? priorEffort
        session.effort = currentEffort !== undefined && currentEffort !== session.defaultEffort ? currentEffort : undefined
        this.setSessionEffort(session.acpSessionId, session.effort)
      }
      return session
    } catch (error) {
      if (this.sessions.get(dshSessionId) === session) this.sessions.delete(dshSessionId)
      throw error
    }
  }

  async setOption(session, category, value) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.setOption(session, category, value)
    const peer = await this.ensure()
    const option = configOptionsOf(session.configOptions ?? [], category)
    if (category === 'model' && option === undefined && !this.hasModelConfig && (session.models?.length ?? 0) > 0) {
      await peer.request('session/set_model', { sessionId: session.acpSessionId, modelId: value }, { timeout: 15_000 })
      return
    }
    try {
      const configId = option?.id ?? category
      const reply = await peer.request('session/set_config_option', { sessionId: session.acpSessionId, configId, value }, { timeout: 15_000 })
      if (Array.isArray(reply?.configOptions)) {
        session.configOptions = reply.configOptions
        this.remember(reply)
      }
      return reply
    } catch (error) {
      // Agents from before configOptions take model or mode via the legacy request.
      if (category === 'model' && option === undefined && !this.hasModelConfig) {
        await peer.request('session/set_model', { sessionId: session.acpSessionId, modelId: value }, { timeout: 15_000 })
        return
      }
      if (category !== 'mode') throw error
      await peer.request('session/set_mode', { sessionId: session.acpSessionId, modeId: value }, { timeout: 15_000 }).catch(() => {})
    }
  }

  supportsImages(session) {
    return (this.workerOf(session) ?? this).caps.image
  }

  async waitForPrompt(session, signal) {
    signal?.throwIfAborted()
    if (session.pendingPrompt === undefined) return
    const turn = session.promptTurn
    let timer
    let onAbort
    try {
      await Promise.race([
        session.pendingPrompt.catch(() => {}),
        new Promise((resolve, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('aborted'))
          signal?.addEventListener('abort', onAbort, { once: true })
          if (turn?.cancelled) timer = setTimeout(() => {
            turn.controller.abort(new Error('cancel acknowledgement timed out'))
            resolve()
          }, this.cancelAckTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.throwIfAborted()
  }

  async prompt(session, blocks, { signal, effort, onProgress } = {}) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.prompt(session, blocks, { signal, effort, onProgress })
    // ACP notices have no turn id. Give cancellation a bounded grace period
    // before accepting notices for another prompt on the same session.
    await this.waitForPrompt(session, signal)
    signal?.throwIfAborted()
    const peer = await this.ensure()
    if (configOptionsOf(session.configOptions ?? [], 'thought_level') !== undefined || session.defaultEffort !== undefined || session.effort !== undefined) {
      const current = session.effort ?? session.defaultEffort
      const target = effort ?? session.defaultEffort
      if (target !== undefined && target !== current) {
        const applied = await this.setOption(session, 'thought_level', target).then(() => true, () => false)
        if (applied) {
          session.effort = effort !== undefined && effort !== session.defaultEffort ? effort : undefined
          this.setSessionEffort(session.acpSessionId, session.effort)
          session.push({ type: 'effort', defaultEffort: session.defaultEffort, effort: session.effort })
        }
      } else if (effort === undefined && session.effort !== undefined) {
        session.effort = undefined
        this.setSessionEffort(session.acpSessionId, undefined)
        session.push({ type: 'effort', defaultEffort: session.defaultEffort, effort: undefined })
      }
    }
    signal?.throwIfAborted()
    const turn = session.promptTurn = {
      cancelled: false,
      controller: new AbortController(),
      onProgress,
      steps: 0,
      lastUsed: undefined,
      sawStepWork: false,
    }
    const onAbort = () => { turn.cancelled = true }
    signal?.addEventListener('abort', onAbort, { once: true })
    session.running = true
    const reply = session.pendingPrompt = peer.request('session/prompt', { sessionId: session.acpSessionId, prompt: acpPrompt(blocks) }, { signal: turn.controller.signal, timeout: 0 })
    reply.then(
      (result) => {
        if (turn.cancelled) return
        const calls = positiveInt(result?.usage?.calls)
          ?? positiveInt(result?.numTurns)
          ?? positiveInt(result?.num_turns)
          ?? (turn.steps > 0 ? turn.steps : undefined)
        const usage = usageOf(result?.usage, calls)
        session.push({ type: 'done', reason: result?.stopReason ?? 'end_turn', ...(usage ? { usage } : {}) })
      },
      error => { if (!turn.cancelled) session.push({ type: 'error', error }) },
    ).finally(() => {
      if (session.promptTurn === turn) session.running = false
      signal?.removeEventListener('abort', onAbort)
    })
    // Errors from `session/prompt` are already delivered in FIFO order through
    // `session.push({ type: 'error', error })` above; re-throwing here would let
    // callers push a duplicate error ahead of already-queued `session/update` events.
    return reply.catch(() => {})
  }

  canSteer(session) {
    return session.running === true
  }

  // The agent's own compaction, through the command it lists for it. False when it
  // lists none: it then condenses only on its own.
  compact(session) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.compact(session)
    // A loaded session may list nothing again: what this CLI listed last stands in.
    const listed = this.commands.get(session.acpSessionId) ?? [...this.commands.values()].at(-1) ?? []
    if (!listed.includes('compact')) return false
    this.prompt(session, [{ type: 'text', text: '/compact' }], {}).catch(() => {})
    return true
  }

  // A one-off session leaves the agent's list when it is done.
  async closeSession(session) {
    if (this.engine.cwdPerProcess) {
      const worker = this.workerOf(session)
      if (worker === undefined) return
      await worker.closeSession(session)
      const retired = this.uncommitSession(worker, session.dshSessionId, { expectedSession: session })
      if (retired !== undefined) await retired.close().catch(() => {})
      return
    }
    if (session?.acpSessionId === undefined) return
    this.commands.delete(session.acpSessionId)
    this.sessionEfforts.delete(session.acpSessionId)
    if (this.caps.close) await this.peer?.request('session/close', { sessionId: session.acpSessionId }, { timeout: 15_000 }).catch(() => {})
  }

  cancel(session) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) { worker.cancel(session); return }
    if (session.promptTurn !== undefined) session.promptTurn.cancelled = true
    this.peer?.notify('session/cancel', { sessionId: session.acpSessionId })
  }

  // The adapter stopped reading this session: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    if (this.engine.cwdPerProcess) {
      const pending = this.pendingOpens.get(dshSessionId)
      if (pending !== undefined) {
        for (const token of pending) token.forgotten = true
      }
      const worker = this.sessionWorkers.get(dshSessionId)
      if (worker === undefined) return
      const retired = this.uncommitSession(worker, dshSessionId, { forget: true })
      if (retired !== undefined) void retired.close().catch(() => {})
      return
    }
    const session = this.sessions.get(dshSessionId)
    const turn = session?.promptTurn
    if (turn !== undefined) {
      turn.cancelled = true
      turn.controller.abort(new Error('the ACP session was closed'))
    }
    if (session?.acpSessionId !== undefined) {
      this.commands.delete(session.acpSessionId)
      this.sessionEfforts.delete(session.acpSessionId)
    }
    this.sessions.delete(dshSessionId)
  }

  async close({ forceKillAfterMs } = {}) {
    for (const pending of this.pendingOpens.values()) {
      for (const token of pending) token.forgotten = true
    }
    this.pendingOpens.clear()
    const toClose = new Set(this.probeWorkers)
    this.probeWorkers.clear()
    for (const worker of [...this.workers.values()]) {
      this.detachWorker(worker)
      toClose.add(worker)
    }
    this.workers.clear()
    this.sessionWorkers.clear()
    await Promise.all([...toClose].map(worker => worker.close({ forceKillAfterMs }).catch(() => {})))
    for (const session of this.sessions.values()) {
      if (session?.acpSessionId !== undefined) this.sessionEfforts.delete(session.acpSessionId)
    }
    this.sessions.clear()
    this.commands.clear()
    if (this.ownsSessionEfforts) this.sessionEfforts.clear()
    const child = this.child
    const peer = this.peer
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    peer?.close?.(new Error(`${this.engine.name} closed`))
    terminateChild(child, forceKillAfterMs === undefined ? undefined : { forceKillAfterMs })
  }

  invalidateListed() {
    // Advance generation to reject late pre-refresh probes without wiping already-
    // discovered modes needed by concurrent session/load resumes before re-probe
    // completes. The catalog object is shared across the family's workers, so
    // invalidating it once resets them all; only an isolated probe worker would
    // need its own, and probe workers never join this.workers.
    this.catalog.invalidateEpoch += 1
    this.catalog.writeEpoch += 1
    this.listed.models = []
    for (const worker of this.workers.values()) {
      if (worker.catalog !== this.catalog) worker.invalidateListed()
    }
  }

  remember(reply, { epoch } = {}) {
    // A probe passes the generation it started in. After an invalidation its
    // evidence is from before the refresh and drops entirely; after ordinary
    // concurrent writes only its replacing slots (config, modes) drop, while
    // its variant evidence still unions in — a slower probe's `agy models`
    // listing is additive either way and losing it would re-degrade notices.
    const preRefresh = epoch !== undefined && epoch.invalidate !== this.catalog.invalidateEpoch
    if (preRefresh) return this.listed
    const stale = epoch !== undefined && epoch.write !== this.catalog.writeEpoch
    const configOptions = !stale && Array.isArray(reply?.configOptions) && reply.configOptions.length > 0 ? reply.configOptions : undefined
    if (configOptionsOf(configOptions ?? [], 'model') !== undefined) this.hasModelConfig = true
    const rawModes = !stale ? reply?.modes?.availableModes ?? configOptionsOf(configOptions ?? [], 'mode')?.options : undefined
    const modes = Array.isArray(rawModes) && rawModes.length > 0 ? rawModes : undefined
    const rawModels = reply?.models?.availableModels
    const models = Array.isArray(rawModels) && rawModels.length > 0 ? rawModels : undefined
    if (configOptions !== undefined || modes !== undefined || models !== undefined) {
      if (!stale) this.catalog.writeEpoch += 1
      // Variant evidence merges by union within an invalidation epoch: the CLI
      // can answer mid-build with a partial catalog (#2145), and a partial
      // answer must not erase what a fuller one already listed. The config
      // keeps last-write-wins: its entries are the CLI's select state, and
      // variant families it omits still surface through the parse. A real
      // removal joins with the next invalidation, which clears this state.
      if (configOptions !== undefined) this.listed.configOptions = configOptions
      if (modes !== undefined) this.listed.modes = modes
      if (models !== undefined) this.listed.models = unionById(this.listed.models, models)
    }
    return this.listed
  }

  discoveredModels(session) {
    const seen = new Set()
    const availableModels = []
    for (const list of [session?.models, this.listed.models]) {
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        const id = String(entry?.modelId ?? entry?.id ?? '')
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        availableModels.push(entry)
      }
    }
    return modelsFromProbe({
      configOptions: session?.configOptions ?? this.listed.configOptions,
      models: availableModels.length > 0 ? { availableModels } : undefined,
    })
  }

  async probeOnOwnPeer({ cwd, mcp, probe }) {
    const peer = await this.ensure({ probe })
    const listing = this.probeModelsListing()
    const reply = await this.newSession(peer, { cwd, mcp })
    if (reply?.sessionId !== undefined) {
      this.commands.delete(reply.sessionId)
      if (this.caps.close) await peer.request('session/close', { sessionId: reply.sessionId }, { timeout: 15_000 }).catch(() => {})
    }
    return mergeModelEvidence(reply, await listing)
  }

  // Some CLIs advertise their catalog in two places at once: the ACP session reply
  // and a plain listing command (`agy models`). The ACP reply can be a partial
  // snapshot while the CLI's own catalog is still being built (#2145): the listing
  // then carries the variants the reply lacks, so both are merged before parsing.
  async probeModelsListing() {
    const args = this.engine.modelsArgs
    if (!Array.isArray(args) || args.length === 0) return []
    try {
      const bin = this.bin ?? findEngineExecutable(this.engine, name => this.findExecutable(name))
      if (bin === undefined) return []
      const launch = launchOf(bin, args)
      const result = await runProbeCommand(launch.file, launch.args, {
        timeoutMs: 10_000,
        forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS,
        spawnOptions: launch.options,
      })
      return result.ok ? parseModelListing(result.stdout) : []
    } catch {
      return []
    }
  }

  // Models (and per-model thinking levels) the agent advertises on a probe session.
  async listModels({ cwd, mcp }) {
    const epoch = this.catalogEpoch()
    const fresherModels = () => modelsFromProbe({ configOptions: this.listed.configOptions, models: { availableModels: this.listed.models } })
    if (this.engine.cwdPerProcess) {
      const live = this.activeWorker()
      if (live !== undefined) {
        live.inFlight += 1
        try {
          const target = live.engine.spawnCwd && existsSync(live.engine.spawnCwd) ? live.engine.spawnCwd : cwd
          const models = await live.listModels({ cwd: target, mcp })
          if (this.catalogEpochMatches(epoch)) {
            this.caps.image = live.caps.image
            if (live.catalog !== this.catalog) {
              this.remember({
                configOptions: live.listed.configOptions,
                modes: { availableModes: live.listed.modes },
                models: { availableModels: live.listed.models },
              }, { epoch })
            }
            return models
          }
          const fresher = fresherModels()
          return fresher.length > 0 ? fresher : models
        } finally {
          live.inFlight -= 1
          if (this.maybeRetireWorker(live)) await live.close().catch(() => {})
        }
      }
      const temp = this.spawnWorker(cwd, { isolated: true })
      this.probeWorkers.add(temp)
      try {
        const reply = await temp.probeOnOwnPeer({ cwd, mcp, probe: true })
        const models = modelsFromProbe(reply)
        if (this.catalogEpochMatches(epoch)) {
          this.caps.image = temp.caps.image
          this.remember(reply, { epoch })
          return models
        }
        // Even when fresher writes landed mid-probe the evidence unions in; only
        // an invalidation discards a probe wholesale (see remember()).
        this.remember(reply, { epoch })
        const fresher = fresherModels()
        return fresher.length > 0 ? fresher : models
      } finally {
        this.probeWorkers.delete(temp)
        await temp.close({ forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS }).catch(() => {})
      }
    }
    // Reuse an already-running live peer when present. Otherwise run the probe in
    // an isolated temporary process with probeEnv so a concurrent live session open
    // never inherits MISE_OFFLINE=1 on the shared engine peer.
    if (this.peer !== undefined || this.starting !== undefined) {
      const probe = await this.probeOnOwnPeer({ cwd, mcp, probe: false })
      const stale = !this.catalogEpochMatches(epoch)
      this.remember(probe, { epoch })
      if (stale) {
        const fresher = fresherModels()
        if (fresher.length > 0) return fresher
      }
      return modelsFromProbe(probe)
    }
    const temp = new AcpEngine(
      this.route,
      { ...this.engine, cwdPerProcess: false },
      { findExecutable: this.findExecutable, defaultEfforts: new Map(this.defaultEfforts), sessionEfforts: this.sessionEfforts, cancelAckTimeoutMs: this.cancelAckTimeoutMs },
    )
    this.probeWorkers.add(temp)
    try {
      const probe = await temp.probeOnOwnPeer({ cwd, mcp, probe: true })
      const stale = !this.catalogEpochMatches(epoch)
      this.remember(probe, { epoch })
      if (!stale) {
        this.caps.image = temp.caps.image
        return modelsFromProbe(probe)
      }
      const fresher = fresherModels()
      return fresher.length > 0 ? fresher : modelsFromProbe(probe)
    } finally {
      this.probeWorkers.delete(temp)
      await temp.close({ forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS }).catch(() => {})
    }
  }
}

function acpPrompt(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'image') {
      out.push({ type: 'image', mimeType: block.mimeType ?? block.mediaType ?? 'image/png', data: block.data })
    } else if ((block.text ?? '') !== '') {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

// The trailing token of a concrete variant id, when it is a known thinking level.
const tierSuffixOf = (id, vocabulary) => vocabulary.find(token => id.endsWith(`-${token}`))

const catalogEntryId = entry => String(entry?.modelId ?? entry?.id ?? entry?.value ?? entry?.name ?? '')
function unionById(previous = [], next = []) {
  const seen = new Set()
  const out = []
  for (const entry of [...previous, ...next]) {
    const id = catalogEntryId(entry)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

// Model entries of a CLI's plain listing command output (`agy models` style):
// one model per line, the id first, its display name after a tab or spacing.
// Header and progress lines have no id-shaped first token and drop out.
export function parseModelListing(stdout) {
  const entries = []
  const seen = new Set()
  for (const raw of String(stdout ?? '').split(/\r?\n/u)) {
    // A listing printed for a terminal may carry color; the id is read uncolored.
    // eslint-disable-next-line no-control-regex
    const trimmed = raw.replace(/\x1b\[[0-9;]*m/gu, '').trim()
    if (trimmed === '') continue
    const match = /^(\S+)(?:[\t ]{2,}|\t)(.+)$/u.exec(trimmed) ?? /^(\S+)$/u.exec(trimmed)
    if (match === null) continue
    const id = match[1]
    // Model ids carry a digit or a separator; a word alone is a header or noise.
    if (!/^[\w][\w./-]*$/u.test(id) || !/[\d._-]/u.test(id) || seen.has(id)) continue
    seen.add(id)
    entries.push({ modelId: id, name: (match[2] ?? '').trim() || id })
  }
  return entries
}

// The probe reply plus the CLI's own listing entries merged into one evidence set:
// variant ids either source knows count as variant evidence for the parse.
function mergeModelEvidence(reply, listingEntries = []) {
  if (!Array.isArray(listingEntries) || listingEntries.length === 0) return reply ?? {}
  const availableModels = [...(reply?.models?.availableModels ?? [])]
  const seen = new Set(availableModels.map(entry => String(entry?.modelId ?? entry?.id ?? '')))
  for (const entry of listingEntries) {
    const id = String(entry?.modelId ?? entry?.id ?? '')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    availableModels.push(entry)
  }
  return { ...reply, models: { ...reply?.models, availableModels } }
}

// The catalog one probe's evidence describes. Base models come from the model
// config's options when the CLI lists them; `models.availableModels` is variant
// evidence: an entry `<base>-<level>` proves that base serves that thinking level.
// The config and the variants can disagree when the CLI answered mid-build (#2145),
// so variant families the config does not list become bases of their own (when the
// family shows at least two levels, which tells a real tier suffix from a trailing
// word of the model's own name), and a concrete entry neither config nor family
// explains is listed as itself.
export function modelsFromProbe(probe) {
  const option = configOptionsOf(probe?.configOptions ?? [], 'model')
  const available = probe?.models?.availableModels ?? []
  const thought = configOptionsOf(probe?.configOptions ?? [], 'thought_level')
  const thoughtOptions = (thought?.options ?? []).map(entry => ({
    id: String(entry.id ?? entry.value ?? entry.name),
    name: String(entry.name ?? entry.id ?? entry.value),
    ...(entry.description ? { description: String(entry.description) } : {}),
  }))
  const thoughtById = new Map(thoughtOptions.map(entry => [entry.id, entry]))
  const vocabulary = [...new Set([...EFFORT_ORDER, ...thoughtOptions.map(entry => entry.id)])]
  const effortOf = id => thoughtById.get(id) ?? { id, name: EFFORT_NAMES[id] ?? id }
  const configBases = (option?.options ?? []).map(entry => ({ id: String(entry.id ?? entry.value ?? entry.name), name: String(entry.name ?? entry.id ?? entry.value) }))

  // Group the available entries that end in a known level token by their base id.
  const groups = new Map() // baseId -> Map(tierId -> entry)
  const groupOf = (baseId) => {
    let group = groups.get(baseId)
    if (group === undefined) {
      group = new Map()
      groups.set(baseId, group)
    }
    return group
  }
  const entries = available.map((entry) => {
    const id = String(entry.modelId ?? entry.id ?? entry.name)
    const tier = tierSuffixOf(id, vocabulary)
    if (tier !== undefined && id.length > tier.length + 1) groupOf(id.slice(0, -(tier.length + 1))).set(tier, entry)
    return { entry, id, tier, baseId: tier === undefined ? undefined : id.slice(0, -(tier.length + 1)) }
  })

  const configIds = new Set(configBases.map(base => base.id))
  const variantMode = configBases.some(base => groups.has(base.id))
  if (!variantMode) {
    // No evidence this CLI publishes one id per level: every model serves the
    // thinking levels the config lists, like before variant-aware parsing.
    const baseModels = configBases.length > 0
      ? configBases
      : entries.map(({ entry, id }) => ({ id, name: String(entry.name ?? id) }))
    return baseModels.map(model => (thoughtOptions.length > 0 ? { ...model, reasoning: { efforts: thoughtOptions } } : model))
  }

  const consumed = new Set()
  const tiersOf = (baseId) => {
    const group = groups.get(baseId)
    if (group === undefined) return []
    for (const tier of group.keys()) consumed.add(`${baseId}-${tier}`)
    return vocabulary.filter(tier => group.has(tier)).map(effortOf)
  }
  const out = configBases.map((model) => {
    // Leave defaultEffort unset so a Bot without a chosen level keeps the CLI's default.
    const efforts = tiersOf(model.id)
    return efforts.length > 0 ? { ...model, reasoning: { efforts } } : model
  })

  // A variant family the config does not list at all: the CLI's own model ids,
  // collapsed to their base so a pick reaches it the way the config entries do.
  for (const [baseId, group] of groups) {
    if (configIds.has(baseId) || group.size < 2) continue
    for (const tier of group.keys()) consumed.add(`${baseId}-${tier}`)
    const first = group.values().next().value
    const stripped = String(first?.name ?? '').replace(/\s*\([^()]*\)\s*$/u, '').trim()
    out.push({
      id: baseId,
      name: stripped !== '' ? stripped : baseId,
      reasoning: { efforts: vocabulary.filter(tier => group.has(tier)).map(effortOf) },
    })
  }

  // Whatever is left over is a concrete model of its own (a single-level model
  // whose id happens to end in a level word, or a variant of a family too thin
  // to read). It is listed as itself, untiered, rather than dropped.
  for (const { entry, id } of entries) {
    if (consumed.has(id) || configIds.has(id)) continue
    out.push({ id, name: String(entry.name ?? id) })
  }

  const seen = new Set()
  return out.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

function serversFor(mcp, mode = 'http') {
  if (mcp === undefined || mode === 'none') return []
  if (mode === 'stdio') {
    return [{
      name: MCP_SERVER,
      command: process.execPath,
      args: [stdioBridgePath()],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'DSBOT_MCP_URL', value: mcp.url },
        { name: 'DSBOT_MCP_TOKEN', value: mcp.token },
      ],
    }]
  }
  return [{ type: 'http', name: MCP_SERVER, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }]
}

// ACP has no standard field for the MCP server of a call, so each CLI marks it
// differently: provider/server fields in input/_meta, permissionRule, or name prefixes.
const ownToolCall = (call) => {
  const input = inputOf(call)
  const args = call?.args !== null && typeof call?.args === 'object' ? call.args : {}
  const name = String(call?.name ?? call?.toolName ?? '')
  return input.providerIdentifier === MCP_SERVER
    || input.serverName === MCP_SERVER
    || input.mcpServer === MCP_SERVER
    || call?._meta?.mcpServer === MCP_SERVER
    || call?._meta?.serverName === MCP_SERVER
    || String(call?._meta?.['cognition.ai/toolName'] ?? '').startsWith(`mcp__${MCP_SERVER}__`)
    || String(call?._meta?.['cognition.ai/permissionRule'] ?? '').startsWith(`mcp__${MCP_SERVER}__`)
    || name.startsWith(`mcp__${MCP_SERVER}__`)
    || name.startsWith(`mcp_${MCP_SERVER}_`)
    || name.startsWith(`${MCP_SERVER}__`)
    || name.startsWith(`${MCP_SERVER}:`)
    || name.startsWith(`${MCP_SERVER}/`)
    || (name === 'call_mcp_tool' && (input.ServerName === MCP_SERVER || args.ServerName === MCP_SERVER))
}
const ANONYMOUS_MCP_TITLE = /^mcp(?:\s*:\s*tool)?$/i
// Cursor opens an MCP call as an empty placeholder (`MCP: tool`) and names the
// provider only in a follow-up tool_call_update; defer activity until identity arrives.
const isAnonymousMcpPlaceholder = (call) => {
  if (ownToolCall(call)) return false
  const title = typeof call?.title === 'string' ? call.title.trim() : ''
  if (!ANONYMOUS_MCP_TITLE.test(title)) return false
  if (call?.name !== undefined || call?.toolName !== undefined) return false
  if (Object.keys(inputOf(call)).length > 0) return false
  if ((call?.locations?.length ?? 0) > 0) return false
  const meta = call?._meta
  if (meta !== null && typeof meta === 'object' && (
    meta.mcpServer !== undefined
    || meta.serverName !== undefined
    || meta['cognition.ai/toolName'] !== undefined
    || meta['cognition.ai/permissionRule'] !== undefined
  )) return false
  return true
}
const configOptionsOf = (options, category) => options.find(option => (option.category ?? option.id) === category)
const textOf = content => (Array.isArray(content) ? content : [content]).filter(block => block?.type === 'text').map(block => block.text).join('')
const planText = entries => (entries ?? []).map(entry => `- ${entry.content ?? entry.title ?? ''}`).join('\n')
const mergeCall = (known, update) => ({
  ...known,
  ...Object.fromEntries(Object.entries(update).filter(([key, value]) => key !== 'sessionUpdate' && value !== undefined && value !== null)),
  ...(known?._meta !== null && typeof known?._meta === 'object' && update?._meta !== null && typeof update?._meta === 'object'
    ? { _meta: { ...known._meta, ...update._meta } }
    : {}),
})
const callOf = (session, toolCall) => mergeCall(toolCall?.toolCallId === undefined ? undefined : session.toolCalls.get(toolCall.toolCallId), toolCall ?? {})
// ACP tool kinds that change files or run something.
const CHANGE_KINDS = new Set(['edit', 'delete', 'move', 'execute'])
const VERBS = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run', think: 'Think', fetch: 'Fetch' }
const inputOf = call => (call?.rawInput !== null && typeof call?.rawInput === 'object' ? call.rawInput : {})
// One line a person can act on: what kind of action, on what.
export const describeCall = (call) => {
  const input = inputOf(call)
  const command = input.command ?? input.cmd ?? input.CommandLine
  const target = typeof command === 'string' ? `\`${command.length > 160 ? `${command.slice(0, 157)}…` : command}\``
    : (call.locations ?? []).map(location => location?.path).filter(Boolean).join(', ')
      || input.path || input.file_path || input.Path || input.TargetFile || input.url || input.query || input.pattern || ''
  const verb = VERBS[call.kind]
  const title = typeof call.title === 'string' && call.title.trim() !== '' ? call.title.trim() : undefined
  const rawTarget = String(target).replaceAll('`', '')
  if (title !== undefined && (target === '' || (title.includes(rawTarget) && (verb === undefined || title !== rawTarget)))) return title
  if (verb !== undefined && target !== '') return `${verb} ${target}`
  return [title ?? verb ?? 'Use a tool', target].filter(Boolean).join(': ')
}
// What the card adds under its one-line action: the call's other inputs, one
// per line; what the action line already says is not repeated.
const detailText = (call, action = '') => {
  const lines = Object.entries(inputOf(call))
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
    .filter(([, value]) => !action.includes(value))
    .map(([key, value]) => `${key}: ${value}`)
  const paths = (call.locations ?? []).map(location => location?.path).filter(path => path && !action.includes(path))
  if (paths.length > 0) lines.push(paths.join(', '))
  return lines.join('\n').slice(0, 4_000)
}
const positiveInt = value => (Number.isSafeInteger(value) && value > 0 ? value : undefined)
// A prompt's usage. Some CLIs fold cached input into inputTokens (Devin: totalTokens is
// inputTokens + outputTokens), while others (Antigravity) count cachedReadTokens apart.
export const usageOf = (usage, calls) => {
  if (typeof usage?.inputTokens !== 'number' && typeof usage?.outputTokens !== 'number') return undefined
  const read = usage.cachedReadTokens ?? 0
  const write = usage.cachedWriteTokens ?? 0
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const separate = typeof usage.totalTokens === 'number' && read + write > 0 && usage.totalTokens >= input + read + write + output
  const resolvedCalls = positiveInt(calls) ?? positiveInt(usage.calls)
  return {
    inputTokens: !separate && read + write <= input ? input - read - write : input,
    outputTokens: output,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(usage.thoughtTokens ? { reasoningTokens: usage.thoughtTokens } : {}),
    ...(resolvedCalls !== undefined && resolvedCalls > 1 ? { calls: resolvedCalls } : {}),
  }
}
const compactionStatus = status => (status === 'completed' ? 'completed' : status === 'started' || status === 'in_progress' ? 'started' : 'failed')
