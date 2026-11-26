// The Codex app-server engine: `codex app-server --listen stdio://`.
// Each live Session has its own process and resumable thread. Turns stream
// item notifications back.
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { PROBE_FORCE_KILL_AFTER_MS, cleanEnv, findEngineExecutable, probeEnv, spawnAgent, terminateChild } from './discover.js'

// The name the loopback MCP server is registered under in each thread's config.
const MCP_SERVER = 'dsbot'

export class CodexEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    this.forkSupported = undefined
    this.threads = new Map()
    this.probeEngines = new Set()
  }

  threadFor(dshSessionId) {
    let thread = this.threads.get(dshSessionId)
    // A thread whose process exited keeps its queue and, with it, the pump
    // still waiting there: a resumed thread needs a fresh one.
    if (thread === undefined || thread.dead) {
      const queue = new EventQueue()
      thread = {
        dshSessionId,
        threadId: undefined,
        dead: false,
        lastTotal: undefined,
        awaitingFirstPrompt: false,
        push: event => queue.push(event),
        next: () => queue.next(),
      }
      this.threads.set(dshSessionId, thread)
    }
    return thread
  }

  async ensure({ probe = false } = {}) {
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
    const child = spawnAgent(bin, this.engine.args ?? [], {
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
      for (const thread of this.threads.values()) {
        this.releaseCompaction(thread)
        thread.dead = true
        thread.push({ type: 'error', error })
      }
    }
    child.on('exit', () => gone(new Error(`${this.engine.name} exited`)))
    // A CLI that cannot start at all (a broken install, a missing interpreter)
    // raises 'error', never 'exit'; unheard it takes the host down.
    child.on('error', error => gone(Object.assign(new Error(`${this.engine.name} could not start: ${error.message}`), { code: 'LOCAL_AGENT_EXIT' })))
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    try {
      await peer.request('initialize', { clientInfo: { name: 'ds-bot', title: null, version: '1' } }, { timeout: 30_000 })
      if (this.child !== child) {
        throw Object.assign(new Error(`${this.engine.name} closed while starting`), { code: 'LOCAL_AGENT_EXIT' })
      }
      peer.notify('initialized', {})
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

  onNotice(method, params) {
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    switch (method) {
      case 'turn/started':
        if (thread !== undefined) this.activateTurn(thread, params?.turn?.id)
        break
      case 'item/started':
      case 'item/completed': {
        const item = params?.item ?? {}
        if (thread === undefined) break
        // Codex 0.166 condenses as an item of its own, in a turn of its own or mid-turn.
        if (item.type === 'contextCompaction' || item.type === 'context_compaction') {
          if (method === 'item/started') this.activateTurn(thread, params?.turnId)
          thread.push({ type: 'compaction', status: method === 'item/started' ? 'started' : 'completed' })
          break
        }
        // Every event names its turn, so the adapter can tell a finished turn's
        // leftovers from the turn it reads now (#1513).
        const turnId = params?.turnId
        if (item.type === 'agentMessage' || item.type === 'agent_message') {
          if ((item.text ?? '') !== '') thread.push({ type: 'text', text: item.text, turnId })
        } else if (item.type === 'reasoning') {
          const thought = (item.content ?? []).join('') || item.text || ''
          if (thought !== '') thread.push({ type: 'thought', text: thought, turnId })
        } else if (method === 'item/started' && item.type !== undefined && !NON_ACTIVITY_ITEMS.has(item.type)) {
          const team = item.type === 'mcpToolCall' && (item.server === MCP_SERVER || item.serverName === MCP_SERVER)
          thread.push({ type: 'activity', text: `▸ ${activityOf(item)}`, turnId, ...(team ? { team: true } : {}) })
        }
        break
      }
      case 'turn/completed': {
        if (thread === undefined) break
        const turn = params?.turn ?? {}
        // Only the turn that finished is cleared. A late notice for an earlier turn —
        // one a steer already replaced — must not clear the turn running now: that would
        // make the next input start a turn instead of steering the live one (#1513).
        thread.completedTurnId = turn.id
        if (turn.id === undefined || thread.turnId === turn.id) thread.turnId = undefined
        if (turn.status === 'failed') thread.push({ type: 'error', error: new Error(turn.error?.message ?? 'the turn failed'), turnId: turn.id })
        else thread.push({ type: 'done', reason: 'stop', turnId: turn.id })
        break
      }
      case 'thread/tokenUsage/updated': {
        // {total, last, modelContextWindow}: `last` is the request that just ran, and
        // its totalTokens is what the thread's context holds now (after a compaction,
        // what is left). `total` is cumulative across the thread and deduplicates
        // repeated or catch-up notifications so billed tokens are never double-counted.
        const last = params?.tokenUsage?.last
        if (thread === undefined || last === undefined) break
        const size = params.tokenUsage.modelContextWindow
        if (typeof last.totalTokens === 'number') thread.push({ type: 'context', used: last.totalTokens, ...(typeof size === 'number' ? { size } : {}), turnId: params?.turnId })
        const total = codexTotals(params?.tokenUsage?.total)
        if (thread.awaitingFirstPrompt === true) {
          if (total !== undefined) thread.lastTotal = total
          break
        }
        let step = last
        if (total !== undefined) {
          const prev = thread.lastTotal
          thread.lastTotal = total
          if (prev !== undefined) {
            const regressed = total.inputTokens < prev.inputTokens || total.outputTokens < prev.outputTokens
            if (!regressed) {
              const delta = {
                inputTokens: total.inputTokens - prev.inputTokens,
                outputTokens: total.outputTokens - prev.outputTokens,
                cachedInputTokens: Math.max(0, total.cachedInputTokens - prev.cachedInputTokens),
                cacheWriteInputTokens: Math.max(0, total.cacheWriteInputTokens - prev.cacheWriteInputTokens),
                reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - prev.reasoningOutputTokens),
              }
              if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.cachedInputTokens === 0 && delta.cacheWriteInputTokens === 0 && delta.reasoningOutputTokens === 0) {
                break
              }
              step = delta
            }
          }
        }
        const cached = step.cachedInputTokens ?? 0
        const cacheWrite = step.cacheWriteInputTokens ?? 0
        const totalInput = step.inputTokens ?? 0
        // Codex folds cached input into inputTokens; DSH counts cached buckets apart.
        const uncached = Math.max(0, totalInput - cached - (cached + cacheWrite <= totalInput ? cacheWrite : 0))
        if (uncached > 0 || cached > 0 || cacheWrite > 0 || (step.outputTokens ?? 0) > 0) {
          thread.push({
            type: 'usage',
            turnId: params?.turnId,
            usage: {
              inputTokens: uncached,
              outputTokens: step.outputTokens ?? 0,
              ...(cached > 0 ? { cacheReadTokens: cached } : {}),
              ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
              ...(step.reasoningOutputTokens ? { reasoningTokens: step.reasoningOutputTokens } : {}),
            },
          })
        }
        break
      }
      default: break
    }
  }

  // Server-initiated approval requests bridge to the approval tool.
  onRequest(method, params) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'execCommandApproval' || method === 'patchApproval') {
      const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
      if (thread === undefined) return Promise.reject({ code: -32603, message: 'unknown thread' })
      const options = (params?.availableDecisions ?? params?.decisions ?? ['accept', 'decline']).map(decision => ({ optionId: decision, kind: decision === 'accept' ? 'allow_once' : decision === 'acceptForSession' ? 'allow_always' : 'reject_once', name: decision }))
      return new Promise((resolve) => {
        const reply = (decision) => resolve({ decision: decision ?? 'decline' })
        thread.push({
          type: 'permission', id: `perm-${Math.random().toString(36).slice(2)}`, reply,
          action: params?.reason ?? params?.command ?? 'The agent asks to run an action',
          changes: true,
          detail: detailText(params),
          // Commands can override the thread directory; only the server's resolved cwd counts.
          cwd: method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval' ? params?.cwd : thread?.cwd,
          options,
        })
      })
    }
    // Codex asks before every MCP tool call under `on-request`. A refusal reads as
    // "user rejected MCP tool call", so DS Bot's own loopback server is approved
    // here: toolsFor() already narrowed what the Bot may call. Other servers and
    // real form elicitations keep the refusal; they are not DS Bot's to approve.
    if (method === 'mcpServer/elicitation/request' && params?.serverName === MCP_SERVER && params?._meta?.codex_approval_kind === 'mcp_tool_call') {
      return Promise.resolve({ action: 'accept', content: null, _meta: null })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async open(dshSessionId, { cwd, mcp, resumeId, resumeOnly = false, mode, instructions, model, review, ephemeral }) {
    const peer = await this.ensure()
    const prior = this.threads.get(dshSessionId)
    const created = prior === undefined || prior.dead
    const thread = this.threadFor(dshSessionId)
    if (resumeId !== undefined) thread.threadId = resumeId
    // Codex 0.166 reads `ThreadStartParams` from the top level and takes the MCP
    // servers from `config`; it drops unknown keys without a word. So the fields keep
    // their documented names: `sandbox`, `approvalPolicy`, and `config.mcp_servers`.
    // The team instructions belong to a new thread: a resumed one keeps the
    // instructions it was started with, and instruct() updates them later.
    const params = {
      cwd,
      ...(model && model !== 'default' ? { model } : {}),
      ...(mode ? { sandbox: mode, approvalPolicy: mode === 'danger-full-access' && !review ? 'never' : 'on-request' } : {}),
      ...(mcp !== undefined ? { config: { mcp_servers: { [MCP_SERVER]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } } } } : {}),
    }
    if (thread.threadId !== undefined) {
      thread.awaitingFirstPrompt = true
      thread.lastTotal = undefined
      try {
        // thread/resume takes the same params, plus the thread id. The instructions it
        // was started with stay: they are not sent again here.
        await peer.request('thread/resume', { threadId: thread.threadId, ...params }, { timeout: 30_000 })
        thread.cwd = cwd
        thread.resumed = true
        return thread
      } catch {
        thread.awaitingFirstPrompt = false
        thread.lastTotal = undefined
        thread.threadId = undefined
        if (resumeOnly) {
          if (created && this.threads.get(dshSessionId) === thread) this.threads.delete(dshSessionId)
          throw Object.assign(new Error('the saved local agent session could not be resumed'), { code: 'LOCAL_AGENT_SESSION_LOST' })
        }
      }
    }
    const resolvedInstructions = typeof instructions === 'function' ? instructions() : instructions
    const reply = await peer.request('thread/start', { ...params, ...(resolvedInstructions ? { developerInstructions: resolvedInstructions } : {}), ...(ephemeral ? { ephemeral: true } : {}) }, { timeout: 60_000 })
    thread.threadId = reply?.thread?.id ?? reply?.threadId
    thread.cwd = cwd
    thread.resumed = false
    thread.awaitingFirstPrompt = false
    thread.lastTotal = undefined
    return thread
  }

  // Forks an existing Codex thread via `thread/fork` (Codex app-server v2) so a
  // background task can inherit the parent thread's working context natively.
  // Caches `forkSupported = false` if an older Codex returns JSON-RPC -32601.
  async fork(sourceThreadId, newDshSessionId, { cwd, mcp, mode, instructions, model, review, ephemeral } = {}) {
    if (this.forkSupported === false || typeof sourceThreadId !== 'string' || sourceThreadId === '') return undefined
    const peer = await this.ensure()
    const params = {
      threadId: sourceThreadId,
      ...(cwd ? { cwd } : {}),
      ...(model && model !== 'default' ? { model } : {}),
      ...(mode ? { sandbox: mode, approvalPolicy: mode === 'danger-full-access' && !review ? 'never' : 'on-request' } : {}),
      ...(mcp !== undefined ? { config: { mcp_servers: { [MCP_SERVER]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } } } } : {}),
      ...(instructions ? { developerInstructions: instructions } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
    }
    try {
      const reply = await peer.request('thread/fork', params, { timeout: 60_000 })
      const forkedId = reply?.thread?.id ?? reply?.threadId
      if (typeof forkedId !== 'string' || forkedId === '') return undefined
      this.forkSupported = true
      return { cliSessionId: forkedId }
    } catch (error) {
      if (error?.code === -32601) this.forkSupported = false
      return undefined
    }
  }

  // Follow-up instructions while a thread lives (Codex injects a developer item).
  // Returns `{ ok, unsupported }` so callers only advance promptHash once delivered.
  async instruct(thread, text) {
    if (text === '') return { ok: true }
    if (this.peer === undefined || thread?.threadId === undefined) return { ok: false, unsupported: false }
    try {
      await this.peer.request('thread/inject_items', { threadId: thread.threadId, items: [{ type: 'developerMessage', text }] }, { timeout: 15_000 })
      return { ok: true }
    } catch (error) {
      return { ok: false, unsupported: error?.code === -32601 }
    }
  }

  async prompt(thread, blocks, { signal, effort }) {
    const peer = await this.ensure()
    thread.awaitingFirstPrompt = false
    const reply = await peer.request('turn/start', {
      threadId: thread.threadId,
      input: codexInput(blocks),
      // The app-server takes the level per turn and keeps it for the next ones.
      ...(effort === undefined ? {} : { effort }),
    }, { signal, timeout: 0 })
    const turnId = reply?.turn?.id ?? reply?.id
    // Notifications in the response's stdout batch run before this continuation.
    thread.turnId = thread.completedTurnId === turnId ? undefined : turnId
    return turnId
  }

  // Codex's app-server refuses a steer that does not name the turn it steers, and
  // a refused steer must reach the adapter: it starts a turn of its own instead of
  // dropping the user's answer. A thread with no live turn cannot be steered at all.
  canSteer(thread) {
    return thread?.turnId !== undefined
  }

  activateTurn(thread, turnId) {
    if (turnId === undefined) return
    thread.awaitingFirstPrompt = false
    thread.turnId = turnId
    thread.pendingCompaction = false
    const cancelled = thread.compactionCancel
    thread.compactionCancel = undefined
    if (cancelled !== undefined) Promise.resolve(this.cancel(thread)).then(cancelled.resolve, cancelled.reject)
  }

  releaseCompaction(thread) {
    thread.pendingCompaction = false
    thread.compactionCancel?.resolve()
    thread.compactionCancel = undefined
  }

  // The thread's own compaction: a turn of its own, which ends with turn/completed.
  compact(thread) {
    if (this.peer === undefined) return false
    thread.awaitingFirstPrompt = false
    thread.turnId = undefined
    thread.pendingCompaction = true
    this.peer.request('thread/compact/start', { threadId: thread.threadId }, { timeout: 30_000 })
      .catch(error => {
        this.releaseCompaction(thread)
        thread.push({ type: 'error', error })
      })
    return true
  }

  async steer(thread, input) {
    const expectedTurnId = thread?.turnId
    if (expectedTurnId === undefined) throw new Error('the turn this input steers has already ended')
    const blocks = Array.isArray(input) ? input : [{ type: 'text', text: input }]
    await this.peer?.request('turn/steer', { threadId: thread.threadId, expectedTurnId, input: codexInput(blocks) }, { timeout: 15_000 })
  }

  cancel(thread) {
    if (thread.pendingCompaction) {
      thread.compactionCancel ??= Promise.withResolvers()
      return thread.compactionCancel.promise
    }
    if (thread.turnId === undefined) return
    return this.peer?.request('turn/interrupt', { threadId: thread.threadId, turnId: thread.turnId }, { timeout: 15_000 }).catch(() => {})
  }

  // The adapter stopped reading this thread: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    const thread = this.threads.get(dshSessionId)
    if (thread !== undefined) this.releaseCompaction(thread)
    this.threads.delete(dshSessionId)
  }

  async listModelsOnOwnPeer({ probe }) {
    const peer = await this.ensure({ probe })
    const reply = await peer.request('model/list', {}, { timeout: 30_000 })
    return (reply?.data ?? reply?.models ?? []).map((entry) => {
      const model = {
        id: String(entry.id ?? entry.model),
        name: String(entry.displayName ?? entry.name ?? entry.id ?? entry.model),
      }
      // The app-server advertises the levels each model takes. Its default is
      // left out on purpose: DSH would send it on every turn, and the level the
      // user set in their Codex config (model_reasoning_effort) would stop
      // applying. A Bot without a level of its own keeps the CLI's.
      const efforts = (entry.supportedReasoningEfforts ?? []).map(option => ({
        id: String(option.reasoningEffort ?? option),
        name: String(option.reasoningEffort ?? option),
        ...(option.description ? { description: String(option.description) } : {}),
      }))
      if (efforts.length === 0) return model
      return { ...model, reasoning: { efforts } }
    })
  }

  async listModels() {
    // Reuse an existing live peer if one is already running; otherwise probe in a
    // temporary process with probeEnv so a concurrent live session never inherits MISE_OFFLINE=1.
    if (this.peer !== undefined || this.starting !== undefined) {
      return this.listModelsOnOwnPeer({ probe: false })
    }
    const temp = new CodexEngine(this.route, this.engine, { findExecutable: this.findExecutable })
    this.probeEngines.add(temp)
    try {
      return await temp.listModelsOnOwnPeer({ probe: true })
    } finally {
      this.probeEngines.delete(temp)
      await temp.close({ forceKillAfterMs: PROBE_FORCE_KILL_AFTER_MS }).catch(() => {})
    }
  }

  async close({ forceKillAfterMs } = {}) {
    const probes = [...this.probeEngines]
    this.probeEngines.clear()
    await Promise.all(probes.map(engine => engine.close({ forceKillAfterMs }).catch(() => {})))
    for (const thread of this.threads.values()) this.releaseCompaction(thread)
    this.threads.clear()
    const child = this.child
    const peer = this.peer
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    peer?.close?.(new Error(`${this.engine.name} closed`))
    if (child === undefined) return this.closing
    if (child.exitCode !== null || child.signalCode !== null) return
    this.closing = new Promise((resolve) => {
      child.once('close', () => resolve())
      terminateChild(child, forceKillAfterMs === undefined ? undefined : { forceKillAfterMs })
    })
    return this.closing
  }
}

function codexInput(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'image') {
      const url = block.url ?? (block.data?.startsWith('data:') ? block.data : `data:${block.mediaType ?? block.mimeType ?? 'image/png'};base64,${block.data}`)
      out.push({ type: 'image', url })
    } else if ((block.text ?? '') !== '') {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

const NON_ACTIVITY_ITEMS = new Set(['userMessage', 'user_message', 'developerMessage', 'developer_message', 'contextCompaction', 'context_compaction'])

export function unwrapShellCommand(raw) {
  if (Array.isArray(raw)) {
    if (raw.length >= 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(String(raw[0])) && /^-[a-z]*c$/i.test(String(raw[1]))) {
      return String(raw[2])
    }
    return raw.join(' ')
  }
  const text = String(raw ?? '').trim()
  const match = /^(?:\/\S+\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c\s+([\s\S]+)$/i.exec(text)
  if (!match) return text
  const body = match[1].trim()
  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) {
    const quote = body[0]
    const inner = body.slice(1, -1)
    return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner.replace(/'\\''/g, "'")
  }
  return body
}

const activityOf = item => {
  const kind = item.type === 'commandExecution' ? unwrapShellCommand(item.command ?? 'command')
    : item.type === 'fileChange' ? 'edit'
      : item.type === 'mcpToolCall' ? (item.tool ?? 'tool')
        : (item.title ?? item.type)
  return String(kind).split('\n')[0].slice(0, 120)
}
const detailText = params => JSON.stringify(params ?? {})

function codexTotals(total) {
  if (total === null || typeof total !== 'object') return undefined
  if (typeof total.inputTokens !== 'number' && typeof total.outputTokens !== 'number') return undefined
  return {
    inputTokens: Math.max(0, total.inputTokens ?? 0),
    outputTokens: Math.max(0, total.outputTokens ?? 0),
    cachedInputTokens: Math.max(0, total.cachedInputTokens ?? 0),
    cacheWriteInputTokens: Math.max(0, total.cacheWriteInputTokens ?? 0),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens ?? 0),
  }
}
