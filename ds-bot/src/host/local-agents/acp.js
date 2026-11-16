// The Agent Client Protocol engine: one child process per route (or per working
// folder when the CLI pins shell commands to its process cwd), ACP over stdio.
// A process multiplexes sessions: each DS Bot Session maps to one ACP session,
// created or resumed with our loopback MCP server attached.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { cleanEnv, findEngineExecutable, spawnAgent } from './discover.js'
import { acpMode } from './engines.js'

const CLIENT = { name: 'ds-bot', version: '1' }
// DS Bot's loopback MCP server, which carries the Bot's team tools.
const MCP_SERVER = 'dsbot'
const AUTH_ERROR = /not signed in|not logged in|login required|unauthorized|authentication/i
const TIMEOUT_ERROR = /timed out|timeout/i
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

function terminateChild(child) {
  if (child === undefined) return
  try { child.kill('SIGTERM') } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.()
}
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

// Events a driver reports, normalized for the adapter:
// {type:'text'|'thought',text} | {type:'activity',text} (one compact line of the
// agent's own work) | {type:'permission',id,action,detail,options,changes,reply} |
// {type:'done',reason,usage?} | {type:'error',error} | {type:'usage',usage} |
// {type:'context',used?,size?} (how full the CLI's own context is) |
// {type:'compaction',status:'started'|'completed'|'failed'}
export class AcpEngine {
  constructor(route, engine, { findExecutable, defaultEfforts = new Map(), sessionEfforts = new Map() }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.defaultEfforts = defaultEfforts
    this.sessionEfforts = sessionEfforts
    this.hasModelConfig = false
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    this.sessions = new Map()
    this.caps = {}
    // The modes, options and models this CLI listed last, for a reply that lists none.
    this.listed = { modes: [], configOptions: [], models: [] }
    // The commands each agent session lists, by the agent's session id.
    this.commands = new Map()
    // For CLIs whose commands follow their process cwd (`cwdPerProcess`): one
    // worker AcpEngine per resolved workspace folder.
    this.workers = new Map()
    this.sessionWorkers = new Map()
    this.ephemeral = false
  }

  activeWorker() {
    return [...this.workers.values()].find(worker => worker.peer !== undefined)
  }

  spawnWorker(cwd) {
    return new AcpEngine(
      this.route,
      { ...this.engine, cwdPerProcess: false, ...(cwd ? { spawnCwd: cwd } : {}) },
      { findExecutable: this.findExecutable, defaultEfforts: new Map(this.defaultEfforts), sessionEfforts: this.sessionEfforts },
    )
  }

  workerOf(session, dshSessionId = session?.dshSessionId) {
    return session?._worker ?? (dshSessionId !== undefined ? this.sessionWorkers.get(dshSessionId) : undefined)
  }

  async ensure() {
    if (this.peer !== undefined) return this.peer
    if (this.starting !== undefined) return this.starting
    const starting = this.startPeer()
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  async startPeer() {
    const bin = findEngineExecutable(this.engine, name => this.findExecutable(name))
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    const spawnCwd = this.engine.spawnCwd && existsSync(this.engine.spawnCwd) ? this.engine.spawnCwd : undefined
    const child = spawnAgent(bin, this.engine.args ?? [], {
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
      env: cleanEnv(this.engine.env ?? {}),
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
        terminateChild(child)
      }
      throw error
    }
  }

  sessionFor(dshSessionId) {
    let session = this.sessions.get(dshSessionId)
    // A session whose process exited keeps its queue and, with it, the pump
    // still waiting there: a reopened session needs a fresh one.
    if (session === undefined || session.dead) {
      const queue = new EventQueue()
      session = { dshSessionId, acpSessionId: undefined, dead: false, modes: [], toolCalls: new Map(), push: event => queue.push(event), next: () => queue.next() }
      this.sessions.set(dshSessionId, session)
    }
    return session
  }

  onNotice(method, params) {
    // Devin lists a session's commands before it answers session/new, so they are
    // kept by the agent's session id rather than on a session not known yet.
    if (params?.update?.sessionUpdate === 'available_commands_update') {
      this.commands.set(params.sessionId, (params.update.availableCommands ?? []).map(command => command?.name).filter(Boolean))
      return
    }
    const session = [...this.sessions.values()].find(entry => entry.acpSessionId === params?.sessionId)
    if (session === undefined) return
    // Devin CLI 3000.12 reports its compaction this way, not as compaction_update.
    if (method === '_cognition.ai/compaction') {
      session.push({ type: 'compaction', status: compactionStatus(params?.status) })
      return
    }
    if (method !== 'session/update') return
    const update = params?.update ?? {}
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': session.push({ type: 'text', text: textOf(update.content) }); break
      case 'agent_thought_chunk': session.push({ type: 'thought', text: textOf(update.content) }); break
      case 'tool_call':
      case 'tool_call_update': {
        // A permission request names the call only by id; its title, kind and
        // input came with the call's own updates, so they are kept here.
        const id = update.toolCallId
        const known = id === undefined ? undefined : session.toolCalls.get(id)
        const call = mergeCall(known, update)
        if (id !== undefined) session.toolCalls.set(id, call)
        if (known === undefined) session.push({ type: 'activity', text: `▸ ${describeCall(call)}` })
        else if (update.status === 'failed' && known.status !== 'failed') session.push({ type: 'activity', text: `▸ ${describeCall(call)} — failed` })
        break
      }
      case 'plan': session.push({ type: 'thought', text: planText(update.entries) }); break
      case 'usage_update': {
        // Devin sends each one twice, the second marked as a subagent's; a real
        // subagent's context is not the session's.
        if (update._meta?.['cognition.ai/subagent_context'] !== undefined) break
        if (typeof update.used === 'number') session.push({ type: 'context', used: update.used, ...(typeof update.size === 'number' ? { size: update.size } : {}) })
        break
      }
      case 'config_option_update': {
        if (Array.isArray(update.configOptions)) {
          session.configOptions = update.configOptions
          session.modes = update.modes?.availableModes ?? configOptionsOf(update.configOptions, 'mode')?.options ?? session.modes
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
      const options = (params?.options ?? []).map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
      const call = callOf(session, params?.toolCall)
      // Cursor, Devin and Antigravity ask before MCP tool calls. A call to DS Bot's
      // own server is approved once here: toolsFor() already narrowed what the Bot
      // may call. Other tools, and an agent that offers no one-time allow, still ask.
      const once = ownToolCall(call) ? options.find(option => option.kind === 'allow_once') : undefined
      if (once !== undefined) return Promise.resolve({ outcome: { outcome: 'selected', optionId: once.optionId } })
      const action = describeCall(call)
      return new Promise((resolve) => {
        const id = `perm-${Math.random().toString(36).slice(2)}`
        const reply = (optionId) => {
          if (optionId === null) resolve({ outcome: { outcome: 'cancelled' } })
          else resolve({ outcome: { outcome: 'selected', optionId } })
        }
        session.push({
          type: 'permission', id, reply,
          action,
          detail: detailText(call, action),
          options,
          changes: CHANGE_KINDS.has(call.kind),
        })
      })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async openInWorker(dshSessionId, openArgs) {
    const existing = openArgs.ephemeral === true ? this.activeWorker() : undefined
    const key = openArgs.cwd ? resolve(openArgs.cwd) : ''
    const reused = existing !== undefined
    let worker = existing ?? this.workers.get(key)
    const created = worker === undefined
    if (created) {
      worker = this.spawnWorker(key)
      if (openArgs.ephemeral === true) worker.ephemeral = true
      this.workers.set(key, worker)
    }
    try {
      const session = await worker.open(dshSessionId, openArgs)
      session._worker = worker
      this.sessionWorkers.set(dshSessionId, worker)
      this.caps.image = worker.caps.image
      return session
    } catch (error) {
      if (created && !reused && ![...this.sessionWorkers.values()].includes(worker)) {
        this.workers.delete(key)
        await worker.close().catch(() => {})
      }
      throw error
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
  async loadSession(peer, { cwd, mcp, resumeId }) {
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
        if (i === modes.length - 1) return { reply: await this.newSession(peer, { cwd, mcp }), loaded: false }
      }
    }
  }

  // A new or resumed ACP session for one DS Bot Session.
  async open(dshSessionId, openArgs) {
    if (this.engine.cwdPerProcess) return this.openInWorker(dshSessionId, openArgs)
    const { cwd, mcp, resumeId, preset, model } = openArgs
    const peer = await this.ensure()
    const session = this.sessionFor(dshSessionId)
    const { reply, loaded } = resumeId !== undefined
      ? await this.loadSession(peer, { cwd, mcp, resumeId })
      : { reply: await this.newSession(peer, { cwd, mcp }), loaded: false }
    session.acpSessionId = reply?.sessionId ?? resumeId
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

  async prompt(session, blocks, { signal, effort } = {}) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.prompt(session, blocks, { signal, effort })
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
    session.running = true
    const reply = peer.request('session/prompt', { sessionId: session.acpSessionId, prompt: acpPrompt(blocks) }, { signal, timeout: 0 })
    reply.then(
      result => { session.running = false; session.push({ type: 'done', reason: result?.stopReason ?? 'end_turn', ...(usageOf(result?.usage) ? { usage: usageOf(result.usage) } : {}) }) },
      error => { session.running = false; session.push({ type: 'error', error }) },
    )
    return reply
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
      worker.forget(session.dshSessionId)
      this.sessionWorkers.delete(session.dshSessionId)
      if (worker.ephemeral && worker.sessions.size === 0) {
        for (const [key, entry] of this.workers) if (entry === worker) this.workers.delete(key)
        await worker.close()
      }
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
    this.peer?.notify('session/cancel', { sessionId: session.acpSessionId })
  }

  // The adapter stopped reading this session: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    if (this.engine.cwdPerProcess) {
      const worker = this.sessionWorkers.get(dshSessionId)
      if (worker === undefined) return
      this.sessionWorkers.delete(dshSessionId)
      worker.forget(dshSessionId)
      if (worker.sessions.size === 0) {
        for (const [key, entry] of this.workers) if (entry === worker) this.workers.delete(key)
        void worker.close().catch(() => {})
      }
      return
    }
    this.sessions.delete(dshSessionId)
  }

  async close() {
    for (const worker of this.workers.values()) await worker.close()
    this.workers.clear()
    this.sessionWorkers.clear()
    const child = this.child
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    terminateChild(child)
  }

  remember(reply) {
    const configOptions = reply?.configOptions
    if (configOptionsOf(configOptions ?? [], 'model') !== undefined) this.hasModelConfig = true
    const modes = reply?.modes?.availableModes ?? configOptionsOf(configOptions ?? [], 'mode')?.options
    const models = reply?.models?.availableModels
    this.listed = {
      configOptions: configOptions ?? this.listed.configOptions,
      modes: modes ?? this.listed.modes,
      models: models ?? this.listed.models,
    }
    return this.listed
  }

  // Models (and per-model thinking levels) the agent advertises on a probe session.
  async listModels({ cwd, mcp }) {
    if (this.engine.cwdPerProcess) {
      const live = this.activeWorker()
      if (live !== undefined) {
        const target = live.engine.spawnCwd && existsSync(live.engine.spawnCwd) ? live.engine.spawnCwd : cwd
        const models = await live.listModels({ cwd: target, mcp })
        this.caps.image = live.caps.image
        return models
      }
      const temp = this.spawnWorker(cwd)
      try {
        const models = await temp.listModels({ cwd, mcp })
        this.caps.image = temp.caps.image
        return models
      } finally {
        await temp.close()
      }
    }
    const peer = await this.ensure()
    const probe = await this.newSession(peer, { cwd, mcp })
    if (probe?.sessionId !== undefined) {
      this.commands.delete(probe.sessionId)
      if (this.caps.close) await peer.request('session/close', { sessionId: probe.sessionId }, { timeout: 15_000 }).catch(() => {})
    }
    this.remember(probe)
    return modelsFromProbe(probe)
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

export function modelsFromProbe(probe) {
  const option = configOptionsOf(probe?.configOptions ?? [], 'model')
  const available = probe?.models?.availableModels ?? []
  const baseModels = (option?.options ?? []).length > 0
    ? option.options.map(entry => ({ id: String(entry.id ?? entry.value ?? entry.name), name: String(entry.name ?? entry.id ?? entry.value) }))
    : available.map(entry => ({ id: String(entry.modelId ?? entry.id ?? entry.name), name: String(entry.name ?? entry.modelId ?? entry.id) }))
  const thought = configOptionsOf(probe?.configOptions ?? [], 'thought_level')
  const thoughtOptions = (thought?.options ?? []).map(entry => ({
    id: String(entry.id ?? entry.value ?? entry.name),
    name: String(entry.name ?? entry.id ?? entry.value),
    ...(entry.description ? { description: String(entry.description) } : {}),
  }))
  const thoughtById = new Map(thoughtOptions.map(entry => [entry.id, entry]))
  const availableIds = new Set(available.map(entry => String(entry.modelId ?? entry.id ?? '')).filter(Boolean))
  const knownEfforts = [...new Set([...EFFORT_ORDER, ...thoughtOptions.map(entry => entry.id)])]
  const hasVariantMap = (option?.options ?? []).length > 0
    && availableIds.size > 0
    && baseModels.some(base => knownEfforts.some(effortId => availableIds.has(`${base.id}-${effortId}`)))
  return baseModels.map((model) => {
    // Leave defaultEffort unset so a Bot without a chosen level keeps the CLI's default.
    if (hasVariantMap) {
      const efforts = knownEfforts
        .filter(effortId => availableIds.has(`${model.id}-${effortId}`))
        .map(effortId => thoughtById.get(effortId) ?? { id: effortId, name: EFFORT_NAMES[effortId] ?? effortId })
      return efforts.length > 0 ? { ...model, reasoning: { efforts } } : model
    }
    return thoughtOptions.length > 0 ? { ...model, reasoning: { efforts: thoughtOptions } } : model
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
    || String(call?._meta?.['cognition.ai/permissionRule'] ?? '').startsWith(`mcp__${MCP_SERVER}__`)
    || name.startsWith(`mcp__${MCP_SERVER}__`)
    || name.startsWith(`mcp_${MCP_SERVER}_`)
    || name.startsWith(`${MCP_SERVER}__`)
    || name.startsWith(`${MCP_SERVER}:`)
    || name.startsWith(`${MCP_SERVER}/`)
    || (name === 'call_mcp_tool' && (input.ServerName === MCP_SERVER || args.ServerName === MCP_SERVER))
}
const configOptionsOf = (options, category) => options.find(option => (option.category ?? option.id) === category)
const textOf = content => (Array.isArray(content) ? content : [content]).filter(block => block?.type === 'text').map(block => block.text).join('')
const planText = entries => (entries ?? []).map(entry => `- ${entry.content ?? entry.title ?? ''}`).join('\n')
const mergeCall = (known, update) => ({
  ...known,
  ...Object.fromEntries(Object.entries(update).filter(([key, value]) => key !== 'sessionUpdate' && value !== undefined && value !== null)),
})
const callOf = (session, toolCall) => mergeCall(toolCall?.toolCallId === undefined ? undefined : session.toolCalls.get(toolCall.toolCallId), toolCall ?? {})
// ACP tool kinds that change files or run something.
const CHANGE_KINDS = new Set(['edit', 'delete', 'move', 'execute'])
const VERBS = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run', think: 'Think', fetch: 'Fetch' }
const inputOf = call => (call.rawInput !== null && typeof call.rawInput === 'object' ? call.rawInput : {})
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
// A prompt's usage. Some CLIs fold cached input into inputTokens (Devin: totalTokens is
// inputTokens + outputTokens), while others (Antigravity) count cachedReadTokens apart.
export const usageOf = (usage) => {
  if (typeof usage?.inputTokens !== 'number' && typeof usage?.outputTokens !== 'number') return undefined
  const read = usage.cachedReadTokens ?? 0
  const write = usage.cachedWriteTokens ?? 0
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const separate = typeof usage.totalTokens === 'number' && read + write > 0 && usage.totalTokens >= input + read + write + output
  return {
    inputTokens: !separate && read + write <= input ? input - read - write : input,
    outputTokens: output,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(usage.thoughtTokens ? { reasoningTokens: usage.thoughtTokens } : {}),
  }
}
const compactionStatus = status => (status === 'completed' ? 'completed' : status === 'started' || status === 'in_progress' ? 'started' : 'failed')
