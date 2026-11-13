// The Agent Client Protocol engine: one child process per route, ACP over
// stdio. A process multiplexes sessions: each DS Bot Session maps to one ACP
// session, created or resumed with our loopback MCP server attached.
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { cleanEnv, spawnAgent } from './discover.js'
import { acpMode } from './engines.js'

const CLIENT = { name: 'ds-bot', version: '1' }
// DS Bot's loopback MCP server, which carries the Bot's team tools.
const MCP_SERVER = 'dsbot'

// Events a driver reports, normalized for the adapter:
// {type:'text'|'thought',text} | {type:'activity',text} (one compact line of the
// agent's own work) | {type:'permission',id,action,detail,options,changes,reply} |
// {type:'done',reason} | {type:'error',error} | {type:'usage',usage}
export class AcpEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.sessions = new Map()
    this.caps = {}
    // The modes and options this CLI listed last, for a reply that lists none.
    this.listed = { modes: [], configOptions: [] }
  }

  async ensure() {
    if (this.peer !== undefined) return this.peer
    const bin = this.engine.command.startsWith('/') || this.engine.command.startsWith('~')
      ? this.findExecutable(this.engine.command)
      : this.findExecutable(this.engine.command)
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    const child = spawnAgent(bin, this.engine.args ?? [], {
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
    const reply = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: CLIENT,
    }, { timeout: 30_000 })
    this.caps = { mcpHttp: reply?.agentCapabilities?.mcpCapabilities?.http === true, mcpSse: reply?.agentCapabilities?.mcpCapabilities?.sse === true }
    return peer
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
    if (method !== 'session/update') return
    const update = params?.update ?? {}
    const session = [...this.sessions.values()].find(entry => entry.acpSessionId === params?.sessionId)
    if (session === undefined) return
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
        const usage = usageOf(update)
        if (usage !== undefined) session.push({ type: 'usage', usage })
        break
      }
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
      // Cursor and Devin ask before every MCP tool call. A call to DS Bot's own server
      // is approved once here: toolsFor() already narrowed what the Bot may call.
      // Other tools, and an agent that offers no one-time allow, still ask.
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

  // A new or resumed ACP session for one DS Bot Session.
  async open(dshSessionId, { cwd, mcp, resumeId, preset, model }) {
    const peer = await this.ensure()
    const session = this.sessionFor(dshSessionId)
    const mcpServers = serversFor(mcp)
    if (mcp !== undefined && this.caps.mcpHttp === false) throw Object.assign(new Error(`${this.engine.name} cannot use HTTP MCP servers; the team tools cannot reach it`), { code: 'NOT_SUPPORTED' })
    const params = { cwd, mcpServers }
    let reply
    if (resumeId !== undefined) {
      try {
        reply = await peer.request('session/load', { ...params, sessionId: resumeId }, { timeout: 30_000 })
      } catch {
        reply = await peer.request('session/new', params, { timeout: 60_000 })
      }
    } else {
      reply = await peer.request('session/new', params, { timeout: 60_000 })
    }
    session.acpSessionId = reply?.sessionId ?? resumeId
    // Some agents list nothing on session/load: the session reads what this CLI
    // listed before rather than guessing a mode.
    const listed = this.remember(reply)
    session.configOptions = listed.configOptions
    session.modes = listed.modes
    // The preset maps to a mode only once the agent has listed its own.
    const mode = acpMode(preset, session.modes)
    if (mode !== undefined) await this.setOption(session, 'mode', mode).catch(() => {})
    // A model the agent does not take fails the turn: going on would answer with a
    // model the user did not pick.
    if (model !== undefined && model !== 'default') {
      await this.setOption(session, 'model', model).catch((error) => {
        throw Object.assign(new Error(`${this.engine.name} did not switch to the model ${model}: ${error?.message ?? error}. Pick another model in the Bot's settings.`), { code: 'LOCAL_AGENT_MODEL' })
      })
    }
    return session
  }

  async setOption(session, category, value) {
    const peer = await this.ensure()
    try {
      const configId = configOptionsOf(session.configOptions ?? [], category)?.id ?? category
      await peer.request('session/set_config_option', { sessionId: session.acpSessionId, configId, value }, { timeout: 15_000 })
    } catch (error) {
      // An agent from before config options takes its mode through session/set_mode.
      if (category !== 'mode') throw error
      await peer.request('session/set_mode', { sessionId: session.acpSessionId, modeId: value }, { timeout: 15_000 }).catch(() => {})
    }
  }

  async prompt(session, blocks, { signal }) {
    const peer = await this.ensure()
    const reply = peer.request('session/prompt', { sessionId: session.acpSessionId, prompt: blocks }, { signal, timeout: 0 })
    reply.then(
      result => session.push({ type: 'done', reason: result?.stopReason ?? 'end_turn' }),
      error => session.push({ type: 'error', error }),
    )
    return reply
  }

  cancel(session) {
    this.peer?.notify('session/cancel', { sessionId: session.acpSessionId })
  }

  // The adapter stopped reading this session: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    this.sessions.delete(dshSessionId)
  }

  async close() {
    const child = this.child
    this.child = undefined
    this.peer = undefined
    if (child !== undefined) {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.()
    }
  }

  remember(reply) {
    const configOptions = reply?.configOptions
    const modes = reply?.modes?.availableModes ?? configOptionsOf(configOptions ?? [], 'mode')?.options
    if (configOptions !== undefined || modes !== undefined) this.listed = { configOptions: configOptions ?? [], modes: modes ?? [] }
    return this.listed
  }

  // Models the agent advertises on a probe session (configOptions 'model').
  async listModels({ cwd, mcp }) {
    const peer = await this.ensure()
    const probe = await peer.request('session/new', { cwd, mcpServers: serversFor(mcp) }, { timeout: 60_000 })
    this.remember(probe)
    const option = configOptionsOf(probe?.configOptions ?? [], 'model')
    return (option?.options ?? []).map(entry => ({ id: String(entry.id ?? entry.value ?? entry.name), name: String(entry.name ?? entry.id ?? entry.value) }))
  }
}

const serversFor = mcp => (mcp === undefined ? [] : [{ type: 'http', name: MCP_SERVER, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }])
// ACP has no field for the MCP server of a call, so each agent says it its own way:
// Cursor in the call's input, Devin in the permission rule the request names.
const ownToolCall = call => call?.rawInput?.providerIdentifier === MCP_SERVER
  || String(call?._meta?.['cognition.ai/permissionRule'] ?? '').startsWith(`mcp__${MCP_SERVER}__`)
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
  const command = input.command ?? input.cmd
  const target = typeof command === 'string' ? `\`${command.length > 160 ? `${command.slice(0, 157)}…` : command}\``
    : (call.locations ?? []).map(location => location?.path).filter(Boolean).join(', ')
      || input.path || input.file_path || input.url || input.query || input.pattern || ''
  const verb = VERBS[call.kind]
  const title = typeof call.title === 'string' && call.title.trim() !== '' ? call.title.trim() : undefined
  if (title !== undefined && (target === '' || title.includes(String(target).replaceAll('`', '')))) return title
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
const usageOf = update => {
  const used = update.used ?? update
  const input = used.inputTokens ?? used.input_tokens
  const output = used.outputTokens ?? used.output_tokens
  if (typeof input !== 'number' && typeof output !== 'number') return undefined
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}
