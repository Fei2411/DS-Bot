// The LlmAdapter that serves every local-agent route. A DS Bot Bot whose model
// is one of these routes answers through a local agent CLI instead of a model
// API: the loop, Sessions, tools and approvals are the ordinary ones; this
// adapter turns each request into a prompt for the CLI session the Session is
// mapped to, and the CLI's output back into stream chunks.
import { createHash, randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { textOf } from '../text.js'
import { engineOf, cliMode } from './engines.js'
import { LoopbackMcp } from './mcp.js'

export const DEFAULT_CONTEXT_WINDOW = 200_000
// The replay window when a CLI session is new or its resume failed.
const REPLAY_MESSAGES = 12
const REPLAY_BYTES = 24 * 1024
const IDLE_CLOSE_MS = 10 * 60_000
const APPROVE_TOOL = 'approve_agent_action'
// A CLI that answers its compaction command first and condenses after (Devin) says
// that it started within this long, or it is taken to have condensed without a word.
const COMPACT_START_MS = 15_000
// What a request DS Bot makes of the CLI for itself answers to a tool call it tries.
const NO_TOOLS = 'Tools are not available for this request. Answer with text only.'

// A title request never reaches the CLI.
function titleChunk(text) {
  const title = text.slice(0, 60)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: title },
    { type: 'block-end', index: 0, block: { type: 'text', text: title } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// A compaction request neither: a deterministic digest of the messages.
function digestChunks(messages) {
  const lines = []
  let used = 0
  for (const message of messages ?? []) {
    const text = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${text.slice(0, 300)}`
    if (used + line.length > 8 * 1024) break
    lines.push(line)
    used += line.length
  }
  const text = `[Earlier conversation, condensed]\n${lines.join('\n')}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// Marks the one retry of a turn whose saved Claude conversation was gone.
const RESUME_RETRIED = Symbol('resume retried')

export class LocalAgentAdapter extends LlmAdapter {
  // deps: {rt, findExecutable, spawnEngine(kind,route,engine), record(sessionId),
  //        saveRecord, dropRecord, presetFor(sessionId), toolsFor(options), signInHint(route),
  //        usedModels(route)}
  constructor(deps) {
    super()
    this.deps = deps
    this.engines = new Map()   // route -> engine driver
    this.live = new Map()      // sessionId -> live session
    this.modelCache = new Map()
    this.probes = new Map()    // route -> the probe under way
    this.disposed = false
  }

  providerInfo(route) {
    const engine = engineOf(route, this.deps.customAgents())
    return { id: route, name: engine?.name ?? route }
  }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }

  engine(route) {
    let driver = this.engines.get(route)
    if (driver === undefined) {
      const spec = engineOf(route, this.deps.customAgents())
      if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'NO_ADAPTER')
      driver = this.deps.spawnEngine(spec.kind, route, spec)
      this.engines.set(route, driver)
    }
    return driver
  }

  // What DS Bot knows of a route without starting its CLI: the CLI's default, what a
  // probe found, and what a Bot runs on. DSH and the catalog ask this for every route.
  async listModels(route) {
    if (engineOf(route, this.deps.customAgents()) === undefined) return []
    const listed = [{ provider: route, id: 'default', name: 'CLI default' }, ...(this.modelCache.get(route) ?? [])]
    const used = (this.deps.usedModels?.(route) ?? []).filter(id => !listed.some(model => model.id === id))
    return [...listed, ...used.map(id => ({ provider: route, id, name: id }))]
  }

  // Asks one CLI what it serves, once. A failure is not kept, so the next look tries
  // again. The process it took leaves unless a Session runs on it.
  async probeModels(route) {
    if (this.modelCache.has(route)) return this.listModels(route)
    if (engineOf(route, this.deps.customAgents()) === undefined) return []
    let probe = this.probes.get(route)
    if (probe === undefined) {
      probe = this.askModels(route).finally(() => this.probes.delete(route))
      this.probes.set(route, probe)
    }
    await probe
    return this.listModels(route)
  }

  async askModels(route) {
    const engine = this.engine(route)
    try {
      const models = await engine.listModels({ cwd: this.deps.probeCwd(), mcp: undefined })
      this.modelCache.set(route, (models ?? []).filter(model => model.id !== 'default')
        .map(model => ({ provider: route, id: model.id, name: model.name ?? model.id, ...(model.reasoning ? { reasoning: model.reasoning } : {}) })))
    } catch { /* the menu still has the CLI's default */ }
    if (![...this.live.values()].some(other => other.engine === engine && !other.dead)) await engine.close?.().catch(() => {})
  }

  dropModelCache(route) {
    if (route === undefined) this.modelCache.clear()
    else this.modelCache.delete(route)
  }

  async resolveModel(route, model) {
    const spec = engineOf(route, this.deps.customAgents())
    const listed = (await this.listModels(route).catch(() => [])).find(entry => entry.id === model)
    return {
      provider: route,
      id: model,
      name: listed?.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      // The thinking levels the engine advertises for this model, if any.
      ...(listed?.reasoning ? { reasoning: listed.reasoning } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // The live bridge for one DS Bot Session.
  async liveFor(options, preset) {
    const sessionId = String(options.sessionId)
    let live = this.live.get(sessionId)
    const record = this.deps.record(sessionId)
    const route = options.provider
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
      // A CLI takes its model and permission mode when its session opens. Another
      // model or preset reopens the same CLI session as soon as no turn runs in it.
      if ((live.model === options.model && live.preset === preset) || live.state !== 'idle') return live
      await this.closeLive(live, { idle: true })
    } else if (live !== undefined) await this.closeLive(live)
    const spec = engineOf(route, this.deps.customAgents())
    if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'LOCAL_AGENT_MISSING')
    const engine = this.engine(route)
    live = {
      sessionId, route, spec, engine, dead: false,
      record,
      cliSessionId: record?.cliSessionId,
      handed: record?.handedId,
      promptHash: record?.promptHash,
      engineSession: undefined,
      mcp: undefined,
      events: [],
      waiters: [],
      pending: new Map(),   // dshCallId -> {name, mcpCallId?, reply?}
      started: false,
      // 'idle': no CLI turn. 'running': a prompt is in flight. 'suspended': the
      // turn waits on a bridged tool call or a permission answer.
      state: 'idle',
      // Prompts queued while a turn runs (ACP speaks one prompt at a time);
      // the drain sends the next one when the turn ends.
      queue: [],
      idle: undefined,
      cwd: record?.cwd,
      model: options.model,
      preset,
      // What the CLI reported of its own context ({used, size, stale}) and how often
      // it condensed in this Session; the parts module decides with them.
      context: record?.context,
      compactions: record?.compactions ?? 0,
      // Output of a request DS Bot made for itself may trail its end (Devin's
      // "Context compacted"); until the next prompt, text, thoughts and activity drop.
      mute: false,
    }
    live.push = (event) => {
      this.observe(live, event)
      if (live.mute && live.state === 'idle' && (event?.type === 'text' || event?.type === 'thought' || event?.type === 'activity')) return
      clearTimeout(live.idle)
      live.idle = setTimeout(() => void this.closeLive(live, { idle: true }), IDLE_CLOSE_MS)
      live.idle.unref?.()
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
      ...(live.context === undefined ? {} : { context: live.context }),
      ...(live.compactions > 0 ? { compactions: live.compactions } : {}),
      ...extra,
    }
  }

  // The CLI's own word on its context. A size it reports replaces the default
  // window; a compaction makes the last figure stale until the CLI reports again,
  // except where it reported during the compaction itself (Codex).
  observe(live, event) {
    if (event?.type === 'context') {
      const size = Number.isFinite(event.size) && event.size > 0 ? event.size : live.context?.size
      live.context = Number.isFinite(event.used)
        ? { used: event.used, ...(size === undefined ? {} : { size }) }
        : { ...live.context, ...(size === undefined ? {} : { size }) }
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
    this.deps.saveRecord(live.sessionId, this.recordOf(live))
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

  async closeLive(live, { idle = false } = {}) {
    if (live.dead) return
    live.dead = true
    clearTimeout(live.idle)
    this.live.delete(live.sessionId)
    live.engine.forget?.(live.sessionId)
    live.mcp?.close()
    if (idle) {
      // The CLI session survives on the agent side; the process leaves and the
      // next prompt resumes it.
      live.engineSession = undefined
      live.started = false
    }
    for (const waiter of live.waiters.splice(0)) waiter({ type: 'done', reason: 'stop' })
    const stillUsed = [...this.live.values()].some(other => other.engine === live.engine && !other.dead)
    if (!stillUsed) await live.engine.close?.().catch(() => {})
  }

  // The turn under way ends: the CLI stops, and a call it waits on gets an answer.
  stopTurn(live, reason) {
    live.state = 'idle'
    live.queue.length = 0
    if (live.engineSession !== undefined) live.engine.cancel?.(live.engineSession)
    live.mcp?.failAll(new Error(reason))
    for (const pending of live.pending.values()) pending.resolve({ text: reason, isError: true })
    live.pending.clear()
  }

  // The Session left this CLI: its part moved on. Its process leaves; the CLI session
  // and its record stay, so opening that part again resumes it.
  async closeSession(sessionId, reason = 'the conversation moved on') {
    const live = this.live.get(String(sessionId))
    if (live === undefined) return
    this.stopTurn(live, reason)
    await this.closeLive(live, { idle: true })
  }

  // A Claude CLI that died before `system/init` never read the prompt it was
  // handed: roll the marker back in the live state and in the saved record, so a
  // host that restarts before the next call still replays the input. ACP and
  // Codex create their session before the prompt, so theirs was read.
  // A resume that found its conversation gone also drops the id: the next start
  // opens a new conversation and replays the history, instead of failing every
  // turn on the same id.
  rollbackUnread(live, sessionId) {
    if (live.spec.kind !== 'claude') return
    const session = live.engineSession
    if (session?.dead !== true || session.cliSessionId !== undefined || session.rolledBack === true) return
    session.rolledBack = true
    if (session.resumeMissing === true) {
      live.cliSessionId = undefined
      live.handed = undefined
      live.resumeLost = true
    } else live.handed = live.handedBefore
    this.deps.saveRecord(sessionId, this.recordOf(live))
  }

  // The loopback MCP server for one live session; tools/call lands in its event queue.
  // `tools` lists the current turn's tools; the server outlives the turn that
  // started it, so tools/list reads the latest one.
  async ensureMcp(live, tools) {
    live.tools = tools
    if (live.mcp !== undefined) return live.mcp
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
      const title = (textOf(first?.content).split('\n').find(line => line.trim() !== '') ?? 'Chat').trim()
      yield* titleChunk(title === '' ? 'Chat' : title)
      return
    }
    if (options.purpose === 'compaction') {
      yield* digestChunks(options.messages)
      return
    }
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new LlmError('a local agent request needs a session', 'INVALID_REQUEST')
    const preset = this.deps.presetFor(sessionId)
    const live = await this.liveFor(options, preset)

    // What the request carries past the last handed message. When the marker is
    // gone the CLI session is stale or new: it gets a replay instead of a delta.
    const messages = options.messages ?? []
    const at = live.handed === undefined ? -1 : messages.findIndex(message => message.id === live.handed)
    const fresh = live.handed === undefined || at === -1
    const delta = fresh ? [] : messages.slice(at + 1)

    // Results of the calls the last step emitted answer the suspended CLI calls.
    // A user message never resolves an approve_agent_action pending: only that
    // tool's own result may. User text may answer a pending bridged MCP call
    // whose DSH tool concluded the turn (a question-type card).
    for (const message of delta) {
      if (message.role !== 'tool') continue
      const pending = live.pending.get(message.toolCallId)
      if (pending === undefined) continue
      live.pending.delete(message.toolCallId)
      pending.resolve({ text: textOf(message.content) || (message.isError ? 'the call failed' : ''), isError: message.isError === true })
    }
    // The loop's runtime-context user messages are context, not input: they
    // fold into the next prompt or steer, never start a prompt on their own.
    const contextText = delta
      .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      .map(message => textOf(message.content)).filter(text => text !== '').join('\n')
    const users = delta.filter(message => message.role === 'user' && message.source?.kind !== 'runtime-context')
    // The first open bridged call that is not an approval may take the user's
    // next message as its answer; the rest of the input is new.
    const openCall = [...live.pending.entries()].find(([, entry]) => entry.name !== APPROVE_TOOL)
    const remaining = []
    let answered = openCall === undefined
    for (const message of users) {
      if (!answered && openCall !== undefined) {
        const [id, pending] = openCall
        live.pending.delete(id)
        pending.resolve({ text: textOf(message.content) })
        answered = true
      } else {
        remaining.push(message)
      }
    }

    const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n').trim()
    const promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    const mcp = await this.ensureMcp(live, () => this.deps.toolsFor(options))
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd

    const mode = cliMode(live.spec.kind, preset)
    const instructions = system === '' ? undefined : system

    const freshCli = live.cliSessionId === undefined
    if (live.engineSession === undefined) {
      const openArgs = {
        cwd,
        mcp,
        resumeId: live.cliSessionId,
        mode,
        preset,
        model: options.model,
        // Codex carries the team instructions as developer config on a new
        // thread; Claude gets them appended at spawn; ACP reads them in the
        // first prompt below.
        instructions: live.spec.kind === 'codex' && freshCli ? instructions : undefined,
        system: live.spec.kind === 'claude' ? instructions : undefined,
      }
      live.engineSession = await live.engine.open(sessionId, openArgs)
        .catch(error => { throw toLlmError(error, live) })
      // A resumed CLI reports its id only with `system/init`: keep the saved one
      // in the meantime, or a resume that fails would erase it.
      const reportedId = live.engineSession.acpSessionId ?? live.engineSession.threadId ?? live.engineSession.cliSessionId
      if (reportedId !== undefined) live.cliSessionId = reportedId
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
      if (live.spec.kind !== 'acp' && instructions !== undefined) live.promptHash = promptHash
      this.deps.saveRecord(sessionId, this.recordOf(live, { cwd, promptHash: live.promptHash ?? promptHash, model: options.model }))
      // Claude reports its session id with `system/init`, after start() resolved:
      // the record above has no id yet, so persist it when it lands or the next
      // host has nothing to resume and the conversation starts over.
      const pendingId = session.whenSessionId?.()
      if (pendingId !== undefined) {
        void pendingId.then((id) => {
          if (id === undefined || live.dead) return
          live.cliSessionId = id
          this.deps.saveRecord(sessionId, this.recordOf(live, { cliSessionId: id, cwd, promptHash: live.promptHash ?? promptHash, model: options.model }))
        })
      }
    }

    let promptText = fresh ? renderReplay(messages, system)
      : [contextText, ...remaining.map(message => textOf(message.content))].filter(text => text !== '').join('\n\n')
    let sentInstructions = live.spec.kind !== 'acp' && freshCli && instructions !== undefined
    // A new CLI session gets its instructions in the open args or the replay;
    // the "updated" line is only for a session that saw older ones.
    if (instructions !== undefined && !freshCli && live.promptHash !== promptHash) {
      const updated = `Updated team instructions (replace earlier ones):\n\n${instructions}`
      if (live.spec.kind === 'codex') {
        await live.engine.instruct?.(live.engineSession, updated)
        sentInstructions = true
      } else if (promptText !== '' || live.spec.kind === 'acp' || live.spec.kind === 'claude') {
        promptText = `${updated}\n\n${promptText}`
        sentInstructions = true
      }
    }
    if (promptText !== '') {
      this.sendInput(live, promptText, options.signal, options.reasoningEffort)
      if (sentInstructions) live.promptHash = promptHash
      // ACP only counts instructions once they reach the agent with a prompt.
      if (live.spec.kind === 'acp' && (freshCli || sentInstructions)) live.promptHash = promptHash
    }
    if (live.spec.kind === 'acp' && freshCli && promptText === '' && instructions !== undefined) {
      this.sendInput(live, `Follow these instructions from the user's team for everything you do here. They sit on top of your own; when they conflict, these win.\n\n${instructions}`, options.signal, options.reasoningEffort)
      live.promptHash = promptHash
    }

    // The last DSH message is handed now; a later call sends only what follows.
    // The marker before it is kept: a start that fails before the CLI reads
    // anything must not count that message as delivered.
    const last = messages.at(-1)
    if (last !== undefined) {
      live.handedBefore = live.handed
      live.handed = last.id
      this.deps.saveRecord(sessionId, this.recordOf(live, { cwd, promptHash: live.promptHash ?? promptHash, model: options.model }))
    }

    try {
      yield* this.drain(live, options)
    } catch (error) {
      // The caller sees the failure now: a start that died before reading its
      // prompt must not count as delivered, in case the host restarts next.
      this.rollbackUnread(live, sessionId)
      // The saved conversation is gone: start over in a new one with the
      // history, once, so the user sees the answer instead of this failure.
      if (live.resumeLost === true && options[RESUME_RETRIED] !== true) {
        live.resumeLost = false
        yield* this.stream({ ...options, [RESUME_RETRIED]: true })
        return
      }
      throw error
    }
  }

  // Input for the CLI: a fresh prompt while it is idle; while a turn runs or
  // waits on a bridged call, steering for Codex and Claude, or a queued prompt
  // for ACP (it speaks one prompt at a time; the drain sends it when the turn
  // ends, inside the same stream). The prompt request itself stays open for
  // the whole turn (ACP session/prompt ends when the agent's turn does), so it
  // is sent but not awaited; a send failure lands in the queue as an error.
  sendInput(live, text, signal, effort) {
    live.mute = false
    if (live.state !== 'idle') {
      if (live.spec.kind === 'acp') { live.queue.push(text); return }
      try {
        Promise.resolve(live.engine.steer?.(live.engineSession, text))
          .catch(error => live.push({ type: 'error', error }))
      } catch (error) {
        live.push({ type: 'error', error })
      }
      return
    }
    live.state = 'running'
    try {
      Promise.resolve(live.engine.prompt(live.engineSession, [{ type: 'text', text }], { signal, effort }))
        .catch(error => live.push({ type: 'error', error }))
    } catch (error) {
      live.push({ type: 'error', error })
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
    // model calls (Codex): the chunk carries the sum.
    let usage
    const addUsage = (more) => {
      usage = usage === undefined ? { ...more } : Object.fromEntries([...new Set([...Object.keys(usage), ...Object.keys(more)])].map(key => [key, (usage[key] ?? 0) + (more[key] ?? 0)]))
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
    try {
    for (;;) {
      const event = await Promise.race([live.next(), abortPromise]).catch(error => ({ type: 'abort', error }))
      if (event.type === 'abort') {
        this.stopTurn(live, 'the turn was stopped')
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
        return
      }
      switch (event.type) {
        case 'text': {
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
        case 'usage': yield addUsage(event.usage); break
        case 'call': {
          yield* closeBlocks()
          live.state = 'suspended'
          // A team tool the CLI invoked over the loopback MCP server.
          for (const chunk of emitCalls([{ name: event.name, args: event.args, dshCallId: event.dshCallId }])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'permission': {
          // The preset answers what it already decides, also on an agent with no
          // matching mode of its own: full access allows, read-only refuses a change.
          const answer = presetAnswer(this.deps.presetFor(live.sessionId), event)
          if (answer !== undefined) { event.reply(answer); break }
          yield* closeBlocks()
          live.state = 'suspended'
          // The CLI's own permission prompt, bridged as an approval tool call.
          const call = { name: APPROVE_TOOL, args: { action: event.action, ...(event.detail ? { detail: event.detail } : {}) }, dshCallId: event.id }
          live.pending.set(event.id, { name: APPROVE_TOOL, resolve: (result) => event.reply(pickAllowOption(event.options, result)) })
          for (const chunk of emitCalls([call])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          yield* closeBlocks()
          if (event.usage !== undefined) yield addUsage(event.usage)
          live.state = 'idle'
          // Input queued while this turn ran goes out as the next prompt
          // inside the same drain (ACP takes one prompt at a time).
          const next = live.queue.shift()
          if (next !== undefined) {
            this.sendInput(live, next, options.signal, options.reasoningEffort)
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
      this.meter(live, await this.collect(live, () => this.take(live), signal, { compaction: true }))
      return 'done'
    })
  }

  // One prompt in a Session's own CLI session, which has the whole conversation in
  // context, answered with text and no tools: the handoff note.
  async note(sessionId, text, signal) {
    return this.maintain(sessionId, signal, async (live) => {
      this.sendInput(live, text, signal)
      return this.meter(live, await this.collect(live, () => this.take(live), signal)).text
    })
  }

  // Runs `work` on a Session's CLI session while no turn uses it. A CLI session the
  // Session has no process for is opened for it and let go of after, so the next turn
  // opens it again with its own tools and instructions.
  async maintain(sessionId, signal, work) {
    let live = this.live.get(sessionId)
    const record = live === undefined ? this.deps.record(sessionId) : undefined
    if (live === undefined && record?.cliSessionId === undefined) throw new LlmError('this conversation has no session of its local agent yet', 'LOCAL_AGENT_ERROR')
    let opened = false
    if (live === undefined || live.engineSession === undefined || live.engineSession.dead === true) {
      live ??= await this.liveFor({ sessionId, provider: record.route, model: record.model }, this.deps.presetFor(sessionId))
      await this.openFor(live, sessionId)
      opened = true
    }
    if (live.state !== 'idle' || live.pending.size > 0) throw new LlmError('the local agent is in the middle of a turn', 'LOCAL_AGENT_BUSY')
    // What a finished turn left behind is not this request's answer.
    live.events.length = 0
    try {
      return await work(live)
    } finally {
      if (live.state !== 'idle') this.stopTurn(live, 'the request was stopped')
      live.events.length = 0
      live.mute = true
      if (opened) await this.closeLive(live, { idle: true })
    }
  }

  async openFor(live, sessionId) {
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd
    live.engineSession = await live.engine.open(sessionId, { cwd, mcp: undefined, resumeId: live.cliSessionId, mode: cliMode(live.spec.kind, live.preset), preset: live.preset, model: live.model })
      .catch(error => { throw toLlmError(error, live) })
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
      usage = usage === undefined ? { ...more } : Object.fromEntries([...new Set([...Object.keys(usage), ...Object.keys(more)])].map(key => [key, (usage[key] ?? 0) + (more[key] ?? 0)]))
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
        if (ended && (!compaction || condensed)) return { text, usage }
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
          case 'quiet': return { text, usage }
          case 'usage': add(event.usage); break
          case 'done':
            add(event.usage)
            ended = true
            live.state = 'idle'
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
  meter(live, result) {
    if (result.usage !== undefined) this.deps.recordUsage?.({ sessionId: live.sessionId, kind: 'compaction', provider: live.route, model: live.model, usage: result.usage })
    return result
  }

  // A one-off request on the CLI a Session runs on, in a session of its own with no
  // team tools and read-only access, which is let go of after: the context steward's
  // call for a Bot whose team has no model of its own.
  async ask(sessionId, { system, prompt, signal }) {
    const record = this.live.get(sessionId) ?? this.deps.record(sessionId)
    const route = record?.route
    const spec = route === undefined ? undefined : engineOf(route, this.deps.customAgents())
    if (spec === undefined) throw new LlmError('this conversation has no local agent', 'LOCAL_AGENT_MISSING')
    const engine = this.engine(route)
    const sideId = `dsbot-side-${randomUUID()}`
    let session
    try {
      session = await engine.open(sideId, {
        cwd: this.deps.probeCwd(), mcp: undefined, mode: cliMode(spec.kind, 'read-only'), preset: 'read-only', model: record.model, ephemeral: true,
        instructions: spec.kind === 'codex' ? system : undefined,
        system: spec.kind === 'claude' ? system : undefined,
      }).catch(error => { throw toLlmError(error, { spec }) })
      const side = { state: 'running', pending: new Map(), spec }
      // A decision needs no long thinking: the least the model offers, when it lists any.
      const efforts = (this.modelCache.get(route) ?? []).find(model => model.id === record.model)?.reasoning?.efforts ?? []
      const effort = efforts.some(entry => entry.id === 'off') ? 'off' : efforts[0]?.id
      // An ACP prompt resolves only when its turn ends, and its events wait in the
      // queue; a prompt the CLI refuses ends the request at once.
      const refused = Promise.resolve(engine.prompt(session, [{ type: 'text', text: spec.kind === 'acp' ? `${system}\n\n${prompt}` : prompt }], { signal, effort }))
        .then(() => new Promise(() => {}), error => ({ type: 'error', error }))
      const result = await this.collect(side, () => ({ event: Promise.race([session.next(), refused]), drop: () => {} }), signal)
      return this.meter({ sessionId, route, model: record.model }, result).text
    } finally {
      if (session !== undefined) {
        if (signal?.aborted) engine.cancel?.(session)
        await engine.closeSession?.(session)
      }
      engine.forget?.(sideId)
      if (![...this.live.values()].some(other => other.engine === engine && !other.dead)) await engine.close?.().catch(() => {})
    }
  }

  async dispose() {
    this.disposed = true
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
  return optionOf(options, 'allow') ?? null
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

// The replay a fresh CLI session stands up on: the system prompt, then the
// recent messages rendered as text, newest first, always with the latest input
// and the handoff a new part opens with, both word for word.
function renderReplay(messages, system) {
  const picked = []
  let used = 0
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  let full = false
  for (const message of [...body].reverse()) {
    const whole = message === latest || message.source?.handoff === true
    const text = textOf(message.content)
    const line = `${message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'}: ${whole ? text : text.slice(0, 2_000)}`
    if (whole) { picked.unshift(line); used += line.length; continue }
    full ||= picked.length >= REPLAY_MESSAGES || used + line.length > REPLAY_BYTES
    if (full) continue
    picked.unshift(line)
    used += line.length
  }
  if (picked.length === 0) return ''
  const head = system === '' ? '' : `The team instructions for this conversation:\n${system}\n\n`
  return `${head}The conversation so far (oldest first):\n\n${picked.join('\n\n')}`
}

// Process exits, missing CLIs, quota and sign-in failures get typed codes so DS
// Bot's repair card can act on them.
function toLlmError(error, live) {
  if (error instanceof LlmError) return error
  const text = String(error?.message ?? error)
  // A CLI whose context is past its window: the part moves on the way an overflow does.
  const overflow = /prompt is too long|context.?(window|length).?(exceeded|is full)|context_length_exceeded|exceeds the (model's )?(maximum )?context|too many tokens/i
  const code = error?.code === 'NO_ADAPTER' ? 'LOCAL_AGENT_MISSING'
    : overflow.test(text) ? 'CONTEXT_WINDOW_EXCEEDED'
      : /not signed in|not logged in|login required|unauthorized|authentication/i.test(text) ? 'LOCAL_AGENT_SIGNIN'
        : /quota|rate.?limit|usage limit|exceeded/i.test(text) ? 'LOCAL_AGENT_QUOTA'
          : /exited|spawn|ENOENT/i.test(text) ? 'LOCAL_AGENT_EXIT'
            : error?.code ?? 'LOCAL_AGENT_ERROR'
  const hint = code === 'LOCAL_AGENT_SIGNIN' ? ` Sign in with: ${live?.spec?.signIn ?? `${live?.spec?.command ?? 'the CLI'} login`}.` : ''
  return new LlmError(`${text}${hint}`, code, error?.status === undefined ? {} : { status: error.status })
}
