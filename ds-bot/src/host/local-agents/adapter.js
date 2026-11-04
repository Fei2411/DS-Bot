// The LlmAdapter that serves every local-agent route. A DS Bot Bot whose model
// is one of these routes answers through a local agent CLI instead of a model
// API: the loop, Sessions, tools and approvals are the ordinary ones; this
// adapter turns each request into a prompt for the CLI session the Session is
// mapped to, and the CLI's output back into stream chunks.
import { createHash } from 'node:crypto'
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

export class LocalAgentAdapter extends LlmAdapter {
  // deps: {rt, findExecutable, spawnEngine(kind,route,engine), record(sessionId),
  //        saveRecord, dropRecord, presetFor(sessionId), toolsFor(options), signInHint(route)}
  constructor(deps) {
    super()
    this.deps = deps
    this.engines = new Map()   // route -> engine driver
    this.live = new Map()      // sessionId -> live session
    this.modelCache = new Map()
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

  async listModels(route) {
    const cached = this.modelCache.get(route)
    if (cached !== undefined) return cached
    const spec = engineOf(route, this.deps.customAgents())
    if (spec === undefined) return []
    const fallback = [{ provider: route, id: 'default', name: 'CLI default' }]
    let models
    try {
      models = await this.engine(route).listModels({ cwd: this.deps.probeCwd(), mcp: undefined })
    } catch {
      models = []
    }
    const value = [...fallback, ...(models ?? []).filter(model => model.id !== 'default')
      .map(model => ({ provider: route, id: model.id, name: model.name ?? model.id }))]
    this.modelCache.set(route, value)
    return value
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
    }
  }

  // ---------------------------------------------------------------------------
  // The live bridge for one DS Bot Session.
  async liveFor(options) {
    const sessionId = String(options.sessionId)
    let live = this.live.get(sessionId)
    const record = this.deps.record(sessionId)
    if (live !== undefined && !live.dead && live.route === options.provider) return live
    const route = options.provider
    const spec = engineOf(route, this.deps.customAgents())
    if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'NO_ADAPTER')
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
      idle: undefined,
      cwd: record?.cwd,
      model: options.model,
    }
    live.push = (event) => {
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

  async closeLive(live, { idle = false } = {}) {
    if (live.dead) return
    live.dead = true
    clearTimeout(live.idle)
    this.live.delete(live.sessionId)
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

  // The loopback MCP server for one live session; tools/call lands in its event queue.
  async ensureMcp(live, tools) {
    if (live.mcp !== undefined) return live.mcp
    const mcp = new LoopbackMcp(() => tools, ({ name, arguments: args, callId }) => {
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
    const live = await this.liveFor(options)

    // What the request carries past the last handed message. When the marker is
    // gone the CLI session is stale or new: it gets a replay instead of a delta.
    const messages = options.messages ?? []
    const at = live.handed === undefined ? -1 : messages.findIndex(message => message.id === live.handed)
    const fresh = live.handed === undefined || at === -1
    const delta = fresh ? [] : messages.slice(at + 1)

    // Results of the calls the last step emitted answer the suspended CLI calls.
    for (const message of delta) {
      if (message.role !== 'tool') continue
      const pending = live.pending.get(message.toolCallId ?? message.source?.callId)
      if (pending === undefined) continue
      live.pending.delete(message.toolCallId ?? message.source?.callId)
      pending.resolve({ text: textOf(message.content) || (message.isError ? 'the call failed' : ''), isError: message.isError === true })
    }
    const users = delta.filter(message => message.role === 'user')
    // A turn that ended with a question still open resolves it with the user's
    // next message; the rest, if any, are new input.
    const answers = [...live.pending.values()]
    const remaining = []
    for (const message of users) {
      const pending = answers.shift()
      if (pending !== undefined && ![...live.pending.values()].includes(pending)) { remaining.push(message); continue }
      if (pending !== undefined) {
        for (const [id, entry] of live.pending) if (entry === pending) { live.pending.delete(id); pending.resolve({ text: textOf(message.content) }) }
      } else {
        remaining.push(message)
      }
    }

    const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n').trim()
    const promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    const mcp = await this.ensureMcp(live, () => this.deps.toolsFor(options))
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd

    const preset = this.deps.presetFor(sessionId)
    const mode = cliMode(live.spec.kind, preset, live.engineSession?.modes)
    const instructions = system === '' ? undefined : system

    const freshCli = live.cliSessionId === undefined
    if (live.engineSession === undefined) {
      const openArgs = {
        cwd,
        mcp,
        resumeId: live.cliSessionId,
        mode,
        model: options.model,
        // Codex carries the team instructions as developer config on a new
        // thread; Claude gets them appended at spawn; ACP reads them in the
        // first prompt below.
        instructions: live.spec.kind === 'codex' && freshCli ? instructions : undefined,
        system: live.spec.kind === 'claude' ? instructions : undefined,
      }
      live.engineSession = await live.engine.open(sessionId, openArgs)
        .catch(error => { throw toLlmError(error, live) })
      live.cliSessionId = live.engineSession.acpSessionId ?? live.engineSession.threadId ?? live.engineSession.cliSessionId
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
      this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
    }

    let promptText = fresh ? renderReplay(messages, system)
      : remaining.map(message => textOf(message.content)).filter(text => text !== '').join('\n\n')
    let sentInstructions = live.spec.kind !== 'acp' && freshCli && instructions !== undefined
    if (instructions !== undefined && live.promptHash !== promptHash) {
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
      this.sendPrompt(live, promptText, options.signal)
      if (sentInstructions) live.promptHash = promptHash
      // ACP only counts instructions once they reach the agent with a prompt.
      if (live.spec.kind === 'acp' && (freshCli || sentInstructions)) live.promptHash = promptHash
    }
    if (live.spec.kind === 'acp' && freshCli && promptText === '' && instructions !== undefined) {
      this.sendPrompt(live, `Follow these instructions from the user's team for everything you do here. They sit on top of your own; when they conflict, these win.\n\n${instructions}`, options.signal)
      live.promptHash = promptHash
    }

    // The last DSH message is handed now; a later call sends only what follows.
    const last = messages.at(-1)
    if (last !== undefined) {
      live.handed = last.id
      this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
    }

    yield* this.drain(live, options)
  }

  // Prompt the engine. The request stays open for the whole turn (ACP
  // session/prompt ends when the agent's turn does), so it is sent but not
  // awaited: the drain below consumes the turn's events, bridged calls
  // included. A send failure lands in the queue as an error event.
  sendPrompt(live, text, signal) {
    try {
      Promise.resolve(live.engine.prompt(live.engineSession, [{ type: 'text', text }], { signal }))
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
    const abortable = promise => Promise.race([
      promise,
      new Promise((_, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason ?? new Error('aborted'))
        else options.signal?.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')), { once: true })
      }),
    ])
    for (;;) {
      const event = await abortable(live.next()).catch(error => ({ type: 'abort', error }))
      if (event.type === 'abort') {
        live.engine.cancel?.(live.engineSession)
        live.mcp?.failAll(new Error('the turn was stopped'))
        for (const pending of live.pending.values()) pending.resolve({ text: 'the turn was stopped', isError: true })
        live.pending.clear()
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
          const text = event.type === 'activity' ? `${event.text}\n` : event.text
          if (thinkIndex === -1) {
            if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'reasoning' }
            thinkIndex = index - 1
          }
          thinkBuf += text
          yield { type: 'reasoning-delta', index: thinkIndex, text }
          break
        }
        case 'usage': yield { type: 'usage', usage: event.usage }; break
        case 'call': {
          yield* closeBlocks()
          // A team tool the CLI invoked over the loopback MCP server.
          for (const chunk of emitCalls([{ name: event.name, args: event.args, dshCallId: event.dshCallId }])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'permission': {
          yield* closeBlocks()
          // The CLI's own permission prompt, bridged as an approval tool call.
          const call = { name: APPROVE_TOOL, args: { action: event.action, ...(event.detail ? { detail: event.detail } : {}) }, dshCallId: event.id }
          live.pending.set(event.id, { name: APPROVE_TOOL, resolve: (result) => event.reply(pickAllowOption(event.options, result)) })
          for (const chunk of emitCalls([call])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          yield* closeBlocks()
          if (event.usage !== undefined) yield { type: 'usage', usage: event.usage }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        case 'error': {
          throw toLlmError(event.error, live)
        }
        default: break
      }
    }
  }

  async dispose() {
    this.disposed = true
    for (const live of [...this.live.values()]) await this.closeLive(live)
    for (const live of Array.from(this.live.values())) await this.closeLive(live)
    for (const engine of Array.from(this.engines.values())) await engine.close?.().catch(() => {})
    this.engines.clear()
  }
}

// The result DSH gives approve_agent_action decides the agent's option:
// 'allow' picks the first allow-kind option; anything else fails closed.
function pickAllowOption(options, result) {
  const allowed = result.isError !== true && /allow|yes|approve/i.test(result.text ?? '')
  if (!allowed) return null
  const option = (options ?? []).find(entry => /allow/.test(entry.kind ?? ''))
  return option?.optionId ?? null
}

// The replay a fresh CLI session stands up on: the system prompt, then the
// recent messages rendered as text, newest first, always with the latest input.
function renderReplay(messages, system) {
  const picked = []
  let used = 0
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  for (const message of [...body].reverse()) {
    const line = `${message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'}: ${textOf(message.content).slice(0, 2_000)}`
    if (message === latest) { picked.unshift(line); used += line.length; continue }
    if (picked.length >= REPLAY_MESSAGES || used + line.length > REPLAY_BYTES) break
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
  const code = error?.code === 'NO_ADAPTER' ? 'LOCAL_AGENT_MISSING'
    : /not signed in|not logged in|login required|unauthorized|authentication/i.test(text) ? 'LOCAL_AGENT_SIGNIN'
      : /quota|rate.?limit|usage limit|exceeded/i.test(text) ? 'LOCAL_AGENT_QUOTA'
        : /exited|spawn|ENOENT/i.test(text) ? 'LOCAL_AGENT_EXIT'
          : error?.code ?? 'LOCAL_AGENT_ERROR'
  const hint = code === 'LOCAL_AGENT_SIGNIN' ? ` Sign in with: ${live?.spec?.signIn ?? `${live?.spec?.command ?? 'the CLI'} login`}.` : ''
  return new LlmError(`${text}${hint}`, code, error?.status === undefined ? {} : { status: error.status })
}
